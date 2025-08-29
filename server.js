const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(express.json());
app.use(express.static('public'));

// 数据存储路径
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.txt');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// 确保目录存在
[DATA_DIR, BACKUP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// 内存中的连接管理
const connections = new Map(); // 存储 WebSocket 连接
const groupUsers = new Map(); // 存储每个组的在线用户

// 工具函数：生成密码哈希
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// 工具函数：读取用户数据
function readUsers() {
    try {
        if (!fs.existsSync(USERS_FILE)) {
            return {};
        }
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return data ? JSON.parse(data) : {};
    } catch (error) {
        console.error('Error reading users:', error);
        return {};
    }
}

// 工具函数：写入用户数据
function writeUsers(users) {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing users:', error);
        return false;
    }
}

// 工具函数：读取看板数据
function readBoardData(groupName) {
    try {
        const filePath = path.join(DATA_DIR, `${groupName}.txt`);
        if (!fs.existsSync(filePath)) {
            return { todo: [], doing: [], done: [], archived: [] };
        }
        const data = fs.readFileSync(filePath, 'utf8');
        const boardData = data ? JSON.parse(data) : { todo: [], doing: [], done: [], archived: [] };
        
        // 确保归档字段存在
        if (!boardData.archived) {
            boardData.archived = [];
        }
        
        return boardData;
    } catch (error) {
        console.error('Error reading board:', error);
        return { todo: [], doing: [], done: [], archived: [] };
    }
}

// 工具函数：写入看板数据
function writeBoardData(groupName, boardData) {
    try {
        const filePath = path.join(DATA_DIR, `${groupName}.txt`);
        fs.writeFileSync(filePath, JSON.stringify(boardData, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing board:', error);
        return false;
    }
}

// 工具函数：创建备份
function createBackup(groupName, boardData) {
    try {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(BACKUP_DIR, `${groupName}-${timestamp}.txt`);
        fs.writeFileSync(backupFile, JSON.stringify(boardData, null, 2));
        
        // 清理旧备份（保留最近50个）
        cleanupOldBackups(groupName);
        
        return true;
    } catch (error) {
        console.error('Error creating backup:', error);
        return false;
    }
}

// 工具函数：清理旧备份
function cleanupOldBackups(groupName) {
    try {
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(file => file.startsWith(`${groupName}-`))
            .map(file => ({
                name: file,
                path: path.join(BACKUP_DIR, file),
                stat: fs.statSync(path.join(BACKUP_DIR, file))
            }))
            .sort((a, b) => b.stat.mtime - a.stat.mtime);
        
        // 删除超过50个的备份
        if (files.length > 50) {
            files.slice(50).forEach(file => {
                fs.unlinkSync(file.path);
            });
        }
    } catch (error) {
        console.error('Error cleaning up backups:', error);
    }
}

// 工具函数：广播消息给组内用户
function broadcastToGroup(groupName, message, excludeWs = null) {
    const users = groupUsers.get(groupName) || [];
    users.forEach(({ ws, username }) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// API 路由：用户注册
app.post('/api/register', (req, res) => {
    const { username, password, groupName } = req.body;
    
    if (!username || !password || !groupName) {
        return res.json({ success: false, message: '请填写所有字段' });
    }
    
    const users = readUsers();
    
    // 检查用户名是否已存在
    if (users[username]) {
        return res.json({ success: false, message: '用户名已存在' });
    }
    
    // 创建新用户
    users[username] = {
        password: hashPassword(password),
        groups: [groupName],
        created: new Date().toISOString()
    };
    
    if (writeUsers(users)) {
        res.json({ success: true, message: '注册成功' });
    } else {
        res.json({ success: false, message: '注册失败' });
    }
});

// API 路由：用户登录
app.post('/api/login', (req, res) => {
    const { username, password, groupName } = req.body;
    
    if (!username || !password || !groupName) {
        return res.json({ success: false, message: '请填写所有字段' });
    }
    
    const users = readUsers();
    const user = users[username];
    
    if (!user || user.password !== hashPassword(password)) {
        return res.json({ success: false, message: '用户名或密码错误' });
    }
    
    // 添加用户到组（如果不存在）
    if (!user.groups.includes(groupName)) {
        user.groups.push(groupName);
        writeUsers(users);
    }
    
    res.json({ success: true, message: '登录成功' });
});

// API 路由：获取看板数据
app.get('/api/board/:groupName', (req, res) => {
    const { groupName } = req.params;
    const boardData = readBoardData(groupName);
    res.json({ success: true, board: boardData });
});

// API 路由：导出 Markdown
app.get('/api/export/:groupName', (req, res) => {
    const { groupName } = req.params;
    const boardData = readBoardData(groupName);
    
    try {
        const markdown = generateMarkdown(groupName, boardData);
        res.json({ success: true, markdown });
    } catch (error) {
        console.error('Export error:', error);
        res.json({ success: false, message: '导出失败' });
    }
});

// 生成 Markdown 格式
function generateMarkdown(groupName, boardData) {
    const now = new Date();
    let markdown = `# ${groupName} - 看板导出\n\n`;
    markdown += `导出时间: ${now.toLocaleDateString('zh-CN')} ${now.toLocaleTimeString('zh-CN')}\n\n`;
    
    const sections = [
        { title: '待办', key: 'todo', emoji: '📋' },
        { title: '进行中', key: 'doing', emoji: '🔄' },
        { title: '已完成', key: 'done', emoji: '✅' },
        { title: '归档', key: 'archived', emoji: '📁' }
    ];
    
    sections.forEach(section => {
        markdown += `## ${section.emoji} ${section.title}\n\n`;
        const cards = boardData[section.key] || [];
        
        if (cards.length === 0) {
            markdown += `*暂无任务*\n\n`;
        } else {
            cards.forEach((card, index) => {
                markdown += `### ${index + 1}. ${card.title}\n\n`;
                
                if (card.description) {
                    markdown += `**描述:** ${card.description}\n\n`;
                }
                
                markdown += `**创建者:** ${card.author}\n\n`;
                markdown += `**创建时间:** ${new Date(card.created).toLocaleDateString('zh-CN')}\n\n`;
                
                if (card.deadline) {
                    markdown += `**截止时间:** ${new Date(card.deadline).toLocaleDateString('zh-CN')}\n\n`;
                }
                
                markdown += `---\n\n`;
            });
        }
    });
    
    return markdown;
}

// WebSocket 连接处理
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
        // 从所有组中移除此连接
        connections.forEach((value, key) => {
            if (value.ws === ws) {
                const groupName = value.groupName;
                connections.delete(key);
                
                // 更新组内用户列表
                const users = groupUsers.get(groupName) || [];
                const updatedUsers = users.filter(u => u.ws !== ws);
                groupUsers.set(groupName, updatedUsers);
                
                // 广播用户列表更新
                broadcastToGroup(groupName, {
                    type: 'users-update',
                    group: groupName,
                    users: updatedUsers.map(u => u.username)
                });
            }
        });
    });
});

// 处理 WebSocket 消息
function handleWebSocketMessage(ws, data) {
    const { type, user, group } = data;
    
    switch (type) {
        case 'join':
            handleJoin(ws, user, group);
            break;
        case 'add-card':
            handleAddCard(ws, data);
            break;
        case 'update-card':
            handleUpdateCard(ws, data);
            break;
        case 'delete-card':
            handleDeleteCard(ws, data);
            break;
        case 'move-card':
            handleMoveCard(ws, data);
            break;
        case 'card-editing':
            handleCardEditing(ws, data);
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
        default:
            ws.send(JSON.stringify({
                type: 'error',
                message: '未知的消息类型'
            }));
    }
}

// 处理用户加入
function handleJoin(ws, username, groupName) {
    const connectionId = `${username}-${Date.now()}`;
    connections.set(connectionId, { ws, username, groupName });
    
    // 更新组内用户列表
    const users = groupUsers.get(groupName) || [];
    users.push({ ws, username });
    groupUsers.set(groupName, users);
    
    // 发送当前看板数据
    const boardData = readBoardData(groupName);
    ws.send(JSON.stringify({
        type: 'board-update',
        group: groupName,
        board: boardData
    }));
    
    // 广播用户列表更新
    broadcastToGroup(groupName, {
        type: 'users-update',
        group: groupName,
        users: users.map(u => u.username)
    });
}

// 处理添加卡片
function handleAddCard(ws, data) {
    const { group, status, card } = data;
    const boardData = readBoardData(group);
    
    if (!boardData[status]) {
        boardData[status] = [];
    }
    
    boardData[status].push(card);
    
    if (writeBoardData(group, boardData)) {
        // 创建备份
        createBackup(group, boardData);
        
        // 广播更新
        broadcastToGroup(group, {
            type: 'board-update',
            group: group,
            board: boardData
        });
    }
}

// 处理更新卡片
function handleUpdateCard(ws, data) {
    const { group, cardId, updates } = data;
    const boardData = readBoardData(group);
    
    let cardFound = false;
    ['todo', 'doing', 'done', 'archived'].forEach(status => {
        const cardIndex = boardData[status].findIndex(card => card.id === cardId);
        if (cardIndex !== -1) {
            Object.assign(boardData[status][cardIndex], updates);
            cardFound = true;
        }
    });
    
    if (cardFound && writeBoardData(group, boardData)) {
        createBackup(group, boardData);
        
        broadcastToGroup(group, {
            type: 'board-update',
            group: group,
            board: boardData
        });
    }
}

// 处理删除卡片
function handleDeleteCard(ws, data) {
    const { group, cardId } = data;
    const boardData = readBoardData(group);
    
    let cardFound = false;
    ['todo', 'doing', 'done', 'archived'].forEach(status => {
        const cardIndex = boardData[status].findIndex(card => card.id === cardId);
        if (cardIndex !== -1) {
            boardData[status].splice(cardIndex, 1);
            cardFound = true;
        }
    });
    
    if (cardFound && writeBoardData(group, boardData)) {
        createBackup(group, boardData);
        
        broadcastToGroup(group, {
            type: 'board-update',
            group: group,
            board: boardData
        });
    }
}

// 处理移动卡片
function handleMoveCard(ws, data) {
    const { group, cardId, fromStatus, toStatus } = data;
    const boardData = readBoardData(group);
    
    const fromIndex = boardData[fromStatus].findIndex(card => card.id === cardId);
    if (fromIndex !== -1) {
        const card = boardData[fromStatus].splice(fromIndex, 1)[0];
        boardData[toStatus].push(card);
        
        if (writeBoardData(group, boardData)) {
            createBackup(group, boardData);
            
            broadcastToGroup(group, {
                type: 'board-update',
                group: group,
                board: boardData
            });
        }
    }
}

// 处理卡片编辑状态
function handleCardEditing(ws, data) {
    broadcastToGroup(data.group, data, ws);
}

// 处理归档卡片
function handleArchiveCard(ws, data) {
    const { group, cardId, fromStatus } = data;
    const boardData = readBoardData(group);
    
    const cardIndex = boardData[fromStatus].findIndex(card => card.id === cardId);
    if (cardIndex !== -1) {
        const card = boardData[fromStatus].splice(cardIndex, 1)[0];
        boardData.archived.push(card);
        
        if (writeBoardData(group, boardData)) {
            createBackup(group, boardData);
            
            broadcastToGroup(group, {
                type: 'board-update',
                group: group,
                board: boardData
            });
        }
    }
}

// 处理还原卡片
function handleRestoreCard(ws, data) {
    const { group, cardId } = data;
    const boardData = readBoardData(group);
    
    const cardIndex = boardData.archived.findIndex(card => card.id === cardId);
    if (cardIndex !== -1) {
        const card = boardData.archived.splice(cardIndex, 1)[0];
        boardData.todo.push(card); // 还原到待办列
        
        if (writeBoardData(group, boardData)) {
            createBackup(group, boardData);
            
            broadcastToGroup(group, {
                type: 'board-update',
                group: group,
                board: boardData
            });
        }
    }
}

// 处理清空归档
function handleClearArchive(ws, data) {
    const { group } = data;
    const boardData = readBoardData(group);
    
    boardData.archived = [];
    
    if (writeBoardData(group, boardData)) {
        createBackup(group, boardData);
        
        broadcastToGroup(group, {
            type: 'board-update',
            group: group,
            board: boardData
        });
    }
}

// 定期清理备份（每小时执行一次）
setInterval(() => {
    try {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.txt') && f !== 'users.txt');
        files.forEach(file => {
            const groupName = file.replace('.txt', '');
            cleanupOldBackups(groupName);
        });
    } catch (error) {
        console.error('Backup cleanup error:', error);
    }
}, 3600000); // 1小时

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`多人协作看板服务器运行在端口 ${PORT}`);
    console.log(`数据存储目录: ${DATA_DIR}`);
    console.log(`备份目录: ${BACKUP_DIR}`);
});