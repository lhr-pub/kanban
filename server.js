require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const AsyncLock = require('async-lock');

// 并发锁实例 - 防止同一文件的并发读写竞态
const fileLock = new AsyncLock({ timeout: 5000 });

// ============ 数据加密配置 ============
// 从环境变量读取加密密钥（32字节 = 256位）
// 如果未设置，则不加密（向后兼容）
const DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || '';
const ENCRYPTION_ENABLED = DATA_ENCRYPTION_KEY.length >= 32;

// 派生实际使用的密钥（确保正好32字节）
const encryptionKey = ENCRYPTION_ENABLED
    ? crypto.createHash('sha256').update(DATA_ENCRYPTION_KEY).digest()
    : null;

// 加密文件的魔数标识（用于区分明文和密文）
const ENCRYPTED_MAGIC = Buffer.from('KANBAN_ENC_V1\x00\x00\x00'); // 16 bytes

/**
 * 加密数据
 * @param {string} plaintext - 明文 JSON 字符串
 * @returns {Buffer} - 加密后的数据（magic + iv + tag + ciphertext）
 */
function encryptData(plaintext) {
    const iv = crypto.randomBytes(12); // GCM 推荐 12 字节 IV
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ]);
    const tag = cipher.getAuthTag(); // 16 bytes
    // 格式: MAGIC(16) + IV(12) + TAG(16) + CIPHERTEXT
    return Buffer.concat([ENCRYPTED_MAGIC, iv, tag, encrypted]);
}

/**
 * 解密数据
 * @param {Buffer} data - 加密的数据
 * @returns {string} - 解密后的明文
 */
function decryptData(data) {
    // 解析各部分
    const iv = data.subarray(16, 28);        // 12 bytes
    const tag = data.subarray(28, 44);       // 16 bytes
    const ciphertext = data.subarray(44);    // 剩余部分

    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
    ]).toString('utf8');
}

/**
 * 检查数据是否已加密（通过魔数）
 */
function isEncrypted(data) {
    if (!Buffer.isBuffer(data) || data.length < 44) return false;
    return data.subarray(0, 16).equals(ENCRYPTED_MAGIC);
}

if (ENCRYPTION_ENABLED) {
    console.log('📦 数据加密已启用 (AES-256-GCM)');
} else {
    console.log('⚠️  数据加密未启用 (设置 DATA_ENCRYPTION_KEY 环境变量以启用)');
}
// ============ 数据加密配置 END ============

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
// raise JSON body limit to support base64 image upload (~10MB)
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// 数据目录
const dataDir = path.join(__dirname, 'data');
const backupsDir = path.join(dataDir, 'backups');

// 确保数据目录存在
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}
if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
}

// uploads directory (served statically)
const uploadsRoot = path.join(dataDir, 'uploads');
const wallpapersDir = path.join(uploadsRoot, 'wallpapers');
if (!fs.existsSync(uploadsRoot)) fs.mkdirSync(uploadsRoot, { recursive: true });
if (!fs.existsSync(wallpapersDir)) fs.mkdirSync(wallpapersDir, { recursive: true });
app.use('/uploads', express.static(uploadsRoot));

// Default board background (used when a user hasn't set one)
const DEFAULT_BACKGROUND_URL = process.env.DEFAULT_BG_URL || 'https://snlz-1322843231.cos.ap-nanjing.myqcloud.com/uPic/photo-1742156345582-b857d994c84e.webp';

function getDefaultBackgrounds() {
    try {
        // Support comma-separated list
        const csv = process.env.DEFAULT_BG_URLS;
        let urls = [];
        if (csv && typeof csv === 'string') {
            urls = csv.split(',').map(s => s.trim()).filter(Boolean);
        } else {
            const a = process.env.DEFAULT_BG_URL_1;
            const b = process.env.DEFAULT_BG_URL_2;
            const c = process.env.DEFAULT_BG_URL_3;
            urls = [a, b, c].filter(u => typeof u === 'string' && u.trim());
        }
        if (!urls.length && DEFAULT_BACKGROUND_URL) urls = [DEFAULT_BACKGROUND_URL];
        return urls.slice(0, 3);
    } catch (_) {
        return DEFAULT_BACKGROUND_URL ? [DEFAULT_BACKGROUND_URL] : [];
    }
}

// 内存中的WebSocket连接管理
const connections = new Map();

// 管理员会话（内存）
const adminSessions = new Map(); // token -> { username, expiresAt }

function createAdminToken(username) {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = Date.now() + (2 * 60 * 60 * 1000); // 2小时
    adminSessions.set(token, { username, expiresAt });
    return token;
}

function verifyAdminToken(req, res, next) {
    const authHeader = req.headers['authorization'] || '';
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
        return res.status(401).json({ message: '未授权' });
    }
    const token = parts[1];
    const session = adminSessions.get(token);
    if (!session) return res.status(401).json({ message: '无效令牌' });
    if (session.expiresAt < Date.now()) {
        adminSessions.delete(token);
        return res.status(401).json({ message: '令牌已过期' });
    }
    // 滚动过期
    session.expiresAt = Date.now() + (2 * 60 * 60 * 1000);
    req.adminUsername = session.username;
    req.adminToken = token;
    next();
}

function ensureAdminUser() {
    try {
        const usersFile = path.join(dataDir, 'users.json');
        const users = readJsonFile(usersFile, {});
        const adminUsername = process.env.ADMIN_USERNAME || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
        const adminEmail = process.env.ADMIN_EMAIL || '';

        const existing = users[adminUsername];
        if (!existing) {
            const hashedPassword = crypto.createHash('sha256').update(adminPassword).digest('hex');
            users[adminUsername] = {
                password: hashedPassword,
                email: adminEmail,
                verified: true,
                admin: true,
                projects: [],
                created: new Date().toISOString()
            };
            writeJsonFile(usersFile, users);
            console.log(`[BOOTSTRAP] 已创建管理员账户: ${adminUsername}`);
        } else if (!existing.admin) {
            existing.admin = true;
            writeJsonFile(usersFile, users);
            console.log(`[BOOTSTRAP] 已提升为管理员: ${adminUsername}`);
        }
    } catch (e) {
        console.error('Admin bootstrap error:', e);
    }
}

ensureAdminUser();

// 邮件发送配置（通过环境变量）
const emailConfig = {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: (process.env.SMTP_USER && process.env.SMTP_PASS)
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined
};
const emailEnabled = Boolean(emailConfig.host && emailConfig.auth && emailConfig.auth.user && emailConfig.auth.pass);
const mailTransporter = emailEnabled ? nodemailer.createTransport(emailConfig) : null;
if (emailEnabled) {
    mailTransporter.verify().then(() => {
        console.log('[MAIL] SMTP 连接验证成功');
    }).catch(err => {
        console.error('[MAIL] SMTP 连接验证失败:', err && err.message ? err.message : err);
    });
}

async function sendVerificationEmail(toEmail, username, token, baseUrl) {
    const verifyUrl = `${baseUrl}/api/verify?token=${encodeURIComponent(token)}`;

    // 优先使用显式配置的 SMTP
    if (emailEnabled && mailTransporter) {
        const from = process.env.MAIL_FROM || (emailConfig.auth ? emailConfig.auth.user : 'no-reply@example.com');
        try {
            const info = await mailTransporter.sendMail({
                from,
                to: toEmail,
                subject: '看板 - 邮箱验证',
                text: `您好 ${username}，\n\n请点击以下链接验证您的邮箱：\n${verifyUrl}\n\n如果非本人操作请忽略。`,
                html: `<p>您好 <b>${username}</b>，</p><p>请点击以下链接验证您的邮箱：</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>如果非本人操作请忽略。</p>`
            });
            console.log(`[MAIL] 已发送验证邮件至 ${toEmail}. messageId=${info && info.messageId}`);
            return;
        } catch (e) {
            console.error('[MAIL] 发送失败（SMTP）:', e && e.message ? e.message : e);
            // 若 SMTP 发送失败，不再降级到 Ethereal，避免意外泄漏。仅提示日志与手动链接。
            console.log(`[DEV] Verification link for ${username}: ${verifyUrl}`);
            return;
        }
    }

    // 开发环境 Ethereal 回退（预览邮箱，不会真正投递）
    const useEtherealDefault = (process.env.NODE_ENV || 'development') !== 'production';
    const useEthereal = (process.env.USE_ETHEREAL || (useEtherealDefault ? 'true' : 'false')) === 'true';
    if (useEthereal) {
        try {
            const testAccount = await nodemailer.createTestAccount();
            const etherealTransporter = nodemailer.createTransport({
                host: testAccount.smtp.host,
                port: testAccount.smtp.port,
                secure: testAccount.smtp.secure,
                auth: { user: testAccount.user, pass: testAccount.pass }
            });
            const info = await etherealTransporter.sendMail({
                from: testAccount.user,
                to: toEmail,
                subject: '看板 - 邮箱验证 (Ethereal 测试)',
                text: `您好 ${username}，\n\n请点击以下链接验证您的邮箱：\n${verifyUrl}\n\n如果非本人操作请忽略。`,
                html: `<p>您好 <b>${username}</b>，</p><p>请点击以下链接验证您的邮箱：</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>如果非本人操作请忽略。</p>`
            });
            const preview = nodemailer.getTestMessageUrl(info);
            console.log(`[MAIL][ETHEREAL] 预览链接: ${preview}`);
            return;
        } catch (e) {
            console.error('[MAIL][ETHEREAL] 发送失败:', e && e.message ? e.message : e);
            console.log(`[DEV] Verification link for ${username}: ${verifyUrl}`);
            return;
        }
    }

    // 最终回退：仅控制台输出链接
    console.log(`[DEV] Verification link for ${username}: ${verifyUrl}`);
}

// 发送找回密码邮件
async function sendPasswordResetEmail(toEmail, username, token, baseUrl) {
    const resetUrl = `${baseUrl}/?resetToken=${encodeURIComponent(token)}`;

    if (emailEnabled && mailTransporter) {
        const from = process.env.MAIL_FROM || (emailConfig.auth ? emailConfig.auth.user : 'no-reply@example.com');
        try {
            const info = await mailTransporter.sendMail({
                from,
                to: toEmail,
                subject: '看板 - 重置密码',
                text: `您好 ${username}，\n\n我们收到了您的密码重置请求。请点击以下链接设置新密码（1小时内有效）：\n${resetUrl}\n\n如果非本人操作，请忽略本邮件。`,
                html: `<p>您好 <b>${username}</b>，</p><p>我们收到了您的密码重置请求。请点击以下链接设置新密码（1小时内有效）：</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>如果非本人操作，请忽略本邮件。</p>`
            });
            console.log(`[MAIL] 已发送重置密码邮件至 ${toEmail}. messageId=${info && info.messageId}`);
            return;
        } catch (e) {
            console.error('[MAIL] 重置密码邮件发送失败（SMTP）:', e && e.message ? e.message : e);
            console.log(`[DEV] Reset link for ${username}: ${resetUrl}`);
            return;
        }
    }

    const useEtherealDefault = (process.env.NODE_ENV || 'development') !== 'production';
    const useEthereal = (process.env.USE_ETHEREAL || (useEtherealDefault ? 'true' : 'false')) === 'true';
    if (useEthereal) {
        try {
            const testAccount = await nodemailer.createTestAccount();
            const etherealTransporter = nodemailer.createTransport({
                host: testAccount.smtp.host,
                port: testAccount.smtp.port,
                secure: testAccount.smtp.secure,
                auth: { user: testAccount.user, pass: testAccount.pass }
            });
            const info = await etherealTransporter.sendMail({
                from: testAccount.user,
                to: toEmail,
                subject: '看板 - 重置密码 (Ethereal 测试)',
                text: `您好 ${username}，\n\n我们收到了您的密码重置请求。请点击以下链接设置新密码（1小时内有效）：\n${resetUrl}\n\n如果非本人操作，请忽略本邮件。`,
                html: `<p>您好 <b>${username}</b>，</p><p>我们收到了您的密码重置请求。请点击以下链接设置新密码（1小时内有效）：</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>如果非本人操作，请忽略本邮件。</p>`
            });
            const preview = nodemailer.getTestMessageUrl(info);
            console.log(`[MAIL][ETHEREAL] 重置密码预览链接: ${preview}`);
            return;
        } catch (e) {
            console.error('[MAIL][ETHEREAL] 重置密码邮件发送失败:', e && e.message ? e.message : e);
            console.log(`[DEV] Reset link for ${username}: ${resetUrl}`);
            return;
        }
    }

    console.log(`[DEV] Reset link for ${username}: ${resetUrl}`);
}

// 生成邀请码
function generateInviteCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// 生成项目ID
function generateProjectId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

// 读写文件辅助函数
function readJsonFile(filePath, defaultValue = {}) {
    try {
        if (fs.existsSync(filePath)) {
            // 以 Buffer 形式读取，以便检测是否加密
            const rawData = fs.readFileSync(filePath);

            if (ENCRYPTION_ENABLED && isEncrypted(rawData)) {
                // 文件已加密，解密后解析
                const plaintext = decryptData(rawData);
                return JSON.parse(plaintext);
            } else {
                // 文件是明文（或未启用加密），直接解析
                return JSON.parse(rawData.toString('utf8'));
            }
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue;
}

function writeJsonFile(filePath, data) {
    try {
        const jsonStr = JSON.stringify(data, null, 2);

        if (ENCRYPTION_ENABLED) {
            // 加密后写入（二进制）
            const encrypted = encryptData(jsonStr);
            fs.writeFileSync(filePath, encrypted);
        } else {
            // 明文写入
            fs.writeFileSync(filePath, jsonStr, 'utf8');
        }
        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
        return false;
    }
}

// 用户认证API
app.post('/api/register', async (req, res) => {
    const { username, password, email } = req.body;

    if (!username || !password || !email) {
        return res.status(400).json({ message: '用户名、密码和邮箱不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    if (users[username]) {
        return res.status(400).json({ message: '用户名已存在' });
    }

    // 邮箱是否已被使用
    const emailTaken = Object.values(users).some(u => (u && u.email && u.email.toLowerCase && u.email.toLowerCase() === String(email).toLowerCase()));
    if (emailTaken) {
        return res.status(400).json({ message: '邮箱已被使用' });
    }

    // 密码哈希
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    // 生成邮箱验证令牌
    const verifyToken = crypto.randomBytes(32).toString('hex');
    const verifyTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24小时

    users[username] = {
        password: hashedPassword,
        email,
        verified: false,
        verifyToken,
        verifyTokenExpires,
        projects: [],
        created: new Date().toISOString()
    };

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '注册失败，请稍后重试' });
    }

    try {
        const baseUrl = process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        await sendVerificationEmail(email, username, verifyToken, baseUrl);
        return res.json({ message: '注册成功，请前往邮箱验证后登录', username });
    } catch (err) {
        console.error('Error sending verification email:', err);
        return res.status(500).json({ message: '注册成功，但发送验证邮件失败，请稍后重试' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: '用户名和密码不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    // 支持用户名或邮箱登录
    let canonicalUsername = null;
    let user = users[username];
    if (!user) {
        const input = String(username).toLowerCase();
        for (const [uname, u] of Object.entries(users)) {
            if (u && u.email && String(u.email).toLowerCase() === input) {
                canonicalUsername = uname;
                user = u;
                break;
            }
        }
    } else {
        canonicalUsername = username;
    }

    if (!user) {
        return res.status(400).json({ message: '用户不存在' });
    }

    // 未验证邮箱的用户禁止登录（兼容老数据：仅当明确为 false 时拦截）
    if (user.verified === false) {
        return res.status(403).json({ message: '邮箱未验证，请先完成邮箱验证' });
    }

    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    if (user.password !== hashedPassword) {
        return res.status(400).json({ message: '密码错误' });
    }

    res.json({ message: '登录成功', username: canonicalUsername });
});

// 邮箱验证回调
app.get('/api/verify', (req, res) => {
    const { token } = req.query;
    if (!token || typeof token !== 'string') {
        return res.status(400).send('无效的验证链接');
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    let matchedUser = null;
    for (const [uname, u] of Object.entries(users)) {
        if (u && u.verifyToken === token) {
            // 检查是否过期
            if (u.verifyTokenExpires && new Date(u.verifyTokenExpires) < new Date()) {
                return res.status(400).send('验证链接已过期');
            }
            matchedUser = uname;
            break;
        }
    }

    if (!matchedUser) {
        return res.status(400).send('验证链接无效');
    }

    users[matchedUser].verified = true;
    delete users[matchedUser].verifyToken;
    delete users[matchedUser].verifyTokenExpires;

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).send('服务器错误，请稍后重试');
    }

    // 验证成功后跳转到登录页
    return res.redirect('/?verified=1');
});

// 重新发送验证邮件（登录受阻时调用）
app.post('/api/resend-verification', async (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ message: '缺少用户名' });

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    if (user.verified === true) return res.status(400).json({ message: '用户已验证' });
    if (!user.email) return res.status(400).json({ message: '缺少用户邮箱' });

    // 频率限制：60秒一次
    const now = Date.now();
    const lastSent = user.lastVerificationSentAt ? new Date(user.lastVerificationSentAt).getTime() : 0;
    if (now - lastSent < 60 * 1000) {
        const wait = Math.ceil((60 * 1000 - (now - lastSent)) / 1000);
        return res.status(429).json({ message: `请稍后再试（${wait}s）` });
    }

    // 若令牌不存在或已过期，则生成新令牌并延长过期时间
    let token = user.verifyToken;
    const isExpired = !user.verifyTokenExpires || new Date(user.verifyTokenExpires).getTime() < now;
    if (!token || isExpired) {
        token = crypto.randomBytes(32).toString('hex');
        user.verifyToken = token;
        user.verifyTokenExpires = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    }
    user.lastVerificationSentAt = new Date(now).toISOString();

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '保存失败，请稍后重试' });
    }

    try {
        const baseUrl = process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
        await sendVerificationEmail(user.email, username, token, baseUrl);
        return res.json({ message: '验证邮件已发送，请查收' });
    } catch (e) {
        console.error('Resend verification error:', e);
        return res.status(500).json({ message: '发送失败，请稍后重试' });
    }
});

// 找回密码（发送重置邮件）
app.post('/api/forgot-password', async (req, res) => {
    try {
        const { email, username } = req.body || {};
        if ((!email || !String(email).trim()) && (!username || !String(username).trim())) {
            return res.status(400).json({ message: '请提供邮箱或用户名' });
        }
        const usersFile = path.join(dataDir, 'users.json');
        const users = readJsonFile(usersFile, {});

        // 定位用户（优先 email）
        let targetUsername = null;
        let targetUser = null;
        if (email) {
            const lower = String(email).toLowerCase();
            for (const [uname, u] of Object.entries(users)) {
                if (u && u.email && String(u.email).toLowerCase() === lower) { targetUsername = uname; targetUser = u; break; }
            }
        }
        if (!targetUser && username) {
            const u = users[username];
            if (u && u.email) { targetUsername = username; targetUser = u; }
        }

        // 总是返回成功提示，避免枚举
        if (!targetUser) {
            return res.json({ message: '如果该邮箱存在，我们已发送重置邮件' });
        }

        // 频率限制（60s）
        const now = Date.now();
        const last = targetUser.lastResetSentAt ? new Date(targetUser.lastResetSentAt).getTime() : 0;
        if (now - last < 60 * 1000) {
            const wait = Math.ceil((60 * 1000 - (now - last)) / 1000);
            return res.status(429).json({ message: `请稍后再试（${wait}s）` });
        }

        // 生成或刷新重置令牌
        targetUser.resetToken = crypto.randomBytes(32).toString('hex');
        targetUser.resetTokenExpires = new Date(now + 60 * 60 * 1000).toISOString(); // 1小时
        targetUser.lastResetSentAt = new Date(now).toISOString();

        if (!writeJsonFile(usersFile, users)) {
            return res.status(500).json({ message: '发送失败，请稍后再试' });
        }

        try {
            const baseUrl = process.env.BASE_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.get('host')}`;
            await sendPasswordResetEmail(targetUser.email, targetUsername, targetUser.resetToken, baseUrl);
        } catch (e) {
            console.error('Forgot password send mail error:', e);
        }
        return res.json({ message: '如果该邮箱存在，我们已发送重置邮件' });
    } catch (e) {
        console.error('Forgot password error:', e);
        return res.status(500).json({ message: '服务暂不可用，请稍后再试' });
    }
});

// 使用令牌重置密码
app.post('/api/reset-password', (req, res) => {
    const { token, newPassword } = req.body || {};
    if (!token || typeof token !== 'string' || !newPassword || String(newPassword).trim().length < 6) {
        return res.status(400).json({ message: '参数无效，密码至少6位' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    let matchedUsername = null;
    let matchedUser = null;
    for (const [uname, u] of Object.entries(users)) {
        if (u && u.resetToken === token) { matchedUsername = uname; matchedUser = u; break; }
    }
    if (!matchedUser) {
        return res.status(400).json({ message: '重置链接无效，请重新申请' });
    }
    if (matchedUser.resetTokenExpires && new Date(matchedUser.resetTokenExpires) < new Date()) {
        return res.status(400).json({ message: '重置链接已过期，请重新申请' });
    }

    matchedUser.password = crypto.createHash('sha256').update(String(newPassword).trim()).digest('hex');
    delete matchedUser.resetToken;
    delete matchedUser.resetTokenExpires;

    // 已验证邮箱不做更改；若历史数据未验证，这次通过邮箱也可视为已验证
    if (matchedUser.verified === false) {
        matchedUser.verified = true;
    }

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '保存失败，请稍后再试' });
    }
    return res.json({ message: '密码已重置，请使用新密码登录' });
});

// 修改密码（需要提供旧密码）
app.post('/api/change-password', (req, res) => {
    const { username, oldPassword, newPassword } = req.body || {};
    if (!username || !oldPassword || !newPassword) {
        return res.status(400).json({ message: '缺少必要参数' });
    }
    if (String(newPassword).trim().length < 6) {
        return res.status(400).json({ message: '新密码至少6位' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });

    const oldHash = crypto.createHash('sha256').update(String(oldPassword)).digest('hex');
    if (user.password !== oldHash) return res.status(400).json({ message: '旧密码不正确' });

    user.password = crypto.createHash('sha256').update(String(newPassword).trim()).digest('hex');

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '修改失败，请稍后再试' });
    }

    res.json({ message: '密码已更新' });
});

// 管理员登录（独立）
app.post('/api/admin/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ message: '用户名和密码不能为空' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user || user.admin !== true) {
        return res.status(403).json({ message: '无权访问' });
    }
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    if (user.password !== hashedPassword) {
        return res.status(400).json({ message: '密码错误' });
    }
    const token = createAdminToken(username);
    res.json({ message: '登录成功', token, username });
});

app.post('/api/admin/logout', verifyAdminToken, (req, res) => {
    if (req.adminToken) adminSessions.delete(req.adminToken);
    res.json({ message: '已退出' });
});

// 管理用户列表（仅管理员）
app.get('/api/admin/users', verifyAdminToken, (req, res) => {
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const result = Object.entries(users).map(([uname, u]) => ({
        username: uname,
        email: u.email || '',
        verified: u.verified !== false,
        admin: u.admin === true,
        projects: Array.isArray(u.projects) ? u.projects.length : 0,
        created: u.created || ''
    }));
    res.json(result);
});

// 更新用户属性：verified/admin/password（仅管理员）
app.patch('/api/admin/users/:username', verifyAdminToken, (req, res) => {
    const { username } = req.params;
    const { verified, admin, password } = req.body || {};

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });

    if (typeof verified === 'boolean') {
        user.verified = verified;
        if (verified) {
            delete user.verifyToken;
            delete user.verifyTokenExpires;
        }
    }
    if (typeof admin === 'boolean') {
        user.admin = admin;
    }
    if (typeof password === 'string' && password.trim()) {
        user.password = crypto.createHash('sha256').update(password.trim()).digest('hex');
    }

    if (!writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '保存失败' });
    }
    res.json({ message: '更新成功' });
});

// 删除用户（仅管理员）。若为项目所有者则阻止删除
app.delete('/api/admin/users/:username', verifyAdminToken, (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) return res.status(404).json({ message: '用户不存在' });

    // 若是任一项目所有者，阻止删除
    const owning = Object.values(projects).some(p => p && p.owner === username);
    if (owning) {
        return res.status(400).json({ message: '用户是某项目的所有者，无法删除' });
    }

    // 从各项目成员中移除
    for (const proj of Object.values(projects)) {
        if (proj && Array.isArray(proj.members)) {
            const idx = proj.members.indexOf(username);
            if (idx !== -1) proj.members.splice(idx, 1);
        }
    }

    delete users[username];

    if (!writeJsonFile(projectsFile, projects) || !writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '删除失败' });
    }
    res.json({ message: '已删除用户' });
});

// 提供管理员页面 URL
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// 项目管理API
app.get('/api/user-projects/:username', (req, res) => {
    const { username } = req.params;

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');

    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    const user = users[username];
    if (!user) {
        return res.status(404).json({ message: '用户不存在' });
    }

    // Use user's own projects order directly (newest first if unshifted on create/join)
    const orderedIds = Array.isArray(user.projects) ? user.projects.slice() : [];

    const userProjects = orderedIds.map(projectId => {
        const project = projects[projectId];
        if (!project) return null;

        return {
            id: projectId,
            name: project.name,
            inviteCode: project.inviteCode,
            memberCount: Array.isArray(project.members) ? project.members.length : 0,
            boardCount: Array.isArray(project.boards) ? project.boards.length : 0,
            created: project.created,
            owner: project.owner
        };
    }).filter(Boolean);

    res.json(userProjects);
});

// === Pin Groups APIs (projects + boards) ===
// Fetch user's pin groups (projects and boards map)
app.get('/api/user-pinned/:username', (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const pinnedProjects = Array.isArray(user.pinnedProjects) ? user.pinnedProjects.slice() : [];
    const pinnedBoards = user.pinnedBoards && typeof user.pinnedBoards === 'object' ? JSON.parse(JSON.stringify(user.pinnedBoards)) : {};
    return res.json({ pinnedProjects, pinnedBoards });
});

// Toggle project pinned state
app.post('/api/toggle-pin-project', (req, res) => {
    const { username, projectId, pinned } = req.body || {};
    if (!username || !projectId || typeof pinned !== 'boolean') {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    const project = projects[projectId];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    if (!project) return res.status(404).json({ message: '项目不存在' });
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以置顶项目' });
    user.pinnedProjects = Array.isArray(user.pinnedProjects) ? user.pinnedProjects : [];
    const idx = user.pinnedProjects.indexOf(projectId);
    if (pinned) {
        if (idx === -1) user.pinnedProjects.unshift(projectId);
    } else {
        if (idx !== -1) user.pinnedProjects.splice(idx, 1);
    }
    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: pinned ? '已置顶' : '已取消置顶', pinnedProjects: user.pinnedProjects.slice() });
});

// Toggle board pinned state (within a project)
app.post('/api/toggle-pin-board', (req, res) => {
    const { username, projectId, boardName, pinned } = req.body || {};
    if (!username || !projectId || !boardName || typeof pinned !== 'boolean') {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    const project = projects[projectId];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    if (!project) return res.status(404).json({ message: '项目不存在' });
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以置顶看板' });
    const exists = (Array.isArray(project.boards) && project.boards.includes(boardName)) || (Array.isArray(project.archivedBoards) && project.archivedBoards.includes(boardName));
    if (!exists) return res.status(404).json({ message: '看板不存在' });
    user.pinnedBoards = user.pinnedBoards && typeof user.pinnedBoards === 'object' ? user.pinnedBoards : {};
    user.pinnedBoards[projectId] = Array.isArray(user.pinnedBoards[projectId]) ? user.pinnedBoards[projectId] : [];
    const arr = user.pinnedBoards[projectId];
    const idx = arr.indexOf(boardName);
    if (pinned) {
        if (idx === -1) arr.unshift(boardName);
    } else {
        if (idx !== -1) arr.splice(idx, 1);
    }
    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: pinned ? '已置顶' : '已取消置顶', pinnedBoards: { [projectId]: arr.slice() } });
});

// Reorder project to first/last within its group (pinned or normal)
app.post('/api/reorder-project', (req, res) => {
    const { username, projectId, where } = req.body || {};
    if (!username || !projectId || !where || !['first','last'].includes(where)) {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    const project = projects[projectId];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    if (!project) return res.status(404).json({ message: '项目不存在' });
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以调整顺序' });
    user.pinnedProjects = Array.isArray(user.pinnedProjects) ? user.pinnedProjects : [];
    user.projects = Array.isArray(user.projects) ? user.projects : [];
    const targetArr = user.pinnedProjects.includes(projectId) ? user.pinnedProjects : user.projects;
    const idx = targetArr.indexOf(projectId);
    if (idx === -1) return res.status(404).json({ message: '项目不在当前分组' });
    targetArr.splice(idx, 1);
    if (where === 'first') targetArr.unshift(projectId); else targetArr.push(projectId);
    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '已调整顺序' });
});

// Reorder board to first/last within its group (pinned or normal)
app.post('/api/reorder-board', (req, res) => {
    const { username, projectId, boardName, where } = req.body || {};
    if (!username || !projectId || !boardName || !where || !['first','last'].includes(where)) {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    const project = projects[projectId];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    if (!project) return res.status(404).json({ message: '项目不存在' });
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以调整顺序' });
    const inProject = Array.isArray(project.boards) && project.boards.includes(boardName);
    const inArchived = Array.isArray(project.archivedBoards) && project.archivedBoards.includes(boardName);
    if (!inProject && !inArchived) return res.status(404).json({ message: '看板不存在' });
    user.pinnedBoards = user.pinnedBoards && typeof user.pinnedBoards === 'object' ? user.pinnedBoards : {};
    const arrPinned = Array.isArray(user.pinnedBoards[projectId]) ? user.pinnedBoards[projectId] : [];
    const isPinned = arrPinned.includes(boardName);
    if (isPinned) {
        const idx = arrPinned.indexOf(boardName);
        arrPinned.splice(idx, 1);
        if (where === 'first') arrPinned.unshift(boardName); else arrPinned.push(boardName);
        user.pinnedBoards[projectId] = arrPinned;
        if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
        return res.json({ message: '已调整顺序' });
    } else {
        // reorder inside normal group (project.boards)
        project.boards = Array.isArray(project.boards) ? project.boards : [];
        const idx = project.boards.indexOf(boardName);
        if (idx === -1) return res.status(404).json({ message: '仅支持在未归档的看板分组内移动' });
        project.boards.splice(idx, 1);
        if (where === 'first') project.boards.unshift(boardName); else project.boards.push(boardName);
        if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });
        return res.json({ message: '已调整顺序' });
    }
});
// === End Pin Groups APIs ===

// === User Stars (server-side persistence) ===
app.get('/api/user-stars/:username', (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    user.stars = Array.isArray(user.stars) ? user.stars : [];
    // return a copy to avoid accidental mutation
    return res.json({ stars: user.stars.slice() });
});

app.post('/api/user-stars/toggle', (req, res) => {
    const { username, projectId, boardName, projectName } = req.body || {};
    if (!username || !projectId || !boardName) {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    // 只能对自己参与的项目进行星标
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以设置星标' });

    const exists = (Array.isArray(project.boards) && project.boards.includes(boardName)) || (Array.isArray(project.archivedBoards) && project.archivedBoards.includes(boardName));
    if (!exists) return res.status(404).json({ message: '看板不存在' });

    user.stars = Array.isArray(user.stars) ? user.stars : [];
    const idx = user.stars.findIndex(s => s && s.projectId === projectId && s.boardName === boardName);
    let starred = false;
    if (idx !== -1) {
        user.stars.splice(idx, 1);
        starred = false;
    } else {
        const pn = projectName || project.name || '';
        user.stars.unshift({ projectId, boardName, projectName: pn, starredAt: Date.now() });
        starred = true;
    }
    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ starred, stars: user.stars.slice() });
});
// === End User Stars ===

// === Board move-to-front (project-global order) ===
app.post('/api/user-board-pins/pin', (req, res) => {
    const { username, projectId, boardName } = req.body || {};
    if (!username || !projectId || !boardName) return res.status(400).json({ message: '缺少参数' });
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    // 仅项目成员可调整顺序
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以调整顺序' });
    project.boards = Array.isArray(project.boards) ? project.boards : [];
    const idx = project.boards.indexOf(boardName);
    if (idx === -1) return res.status(404).json({ message: '看板不存在' });
    project.boards.splice(idx, 1);
    project.boards.unshift(boardName);
    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '已置前', boards: project.boards.slice() });
});
// === End Board move-to-front ===

// === User Starred Boards Pin Order (server-side persistence) ===
// Get pinned order for starred boards list (independent of project lists)
app.get('/api/user-star-pins/:username', (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const pins = Array.isArray(user.pinnedStarBoards) ? user.pinnedStarBoards.slice() : [];
    return res.json({ pins });
});

// Pin a starred board to the front of the starred list
app.post('/api/user-star-pins/pin', (req, res) => {
    const { username, projectId, boardName } = req.body || {};
    if (!username || !projectId || !boardName) return res.status(400).json({ message: '缺少参数' });
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    // only members
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以置前星标看板' });
    // ensure it's starred; if not, allow but no effect on render until starred
    user.stars = Array.isArray(user.stars) ? user.stars : [];
    const starred = user.stars.some(s => s && s.projectId === projectId && s.boardName === boardName);
    if (!starred) {
        // Not starred; still record the pin to be effective once starred later
    }
    const key = `${projectId}::${boardName}`;
    user.pinnedStarBoards = Array.isArray(user.pinnedStarBoards) ? user.pinnedStarBoards : [];
    const existingIndex = user.pinnedStarBoards.indexOf(key);
    if (existingIndex !== -1) user.pinnedStarBoards.splice(existingIndex, 1);
    user.pinnedStarBoards.unshift(key);

    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '已置前', pins: user.pinnedStarBoards.slice() });
});
// === End User Starred Boards Pin Order ===

// === User Pinned Projects (server-side persistence) ===
app.get('/api/user-pins/:username', (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const pins = Array.isArray(user.pinnedProjects) ? user.pinnedProjects.slice() : [];
    return res.json({ pins });
});

app.post('/api/user-pins/pin', (req, res) => {
    const { username, projectId } = req.body || {};
    if (!username || !projectId) return res.status(400).json({ message: '缺少参数' });
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    // 只有项目成员可以置前
    const isMember = Array.isArray(project.members) && project.members.includes(username);
    if (!isMember) return res.status(403).json({ message: '只有项目成员可以置前项目' });

    // 将项目在用户的 projects 列表中移动到最前（一次性排序，不作为置顶分组）
    user.projects = Array.isArray(user.projects) ? user.projects : [];
    const existingIndex = user.projects.indexOf(projectId);
    if (existingIndex !== -1) {
        user.projects.splice(existingIndex, 1);
    }
    user.projects.unshift(projectId);

    if (!writeJsonFile(usersFile, users)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '已置前', projects: user.projects.slice() });
});
// === End User Pinned Projects ===

app.post('/api/create-project', (req, res) => {
    const { username, projectName } = req.body;

    if (!username || !projectName) {
        return res.status(400).json({ message: '用户名和项目名称不能为空' });
    }

    const projectId = generateProjectId();
    const inviteCode = generateInviteCode();

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');

    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) {
        return res.status(404).json({ message: '用户不存在' });
    }

    // 创建项目
    projects[projectId] = {
        name: projectName,
        inviteCode: inviteCode,
        owner: username,
        created: new Date().toISOString(),
        members: [username],
        boards: [] // 初始不创建默认看板
        , archivedBoards: []
    };

    // 更新用户项目列表（新项目置前）
    users[username].projects = Array.isArray(users[username].projects) ? users[username].projects : [];
    users[username].projects.unshift(projectId);

    if (writeJsonFile(projectsFile, projects) &&
        writeJsonFile(usersFile, users)) {
        res.json({
            message: '项目创建成功',
            projectId,
            inviteCode
        });
    } else {
        res.status(500).json({ message: '创建项目失败' });
    }
});

app.post('/api/join-project', (req, res) => {
    const { username, inviteCode } = req.body;

    if (!username || !inviteCode) {
        return res.status(400).json({ message: '用户名和邀请码不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');

    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) {
        return res.status(404).json({ message: '用户不存在' });
    }

    // 查找项目
    let projectId = null;
    let project = null;

    for (const [id, proj] of Object.entries(projects)) {
        if (proj.inviteCode === inviteCode.toUpperCase()) {
            projectId = id;
            project = proj;
            break;
        }
    }

    if (!project) {
        return res.status(404).json({ message: '邀请码无效' });
    }

    // 检查用户是否已经在项目中
    project.members = Array.isArray(project.members) ? project.members : [];
    if (project.members.includes(username)) {
        return res.status(400).json({ message: '您已经是该项目的成员' });
    }

    // 创建加入请求，等待其他成员同意
    project.pendingRequests = Array.isArray(project.pendingRequests) ? project.pendingRequests : [];
    const exists = project.pendingRequests.find(r => r && r.username === username);
    if (exists) {
        return res.json({ message: '已提交申请，待审批' });
    }
    project.pendingRequests.push({ username, requestedBy: username, requestedAt: new Date().toISOString() });

    if (writeJsonFile(projectsFile, projects)) {
        try {
            (project.boards || []).forEach(boardName => {
                broadcastToBoard(projectId, boardName, {
                    type: 'join-request',
                    projectId,
                    username,
                    requestedBy: username
                });
            });
        } catch (e) { console.warn('Broadcast join-request warning:', e.message); }
        res.json({ message: '已提交申请，待审批' });
    } else {
        res.status(500).json({ message: '提交申请失败' });
    }
});

app.get('/api/project-boards/:projectId', (req, res) => {
    const { projectId } = req.params;

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    res.json({
        inviteCode: project.inviteCode,
        members: project.members,
        boards: project.boards,
        archivedBoards: Array.isArray(project.archivedBoards) ? project.archivedBoards : [],
        owner: project.owner,
        boardOwners: project.boardOwners || {},
        pendingRequests: project.pendingRequests || [],
        pendingInvites: project.pendingInvites || []
    });
});

// User background APIs (per-user board wallpaper)
app.get('/api/user-background/:username', (req, res) => {
    const { username } = req.params;
    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});
    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });
    const url = (user.backgroundUrl && typeof user.backgroundUrl === 'string' && user.backgroundUrl.trim())
        ? user.backgroundUrl
        : '';
    return res.json({ url });
});

// Set default background for user
app.post('/api/user-background/set-default', (req, res) => {
    const { username, index } = req.body || {};
    if (!username) return res.status(400).json({ message: '缺少参数' });
    try {
        const usersFile = path.join(dataDir, 'users.json');
        const users = readJsonFile(usersFile, {});
        const user = users[username];
        if (!user) return res.status(404).json({ message: '用户不存在' });
        const defaults = getDefaultBackgrounds();
        const i = (typeof index === 'number' && index >= 0 && index < defaults.length) ? index : 0;
        user.backgroundUrl = defaults[i] || DEFAULT_BACKGROUND_URL || '';
        writeJsonFile(usersFile, users);
        return res.json({ url: user.backgroundUrl });
    } catch (e) {
        return res.status(500).json({ message: '设置失败' });
    }
});

// Provide available default backgrounds
app.get('/api/default-backgrounds', (req, res) => {
    try {
        return res.json({ defaults: getDefaultBackgrounds() });
    } catch (_) {
        return res.json({ defaults: [] });
    }
});

app.post('/api/user-background/upload', (req, res) => {
    const { username, imageData } = req.body || {};
    if (!username || !imageData || typeof imageData !== 'string') {
        return res.status(400).json({ message: '缺少参数' });
    }
    try {
        const usersFile = path.join(dataDir, 'users.json');
        const users = readJsonFile(usersFile, {});
        const user = users[username];
        if (!user) return res.status(404).json({ message: '用户不存在' });

        // parse data URL
        const m = imageData.match(/^data:(image\/(png|jpeg|jpg|webp));base64,(.+)$/i);
        if (!m) return res.status(400).json({ message: '图片格式不支持，请上传 PNG/JPEG/WEBP' });
        const mime = m[1].toLowerCase();
        const ext = mime.includes('png') ? 'png' : (mime.includes('webp') ? 'webp' : 'jpg');
        const b64 = m[3];
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ message: '图片过大（<=10MB）' });

        // save file with stable per-user name; cleanup previous different extensions
        const exts = ['png','jpg','jpeg','webp'];
        try {
            exts.forEach(x => {
                const p = path.join(wallpapersDir, `${username}.${x}`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });
        } catch(_){}
        const fname = `${username}.${ext}`;
        const filePath = path.join(wallpapersDir, fname);
        fs.writeFileSync(filePath, buf);

        // persist url on user profile
        const url = `/uploads/wallpapers/${fname}`;
        user.backgroundUrl = url;
        writeJsonFile(usersFile, users);

        return res.json({ url });
    } catch (e) {
        console.error('Upload background error:', e);
        return res.status(500).json({ message: '上传失败' });
    }
});

app.post('/api/user-background/clear', (req, res) => {
    const { username } = req.body || {};
    if (!username) return res.status(400).json({ message: '缺少参数' });
    try {
        const usersFile = path.join(dataDir, 'users.json');
        const users = readJsonFile(usersFile, {});
        const user = users[username];
        if (!user) return res.status(404).json({ message: '用户不存在' });

        // remove any stored files for all possible extensions
        try {
            ['png','jpg','jpeg','webp'].forEach(x => {
                const p = path.join(wallpapersDir, `${username}.${x}`);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            });
        } catch(_){}
        delete user.backgroundUrl;
        writeJsonFile(usersFile, users);
        return res.json({ success: true });
    } catch (e) {
        console.error('Clear background error:', e);
        return res.status(500).json({ message: '清除失败' });
    }
});

// 新增：获取项目的待加入请求（兼容前端 /api/join-requests/:projectId 调用）
app.get('/api/join-requests/:projectId', (req, res) => {
    const { projectId } = req.params;
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    const requests = Array.isArray(project.pendingRequests) ? project.pendingRequests : [];
    return res.json({ requests });
});

// 新增：重命名项目API
app.post('/api/rename-project', (req, res) => {
    const { projectId, newName, actor } = req.body;

    if (!projectId || !newName) {
        return res.status(400).json({ message: '项目ID和新名称不能为空' });
    }

    const sanitized = String(newName).trim();
    if (!sanitized) {
        return res.status(400).json({ message: '新名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    // 权限校验：只有项目所有者可以重命名项目
    if (!actor || actor !== project.owner) {
        return res.status(403).json({ message: '只有项目所有者可以重命名项目' });
    }

    project.name = sanitized;

    if (writeJsonFile(projectsFile, projects)) {
        // 同步更新所有用户的星标中的项目名称
        try {
            const usersFile = path.join(dataDir, 'users.json');
            const users = readJsonFile(usersFile, {});
            let changed = false;
            for (const [uname, u] of Object.entries(users)) {
                if (!u || !Array.isArray(u.stars)) continue;
                u.stars.forEach(s => { if (s && s.projectId === projectId) { s.projectName = sanitized; changed = true; } });
            }
            if (changed) writeJsonFile(usersFile, users);
        } catch (e) { console.warn('Update stars projectName warning:', e && e.message ? e.message : e); }
        // 通知该项目下所有看板的参与者
        try {
            (project.boards || []).forEach(boardName => {
                broadcastToBoard(projectId, boardName, {
                    type: 'project-renamed',
                    projectId,
                    newName: sanitized
                });
            });
        } catch (e) {
            console.warn('Broadcast project-renamed warning:', e.message);
        }
        return res.json({ message: '项目重命名成功' });
    } else {
        return res.status(500).json({ message: '保存项目数据失败' });
    }
});

// 新增：项目成员管理 - 添加成员
app.post('/api/add-project-member', (req, res) => {
    const { projectId, username } = req.body || {};
    if (!projectId || !username) {
        return res.status(400).json({ message: '项目ID和用户名不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');

    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    const user = users[username];
    if (!user) return res.status(404).json({ message: '用户不存在' });

    project.members = Array.isArray(project.members) ? project.members : [];
    if (project.members.includes(username)) {
        return res.status(400).json({ message: '该用户已是项目成员' });
    }

    project.members.push(username);
    user.projects = Array.isArray(user.projects) ? user.projects : [];
    if (!user.projects.includes(projectId)) user.projects.push(projectId);

    const ok = writeJsonFile(projectsFile, projects) && writeJsonFile(usersFile, users);
    if (!ok) return res.status(500).json({ message: '保存失败' });

    return res.json({ message: '已添加成员', members: project.members });
});

// 新增：项目成员管理 - 移除成员（不能移除所有者）
app.post('/api/remove-project-member', (req, res) => {
    const { projectId, username, actor } = req.body || {};
    if (!projectId || !username) {
        return res.status(400).json({ message: '项目ID和用户名不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');

    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    // 权限：只有所有者可以移除他人；非所有者只能移除自己
    const isOwner = project.owner && actor === project.owner;
    const isSelf = actor && username && actor === username;
    if (!isOwner && !isSelf) {
        return res.status(403).json({ message: '无权限移除其他成员' });
    }

    if (project.owner && project.owner === username) {
        return res.status(400).json({ message: '无法移除项目所有者' });
    }

    project.members = Array.isArray(project.members) ? project.members : [];
    const idx = project.members.indexOf(username);
    if (idx === -1) return res.status(404).json({ message: '该用户不在项目中' });

    project.members.splice(idx, 1);

    // 从用户的项目列表中移除
    const user = users[username];
    if (user && Array.isArray(user.projects)) {
        users[username].projects = user.projects.filter(id => id !== projectId);
    }
    // 同时清理该用户在该项目下的星标
    if (user && Array.isArray(user.stars)) {
        users[username].stars = user.stars.filter(s => s && s.projectId !== projectId);
    }
    // 同时清理该用户在该项目下的置前
    if (user && Array.isArray(user.pinnedProjects)) {
        users[username].pinnedProjects = user.pinnedProjects.filter(id => id !== projectId);
    }

    const ok = writeJsonFile(projectsFile, projects) && writeJsonFile(usersFile, users);
    if (!ok) return res.status(500).json({ message: '保存失败' });

    // 广播成员移除事件到该项目下所有看板
    try {
        (project.boards || []).forEach(boardName => {
            broadcastToBoard(projectId, boardName, {
                type: 'member-removed',
                projectId,
                username
            });
        });
    } catch (e) {
        console.warn('Broadcast member-removed warning:', e && e.message ? e.message : e);
    }

    return res.json({ message: '已移除成员', members: project.members });
});

// 新增：项目成员管理 - 重置邀请码
app.post('/api/regenerate-invite-code', (req, res) => {
    const { projectId, actor } = req.body || {};
    if (!projectId) return res.status(400).json({ message: '项目ID不能为空' });

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    if (!actor || actor !== project.owner) {
        return res.status(403).json({ message: '只有所有者可以重置邀请码' });
    }

    project.inviteCode = generateInviteCode();

    if (!writeJsonFile(projectsFile, projects)) {
        return res.status(500).json({ message: '保存失败' });
    }

    return res.json({ message: '邀请码已重置', inviteCode: project.inviteCode });
});

// 新增：删除项目API
app.delete('/api/delete-project', (req, res) => {
    const { projectId, actor } = req.body || {};

    if (!projectId) {
        return res.status(400).json({ message: '项目ID不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const usersFile = path.join(dataDir, 'users.json');

    const projects = readJsonFile(projectsFile, {});
    const users = readJsonFile(usersFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }
    if (!actor || actor !== project.owner) {
        return res.status(403).json({ message: '只有所有者可以删除项目' });
    }

    try {
        // 广播项目删除（通知所有看板参与者）
        try {
            (project.boards || []).forEach(boardName => {
                broadcastToBoard(projectId, boardName, {
                    type: 'project-deleted',
                    projectId
                });
            });
        } catch (e) {
            console.warn('Broadcast project-deleted warning:', e.message);
        }

        // 删除所有看板文件
        (project.boards || []).forEach(boardName => {
            const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
            if (fs.existsSync(boardFile)) {
                try { fs.unlinkSync(boardFile); } catch (e) { console.warn('Remove board file warning:', boardFile, e.message); }
            }
        });

        // 删除备份文件
        try {
            const prefix = `${projectId}_`;
            const files = fs.readdirSync(backupsDir).filter(f => f.startsWith(prefix));
            files.forEach(f => {
                try { fs.unlinkSync(path.join(backupsDir, f)); } catch (e) { console.warn('Remove backup warning:', f, e.message); }
            });
        } catch (e) {
            console.warn('Clean backups warning:', e.message);
        }

        // 从所有用户中移除此项目，并清理星标
        for (const [username, user] of Object.entries(users)) {
            if (Array.isArray(user.projects)) {
                users[username].projects = user.projects.filter(id => id !== projectId);
            }
            if (Array.isArray(user.stars)) {
                users[username].stars = user.stars.filter(s => s && s.projectId !== projectId);
            }
            if (Array.isArray(user.pinnedProjects)) {
                users[username].pinnedProjects = user.pinnedProjects.filter(id => id !== projectId);
            }
            // 清理项目内的置前看板顺序
            if (user && user.pinnedBoards && Array.isArray(user.pinnedBoards[projectId])) {
                delete users[username].pinnedBoards[projectId];
            }
            // 清理星标置前顺序中属于该项目的条目
            if (user && Array.isArray(user.pinnedStarBoards)) {
                users[username].pinnedStarBoards = user.pinnedStarBoards.filter(k => !String(k).startsWith(projectId + '::'));
            }
        }

        // 从项目列表中删除
        delete projects[projectId];

        if (writeJsonFile(projectsFile, projects) && writeJsonFile(usersFile, users)) {
            return res.json({ message: '项目删除成功' });
        } else {
            return res.status(500).json({ message: '删除项目失败：无法保存数据' });
        }
    } catch (error) {
        console.error('Delete project error:', error);
        return res.status(500).json({ message: '删除项目失败' });
    }
});

app.post('/api/create-board', (req, res) => {
    const { projectId, boardName, actor } = req.body || {};

    if (!projectId || !boardName) {
        return res.status(400).json({ message: '项目ID和看板名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    // 只有项目所有者或申请者自身是所有者（创建者）
    if (!actor || (actor !== project.owner && !project.members.includes(actor))) {
        return res.status(403).json({ message: '无权限创建看板' });
    }

    project.boardOwners = project.boardOwners || {};

    if (project.boards.includes(boardName)) {
        return res.status(400).json({ message: '看板名称已存在' });
    }

    // 创建看板文件
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    const defaultBoard = {
        archived: [],
        // initialize empty dynamic lists (no default columns)
        lists: { listIds: [], lists: {} }
    };

    project.boards.unshift(boardName);
    project.boardOwners[boardName] = actor || project.owner;

    if (writeJsonFile(projectsFile, projects) && writeJsonFile(boardFile, defaultBoard)) {
        res.json({ message: '看板创建成功', owner: project.boardOwners[boardName] });
    } else {
        res.status(500).json({ message: '创建看板失败' });
    }
});

// 删除看板API
app.delete('/api/delete-board', (req, res) => {
    const { projectId, boardName, actor } = req.body || {};

    if (!projectId || !boardName) {
        return res.status(400).json({ message: '项目ID和看板名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }
    const isProjectOwner = actor && actor === project.owner;
    const isBoardOwner = project.boardOwners && actor && project.boardOwners[boardName] === actor;
    if (!isProjectOwner && !isBoardOwner) {
        return res.status(403).json({ message: '只有项目所有者或看板创建者可以删除看板' });
    }

    const boardIndex = project.boards.indexOf(boardName);
    if (boardIndex === -1) {
        // allow deletion from archived list as well
        project.archivedBoards = Array.isArray(project.archivedBoards) ? project.archivedBoards : [];
        const aidx = project.archivedBoards.indexOf(boardName);
        if (aidx === -1) {
            return res.status(404).json({ message: '看板不存在' });
        }
        // remove from archived list and proceed to delete file
        project.archivedBoards.splice(aidx, 1);
    }

    // 删除看板文件
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    try {
        if (fs.existsSync(boardFile)) {
            fs.unlinkSync(boardFile);
        }

        // 从项目中移除看板（若存在于 boards 列表）
        if (boardIndex !== -1) {
            project.boards.splice(boardIndex, 1);
        }

        if (writeJsonFile(projectsFile, projects)) {
            // 同步清理所有用户在该项目该看板的星标
            try {
                const usersFile = path.join(dataDir, 'users.json');
                const users = readJsonFile(usersFile, {});
                let changed = false;
                for (const [uname, u] of Object.entries(users)) {
                    if (!u || !Array.isArray(u.stars)) continue;
                    const next = u.stars.filter(s => !(s && s.projectId === projectId && s.boardName === boardName));
                    if (next.length !== u.stars.length) { u.stars = next; changed = true; }
                    // 同步清理置前的看板
                    if (u && u.pinnedBoards && Array.isArray(u.pinnedBoards[projectId])) {
                        const before = u.pinnedBoards[projectId].length;
                        u.pinnedBoards[projectId] = u.pinnedBoards[projectId].filter(n => n !== boardName);
                        if (u.pinnedBoards[projectId].length !== before) changed = true;
                    }
                    // 清理星标列表的置前顺序
                    if (u && Array.isArray(u.pinnedStarBoards)) {
                        const before2 = u.pinnedStarBoards.length;
                        u.pinnedStarBoards = u.pinnedStarBoards.filter(k => k !== `${projectId}::${boardName}`);
                        if (u.pinnedStarBoards.length !== before2) changed = true;
                    }
                }
                if (changed) writeJsonFile(usersFile, users);
            } catch (e) { console.warn('Clean stars on board delete warning:', e && e.message ? e.message : e); }
            res.json({ message: '看板删除成功' });
        } else {
            res.status(500).json({ message: '删除看板失败' });
        }
    } catch (error) {
        console.error('Delete board error:', error);
        res.status(500).json({ message: '删除看板失败' });
    }
});

// 新增：重命名看板API
app.post('/api/rename-board', (req, res) => {
    const { projectId, oldName, newName, actor } = req.body || {};

    if (!projectId || !oldName || !newName) {
        return res.status(400).json({ message: '项目ID、旧名称和新名称不能为空' });
    }

    const sanitizedNew = String(newName).trim();
    if (!sanitizedNew) {
        return res.status(400).json({ message: '新名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const usersFile = path.join(dataDir, 'users.json');
    const projects = readJsonFile(projectsFile, {});
    const users = readJsonFile(usersFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    const idx = project.boards.indexOf(oldName);
    if (idx === -1) {
        return res.status(404).json({ message: '原看板不存在' });
    }

    const isProjectOwner = actor && actor === project.owner;
    const isBoardOwner = project.boardOwners && actor && project.boardOwners[oldName] === actor;
    if (!isProjectOwner && !isBoardOwner) {
        return res.status(403).json({ message: '只有项目所有者或看板创建者可以重命名看板' });
    }

    if (project.boards.includes(sanitizedNew)) {
        return res.status(400).json({ message: '新看板名称已存在' });
    }

    const oldFile = path.join(dataDir, `${projectId}_${oldName}.json`);
    const newFile = path.join(dataDir, `${projectId}_${sanitizedNew}.json`);

    try {
        // 如果旧文件存在则重命名，否则创建空文件
        if (fs.existsSync(oldFile)) {
            fs.renameSync(oldFile, newFile);
        } else {
            writeJsonFile(newFile, readJsonFile(oldFile, { archived: [], lists: { listIds: [], lists: {} } }));
        }

        // 更新项目中的名称
        project.boards[idx] = sanitizedNew;
        if (project.boardOwners && project.boardOwners[oldName]) {
            project.boardOwners[sanitizedNew] = project.boardOwners[oldName];
            delete project.boardOwners[oldName];
        }

        if (!writeJsonFile(projectsFile, projects)) {
            // 回滚文件名
            try { if (fs.existsSync(newFile)) fs.renameSync(newFile, oldFile); } catch (e) {}
            return res.status(500).json({ message: '保存项目数据失败' });
        }

        // 同步更新所有用户星标中的看板名称
        try {
            let changed = false;
            for (const [uname, u] of Object.entries(users)) {
                if (!u || !Array.isArray(u.stars)) continue;
                u.stars.forEach(s => { if (s && s.projectId === projectId && s.boardName === oldName) { s.boardName = sanitizedNew; changed = true; } });
                // 同步更新置前列表中的看板名称
                if (u && u.pinnedBoards && Array.isArray(u.pinnedBoards[projectId])) {
                    const arr = u.pinnedBoards[projectId];
                    const i = arr.indexOf(oldName);
                    if (i !== -1) { arr[i] = sanitizedNew; changed = true; }
                }
                // 更新星标置前顺序中的键
                if (u && Array.isArray(u.pinnedStarBoards)) {
                    const oldKey = `${projectId}::${oldName}`;
                    const i2 = u.pinnedStarBoards.indexOf(oldKey);
                    if (i2 !== -1) { u.pinnedStarBoards[i2] = `${projectId}::${sanitizedNew}`; changed = true; }
                }
            }
            if (changed) writeJsonFile(usersFile, users);
        } catch (e) { console.warn('Update stars boardName warning:', e && e.message ? e.message : e); }

        // 通知旧看板参与者
        broadcastToBoard(projectId, oldName, {
            type: 'board-renamed',
            projectId,
            oldName,
            newName: sanitizedNew
        });

        res.json({ message: '重命名成功' });
    } catch (error) {
        console.error('Rename board error:', error);
        return res.status(500).json({ message: '重命名失败' });
    }
});

// 新增：移动看板到其他项目
app.post('/api/move-board', (req, res) => {
    const { fromProjectId, toProjectId, boardName, actor } = req.body || {};

    if (!fromProjectId || !toProjectId || !boardName) {
        return res.status(400).json({ message: '缺少必要参数' });
    }
    if (fromProjectId === toProjectId) {
        return res.status(400).json({ message: '目标项目不能与源项目相同' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const usersFile = path.join(dataDir, 'users.json');
    const projects = readJsonFile(projectsFile, {});
    const users = readJsonFile(usersFile, {});

    const fromProject = projects[fromProjectId];
    const toProject = projects[toProjectId];
    if (!fromProject || !toProject) {
        return res.status(404).json({ message: '源项目或目标项目不存在' });
    }

    const idx = Array.isArray(fromProject.boards) ? fromProject.boards.indexOf(boardName) : -1;
    if (idx === -1) {
        return res.status(404).json({ message: '源项目中不存在该看板' });
    }

    // 权限：源项目所有者或该看板的创建者，且必须是目标项目成员
    const isSourceOwner = actor && actor === fromProject.owner;
    const isBoardOwner = fromProject.boardOwners && actor && fromProject.boardOwners[boardName] === actor;
    const isDestMember = Array.isArray(toProject.members) && toProject.members.includes(actor);
    if (!isSourceOwner && !isBoardOwner) {
        return res.status(403).json({ message: '只有源项目所有者或看板创建者可以移动看板' });
    }
    if (!isDestMember) {
        return res.status(403).json({ message: '只能移动到你参与的目标项目' });
    }

    if (Array.isArray(toProject.boards) && toProject.boards.includes(boardName)) {
        return res.status(400).json({ message: '目标项目已存在同名看板' });
    }

    const oldFile = path.join(dataDir, `${fromProjectId}_${boardName}.json`);
    const newFile = path.join(dataDir, `${toProjectId}_${boardName}.json`);

    try {
        // 移动数据文件（重命名）
        if (fs.existsSync(oldFile)) {
            fs.renameSync(oldFile, newFile);
        } else {
            // 源文件不存在则创建空板数据（不含默认列表）
            writeJsonFile(newFile, { archived: [], lists: { listIds: [], lists: {} } });
        }

        // 同步重命名已有的备份文件前缀
        try {
            const oldPrefix = `${fromProjectId}_${boardName}_`;
            const newPrefix = `${toProjectId}_${boardName}_`;
            const files = fs.readdirSync(backupsDir).filter(f => f.startsWith(oldPrefix));
            files.forEach(f => {
                try {
                    fs.renameSync(path.join(backupsDir, f), path.join(backupsDir, f.replace(oldPrefix, newPrefix)));
                } catch (e) { console.warn('Rename backup on move warning:', f, e && e.message ? e.message : e); }
            });
        } catch (e) { console.warn('List backups on move warning:', e && e.message ? e.message : e); }

        // 从源项目移除并加入目标项目
        fromProject.boards.splice(idx, 1);
        fromProject.boardOwners = fromProject.boardOwners || {};
        const owner = fromProject.boardOwners[boardName] || fromProject.owner;
        if (!toProject.boards) toProject.boards = [];
        if (!toProject.boardOwners) toProject.boardOwners = {};
        toProject.boards.unshift(boardName);
        toProject.boardOwners[boardName] = owner;
        delete fromProject.boardOwners[boardName];

        if (!writeJsonFile(projectsFile, projects)) {
            // 回滚文件
            try { if (fs.existsSync(newFile)) fs.renameSync(newFile, oldFile); } catch (e) {}
            return res.status(500).json({ message: '保存项目数据失败' });
        }

        // 更新所有用户的星标（项目ID与项目名称）
        try {
            let changed = false;
            for (const [uname, u] of Object.entries(users)) {
                if (!u || !Array.isArray(u.stars)) continue;
                u.stars.forEach(s => {
                    if (s && s.projectId === fromProjectId && s.boardName === boardName) {
                        s.projectId = toProjectId;
                        s.projectName = toProject.name || s.projectName || '';
                        changed = true;
                    }
                });
                // 同步清理源项目中的置前条目
                if (u && u.pinnedBoards && Array.isArray(u.pinnedBoards[fromProjectId])) {
                    const before = u.pinnedBoards[fromProjectId].length;
                    u.pinnedBoards[fromProjectId] = u.pinnedBoards[fromProjectId].filter(n => n !== boardName);
                    if (u.pinnedBoards[fromProjectId].length !== before) changed = true;
                }
                // 更新星标置前顺序键的项目ID
                if (u && Array.isArray(u.pinnedStarBoards)) {
                    const oldKey = `${fromProjectId}::${boardName}`;
                    const i2 = u.pinnedStarBoards.indexOf(oldKey);
                    if (i2 !== -1) { u.pinnedStarBoards[i2] = `${toProjectId}::${boardName}`; changed = true; }
                }
            }
            if (changed) writeJsonFile(usersFile, users);
        } catch (e) { console.warn('Update stars on move warning:', e && e.message ? e.message : e); }

        // 通知旧看板参与者重连到新项目
        try {
            broadcastToBoard(fromProjectId, boardName, {
                type: 'board-moved',
                fromProjectId,
                toProjectId,
                toProjectName: toProject.name || '',
                boardName
            });
        } catch (e) { console.warn('Broadcast board-moved warning:', e && e.message ? e.message : e); }

        return res.json({ message: '移动成功', toProjectId, toProjectName: toProject.name || '' });
    } catch (error) {
        console.error('Move board error:', error);
        // 尝试回滚文件名
        try { if (fs.existsSync(newFile)) fs.renameSync(newFile, oldFile); } catch (e) {}
        return res.status(500).json({ message: '移动失败' });
    }
});

// 看板数据API
app.get('/api/board/:projectId/:boardName', async (req, res) => {
    const { projectId, boardName } = req.params;
    const decodedBoardName = decodeURIComponent(boardName);

    const { data: boardData } = await withBoardLock(projectId, decodedBoardName, (bd) => {
        // Ensure lists metadata exists; if missing, infer from legacy arrays, otherwise keep empty
        if (!bd.lists || !Array.isArray(bd.lists.listIds) || !bd.lists.lists) {
            bd.lists = inferListsFromArrays(bd);
        }
        ensureListStatusArrays(bd);
        return bd;
    });

    res.json(boardData);
});

// 归档卡片（HTTP 兜底）
app.post('/api/archive-card', async (req, res) => {
    const { projectId, boardName, cardId, fromStatus } = req.body || {};
    if (!projectId || !boardName || !cardId) {
        return res.status(400).json({ message: '参数不完整' });
    }

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        let actualStatus = (fromStatus && Array.isArray(bd[fromStatus])) ? fromStatus : null;
        let cardIndex = -1;

        if (actualStatus) {
            cardIndex = bd[actualStatus].findIndex(card => card.id === cardId);
        }

        if (cardIndex === -1) {
            const statuses = Object.keys(bd).filter(k => Array.isArray(bd[k]) && k !== 'archived');
            for (const st of statuses) {
                const idx = bd[st].findIndex(card => card.id === cardId);
                if (idx !== -1) {
                    actualStatus = st;
                    cardIndex = idx;
                    break;
                }
            }
        }

        if (!actualStatus || cardIndex === -1) {
            return { data: bd, result: { changed: false } };
        }

        const card = bd[actualStatus].splice(cardIndex, 1)[0];
        if (!bd.archived) {
            bd.archived = [];
        }
        card.archivedFrom = actualStatus;
        card.archivedAt = Date.now();
        bd.archived.push(card);
        return { data: bd, result: { changed: true } };
    });

    if (!success) {
        return res.status(500).json({ message: '归档失败' });
    }

    if (result && result.changed) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }

    return res.json({ success: true });
});

// 还原卡片（HTTP 兜底）
app.post('/api/restore-card', async (req, res) => {
    const { projectId, boardName, cardId } = req.body || {};
    if (!projectId || !boardName || !cardId) {
        return res.status(400).json({ message: '参数不完整' });
    }

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        if (!Array.isArray(bd.archived)) {
            return { data: bd, result: { changed: false } };
        }
        const cardIndex = bd.archived.findIndex(card => card.id === cardId);
        if (cardIndex === -1) {
            return { data: bd, result: { changed: false } };
        }

        const card = bd.archived.splice(cardIndex, 1)[0];
        let targetStatus = (card && card.archivedFrom) ? card.archivedFrom : null;
        const listMetas = (bd.lists && bd.lists.lists) ? Object.values(bd.lists.lists) : [];
        const metaStatuses = listMetas.map(m => m && m.status).filter(Boolean);

        if (!targetStatus || targetStatus === 'archived' || (metaStatuses.length && !metaStatuses.includes(targetStatus))) {
            if (metaStatuses.includes('done')) {
                targetStatus = 'done';
            } else if (metaStatuses.length) {
                targetStatus = metaStatuses[metaStatuses.length - 1];
            } else if (Array.isArray(bd.done)) {
                targetStatus = 'done';
            } else {
                const fallback = Object.keys(bd).find(k => Array.isArray(bd[k]) && k !== 'archived');
                targetStatus = fallback || 'done';
            }
        }

        if (!Array.isArray(bd[targetStatus])) bd[targetStatus] = [];
        if (!bd.lists || !Array.isArray(bd.lists.listIds) || !bd.lists.lists) {
            bd.lists = { listIds: [], lists: {} };
        }
        if (targetStatus && !metaStatuses.includes(targetStatus)) {
            const id = targetStatus;
            if (!bd.lists.listIds.includes(id)) bd.lists.listIds.push(id);
            bd.lists.lists[id] = bd.lists.lists[id] || { id, title: id === 'done' ? '已完成' : id, pos: bd.lists.listIds.length - 1, status: targetStatus };
        }

        delete card.archivedFrom;
        delete card.archivedAt;
        bd[targetStatus].push(card);
        return { data: bd, result: { changed: true } };
    });

    if (!success) {
        return res.status(500).json({ message: '还原失败' });
    }

    if (result && result.changed) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }

    return res.json({ success: true });
});

// 归档卡组（HTTP 兜底）
app.post('/api/archive-list', async (req, res) => {
    const { projectId, boardName, status } = req.body || {};
    if (!projectId || !boardName || !status) {
        return res.status(400).json({ message: '参数不完整' });
    }

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        const list = Array.isArray(bd[status]) ? bd[status] : [];
        if (!list.length) {
            return { data: bd, result: { changed: false, count: 0 } };
        }
        if (!bd.archived) bd.archived = [];
        const now = Date.now();
        list.forEach(card => {
            if (!card) return;
            card.archivedFrom = status;
            card.archivedAt = now;
            bd.archived.push(card);
        });
        bd[status] = [];
        return { data: bd, result: { changed: true, count: list.length } };
    });

    if (!success) {
        return res.status(500).json({ message: '归档失败' });
    }

    if (result && result.changed) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }

    return res.json({ success: true, count: result ? result.count : 0 });
});

// 删除卡片（HTTP 兜底）
app.post('/api/delete-card', async (req, res) => {
    const { projectId, boardName, cardId } = req.body || {};
    if (!projectId || !boardName || !cardId) {
        return res.status(400).json({ message: '参数不完整' });
    }

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        let found = false;
        for (const status of Object.keys(bd)) {
            if (!Array.isArray(bd[status])) continue;
            const cardIndex = bd[status].findIndex(card => card.id === cardId);
            if (cardIndex !== -1) {
                bd[status].splice(cardIndex, 1);
                found = true;
                break;
            }
        }
        return { data: bd, result: { changed: found } };
    });

    if (!success) {
        return res.status(500).json({ message: '删除失败' });
    }

    if (result && result.changed) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }

    return res.json({ success: true });
});

// 保存列表元数据（HTTP 兜底）
app.post('/api/save-lists', async (req, res) => {
    const { projectId, boardName, lists } = req.body || {};
    if (!projectId || !boardName || !lists || !Array.isArray(lists.listIds) || typeof lists.lists !== 'object') {
        return res.status(400).json({ message: '无效的列表数据' });
    }

    const { success, data: boardData } = await withBoardLock(projectId, boardName, (bd) => {
        const newStatuses = new Set();
        for (const listId of lists.listIds) {
            const list = lists.lists[listId];
            if (list && list.status) {
                newStatuses.add(list.status);
            }
        }

        const oldStatuses = new Set();
        if (bd.lists && bd.lists.listIds && bd.lists.lists) {
            for (const listId of bd.lists.listIds) {
                const list = bd.lists.lists[listId];
                if (list && list.status) {
                    oldStatuses.add(list.status);
                }
            }
        }

        for (const oldStatus of oldStatuses) {
            if (!newStatuses.has(oldStatus) && oldStatus !== 'archived') {
                delete bd[oldStatus];
            }
        }

        bd.lists = lists;
        ensureListStatusArrays(bd);
        return bd;
    });

    if (!success) {
        return res.status(500).json({ message: '保存失败' });
    }

    broadcastToBoard(projectId, boardName, {
        type: 'board-update',
        projectId,
        boardName,
        board: boardData
    });

    return res.json({ success: true });
});

// 添加卡片（HTTP 兜底，用于刷新过快/WS 不稳定）
app.post('/api/add-card', async (req, res) => {
    const { projectId, boardName, status, card, position } = req.body || {};
    if (!projectId || !boardName || !status || !card || !card.id) {
        return res.status(400).json({ message: '参数不完整' });
    }

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        const exists = Object.keys(bd).some(key => Array.isArray(bd[key]) && bd[key].some(c => c && c.id === card.id));
        if (exists) {
            return { data: bd, result: { changed: false } };
        }
        if (!Array.isArray(bd[status])) {
            bd[status] = [];
        }
        if (position === 'top') {
            bd[status].unshift(card);
        } else {
            bd[status].push(card);
        }
        return { data: bd, result: { changed: true } };
    });

    if (!success) {
        return res.status(500).json({ message: '保存失败' });
    }

    if (result && result.changed) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }

    return res.json({ success: true });
});

// 导出API
// 导出 Markdown（详细格式，包含描述、创建者等元数据）
app.get('/api/export/:projectId/:boardName', (req, res) => {
    const { projectId, boardName } = req.params;
    const decodedBoardName = decodeURIComponent(boardName);
    const boardFile = path.join(dataDir, `${projectId}_${decodedBoardName}.json`);

    const boardData = readJsonFile(boardFile, {
        archived: [],
        lists: { listIds: [], lists: {} }
    });

    let markdown = `# ${decodedBoardName}\n\n`;

    // If lists metadata exists, export in that order and with custom titles
    let sections = [];
    if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
        sections = boardData.lists.listIds
            .map(id => boardData.lists.lists[id])
            .filter(meta => meta && meta.status && meta.status !== 'archived')
            .sort((a,b)=> (a.pos||0) - (b.pos||0))
            .map(meta => ({ key: meta.status, title: meta.title || meta.status }));
        // Append archived at the end if present
        sections.push({ key: 'archived', title: '📁 归档' });
    } else {
        // Fallback to legacy fixed sections
        sections = [
            { key: 'todo', title: '📋 待办' },
            { key: 'doing', title: '🔄 进行中' },
            { key: 'done', title: '✅ 已完成' },
            { key: 'archived', title: '📁 归档' }
        ];
    }

    sections.forEach(section => {
        const cards = Array.isArray(boardData[section.key]) ? boardData[section.key] : [];
        markdown += `## ${section.title}\n\n`;

        if (cards.length === 0) {
            markdown += '_暂无任务_\n\n';
        } else {
            cards.forEach((card, index) => {
                markdown += `### ${index + 1}. ${card.title}\n\n`;
                if (card.description) {
                    markdown += `**描述:** ${card.description}\n\n`;
                }
                if (card.assignee) {
                    markdown += `**分配给:** ${card.assignee}\n\n`;
                }
                if (card.deadline) {
                    markdown += `**截止日期:** ${card.deadline}\n\n`;
                }
                markdown += `**创建者:** ${card.author} | **创建时间:** ${new Date(card.created).toLocaleString()}\n\n`;
                markdown += '---\n\n';
            });
        }
    });

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${decodedBoardName}.md"`);
    res.send(markdown);
});

/**
 * TaskPaper 风格导出（简洁格式，适合快速编辑）
 *
 * 格式示例：
 * ```
 * 待办:
 *
 * - 完成登录功能 @张三 @due(2024-03-15)
 * - 修复 bug
 *
 * 进行中:
 *
 * - 代码审查 @王五
 * ```
 */
app.get('/api/export-taskpaper/:projectId/:boardName', (req, res) => {
    const { projectId, boardName } = req.params;
    const decodedBoardName = decodeURIComponent(boardName);
    const boardFile = path.join(dataDir, `${projectId}_${decodedBoardName}.json`);

    const boardData = readJsonFile(boardFile, {
        archived: [],
        lists: { listIds: [], lists: {} }
    });

    let content = '';

    // If lists metadata exists, export in that order and with custom titles
    let sections = [];
    if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
        sections = boardData.lists.listIds
            .map(id => boardData.lists.lists[id])
            .filter(meta => meta && meta.status && meta.status !== 'archived')
            .sort((a,b)=> (a.pos||0) - (b.pos||0))
            .map(meta => ({ key: meta.status, title: meta.title || meta.status }));
        // Append archived at the end if present
        const archivedCards = Array.isArray(boardData['archived']) ? boardData['archived'] : [];
        if (archivedCards.length > 0) {
            sections.push({ key: 'archived', title: '归档' });
        }
    } else {
        // Fallback to legacy fixed sections
        sections = [
            { key: 'todo', title: '待办' },
            { key: 'doing', title: '进行中' },
            { key: 'done', title: '已完成' }
        ];
        const archivedCards = Array.isArray(boardData['archived']) ? boardData['archived'] : [];
        if (archivedCards.length > 0) {
            sections.push({ key: 'archived', title: '归档' });
        }
    }

    sections.forEach((section, sectionIndex) => {
        const cards = Array.isArray(boardData[section.key]) ? boardData[section.key] : [];

        // 列名后加冒号
        content += `${section.title}:\n\n`;

        cards.forEach(card => {
            let line = `- ${card.title}`;

            // 添加负责人 @标签
            if (card.assignee) {
                line += ` @${card.assignee}`;
            }

            // 添加截止日期 @due(日期)
            if (card.deadline) {
                line += ` @due(${card.deadline})`;
            }

            content += line + '\n';
        });

        // 列之间空一行
        if (sectionIndex < sections.length - 1) {
            content += '\n';
        }
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${decodedBoardName}.taskpaper"`);
    res.send(content);
});

// 导出JSON API
app.get('/api/export-json/:projectId/:boardName', (req, res) => {
    const { projectId, boardName } = req.params;
    const decodedBoardName = decodeURIComponent(boardName);
    const boardFile = path.join(dataDir, `${projectId}_${decodedBoardName}.json`);

    const boardData = readJsonFile(boardFile, {
        archived: [],
        lists: { listIds: [], lists: {} }
    });

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${decodedBoardName}.json"`);
    res.send(JSON.stringify(boardData));
});

// ============ 个人完整数据导出/导入 ============

/**
 * 导出用户的所有项目数据（完整备份）
 * GET /api/user-backup/:username
 */
app.get('/api/user-backup/:username', (req, res) => {
    const { username } = req.params;

    if (!username) {
        return res.status(400).json({ message: '用户名不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) {
        return res.status(404).json({ message: '用户不存在' });
    }

    const userProjects = users[username].projects || [];
    const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        exportedBy: username,
        user: {
            // 不导出密码和敏感信息
            stars: users[username].stars || [],
            pinnedProjects: users[username].pinnedProjects || [],
            pinnedBoards: users[username].pinnedBoards || {},
            backgroundUrl: users[username].backgroundUrl || null
        },
        projects: []
    };

    // 导出用户参与的每个项目
    userProjects.forEach(projectId => {
        const project = projects[projectId];
        if (!project) return;

        const projectExport = {
            originalId: projectId,
            name: project.name,
            owner: project.owner,
            members: project.members || [],
            boards: [],
            boardOwners: project.boardOwners || {},
            joinApprovals: project.joinApprovals || [],
            created: project.created
        };

        // 导出该项目的所有看板数据
        (project.boards || []).forEach(boardName => {
            const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
            const boardData = readJsonFile(boardFile, {
                archived: [],
                lists: { listIds: [], lists: {} }
            });
            projectExport.boards.push({
                name: boardName,
                owner: project.boardOwners?.[boardName] || project.owner,
                data: boardData
            });
        });

        exportData.projects.push(projectExport);
    });

    const filename = `kanban_backup_${username}_${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(JSON.stringify(exportData, null, 2));
});

/**
 * 导入用户数据（创建新项目）
 * POST /api/user-restore
 * Body: { username, backupData }
 */
app.post('/api/user-restore', (req, res) => {
    const { username, backupData } = req.body;

    if (!username || !backupData) {
        return res.status(400).json({ message: '用户名和备份数据不能为空' });
    }

    if (!backupData.version || !backupData.projects) {
        return res.status(400).json({ message: '无效的备份文件格式' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) {
        return res.status(404).json({ message: '用户不存在' });
    }

    const importedProjects = [];
    const idMapping = {}; // 旧ID -> 新ID 映射

    try {
        // 为每个项目创建新的 projectId
        backupData.projects.forEach(projectExport => {
            const newProjectId = Date.now().toString() + Math.random().toString(36).slice(2, 12);
            idMapping[projectExport.originalId] = newProjectId;

            // 创建新项目
            const newProject = {
                name: `${projectExport.name} (恢复)`,
                owner: username, // 当前用户成为所有者
                members: [username], // 只有当前用户是成员
                boards: [],
                boardOwners: {},
                joinApprovals: [],
                created: new Date().toISOString()
            };

            // 恢复每个看板
            projectExport.boards.forEach(boardExport => {
                const boardName = boardExport.name;
                newProject.boards.push(boardName);
                newProject.boardOwners[boardName] = username;

                // 写入看板数据文件
                const boardFile = path.join(dataDir, `${newProjectId}_${boardName}.json`);
                writeJsonFile(boardFile, boardExport.data);
            });

            // 保存项目
            projects[newProjectId] = newProject;

            // 将项目添加到用户的项目列表
            if (!users[username].projects.includes(newProjectId)) {
                users[username].projects.unshift(newProjectId);
            }

            importedProjects.push({
                oldId: projectExport.originalId,
                newId: newProjectId,
                name: newProject.name,
                boardCount: newProject.boards.length
            });
        });

        // 保存更新
        if (!writeJsonFile(projectsFile, projects)) {
            return res.status(500).json({ message: '保存项目数据失败' });
        }
        if (!writeJsonFile(usersFile, users)) {
            return res.status(500).json({ message: '保存用户数据失败' });
        }

        res.json({
            message: '数据恢复成功',
            imported: importedProjects,
            summary: {
                projectCount: importedProjects.length,
                totalBoards: importedProjects.reduce((sum, p) => sum + p.boardCount, 0)
            }
        });

    } catch (error) {
        console.error('Import error:', error);
        res.status(500).json({ message: '导入失败: ' + error.message });
    }
});

/**
 * 导出单个项目的完整数据
 * GET /api/project-backup/:projectId
 */
app.get('/api/project-backup/:projectId', (req, res) => {
    const { projectId } = req.params;
    const { username } = req.query;

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];

    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    // 可选：检查用户是否有权限
    if (username && !project.members?.includes(username) && project.owner !== username) {
        return res.status(403).json({ message: '无权访问此项目' });
    }

    const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        type: 'single_project',
        project: {
            originalId: projectId,
            name: project.name,
            owner: project.owner,
            members: project.members || [],
            boards: [],
            boardOwners: project.boardOwners || {},
            created: project.created
        }
    };

    // 导出所有看板
    (project.boards || []).forEach(boardName => {
        const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
        const boardData = readJsonFile(boardFile, {
            archived: [],
            lists: { listIds: [], lists: {} }
        });
        exportData.project.boards.push({
            name: boardName,
            owner: project.boardOwners?.[boardName] || project.owner,
            data: boardData
        });
    });

    const safeName = project.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_');
    const filename = `project_backup_${safeName}_${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(JSON.stringify(exportData, null, 2));
});

/**
 * 导入单个项目（创建新项目）
 * POST /api/project-restore
 * Body: { username, backupData }
 */
app.post('/api/project-restore', (req, res) => {
    const { username, backupData } = req.body;

    if (!username || !backupData) {
        return res.status(400).json({ message: '用户名和备份数据不能为空' });
    }

    if (!backupData.version || !backupData.project) {
        return res.status(400).json({ message: '无效的项目备份文件格式' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});

    if (!users[username]) {
        return res.status(404).json({ message: '用户不存在' });
    }

    try {
        const projectExport = backupData.project;
        const newProjectId = Date.now().toString() + Math.random().toString(36).slice(2, 12);

        // 创建新项目
        const newProject = {
            name: `${projectExport.name} (恢复)`,
            owner: username,
            members: [username],
            boards: [],
            boardOwners: {},
            joinApprovals: [],
            created: new Date().toISOString()
        };

        // 恢复每个看板
        (projectExport.boards || []).forEach(boardExport => {
            const boardName = boardExport.name;
            newProject.boards.push(boardName);
            newProject.boardOwners[boardName] = username;

            const boardFile = path.join(dataDir, `${newProjectId}_${boardName}.json`);
            writeJsonFile(boardFile, boardExport.data);
        });

        // 保存项目
        projects[newProjectId] = newProject;

        // 添加到用户项目列表
        if (!users[username].projects.includes(newProjectId)) {
            users[username].projects.unshift(newProjectId);
        }

        if (!writeJsonFile(projectsFile, projects)) {
            return res.status(500).json({ message: '保存项目数据失败' });
        }
        if (!writeJsonFile(usersFile, users)) {
            return res.status(500).json({ message: '保存用户数据失败' });
        }

        res.json({
            message: '项目恢复成功',
            project: {
                oldId: projectExport.originalId,
                newId: newProjectId,
                name: newProject.name,
                boardCount: newProject.boards.length
            }
        });

    } catch (error) {
        console.error('Project import error:', error);
        res.status(500).json({ message: '导入失败: ' + error.message });
    }
});

// ============ 个人完整数据导出/导入 END ============

// WebSocket处理
wss.on('connection', (ws) => {
    console.log('New WebSocket connection');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            handleWebSocketMessage(ws, data);
        } catch (error) {
            console.error('WebSocket message error:', error);
            ws.send(JSON.stringify({
                type: 'error',
                message: '消息格式错误'
            }));
        }
    });

    ws.on('close', () => {
        // 从连接管理中移除用户
        for (const [key, connData] of connections.entries()) {
            if (connData.ws === ws) {
                connections.delete(key);
                updateOnlineUsers(connData.projectId, connData.boardName);
                break;
            }
        }
        console.log('WebSocket connection closed');
    });
});

function handleWebSocketMessage(ws, data) {
    switch (data.type) {
        case 'join':
            handleJoin(ws, data);
            break;
        case 'add-card':
            handleAddCard(ws, data);
            break;
        case 'update-card':
            handleUpdateCard(ws, data);
            break;
        case 'move-card':
            handleMoveCard(ws, data);
            break;
        case 'reorder-cards':
            handleReorderCards(ws, data);
            break;
        case 'delete-card':
            handleDeleteCard(ws, data);
            break;
        case 'archive-card':
            handleArchiveCard(ws, data);
            break;
        case 'restore-card':
            handleRestoreCard(ws, data);
            break;
        case 'clear-archive':
            handleClearArchive(ws, data);
            break;
        case 'import-board':
            handleImportBoard(ws, data);
            break;
        case 'card-editing':
            handleCardEditing(ws, data);
            break;
        // persist lists metadata (client dynamic lists)
        case 'save-lists':
            handleSaveLists(ws, data);
            break;
        default:
            ws.send(JSON.stringify({
                type: 'error',
                message: '未知的消息类型'
            }));
    }
}

async function handleJoin(ws, data) {
    const { user, projectId, boardName } = data;
    const connectionKey = `${user}-${projectId}-${boardName}`;

    connections.set(connectionKey, {
        ws,
        user,
        projectId,
        boardName,
        joinTime: Date.now()
    });

    // 发送当前看板数据（带锁，确保初始化数据一致性）
    const { data: boardData } = await withBoardLock(projectId, boardName, (bd) => {
        // Ensure lists metadata exists; if missing, infer from legacy arrays
        if (!bd.lists || !Array.isArray(bd.lists.listIds) || !bd.lists.lists) {
            bd.lists = inferListsFromArrays(bd);
        }
        // Ensure all status arrays exist
        ensureListStatusArrays(bd);
        return bd;
    });

    ws.send(JSON.stringify({
        type: 'board-update',
        projectId,
        boardName,
        board: boardData
    }));

    updateOnlineUsers(projectId, boardName);
}

async function handleAddCard(ws, data) {
    const { projectId, boardName, status, card, position } = data;

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        const exists = Object.keys(bd).some(key => Array.isArray(bd[key]) && bd[key].some(c => c && c.id === card.id));
        if (exists) {
            return { data: bd, result: { changed: false } };
        }
        // Accept dynamic statuses; create bucket if missing
        if (!Array.isArray(bd[status])) {
            bd[status] = [];
        }

        // 支持顶部/底部添加
        if (position === 'top') {
            bd[status].unshift(card);
        } else {
            bd[status].push(card);
        }
        return { data: bd, result: { changed: true } };
    });

    if (success && result && result.changed === false) {
        return;
    }

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleUpdateCard(ws, data) {
    const { projectId, boardName, cardId, updates } = data;

    const { success, data: boardData, result: updated } = await withBoardLock(projectId, boardName, (bd) => {
        let found = false;
        for (const status of Object.keys(bd)) {
            if (!Array.isArray(bd[status])) continue;
            const cardIndex = bd[status].findIndex(card => card.id === cardId);
            if (cardIndex !== -1) {
                Object.assign(bd[status][cardIndex], updates);
                found = true;
                break;
            }
        }
        return found ? { data: bd, result: true } : { data: null, result: false };
    });

    if (success && updated) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleMoveCard(ws, data) {
    const { projectId, boardName, cardId, fromStatus, toStatus } = data;

    const { success, data: boardData, result: errorMsg } = await withBoardLock(projectId, boardName, (bd) => {
        const cardIndex = (Array.isArray(bd[fromStatus]) ? bd[fromStatus] : []).findIndex(card => card.id === cardId);
        if (cardIndex === -1) {
            return { data: null, result: '找不到要移动的任务' };
        }

        const card = bd[fromStatus].splice(cardIndex, 1)[0];
        if (!Array.isArray(bd[toStatus])) bd[toStatus] = [];
        bd[toStatus].push(card);
        return { data: bd, result: null };
    });

    if (!success && errorMsg) {
        ws.send(JSON.stringify({
            type: 'error',
            message: errorMsg
        }));
        return;
    }

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleReorderCards(ws, data) {
    const { projectId, boardName, status, orderedIds } = data;

    // 前置校验（无需锁）
    if (!Array.isArray(orderedIds)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的排序参数' }));
        return;
    }

    const { success, data: boardData, result: errorMsg } = await withBoardLock(projectId, boardName, (bd) => {
        if (!Array.isArray(bd[status])) {
            return { data: null, result: '无效的状态' };
        }

        const existing = bd[status];
        const map = new Map(existing.map(c => [c.id, c]));

        const reordered = [];
        orderedIds.forEach(id => {
            const c = map.get(id);
            if (c) {
                reordered.push(c);
                map.delete(id);
            }
        });
        // 追加任何缺失的卡片，保证不丢数据
        existing.forEach(c => { if (map.has(c.id)) reordered.push(c); });

        bd[status] = reordered;
        return { data: bd, result: null };
    });

    if (!success && errorMsg) {
        ws.send(JSON.stringify({ type: 'error', message: errorMsg }));
        return;
    }

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleDeleteCard(ws, data) {
    const { projectId, boardName, cardId } = data;

    const { success, data: boardData, result: deleted } = await withBoardLock(projectId, boardName, (bd) => {
        let found = false;
        for (const status of Object.keys(bd)) {
            if (!Array.isArray(bd[status])) continue;
            const cardIndex = bd[status].findIndex(card => card.id === cardId);
            if (cardIndex !== -1) {
                bd[status].splice(cardIndex, 1);
                found = true;
                break;
            }
        }
        return found ? { data: bd, result: true } : { data: null, result: false };
    });

    if (success && deleted) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleArchiveCard(ws, data) {
    const { projectId, boardName, cardId, fromStatus } = data;

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        let actualStatus = (fromStatus && Array.isArray(bd[fromStatus])) ? fromStatus : null;
        let cardIndex = -1;

        if (actualStatus) {
            cardIndex = bd[actualStatus].findIndex(card => card.id === cardId);
        }

        if (cardIndex === -1) {
            const statuses = Object.keys(bd).filter(k => Array.isArray(bd[k]) && k !== 'archived');
            for (const st of statuses) {
                const idx = bd[st].findIndex(card => card.id === cardId);
                if (idx !== -1) {
                    actualStatus = st;
                    cardIndex = idx;
                    break;
                }
            }
        }

        if (!actualStatus || cardIndex === -1) {
            return { data: bd, result: { changed: false } };
        }

        const card = bd[actualStatus].splice(cardIndex, 1)[0];
        if (!bd.archived) {
            bd.archived = [];
        }
        card.archivedFrom = actualStatus;
        card.archivedAt = Date.now();
        bd.archived.push(card);
        return { data: bd, result: { changed: true } };
    });

    if (success && result && result.changed === false) {
        return;
    }

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleRestoreCard(ws, data) {
    const { projectId, boardName, cardId } = data;

    const { success, data: boardData, result } = await withBoardLock(projectId, boardName, (bd) => {
        if (!Array.isArray(bd.archived)) {
            return { data: bd, result: { changed: false } };
        }
        const cardIndex = bd.archived.findIndex(card => card.id === cardId);
        if (cardIndex === -1) {
            return { data: bd, result: { changed: false } };
        }

        const card = bd.archived.splice(cardIndex, 1)[0];

        let targetStatus = (card && card.archivedFrom) ? card.archivedFrom : null;
        const listMetas = (bd.lists && bd.lists.lists) ? Object.values(bd.lists.lists) : [];
        const metaStatuses = listMetas.map(m => m && m.status).filter(Boolean);

        if (!targetStatus || targetStatus === 'archived' || (metaStatuses.length && !metaStatuses.includes(targetStatus))) {
            if (metaStatuses.includes('done')) {
                targetStatus = 'done';
            } else if (metaStatuses.length) {
                targetStatus = metaStatuses[metaStatuses.length - 1];
            } else if (Array.isArray(bd.done)) {
                targetStatus = 'done';
            } else {
                const fallback = Object.keys(bd).find(k => Array.isArray(bd[k]) && k !== 'archived');
                targetStatus = fallback || 'done';
            }
        }

        if (!Array.isArray(bd[targetStatus])) bd[targetStatus] = [];

        if (!bd.lists || !Array.isArray(bd.lists.listIds) || !bd.lists.lists) {
            bd.lists = { listIds: [], lists: {} };
        }
        if (targetStatus && !metaStatuses.includes(targetStatus)) {
            const id = targetStatus;
            if (!bd.lists.listIds.includes(id)) bd.lists.listIds.push(id);
            bd.lists.lists[id] = bd.lists.lists[id] || { id, title: id === 'done' ? '已完成' : id, pos: bd.lists.listIds.length - 1, status: targetStatus };
        }

        bd[targetStatus].push(card);
        return { data: bd, result: { changed: true } };
    });

    if (success && result && result.changed === false) {
        return;
    }

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleClearArchive(ws, data) {
    const { projectId, boardName } = data;

    const { success, data: boardData } = await withBoardLock(projectId, boardName, (bd) => {
        bd.archived = [];
        return bd;
    });

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

async function handleImportBoard(ws, data) {
    const { projectId, boardName, data: importData, mode } = data;

    try {
        // Normalize importData structure (before lock, this is read-only)
        const incoming = Object.assign({}, importData || {});
        const incomingLists = (incoming && incoming.lists && Array.isArray(incoming.lists.listIds) && incoming.lists.lists) ? incoming.lists : null;

        const { success, data: boardData } = await withBoardLock(projectId, boardName, (bd) => {
            if (mode === 'overwrite') {
                // Start fresh, but keep lists metadata if provided; otherwise keep existing lists metadata
                const listsMeta = incomingLists || bd.lists || null;
                const next = { archived: Array.isArray(incoming.archived) ? incoming.archived : [] };

                if (listsMeta) {
                    next.lists = listsMeta;
                    // Ensure arrays exist for all statuses from lists
                    ensureListStatusArrays(next);
                    // Merge in any matching statuses from incoming (by status key)
                    for (const id of listsMeta.listIds) {
                        const st = listsMeta.lists[id] && listsMeta.lists[id].status;
                        if (!st) continue;
                        next[st] = Array.isArray(incoming[st]) ? incoming[st] : [];
                    }
                }
                // Fallback legacy sections
                next.todo = next.todo || (Array.isArray(incoming.todo) ? incoming.todo : []);
                next.doing = next.doing || (Array.isArray(incoming.doing) ? incoming.doing : []);
                next.done = next.done || (Array.isArray(incoming.done) ? incoming.done : []);

                bd = next;
            } else {
                // Merge mode: append cards for known statuses; create/merge dynamic statuses
                // Merge lists metadata
                if (incomingLists) {
                    // Ensure target lists exists
                    if (!bd.lists || !Array.isArray(bd.lists.listIds) || !bd.lists.lists) {
                        bd.lists = { listIds: [], lists: {} };
                    }
                    const existing = bd.lists;

                    // Build title -> {id, status} map (case-insensitive)
                    const titleMap = new Map();
                    existing.listIds.forEach(id => {
                        const m = existing.lists[id];
                        if (m && m.title) titleMap.set(String(m.title).toLowerCase(), { id, status: m.status });
                    });

                    // For each incoming list, find same-title list; if found, merge into that status; else append new list
                    incomingLists.listIds.forEach(inId => {
                        const meta = incomingLists.lists[inId];
                        if (!meta || !meta.title) return;
                        const key = String(meta.title).toLowerCase();
                        const hit = titleMap.get(key);
                        if (hit) {
                            // Keep existing id/status; optionally update title/pos
                            existing.lists[hit.id] = Object.assign({}, existing.lists[hit.id] || {}, { title: meta.title });
                            // Merge incoming cards into this status bucket
                            const st = hit.status;
                            if (Array.isArray(incoming[meta.status])) {
                                if (!Array.isArray(bd[st])) bd[st] = [];
                                bd[st] = bd[st].concat(incoming[meta.status]);
                            }
                        } else {
                            // Append as new list
                            const newId = 'list_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
                            const st = meta.status || ('list_' + Math.random().toString(36).slice(2,8));
                            if (!existing.listIds.includes(newId)) existing.listIds.push(newId);
                            existing.lists[newId] = { id: newId, title: meta.title, pos: existing.listIds.length - 1, status: st };
                            if (Array.isArray(incoming[meta.status])) {
                                if (!Array.isArray(bd[st])) bd[st] = [];
                                bd[st] = bd[st].concat(incoming[meta.status]);
                            }
                        }
                    });
                    ensureListStatusArrays(bd);
                }

                // Merge dynamic and legacy arrays: append
                const keys = new Set(Object.keys(bd).concat(Object.keys(incoming)));
                for (const k of keys) {
                    if (k === 'lists') continue;
                    // Skip any list statuses that were merged by title above to avoid double-add
                    if (incomingLists && incomingLists.listIds.some(id => (incomingLists.lists[id]||{}).status === k)) continue;
                    if (Array.isArray(incoming[k])) {
                        if (!Array.isArray(bd[k])) bd[k] = [];
                        bd[k] = bd[k].concat(incoming[k]);
                    }
                }
            }

            // Ensure all card IDs exist
            Object.keys(bd).forEach(st => {
                if (!Array.isArray(bd[st])) return;
                bd[st] = bd[st].map(card => ({
                    ...card,
                    id: card && card.id ? card.id : (Date.now() + Math.random()).toString()
                }));
            });

            return bd;
        });

        if (success) {
            broadcastToBoard(projectId, boardName, {
                type: 'board-update',
                projectId,
                boardName,
                board: boardData
            });

            ws.send(JSON.stringify({
                type: 'import-success',
                message: mode === 'overwrite' ? '数据已覆盖导入' : '数据已合并导入'
            }));
        } else {
            ws.send(JSON.stringify({
                type: 'error',
                message: '导入失败，无法保存数据'
            }));
        }
    } catch (error) {
        console.error('Import error:', error);
        ws.send(JSON.stringify({
            type: 'error',
            message: '导入失败，数据格式错误'
        }));
    }
}

function handleCardEditing(ws, data) {
    broadcastToBoard(data.projectId, data.boardName, data, ws);
}

// persist lists metadata (client dynamic lists)
async function handleSaveLists(ws, data) {
    const { projectId, boardName, lists } = data;

    // 前置校验（无需锁）
    if (!lists || !Array.isArray(lists.listIds) || typeof lists.lists !== 'object') {
        ws.send(JSON.stringify({ type:'error', message:'无效的列表数据' }));
        return;
    }

    const { success, data: boardData } = await withBoardLock(projectId, boardName, (bd) => {
        // 获取新列表中所有的 status
        const newStatuses = new Set();
        for (const listId of lists.listIds) {
            const list = lists.lists[listId];
            if (list && list.status) {
                newStatuses.add(list.status);
            }
        }

        // 获取旧列表中所有的 status
        const oldStatuses = new Set();
        if (bd.lists && bd.lists.listIds && bd.lists.lists) {
            for (const listId of bd.lists.listIds) {
                const list = bd.lists.lists[listId];
                if (list && list.status) {
                    oldStatuses.add(list.status);
                }
            }
        }

        // 清理被删除列表的卡片数据
        for (const oldStatus of oldStatuses) {
            if (!newStatuses.has(oldStatus) && oldStatus !== 'archived') {
                delete bd[oldStatus];
            }
        }

        bd.lists = lists;
        // Ensure arrays exist for any new list statuses
        ensureListStatusArrays(bd);
        return bd;
    });

    if (success) {
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        }, ws);
    }
}

// 辅助函数
function readBoardData(projectId, boardName) {
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    const boardData = readJsonFile(boardFile, {
        archived: [],
        lists: { listIds: [], lists: {} }
    });
    if (!boardData.lists || !Array.isArray(boardData.lists.listIds) || !boardData.lists.lists) {
        boardData.lists = inferListsFromArrays(boardData);
    }
    ensureListStatusArrays(boardData);
    return boardData;
}

function writeBoardData(projectId, boardName, data) {
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    return writeJsonFile(boardFile, data);
}

/**
 * 带并发锁的看板数据原子操作
 * @param {string} projectId - 项目ID
 * @param {string} boardName - 看板名称
 * @param {Function} modifier - 修改函数，接收 boardData，返回 { data, result } 或直接返回修改后的 data
 * @returns {Promise<{success: boolean, data?: any, result?: any}>}
 */
async function withBoardLock(projectId, boardName, modifier) {
    const lockKey = `board:${projectId}:${boardName}`;
    try {
        return await fileLock.acquire(lockKey, async () => {
            const boardData = readBoardData(projectId, boardName);
            const modResult = await modifier(boardData);

            // 支持两种返回格式：直接返回数据，或返回 { data, result }
            const newData = modResult && modResult.data !== undefined ? modResult.data : modResult;
            const extraResult = modResult && modResult.result !== undefined ? modResult.result : null;

            if (newData === null || newData === false) {
                // modifier 返回 null/false 表示不保存（如验证失败）
                return { success: false, data: boardData, result: extraResult };
            }

            if (writeBoardData(projectId, boardName, newData)) {
                createBackup(projectId, boardName, newData);
                return { success: true, data: newData, result: extraResult };
            }
            return { success: false, data: boardData, result: extraResult };
        });
    } catch (error) {
        console.error(`Lock error for ${lockKey}:`, error);
        return { success: false, error: error.message };
    }
}

function ensureListStatusArrays(boardData) {
    try {
        if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds)) {
            for (const id of boardData.lists.listIds) {
                const meta = boardData.lists.lists && boardData.lists.lists[id];
                const st = meta && meta.status;
                if (st && !Array.isArray(boardData[st])) boardData[st] = [];
            }
        }
        if (!Array.isArray(boardData.archived)) boardData.archived = [];
    } catch (e) {}
}

// Infer lists metadata from legacy fixed arrays if present; otherwise return empty lists meta
function inferListsFromArrays(boardData) {
    try {
        const keys = Object.keys(boardData || {});
        // statuses are keys mapping to arrays, excluding archived/lists
        const statuses = keys.filter(k => Array.isArray(boardData[k]) && k !== 'archived');
        if (!statuses.length) return { listIds: [], lists: {} };
        // Prefer standard order if classic columns present
        const order = ['todo', 'doing', 'done'];
        const ordered = [];
        order.forEach(k => { if (statuses.includes(k)) ordered.push(k); });
        statuses.forEach(k => { if (!ordered.includes(k)) ordered.push(k); });
        const lists = {};
        ordered.forEach((st, idx) => {
            const titleMap = { todo: '待办', doing: '进行中', done: '已完成' };
            lists[st] = { id: st, title: titleMap[st] || st, pos: idx, status: st };
        });
        return { listIds: ordered, lists };
    } catch (_) {
        return { listIds: [], lists: {} };
    }
}

function broadcastToBoard(projectId, boardName, message, excludeWs = null) {
    for (const [key, connData] of connections.entries()) {
        if (connData.projectId === projectId &&
            connData.boardName === boardName &&
            connData.ws !== excludeWs &&
            connData.ws.readyState === WebSocket.OPEN) {
            connData.ws.send(JSON.stringify(message));
        }
    }
}

function updateOnlineUsers(projectId, boardName) {
    const users = [];
    for (const [key, connData] of connections.entries()) {
        if (connData.projectId === projectId && connData.boardName === boardName) {
            users.push(connData.user);
        }
    }

    const uniqueUsers = [...new Set(users)];
    broadcastToBoard(projectId, boardName, {
        type: 'user-list',
        projectId,
        boardName,
        users: uniqueUsers
    });
}

function createBackup(projectId, boardName, data) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupsDir, `${projectId}_${boardName}_${timestamp}.json`);
        writeJsonFile(backupFile, data);

        // 清理旧备份（保留最近50个）
        cleanOldBackups(projectId, boardName);
    } catch (error) {
        console.error('Backup error:', error);
    }
}

function cleanOldBackups(projectId, boardName) {
    try {
        const prefix = `${projectId}_${boardName}_`;
        const files = fs.readdirSync(backupsDir)
            .filter(file => file.startsWith(prefix))
            .sort()
            .reverse();

        // 保留最近50个备份
        for (let i = 50; i < files.length; i++) {
            fs.unlinkSync(path.join(backupsDir, files[i]));
        }
    } catch (error) {
        console.error('Clean backup error:', error);
    }
}

// 定期清理备份（每小时执行一次）
setInterval(() => {
    try {
        const projectsFile = path.join(dataDir, 'projects.json');
        const projects = readJsonFile(projectsFile, {});

        for (const [projectId, project] of Object.entries(projects)) {
            const boards = Array.isArray(project.boards) ? project.boards : [];
            boards.forEach(boardName => {
                cleanOldBackups(projectId, boardName);
            });
            const archived = Array.isArray(project.archivedBoards) ? project.archivedBoards : [];
            archived.forEach(boardName => {
                cleanOldBackups(projectId, boardName);
            });
        }
    } catch (error) {
        console.error('Scheduled cleanup error:', error);
    }
}, 3600000); // 1小时

// Server configuration
const config = {
    port: process.env.PORT || 3000,
    env: process.env.NODE_ENV || 'development'
};

// Graceful shutdown handling
function gracefulShutdown() {
    console.log('\nShutting down gracefully...');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });

    // Force close if pending connections remain
    setTimeout(() => {
        console.error('Forcing shutdown after timeout');
        process.exit(1);
    }, 5000);
}

// Start server
server.listen(config.port, () => {
    console.log(`Server running in ${config.env} mode on port ${config.port}`);
});

// Handle signals
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    gracefulShutdown();
});

// Handle server errors
server.on('error', (error) => {
    if (error.syscall !== 'listen') throw error;

    console.error(`Server error: ${error}`);
    process.exit(1);
});

// 新增：成员申请与审批 API
app.post('/api/request-add-member', (req, res) => {
    const { projectId, username, actor } = req.body || {};
    if (!projectId || !username || !actor) {
        return res.status(400).json({ message: '缺少参数' });
    }
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    project.members = Array.isArray(project.members) ? project.members : [];
    if (!project.members.includes(actor)) return res.status(403).json({ message: '只有项目成员可以邀请' });
    if (!users[username]) return res.status(404).json({ message: '被邀请用户不存在' });
    if (project.members.includes(username)) return res.status(400).json({ message: '该用户已是成员' });
    project.pendingInvites = Array.isArray(project.pendingInvites) ? project.pendingInvites : [];
    if (project.pendingInvites.find(r => r && r.username === username)) {
        return res.json({ message: '邀请已发送，等待对方接受' });
    }
    project.pendingInvites.push({ username, invitedBy: actor, invitedAt: new Date().toISOString() });
    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '邀请已发送，等待对方接受' });
});

app.get('/api/project-invites/:projectId', (req, res) => {
    const { projectId } = req.params;
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    res.json({ invites: project.pendingInvites || [] });
});

app.get('/api/user-invites/:username', (req, res) => {
    const { username } = req.params;
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const result = [];
    for (const [pid, proj] of Object.entries(projects)) {
        const invites = (proj.pendingInvites || []).filter(i => i && i.username === username);
        if (invites.length) {
            invites.forEach(i => {
                result.push({ projectId: pid, projectName: proj.name, invitedBy: i.invitedBy, invitedAt: i.invitedAt });
            });
        }
    }
    res.json({ invites: result });
});

// 汇总需要该用户审批的通过邀请码加入项目的申请（该用户为项目所有者）
app.get('/api/user-approvals/:username', (req, res) => {
    const { username } = req.params;
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const approvals = [];
    for (const [pid, proj] of Object.entries(projects)) {
        if (!proj || proj.owner !== username) continue;
        const requests = Array.isArray(proj.pendingRequests) ? proj.pendingRequests : [];
        requests.forEach(r => {
            if (r && r.username) {
                approvals.push({ projectId: pid, projectName: proj.name, username: r.username, requestedAt: r.requestedAt });
            }
        });
    }
    res.json({ approvals });
});

app.post('/api/accept-invite', (req, res) => {
    const { username, projectId } = req.body || {};
    if (!username || !projectId) return res.status(400).json({ message: '缺少参数' });
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    project.pendingInvites = Array.isArray(project.pendingInvites) ? project.pendingInvites : [];
    const idx = project.pendingInvites.findIndex(i => i && i.username === username);
    if (idx === -1) return res.status(404).json({ message: '没有该邀请' });
    project.pendingInvites.splice(idx, 1);
    project.members = Array.isArray(project.members) ? project.members : [];
    if (!project.members.includes(username)) project.members.push(username);
    if (users[username]) {
        users[username].projects = Array.isArray(users[username].projects) ? users[username].projects : [];
        if (!users[username].projects.includes(projectId)) users[username].projects.unshift(projectId);
    }
    if (!writeJsonFile(projectsFile, projects) || !writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '保存失败' });
    }
    try {
        (project.boards || []).forEach(boardName => {
            broadcastToBoard(projectId, boardName, { type: 'member-added', projectId, username });
        });
    } catch (e) {}
    res.json({ message: '已加入项目', members: project.members });
});

app.post('/api/decline-invite', (req, res) => {
    const { username, projectId } = req.body || {};
    if (!username || !projectId) return res.status(400).json({ message: '缺少参数' });
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    project.pendingInvites = Array.isArray(project.pendingInvites) ? project.pendingInvites : [];
    const idx = project.pendingInvites.findIndex(i => i && i.username === username);
    if (idx === -1) return res.status(404).json({ message: '没有该邀请' });
    project.pendingInvites.splice(idx, 1);
    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });
    res.json({ message: '已拒绝邀请' });
});

app.post('/api/deny-join', (req, res) => {
    const { projectId, username, actor } = req.body || {};
    if (!projectId || !username || !actor) return res.status(400).json({ message: '缺少参数' });
    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    if (!actor || actor !== project.owner) return res.status(403).json({ message: '只有项目所有者可以审批' });
    project.pendingRequests = Array.isArray(project.pendingRequests) ? project.pendingRequests : [];
    const idx = project.pendingRequests.findIndex(r => r && r.username === username);
    if (idx === -1) return res.status(404).json({ message: '没有该申请' });
    project.pendingRequests.splice(idx, 1);
    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });
    return res.json({ message: '已拒绝申请', pendingRequests: project.pendingRequests });
});

app.post('/api/approve-join', (req, res) => {
    const { projectId, username, actor } = req.body || {};
    if (!projectId || !username || !actor) return res.status(400).json({ message: '缺少参数' });
    const usersFile = path.join(dataDir, 'users.json');
    const projectsFile = path.join(dataDir, 'projects.json');
    const users = readJsonFile(usersFile, {});
    const projects = readJsonFile(projectsFile, {});
    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });
    if (!actor || actor !== project.owner) return res.status(403).json({ message: '只有项目所有者可以审批' });
    project.pendingRequests = Array.isArray(project.pendingRequests) ? project.pendingRequests : [];
    const idx = project.pendingRequests.findIndex(r => r && r.username === username);
    if (idx === -1) return res.status(404).json({ message: '没有该申请' });
    project.pendingRequests.splice(idx, 1);
    project.members = Array.isArray(project.members) ? project.members : [];
    if (!project.members.includes(username)) project.members.push(username);
    const user = users[username];
    if (user) {
        user.projects = Array.isArray(user.projects) ? user.projects : [];
        if (!user.projects.includes(projectId)) user.projects.unshift(projectId);
    }
    if (!writeJsonFile(projectsFile, projects) || !writeJsonFile(usersFile, users)) {
        return res.status(500).json({ message: '保存失败' });
    }
    try {
        (project.boards || []).forEach(boardName => {
            broadcastToBoard(projectId, boardName, { type: 'member-added', projectId, username });
        });
    } catch (e) {}
    return res.json({ message: '已同意加入', members: project.members, pendingRequests: project.pendingRequests });
});

app.post('/api/archive-board', (req, res) => {
    const { projectId, boardName, actor } = req.body || {};
    if (!projectId || !boardName) return res.status(400).json({ message: '项目ID和看板名称不能为空' });

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    const isProjectOwner = actor && actor === project.owner;
    const isBoardOwner = project.boardOwners && actor && project.boardOwners[boardName] === actor;
    if (!isProjectOwner && !isBoardOwner) {
        return res.status(403).json({ message: '只有项目所有者或看板创建者可以归档看板' });
    }

    project.archivedBoards = Array.isArray(project.archivedBoards) ? project.archivedBoards : [];
    project.boards = Array.isArray(project.boards) ? project.boards : [];

    const idx = project.boards.indexOf(boardName);
    if (idx === -1) return res.status(404).json({ message: '看板不存在' });

    // Move name from boards to archivedBoards (avoid duplicates)
    project.boards.splice(idx, 1);
    if (!project.archivedBoards.includes(boardName)) project.archivedBoards.unshift(boardName);

    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });

    return res.json({ message: '看板已归档', boards: project.boards, archivedBoards: project.archivedBoards });
});

app.post('/api/unarchive-board', (req, res) => {
    const { projectId, boardName, actor } = req.body || {};
    if (!projectId || !boardName) return res.status(400).json({ message: '项目ID和看板名称不能为空' });

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) return res.status(404).json({ message: '项目不存在' });

    const isProjectOwner = actor && actor === project.owner;
    const isBoardOwner = project.boardOwners && actor && project.boardOwners[boardName] === actor;
    if (!isProjectOwner && !isBoardOwner) {
        return res.status(403).json({ message: '只有项目所有者或看板创建者可以还原看板' });
    }

    project.archivedBoards = Array.isArray(project.archivedBoards) ? project.archivedBoards : [];
    project.boards = Array.isArray(project.boards) ? project.boards : [];

    const idx = project.archivedBoards.indexOf(boardName);
    if (idx === -1) return res.status(404).json({ message: '归档中不存在该看板' });

    project.archivedBoards.splice(idx, 1);
    if (!project.boards.includes(boardName)) project.boards.unshift(boardName);

    if (!writeJsonFile(projectsFile, projects)) return res.status(500).json({ message: '保存失败' });

    return res.json({ message: '看板已还原', boards: project.boards, archivedBoards: project.archivedBoards });
});
