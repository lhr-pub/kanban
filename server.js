const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 中间件
app.use(express.json());
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

// 内存中的WebSocket连接管理
const connections = new Map();

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
            const content = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(content);
        }
    } catch (error) {
        console.error(`Error reading ${filePath}:`, error);
    }
    return defaultValue;
}

function writeJsonFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (error) {
        console.error(`Error writing ${filePath}:`, error);
        return false;
    }
}

// 用户认证API
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: '用户名和密码不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    if (users[username]) {
        return res.status(400).json({ message: '用户名已存在' });
    }

    // 密码哈希
    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

    users[username] = {
        password: hashedPassword,
        projects: [],
        created: new Date().toISOString()
    };

    if (writeJsonFile(usersFile, users)) {
        res.json({ message: '注册成功', username });
    } else {
        res.status(500).json({ message: '注册失败，请稍后重试' });
    }
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ message: '用户名和密码不能为空' });
    }

    const usersFile = path.join(dataDir, 'users.json');
    const users = readJsonFile(usersFile, {});

    const user = users[username];
    if (!user) {
        return res.status(400).json({ message: '用户不存在' });
    }

    const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');
    if (user.password !== hashedPassword) {
        return res.status(400).json({ message: '密码错误' });
    }

    res.json({ message: '登录成功', username });
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

    const userProjects = user.projects.map(projectId => {
        const project = projects[projectId];
        if (!project) return null;

        return {
            id: projectId,
            name: project.name,
            inviteCode: project.inviteCode,
            memberCount: project.members.length,
            boardCount: project.boards.length,
            created: project.created
        };
    }).filter(Boolean);

    res.json(userProjects);
});

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
        boards: ['默认看板'] // 创建项目时自动创建默认看板
    };

    // 更新用户项目列表
    users[username].projects.push(projectId);

    // 创建默认看板文件
    const boardFile = path.join(dataDir, `${projectId}_默认看板.json`);
    const defaultBoard = {
        todo: [],
        doing: [],
        done: [],
        archived: []
    };

    if (writeJsonFile(projectsFile, projects) &&
        writeJsonFile(usersFile, users) &&
        writeJsonFile(boardFile, defaultBoard)) {
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
    if (project.members.includes(username)) {
        return res.status(400).json({ message: '您已经是该项目的成员' });
    }

    // 添加用户到项目
    project.members.push(username);
    users[username].projects.push(projectId);

    if (writeJsonFile(projectsFile, projects) && writeJsonFile(usersFile, users)) {
        res.json({ message: '成功加入项目' });
    } else {
        res.status(500).json({ message: '加入项目失败' });
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
        boards: project.boards
    });
});

app.post('/api/create-board', (req, res) => {
    const { projectId, boardName } = req.body;

    if (!projectId || !boardName) {
        return res.status(400).json({ message: '项目ID和看板名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    if (project.boards.includes(boardName)) {
        return res.status(400).json({ message: '看板名称已存在' });
    }

    // 创建看板文件
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    const defaultBoard = {
        todo: [],
        doing: [],
        done: [],
        archived: []
    };

    project.boards.unshift(boardName);

    if (writeJsonFile(projectsFile, projects) && writeJsonFile(boardFile, defaultBoard)) {
        res.json({ message: '看板创建成功' });
    } else {
        res.status(500).json({ message: '创建看板失败' });
    }
});

// 删除看板API
app.delete('/api/delete-board', (req, res) => {
    const { projectId, boardName } = req.body;

    if (!projectId || !boardName) {
        return res.status(400).json({ message: '项目ID和看板名称不能为空' });
    }

    const projectsFile = path.join(dataDir, 'projects.json');
    const projects = readJsonFile(projectsFile, {});

    const project = projects[projectId];
    if (!project) {
        return res.status(404).json({ message: '项目不存在' });
    }

    const boardIndex = project.boards.indexOf(boardName);
    if (boardIndex === -1) {
        return res.status(404).json({ message: '看板不存在' });
    }

    // 删除看板文件
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    try {
        if (fs.existsSync(boardFile)) {
            fs.unlinkSync(boardFile);
        }

        // 从项目中移除看板
        project.boards.splice(boardIndex, 1);

        if (writeJsonFile(projectsFile, projects)) {
            res.json({ message: '看板删除成功' });
        } else {
            res.status(500).json({ message: '删除看板失败' });
        }
    } catch (error) {
        console.error('Delete board error:', error);
        res.status(500).json({ message: '删除看板失败' });
    }
});

// 看板数据API
app.get('/api/board/:projectId/:boardName', (req, res) => {
    const { projectId, boardName } = req.params;
    const boardFile = path.join(dataDir, `${projectId}_${decodeURIComponent(boardName)}.json`);

    const boardData = readJsonFile(boardFile, {
        todo: [],
        doing: [],
        done: [],
        archived: []
    });

    res.json(boardData);
});

// 导出API
app.get('/api/export/:projectId/:boardName', (req, res) => {
    const { projectId, boardName } = req.params;
    const decodedBoardName = decodeURIComponent(boardName);
    const boardFile = path.join(dataDir, `${projectId}_${decodedBoardName}.json`);

    const boardData = readJsonFile(boardFile, {
        todo: [],
        doing: [],
        done: [],
        archived: []
    });

    let markdown = `# ${decodedBoardName}\n\n`;

    const sections = [
        { key: 'todo', title: '📋 待办', icon: '⭕' },
        { key: 'doing', title: '🔄 进行中', icon: '🔄' },
        { key: 'done', title: '✅ 已完成', icon: '✅' },
        { key: 'archived', title: '📁 归档', icon: '📁' }
    ];

    sections.forEach(section => {
        const cards = boardData[section.key] || [];
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
        default:
            ws.send(JSON.stringify({
                type: 'error',
                message: '未知的消息类型'
            }));
    }
}

function handleJoin(ws, data) {
    const { user, projectId, boardName } = data;
    const connectionKey = `${user}-${projectId}-${boardName}`;

    connections.set(connectionKey, {
        ws,
        user,
        projectId,
        boardName,
        joinTime: Date.now()
    });

    // 发送当前看板数据
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    const boardData = readJsonFile(boardFile, {
        todo: [],
        doing: [],
        done: [],
        archived: []
    });

    ws.send(JSON.stringify({
        type: 'board-update',
        projectId,
        boardName,
        board: boardData
    }));

    updateOnlineUsers(projectId, boardName);
}

function handleAddCard(ws, data) {
    const { projectId, boardName, status, card, position } = data;
    const boardData = readBoardData(projectId, boardName);

    if (!boardData[status]) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '无效的状态'
        }));
        return;
    }

    // 支持顶部/底部添加
    if (position === 'top') {
        boardData[status].unshift(card);
    } else {
        boardData[status].push(card);
    }

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleUpdateCard(ws, data) {
    const { projectId, boardName, cardId, updates } = data;
    const boardData = readBoardData(projectId, boardName);

    let updated = false;
    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const cardIndex = boardData[status].findIndex(card => card.id === cardId);
        if (cardIndex !== -1) {
            Object.assign(boardData[status][cardIndex], updates);
            updated = true;
            break;
        }
    }

    if (updated && writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleMoveCard(ws, data) {
    const { projectId, boardName, cardId, fromStatus, toStatus } = data;
    const boardData = readBoardData(projectId, boardName);

    const cardIndex = boardData[fromStatus].findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '找不到要移动的任务'
        }));
        return;
    }

    const card = boardData[fromStatus].splice(cardIndex, 1)[0];
    boardData[toStatus].push(card);

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleReorderCards(ws, data) {
    const { projectId, boardName, status, orderedIds } = data;
    const boardData = readBoardData(projectId, boardName);

    if (!Array.isArray(boardData[status])) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的状态' }));
        return;
    }
    if (!Array.isArray(orderedIds)) {
        ws.send(JSON.stringify({ type: 'error', message: '无效的排序参数' }));
        return;
    }

    const existing = boardData[status];
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

    boardData[status] = reordered;

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleDeleteCard(ws, data) {
    const { projectId, boardName, cardId } = data;
    const boardData = readBoardData(projectId, boardName);

    let deleted = false;
    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const cardIndex = boardData[status].findIndex(card => card.id === cardId);
        if (cardIndex !== -1) {
            boardData[status].splice(cardIndex, 1);
            deleted = true;
            break;
        }
    }

    if (deleted && writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleArchiveCard(ws, data) {
    const { projectId, boardName, cardId, fromStatus } = data;
    const boardData = readBoardData(projectId, boardName);

    const cardIndex = boardData[fromStatus].findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '找不到要归档的任务'
        }));
        return;
    }

    const card = boardData[fromStatus].splice(cardIndex, 1)[0];
    if (!boardData.archived) {
        boardData.archived = [];
    }
    boardData.archived.push(card);

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleRestoreCard(ws, data) {
    const { projectId, boardName, cardId } = data;
    const boardData = readBoardData(projectId, boardName);

    const cardIndex = boardData.archived.findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        ws.send(JSON.stringify({
            type: 'error',
            message: '找不到要还原的任务'
        }));
        return;
    }

    const card = boardData.archived.splice(cardIndex, 1)[0];
    boardData.todo.push(card);

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleClearArchive(ws, data) {
    const { projectId, boardName } = data;
    const boardData = readBoardData(projectId, boardName);

    boardData.archived = [];

    if (writeBoardData(projectId, boardName, boardData)) {
        createBackup(projectId, boardName, boardData);
        broadcastToBoard(projectId, boardName, {
            type: 'board-update',
            projectId,
            boardName,
            board: boardData
        });
    }
}

function handleImportBoard(ws, data) {
    const { projectId, boardName, data: importData, mode } = data;
    let boardData = readBoardData(projectId, boardName);

    try {
        if (mode === 'overwrite') {
            boardData = {
                todo: importData.todo || [],
                doing: importData.doing || [],
                done: importData.done || [],
                archived: importData.archived || []
            };
        } else {
            boardData.todo = [...(boardData.todo || []), ...(importData.todo || [])];
            boardData.doing = [...(boardData.doing || []), ...(importData.doing || [])];
            boardData.done = [...(boardData.done || []), ...(importData.done || [])];
            boardData.archived = [...(boardData.archived || []), ...(importData.archived || [])];
        }

        // 确保所有导入的卡片有唯一ID
        ['todo', 'doing', 'done', 'archived'].forEach(status => {
            boardData[status] = boardData[status].map(card => ({
                ...card,
                id: card.id || (Date.now() + Math.random()).toString()
            }));
        });

        if (writeBoardData(projectId, boardName, boardData)) {
            createBackup(projectId, boardName, boardData);

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

// 辅助函数
function readBoardData(projectId, boardName) {
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    return readJsonFile(boardFile, {
        todo: [],
        doing: [],
        done: [],
        archived: []
    });
}

function writeBoardData(projectId, boardName, data) {
    const boardFile = path.join(dataDir, `${projectId}_${boardName}.json`);
    return writeJsonFile(boardFile, data);
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
            project.boards.forEach(boardName => {
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
