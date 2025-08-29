// 全局变量
let socket;
let currentUser = null;
let currentGroup = null;
let boardData = { todo: [], doing: [], done: [], archived: [] };
let editingCardId = null;

// DOM 元素
const loginPage = document.getElementById('loginPage');
const boardPage = document.getElementById('boardPage');
const authForm = document.getElementById('authForm');
const formTitle = document.getElementById('formTitle');
const submitBtn = document.getElementById('submitBtn');
const switchMode = document.getElementById('switchMode');
const switchText = document.getElementById('switchText');
const groupNameInput = document.getElementById('groupName');
const boardTitle = document.getElementById('boardTitle');
const onlineCount = document.getElementById('onlineCount');
const userList = document.getElementById('userList');
const editModal = document.getElementById('editModal');

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否已登录
    const savedUser = localStorage.getItem('kanbanUser');
    const savedGroup = localStorage.getItem('kanbanGroup');
    
    if (savedUser && savedGroup) {
        currentUser = savedUser;
        currentGroup = savedGroup;
        showBoard();
        connectWebSocket();
    }
    
    // 绑定事件
    authForm.addEventListener('submit', handleAuth);
    switchMode.addEventListener('click', toggleAuthMode);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('exportBtn').addEventListener('click', exportMarkdown);
    
    // 绑定模态框事件
    editModal.addEventListener('click', function(e) {
        if (e.target === editModal) {
            closeEditModal();
        }
    });
    
    // 绑定键盘事件
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && !editModal.classList.contains('hidden')) {
            closeEditModal();
        }
    });
});

// 认证模式切换
function toggleAuthMode(e) {
    e.preventDefault();
    const isLogin = formTitle.textContent === '登录';
    
    if (isLogin) {
        formTitle.textContent = '注册';
        submitBtn.textContent = '注册';
        switchText.textContent = '已有账号？';
        switchMode.textContent = '登录';
    } else {
        formTitle.textContent = '登录';
        submitBtn.textContent = '登录';
        switchText.textContent = '还没有账号？';
        switchMode.textContent = '注册';
    }
}

// 处理认证
async function handleAuth(e) {
    e.preventDefault();
    
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const groupName = groupNameInput.value.trim();
    const isLogin = submitBtn.textContent === '登录';
    
    if (!username || !password || !groupName) {
        alert('请填写所有字段');
        return;
    }
    
    try {
        submitBtn.disabled = true;
        submitBtn.textContent = isLogin ? '登录中...' : '注册中...';
        
        const response = await fetch(`/api/${isLogin ? 'login' : 'register'}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ username, password, groupName })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentUser = username;
            currentGroup = groupName;
            localStorage.setItem('kanbanUser', username);
            localStorage.setItem('kanbanGroup', groupName);
            showBoard();
            connectWebSocket();
        } else {
            alert(data.message || '操作失败');
        }
    } catch (error) {
        console.error('Auth error:', error);
        alert('网络错误，请重试');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isLogin ? '登录' : '注册';
    }
}

// 显示看板页面
function showBoard() {
    loginPage.classList.add('hidden');
    boardPage.classList.remove('hidden');
    boardTitle.textContent = `${currentGroup} - 项目看板`;
    loadBoardData();
}

// WebSocket 连接
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    
    socket = new WebSocket(wsUrl);
    
    socket.onopen = function() {
        console.log('WebSocket connected');
        // 加入项目组
        socket.send(JSON.stringify({
            type: 'join',
            user: currentUser,
            group: currentGroup
        }));
    };
    
    socket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    socket.onclose = function() {
        console.log('WebSocket disconnected');
        // 重连机制
        setTimeout(connectWebSocket, 3000);
    };
    
    socket.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
}

// 处理 WebSocket 消息
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'board-update':
            if (data.group === currentGroup) {
                boardData = data.board;
                renderBoard();
            }
            break;
        case 'users-update':
            if (data.group === currentGroup) {
                updateOnlineUsers(data.users);
            }
            break;
        case 'card-editing':
            if (data.group === currentGroup && data.user !== currentUser) {
                showCardEditing(data.cardId, data.user, data.editing);
            }
            break;
        case 'error':
            alert(data.message);
            break;
    }
}

// 加载看板数据
async function loadBoardData() {
    try {
        const response = await fetch(`/api/board/${currentGroup}`);
        const data = await response.json();
        
        if (data.success) {
            boardData = data.board;
            renderBoard();
        }
    } catch (error) {
        console.error('Load board error:', error);
    }
}

// 渲染看板
function renderBoard() {
    ['todo', 'doing', 'done', 'archived'].forEach(status => {
        const cardsContainer = document.getElementById(`${status}Cards`);
        const countElement = document.getElementById(`${status}Count`);
        
        cardsContainer.innerHTML = '';
        const cards = boardData[status] || [];
        countElement.textContent = cards.length;
        
        cards.forEach(card => {
            const cardElement = createCardElement(card, status);
            cardsContainer.appendChild(cardElement);
        });
    });
}

// 创建卡片元素
function createCardElement(card, status) {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'card';
    cardDiv.dataset.cardId = card.id;
    
    // 计算日期状态
    const today = new Date();
    const deadline = card.deadline ? new Date(card.deadline) : null;
    const daysUntilDeadline = deadline ? Math.ceil((deadline - today) / (1000 * 60 * 60 * 24)) : null;
    
    let deadlineClass = '';
    let deadlineText = '';
    
    if (deadline) {
        if (daysUntilDeadline < 0) {
            deadlineClass = 'deadline overdue';
            deadlineText = `已逾期 ${Math.abs(daysUntilDeadline)} 天`;
        } else if (daysUntilDeadline <= 3) {
            deadlineClass = 'deadline upcoming';
            deadlineText = `${daysUntilDeadline} 天后到期`;
        } else {
            deadlineClass = 'deadline';
            deadlineText = formatDate(deadline);
        }
    }
    
    // 根据状态决定按钮布局
    let leftActions = '';
    let rightActions = '';
    
    if (status === 'archived') {
        // 归档状态：只有还原按钮
        rightActions = '<button class="action-btn move-right" onclick="restoreCard(\'' + card.id + '\')" title="还原">↶</button>';
    } else {
        // 普通状态：左移、右移按钮
        if (status !== 'todo') {
            leftActions = '<button class="action-btn move-left" onclick="moveCard(\'' + card.id + '\', \'left\')" title="向左移动">←</button>';
        }
        if (status !== 'done') {
            rightActions = '<button class="action-btn move-right" onclick="moveCard(\'' + card.id + '\', \'right\')" title="向右移动">→</button>';
        }
        // 只有已完成列才显示归档按钮
        if (status === 'done') {
            rightActions += '<button class="action-btn archive-btn" onclick="archiveCard(\'' + card.id + '\')" title="归档">📁</button>';
        }
    }

    cardDiv.innerHTML = `
        ${leftActions ? `<div class="card-actions left-actions">${leftActions}</div>` : ''}
        ${rightActions ? `<div class="card-actions right-actions">${rightActions}</div>` : ''}
        <div class="card-title">${escapeHtml(card.title)}</div>
        ${card.description ? `<div class="card-description">${escapeHtml(card.description)}</div>` : ''}
        <div class="card-meta">
            <div class="card-dates">
                <span>创建: ${formatDate(new Date(card.created))}</span>
                ${deadline ? `<span class="${deadlineClass}">截止: ${deadlineText}</span>` : ''}
            </div>
            <span class="card-author">${escapeHtml(card.author)}</span>
        </div>
    `;
    
    // 添加点击事件
    cardDiv.addEventListener('click', function(e) {
        if (!e.target.closest('.card-actions')) {
            editCard(card.id);
        }
    });
    
    return cardDiv;
}

// 添加卡片
async function addCard(status) {
    const titleInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Title`);
    const deadlineInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Deadline`);
    
    const title = titleInput.value.trim();
    if (!title) {
        alert('请输入任务标题');
        return;
    }
    
    const newCard = {
        id: Date.now().toString(),
        title: title,
        description: '',
        author: currentUser,
        created: new Date().toISOString(),
        deadline: deadlineInput.value || null
    };
    
    // 发送到服务器
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'add-card',
            group: currentGroup,
            status: status,
            card: newCard
        }));
    }
    
    // 清空输入框
    titleInput.value = '';
    deadlineInput.value = '';
}

// 移动卡片
function moveCard(cardId, direction) {
    const statuses = ['todo', 'doing', 'done'];
    let currentStatus = null;
    let cardIndex = -1;
    
    // 查找卡片当前状态
    for (const status of statuses) {
        const index = boardData[status].findIndex(card => card.id === cardId);
        if (index !== -1) {
            currentStatus = status;
            cardIndex = index;
            break;
        }
    }
    
    if (!currentStatus) return;
    
    const currentStatusIndex = statuses.indexOf(currentStatus);
    let newStatusIndex;
    
    if (direction === 'left') {
        newStatusIndex = currentStatusIndex - 1;
    } else {
        newStatusIndex = currentStatusIndex + 1;
    }
    
    if (newStatusIndex < 0 || newStatusIndex >= statuses.length) return;
    
    const newStatus = statuses[newStatusIndex];
    
    // 发送到服务器
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'move-card',
            group: currentGroup,
            cardId: cardId,
            fromStatus: currentStatus,
            toStatus: newStatus
        }));
    }
}

// 归档卡片
function archiveCard(cardId) {
    // 只能归档已完成的任务
    const cardIndex = boardData.done.findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        alert('只能归档已完成的任务');
        return;
    }
    
    if (confirm('确定要归档这个已完成的任务吗？归档后可以在归档列中找到。')) {
        // 发送到服务器
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'archive-card',
                group: currentGroup,
                cardId: cardId,
                fromStatus: 'done'
            }));
        }
    }
}

// 还原卡片
function restoreCard(cardId) {
    // 发送到服务器，还原到待办列
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'restore-card',
            group: currentGroup,
            cardId: cardId
        }));
    }
}

// 清空归档
function clearArchive() {
    const archivedCount = boardData.archived ? boardData.archived.length : 0;
    
    if (archivedCount === 0) {
        alert('归档列表为空');
        return;
    }
    
    if (confirm(`确定要永久删除所有 ${archivedCount} 个归档任务吗？此操作不可撤销！`)) {
        // 发送到服务器
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'clear-archive',
                group: currentGroup
            }));
        }
    }
}

// 编辑卡片
function editCard(cardId) {
    let card = null;
    
    // 查找卡片
    for (const status of ['todo', 'doing', 'done', 'archived']) {
        card = boardData[status].find(c => c.id === cardId);
        if (card) break;
    }
    
    if (!card) return;
    
    editingCardId = cardId;
    
    // 填充编辑表单
    document.getElementById('editCardTitle').value = card.title;
    document.getElementById('editCardDeadline').value = card.deadline || '';
    document.getElementById('editCardDescription').value = card.description || '';
    document.getElementById('editCardCreated').textContent = `创建时间: ${formatDate(new Date(card.created))}`;
    document.getElementById('editCardAuthor').textContent = `创建者: ${card.author}`;
    
    // 显示模态框
    editModal.classList.remove('hidden');
    
    // 通知其他用户正在编辑
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'card-editing',
            group: currentGroup,
            cardId: cardId,
            user: currentUser,
            editing: true
        }));
    }
}

// 保存卡片
function saveCard() {
    if (!editingCardId) return;
    
    const title = document.getElementById('editCardTitle').value.trim();
    const deadline = document.getElementById('editCardDeadline').value;
    const description = document.getElementById('editCardDescription').value.trim();
    
    if (!title) {
        alert('请输入任务标题');
        return;
    }
    
    // 发送到服务器
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'update-card',
            group: currentGroup,
            cardId: editingCardId,
            updates: {
                title: title,
                deadline: deadline || null,
                description: description
            }
        }));
    }
    
    closeEditModal();
}

// 删除卡片
function deleteCard() {
    if (!editingCardId) return;
    
    if (!confirm('确定要删除这个任务吗？')) return;
    
    // 发送到服务器
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'delete-card',
            group: currentGroup,
            cardId: editingCardId
        }));
    }
    
    closeEditModal();
}

// 关闭编辑模态框
function closeEditModal() {
    editModal.classList.add('hidden');
    
    // 通知停止编辑
    if (editingCardId && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'card-editing',
            group: currentGroup,
            cardId: editingCardId,
            user: currentUser,
            editing: false
        }));
    }
    
    editingCardId = null;
}

// 显示卡片编辑状态
function showCardEditing(cardId, user, editing) {
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    if (!cardElement) return;
    
    if (editing) {
        cardElement.classList.add('editing');
        
        // 添加编辑指示器
        if (!cardElement.querySelector('.editing-indicator')) {
            const indicator = document.createElement('div');
            indicator.className = 'editing-indicator';
            indicator.title = `${user} 正在编辑`;
            cardElement.appendChild(indicator);
        }
    } else {
        cardElement.classList.remove('editing');
        const indicator = cardElement.querySelector('.editing-indicator');
        if (indicator) {
            indicator.remove();
        }
    }
}

// 更新在线用户
function updateOnlineUsers(users) {
    onlineCount.textContent = `在线用户: ${users.length}`;
    userList.innerHTML = '';
    
    users.forEach(user => {
        const userBadge = document.createElement('span');
        userBadge.className = 'user-badge';
        userBadge.textContent = user;
        userList.appendChild(userBadge);
    });
}

// 导出 Markdown
async function exportMarkdown() {
    try {
        const response = await fetch(`/api/export/${currentGroup}`);
        const data = await response.json();
        
        if (data.success) {
            // 创建下载链接
            const blob = new Blob([data.markdown], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${currentGroup}-看板-${formatDate(new Date())}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } else {
            alert(data.message || '导出失败');
        }
    } catch (error) {
        console.error('Export error:', error);
        alert('导出失败');
    }
}

// 退出登录
function logout() {
    if (confirm('确定要退出吗？')) {
        localStorage.removeItem('kanbanUser');
        localStorage.removeItem('kanbanGroup');
        
        if (socket) {
            socket.close();
        }
        
        currentUser = null;
        currentGroup = null;
        boardData = { todo: [], doing: [], done: [] };
        
        boardPage.classList.add('hidden');
        loginPage.classList.remove('hidden');
        
        // 重置表单
        authForm.reset();
    }
}

// 工具函数
function formatDate(date) {
    if (!date) return '';
    return date.toLocaleDateString('zh-CN');
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// 页面卸载时清理
window.addEventListener('beforeunload', function() {
    if (socket) {
        socket.close();
    }
});