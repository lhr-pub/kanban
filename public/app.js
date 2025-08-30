// 全局变量
let socket;
let currentUser = null;
let currentProjectId = null;
let currentProjectName = null;
let currentBoardName = null;
let boardData = { todo: [], doing: [], done: [], archived: [] };
let editingCardId = null;
let previousPage = null; // 记录上一个页面

// DOM 元素
const loginPage = document.getElementById('loginPage');
const projectPage = document.getElementById('projectPage');
const boardSelectPage = document.getElementById('boardSelectPage');
const boardPage = document.getElementById('boardPage');
const archivePage = document.getElementById('archivePage');
const authForm = document.getElementById('authForm');
const formTitle = document.getElementById('formTitle');
const submitBtn = document.getElementById('submitBtn');
const switchMode = document.getElementById('switchMode');
const switchText = document.getElementById('switchText');
const editModal = document.getElementById('editModal');
const importModal = document.getElementById('importModal');
let importFileData = null;

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 检查是否已登录
    const savedUser = localStorage.getItem('kanbanUser');
    if (savedUser) {
        currentUser = savedUser;

        // 恢复页面状态
        const savedPageState = localStorage.getItem('kanbanPageState');
        const savedCurrentProjectId = localStorage.getItem('kanbanCurrentProjectId');
        const savedCurrentProjectName = localStorage.getItem('kanbanCurrentProjectName');
        const savedCurrentBoardName = localStorage.getItem('kanbanCurrentBoardName');

        if (savedPageState && savedCurrentProjectId && savedCurrentProjectName) {
            currentProjectId = savedCurrentProjectId;
            currentProjectName = savedCurrentProjectName;

            if (savedPageState === 'boardSelect') {
                showBoardSelectPage();
            } else if (savedPageState === 'board' && savedCurrentBoardName) {
                currentBoardName = savedCurrentBoardName;
                showBoard();
            } else if (savedPageState === 'archive' && savedCurrentBoardName) {
                currentBoardName = savedCurrentBoardName;
                showBoard();
                // 稍后显示归档页面
                setTimeout(() => showArchive(), 100);
            } else {
                showProjectPage();
            }
        } else {
            showProjectPage();
        }
    } else {
        showLoginPage();
    }

    // 绑定事件
    authForm.addEventListener('submit', handleAuth);
    switchMode.addEventListener('click', toggleAuthMode);

    // 项目页面事件
    document.getElementById('logoutFromProject').addEventListener('click', logout);

    // 看板选择页面事件
    document.getElementById('backToProjects').addEventListener('click', showProjectPage);
    document.getElementById('logoutFromBoard').addEventListener('click', logout);

    // 看板页面事件
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('exportBtn').addEventListener('click', exportMarkdown);
    document.getElementById('importBtn').addEventListener('click', importBoard);
    document.getElementById('archiveBtn').addEventListener('click', showArchive);
    document.getElementById('backToBoardSelect').addEventListener('click', goBack);
    document.getElementById('backToBoard').addEventListener('click', showBoard);

    // 绑定模态框事件
    editModal.addEventListener('click', function(e) {
        if (e.target === editModal) {
            closeEditModal();
        }
    });

    // 绑定键盘事件
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (!editModal.classList.contains('hidden')) {
                closeEditModal();
            }
            if (!importModal.classList.contains('hidden')) {
                cancelImport();
            }
        }
    });

    // 为添加任务输入框绑定回车键事件
    ['todo', 'doing', 'done'].forEach(status => {
        const titleInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Title`);
        if (titleInput) {
            titleInput.addEventListener('keypress', function(e) {
                if (e.key === 'Enter' && this.value.trim()) {
                    e.preventDefault();
                    addCard(status);
                }
            });
        }
    });
});

// 页面显示函数
function showLoginPage() {
    loginPage.classList.remove('hidden');
    projectPage.classList.add('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');
}

function showProjectPage() {
    previousPage = 'project';
    loginPage.classList.add('hidden');
    projectPage.classList.remove('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'project');
    localStorage.removeItem('kanbanCurrentProjectId');
    localStorage.removeItem('kanbanCurrentProjectName');
    localStorage.removeItem('kanbanCurrentBoardName');

    loadUserProjects();
}

function showBoardSelectPage() {
    previousPage = 'boardSelect';
    loginPage.classList.add('hidden');
    projectPage.classList.add('hidden');
    boardSelectPage.classList.remove('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');

    // 更新项目标题
    document.getElementById('projectTitle').textContent = currentProjectName;

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'boardSelect');
    localStorage.setItem('kanbanCurrentProjectId', currentProjectId);
    localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
    localStorage.removeItem('kanbanCurrentBoardName');

    loadProjectBoards();
}

function showBoard() {
    if (!previousPage) {
        previousPage = 'project'; // 如果直接进入看板，设置默认返回到项目页面
    }
    loginPage.classList.add('hidden');
    projectPage.classList.add('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.remove('hidden');
    archivePage.classList.add('hidden');

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'board');
    localStorage.setItem('kanbanCurrentProjectId', currentProjectId);
    localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
    localStorage.setItem('kanbanCurrentBoardName', currentBoardName);

    updateBoardHeader();
    loadBoardData();
    connectWebSocket();

    // 加载项目成员信息（如果还未加载）
    if (!window.currentProjectMembers) {
        loadProjectMembers();
    }

    // 初始化分配用户选项
    updateAssigneeOptions();
}

function showArchive() {
    boardPage.classList.add('hidden');
    archivePage.classList.remove('hidden');

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'archive');

    renderArchive();
}

// 智能返回功能
function goBack() {
    if (previousPage === 'project') {
        showProjectPage();
    } else if (previousPage === 'boardSelect') {
        showBoardSelectPage();
    } else {
        // 默认返回项目页面
        showProjectPage();
    }
}

// 从看板页面返回到项目看板选择页面
function goToProjectBoards() {
    showBoardSelectPage();
}

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
    const isLogin = submitBtn.textContent === '登录';

    if (!username || !password) {
        alert('请填写用户名和密码');
        return;
    }

    try {
        const response = await fetch(`/api/${isLogin ? 'login' : 'register'}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username,
                password
            })
        });

        const result = await response.json();

        if (response.ok) {
            currentUser = username;
            localStorage.setItem('kanbanUser', username);
            showProjectPage();
        } else {
            alert(result.message || `${isLogin ? '登录' : '注册'}失败`);
        }
    } catch (error) {
        console.error('Auth error:', error);
        alert('网络错误，请稍后重试');
    }
}

// 加载用户数据
async function loadUserProjects() {
    try {
        const response = await fetch(`/api/user-projects/${currentUser}`);
        const projects = await response.json();

        // 设置用户名
        document.getElementById('currentUserName').textContent = currentUser;

        if (projects.length === 0) {
            document.getElementById('quickAccessBoards').innerHTML = '<div class="empty-state">还没有加入任何项目，请先创建或加入一个项目！</div>';
            document.getElementById('projectsList').innerHTML = '<div class="empty-state">还没有项目，创建第一个项目开始协作吧！</div>';
            return;
        }

        const quickAccessBoards = document.getElementById('quickAccessBoards');
        const projectsList = document.getElementById('projectsList');

        // 清空现有内容，避免重复
        quickAccessBoards.innerHTML = '';
        projectsList.innerHTML = '';

        // 加载所有看板和项目数据
        for (const project of projects) {
            try {
                const boardsResponse = await fetch(`/api/project-boards/${project.id}`);
                const boardsData = await boardsResponse.json();

                // 添加快速访问看板
                boardsData.boards.forEach(boardName => {
                    const boardCard = document.createElement('div');
                    boardCard.className = 'quick-board-card board-card-with-actions';
                    boardCard.onclick = () => {
                        currentProjectId = project.id;
                        currentProjectName = project.name;
                        currentBoardName = boardName;
                        previousPage = 'project'; // 从项目首页直接进入看板
                        showBoard();
                    };

                    boardCard.innerHTML = `
                        <div class="board-icon">📋</div>
                        <div class="board-details">
                            <h4>${escapeHtml(boardName)}</h4>
                            <span class="board-project">${escapeHtml(project.name)}</span>
                        </div>
                        <div class="board-card-actions">
                            <button class="board-action-btn delete-btn" onclick="event.stopPropagation(); deleteBoardFromHome('${escapeHtml(boardName)}', '${project.id}')" title="删除看板">✕</button>
                        </div>
                    `;

                    quickAccessBoards.appendChild(boardCard);
                });

            } catch (error) {
                console.error(`Error loading boards for project ${project.id}:`, error);
            }

            // 添加项目卡片到项目管理Tab
            const projectCard = document.createElement('div');
            projectCard.className = 'project-card';
            projectCard.onclick = () => selectProject(project.id, project.name);

            projectCard.innerHTML = `
                <h3>${escapeHtml(project.name)}</h3>
                <div class="project-info">
                    邀请码: <span class="invite-code">${project.inviteCode}</span><br>
                    成员: ${project.memberCount}人<br>
                    看板: ${project.boardCount}个<br>
                    创建于: ${new Date(project.created).toLocaleDateString()}
                </div>
            `;

            projectsList.appendChild(projectCard);
        }

    } catch (error) {
        console.error('Load projects error:', error);
        alert('加载项目列表失败');
    }
}

// Tab切换功能已移除，现在使用单页面布局

// 显示/隐藏创建项目表单
function showCreateProjectForm() {
    document.getElementById('createProjectForm').classList.remove('hidden');
    document.getElementById('newProjectName').focus();
}

function hideCreateProjectForm() {
    document.getElementById('createProjectForm').classList.add('hidden');
    document.getElementById('newProjectName').value = '';
}

// 显示/隐藏加入项目表单
function showJoinProjectForm() {
    document.getElementById('joinProjectForm').classList.remove('hidden');
    document.getElementById('inviteCode').focus();
}

function hideJoinProjectForm() {
    document.getElementById('joinProjectForm').classList.add('hidden');
    document.getElementById('inviteCode').value = '';
}

// 选择项目
function selectProject(projectId, projectName) {
    currentProjectId = projectId;
    currentProjectName = projectName;
    document.getElementById('projectTitle').textContent = projectName;
    previousPage = 'project'; // 从项目页面进入看板选择
    showBoardSelectPage();
}

// 创建项目
async function createProject() {
    const projectName = document.getElementById('newProjectName').value.trim();
    if (!projectName) {
        alert('请输入项目名称');
        return;
    }

    try {
        const response = await fetch('/api/create-project', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: currentUser,
                projectName
            })
        });

        const result = await response.json();

        if (response.ok) {
            hideCreateProjectForm();
            loadUserProjects();
            alert(`项目创建成功！\n项目名称: ${projectName}\n邀请码: ${result.inviteCode}\n\n请保存邀请码，用于邀请团队成员！`);
        } else {
            alert(result.message || '创建项目失败');
        }
    } catch (error) {
        console.error('Create project error:', error);
        alert('创建项目失败');
    }
}

// 加入项目
async function joinProject() {
    const inviteCode = document.getElementById('inviteCode').value.trim().toUpperCase();
    if (!inviteCode || inviteCode.length !== 6) {
        alert('请输入6位邀请码');
        return;
    }

    try {
        const response = await fetch('/api/join-project', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                username: currentUser,
                inviteCode
            })
        });

        const result = await response.json();

        if (response.ok) {
            hideJoinProjectForm();
            loadUserProjects();
            alert('成功加入项目！');
        } else {
            alert(result.message || '加入项目失败');
        }
    } catch (error) {
        console.error('Join project error:', error);
        alert('加入项目失败');
    }
}

// 加载项目成员信息
async function loadProjectMembers() {
    try {
        const response = await fetch(`/api/project-boards/${currentProjectId}`);
        const data = await response.json();

        // 保存项目成员列表用于分配用户选项
        window.currentProjectMembers = data.members;

        // 更新分配用户选项
        updateAssigneeOptions();
    } catch (error) {
        console.error('Load project members error:', error);
    }
}

// 加载项目看板列表
async function loadProjectBoards() {
    try {
        const response = await fetch(`/api/project-boards/${currentProjectId}`);
        const data = await response.json();

        document.getElementById('projectInviteCode').textContent = data.inviteCode;
        document.getElementById('projectMembers').textContent = data.members.join(', ');

        // 保存项目成员列表用于分配用户选项
        window.currentProjectMembers = data.members;

        const boardList = document.getElementById('boardList');
        boardList.innerHTML = '';

        if (data.boards.length === 0) {
            boardList.innerHTML = '<div class="empty-state">还没有看板，创建第一个看板吧！</div>';
            return;
        }

        data.boards.forEach(boardName => {
            const boardCard = document.createElement('div');
            boardCard.className = 'quick-board-card board-card-with-actions';
            boardCard.onclick = () => selectBoard(boardName);

            boardCard.innerHTML = `
                <div class="board-icon">📋</div>
                <div class="board-details">
                    <h4>${escapeHtml(boardName)}</h4>
                    <span class="board-project">${escapeHtml(currentProjectName)}</span>
                </div>
                <div class="board-card-actions">
                    <button class="board-action-btn delete-btn" onclick="event.stopPropagation(); deleteBoard('${escapeHtml(boardName)}')" title="删除看板">✕</button>
                </div>
            `;

            boardList.appendChild(boardCard);
        });

    } catch (error) {
        console.error('Load boards error:', error);
        alert('加载看板列表失败');
    }
}

// 选择看板
function selectBoard(boardName) {
    currentBoardName = boardName;
    previousPage = 'boardSelect'; // 从看板选择页面进入看板
    showBoard();
}

// 创建看板
async function createBoard() {
    const boardName = document.getElementById('newBoardName').value.trim();
    if (!boardName) {
        alert('请输入看板名称');
        return;
    }

    try {
        const response = await fetch('/api/create-board', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectId: currentProjectId,
                boardName
            })
        });

        const result = await response.json();

        if (response.ok) {
            document.getElementById('newBoardName').value = '';
            loadProjectBoards();
            alert('看板创建成功！');
        } else {
            alert(result.message || '创建看板失败');
        }
    } catch (error) {
        console.error('Create board error:', error);
        alert('创建看板失败');
    }
}

// 删除看板
async function deleteBoard(boardName) {
    if (!confirm(`确定要删除看板 "${boardName}" 吗？\n\n⚠️ 删除后看板内的所有任务都将永久丢失，此操作无法撤销！`)) {
        return;
    }

    try {
        const response = await fetch('/api/delete-board', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectId: currentProjectId,
                boardName
            })
        });

        const result = await response.json();

        if (response.ok) {
            loadProjectBoards();
            alert('看板删除成功！');
        } else {
            alert(result.message || '删除看板失败');
        }
    } catch (error) {
        console.error('Delete board error:', error);
        alert('删除看板失败');
    }
}

// 从首页删除看板
async function deleteBoardFromHome(boardName, projectId) {
    if (!confirm(`确定要删除看板 "${boardName}" 吗？\n\n⚠️ 删除后看板内的所有任务都将永久丢失，此操作无法撤销！`)) {
        return;
    }

    try {
        const response = await fetch('/api/delete-board', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectId: projectId,
                boardName
            })
        });

        const result = await response.json();

        if (response.ok) {
            loadUserProjects(); // 重新加载首页项目列表
            alert('看板删除成功！');
        } else {
            alert(result.message || '删除看板失败');
        }
    } catch (error) {
        console.error('Delete board from home error:', error);
        alert('删除看板失败');
    }
}

// 更新看板头部信息
function updateBoardHeader() {
    document.getElementById('currentProjectName').textContent = currentProjectName;
    document.getElementById('currentBoardName').textContent = currentBoardName;
}

// WebSocket 连接
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = function() {
        console.log('WebSocket connected');
        socket.send(JSON.stringify({
            type: 'join',
            user: currentUser,
            projectId: currentProjectId,
            boardName: currentBoardName
        }));
    };

    socket.onmessage = function(event) {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };

    socket.onclose = function() {
        console.log('WebSocket disconnected');
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = function(error) {
        console.error('WebSocket error:', error);
    };
}

// 处理WebSocket消息
function handleWebSocketMessage(data) {
    switch (data.type) {
        case 'board-update':
            if (data.projectId === currentProjectId && data.boardName === currentBoardName) {
                boardData = data.board;
                renderBoard();
            }
            break;
        case 'user-list':
            if (data.projectId === currentProjectId && data.boardName === currentBoardName) {
                updateOnlineUsers(data.users);
            }
            break;
        case 'card-editing':
            if (data.projectId === currentProjectId && data.boardName === currentBoardName) {
                showCardEditing(data.cardId, data.user, data.editing);
            }
            break;
        case 'import-success':
            alert(data.message);
            break;
        case 'error':
            alert(data.message);
            break;
    }
}

// 加载看板数据
async function loadBoardData() {
    try {
        const response = await fetch(`/api/board/${currentProjectId}/${encodeURIComponent(currentBoardName)}`);
        if (response.ok) {
            boardData = await response.json();
            renderBoard();
        }
    } catch (error) {
        console.error('Load board error:', error);
    }
}

// 渲染看板
function renderBoard() {
    ['todo', 'doing', 'done'].forEach(status => {
        const cardsContainer = document.getElementById(`${status}Cards`);
        const countElement = document.getElementById(`${status}Count`);

        cardsContainer.innerHTML = '';
        const cards = boardData[status] || [];
        countElement.textContent = cards.length;

        // 按创建时间正序排序（最新的在后面）
        const sortedCards = cards.slice().sort((a, b) => {
            return new Date(a.created) - new Date(b.created);
        });

        sortedCards.forEach(card => {
            const cardElement = createCardElement(card, status);
            cardsContainer.appendChild(cardElement);
        });
    });

    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

// 渲染归档页面
function renderArchive() {
    const archivedCards = document.getElementById('archivedCards');
    const archivedCount = document.getElementById('archivedCount');

    archivedCards.innerHTML = '';
    const cards = boardData.archived || [];
    archivedCount.textContent = cards.length;

    // 按创建时间正序排序（最新的在后面）
    const sortedCards = cards.slice().sort((a, b) => {
        return new Date(a.created) - new Date(b.created);
    });

    sortedCards.forEach(card => {
        const cardElement = createCardElement(card, 'archived');
        archivedCards.appendChild(cardElement);
    });
}

// 创建卡片元素
function createCardElement(card, status) {
    const cardElement = document.createElement('div');
    cardElement.className = 'card';
    cardElement.dataset.cardId = card.id;

    const isOverdue = card.deadline && new Date(card.deadline) < new Date();
    const isEditing = editingCardId === card.id;

    if (isOverdue) cardElement.classList.add('overdue');
    if (isEditing) cardElement.classList.add('editing');

    let actionsHtml = '';
    if (status !== 'archived') {
        if (status !== 'todo') {
            actionsHtml += `<button class="action-btn move-left" onclick="moveCard('${card.id}', 'left')" title="向左移动">←</button>`;
        }
        if (status !== 'done') {
            actionsHtml += `<button class="action-btn move-right" onclick="moveCard('${card.id}', 'right')" title="向右移动">→</button>`;
        }
        if (status === 'done') {
            actionsHtml += `<button class="archive-btn" onclick="archiveCard('${card.id}')" title="归档">📁</button>`;
        }
    } else {
        actionsHtml = `<button class="restore-btn" onclick="restoreCard('${card.id}')" title="还原到待办">↶</button>`;
    }

    const assigneeHtml = card.assignee ?
        `<span class="card-assignee clickable" onclick="event.stopPropagation(); editCardAssignee('${card.id}')" title="点击修改分配用户">@${escapeHtml(card.assignee)}</span>` :
        `<span class="card-assignee unassigned clickable" onclick="event.stopPropagation(); editCardAssignee('${card.id}')" title="点击分配用户">未分配</span>`;
    const deadlineHtml = card.deadline ?
        `<span class="card-deadline clickable" onclick="event.stopPropagation(); editCardDeadline('${card.id}')" title="点击修改截止日期">📅 ${card.deadline}</span>` :
        `<span class="card-deadline clickable unset" onclick="event.stopPropagation(); editCardDeadline('${card.id}')" title="点击设置截止日期">📅 设置</span>`;

    cardElement.innerHTML = `
        <div class="card-actions">${actionsHtml}</div>
        <h4 class="card-title clickable" onclick="event.stopPropagation(); editCardTitle('${card.id}')" title="点击编辑标题">${escapeHtml(card.title)}</h4>
        <p class="card-description clickable" onclick="event.stopPropagation(); editCardDescription('${card.id}')" title="点击编辑描述">${escapeHtml(card.description || '点击添加描述...')}</p>
        <div class="card-footer" onclick="openEditModal('${card.id}')">
            <div class="card-footer-top">
                <div class="card-left-info">
                    ${assigneeHtml}
                </div>
                <div class="card-right-info">
                    ${deadlineHtml}
                </div>
            </div>
        </div>
    `;

    return cardElement;
}

// 添加卡片
function addCard(status) {
    const titleInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Title`);
    const assigneeInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Assignee`);
    const deadlineInput = document.getElementById(`new${status.charAt(0).toUpperCase() + status.slice(1)}Deadline`);

    const title = titleInput.value.trim();
    if (!title) {
        alert('请输入任务标题');
        return;
    }

    const card = {
        id: Date.now().toString(),
        title: title,
        description: '',
        author: currentUser,
        assignee: assigneeInput.value || null,
        created: new Date().toISOString(),
        deadline: deadlineInput.value || null
    };

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'add-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            status: status,
            card: card
        }));
    }

    titleInput.value = '';
    assigneeInput.value = '';
    deadlineInput.value = '';
}

// 移动卡片
function moveCard(cardId, direction) {
    const statuses = ['todo', 'doing', 'done'];
    let fromStatus = null;
    let cardIndex = -1;

    for (const status of statuses) {
        const index = boardData[status].findIndex(card => card.id === cardId);
        if (index !== -1) {
            fromStatus = status;
            cardIndex = index;
            break;
        }
    }

    if (fromStatus === null) return;

    const currentIndex = statuses.indexOf(fromStatus);
    let toStatus;

    if (direction === 'left' && currentIndex > 0) {
        toStatus = statuses[currentIndex - 1];
    } else if (direction === 'right' && currentIndex < statuses.length - 1) {
        toStatus = statuses[currentIndex + 1];
    }

    if (toStatus && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'move-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: cardId,
            fromStatus: fromStatus,
            toStatus: toStatus
        }));
    }
}

// 归档卡片
function archiveCard(cardId) {
    const cardIndex = boardData.done.findIndex(card => card.id === cardId);
    if (cardIndex === -1) {
        alert('只能归档已完成的任务');
        return;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'archive-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: cardId,
            fromStatus: 'done'
        }));
    }
}

// 还原卡片
function restoreCard(cardId) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'restore-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: cardId
        }));
    }
}

// 清空归档
function clearArchive() {
    if (confirm('确定要清空所有归档任务吗？此操作不可恢复。')) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'clear-archive',
                projectId: currentProjectId,
                boardName: currentBoardName
            }));
        }
    }
}

// 打开编辑模态框
function openEditModal(cardId) {
    let card = null;

    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            break;
        }
    }

    if (!card) return;

    editingCardId = cardId;
    document.getElementById('editCardTitle').value = card.title;
    document.getElementById('editCardDescription').value = card.description || '';
    document.getElementById('editCardDeadline').value = card.deadline || '';
    document.getElementById('editCardCreated').textContent = `创建于: ${new Date(card.created).toLocaleString()}`;
    document.getElementById('editCardAuthor').textContent = `创建者: ${card.author}`;

    // 更新分配用户下拉列表
    updateAssigneeOptions();
    document.getElementById('editCardAssignee').value = card.assignee || '';

    editModal.classList.remove('hidden');

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'card-editing',
            projectId: currentProjectId,
            boardName: currentBoardName,
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
    const description = document.getElementById('editCardDescription').value.trim();
    const assignee = document.getElementById('editCardAssignee').value || null;
    const deadline = document.getElementById('editCardDeadline').value || null;

    if (!title) {
        alert('任务标题不能为空');
        return;
    }

    const updates = { title, description, assignee, deadline };

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'update-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: editingCardId,
            updates: updates
        }));
    }

    closeEditModal();
}

// 删除卡片
function deleteCard() {
    if (!editingCardId) return;

    if (confirm('确定要删除这个任务吗？')) {
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
                type: 'delete-card',
                projectId: currentProjectId,
                boardName: currentBoardName,
                cardId: editingCardId
            }));
        }
        closeEditModal();
    }
}

// 关闭编辑模态框
function closeEditModal() {
    if (editingCardId && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'card-editing',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: editingCardId,
            user: currentUser,
            editing: false
        }));
    }

    editingCardId = null;
    editModal.classList.add('hidden');
}

// 更新在线用户
function updateOnlineUsers(users) {
    document.getElementById('onlineCount').textContent = `在线用户: ${users.length}`;
    document.getElementById('userList').innerHTML = users.map(user =>
        `<span class="online-user">${escapeHtml(user)}</span>`
    ).join('');

    // 同时更新分配用户选项
    window.currentOnlineUsers = users;
    updateAssigneeOptions();
}

// 更新分配用户选项
function updateAssigneeOptions() {
    const assigneeSelects = [
        'editCardAssignee',
        'newTodoAssignee',
        'newDoingAssignee',
        'newDoneAssignee'
    ];

    assigneeSelects.forEach(selectId => {
        const assigneeSelect = document.getElementById(selectId);
        if (!assigneeSelect) return;

        const currentValue = assigneeSelect.value;

        // 清空现有选项
        assigneeSelect.innerHTML = '<option value="">未分配</option>';

        // 优先使用在线用户列表，如果没有则使用项目成员列表
        let users = window.currentOnlineUsers || window.currentProjectMembers || [];

        users.forEach(user => {
            const option = document.createElement('option');
            option.value = user;
            option.textContent = user;
            assigneeSelect.appendChild(option);
        });

        // 恢复之前的值
        assigneeSelect.value = currentValue;
    });
}

// 显示卡片编辑状态
function showCardEditing(cardId, user, editing) {
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardElement) {
        if (editing && user !== currentUser) {
            cardElement.classList.add('editing');
            cardElement.title = `${user} 正在编辑此任务`;
        } else {
            cardElement.classList.remove('editing');
            cardElement.title = '';
        }
    }
}

// 导出Markdown
async function exportMarkdown() {
    try {
        const response = await fetch(`/api/export/${currentProjectId}/${encodeURIComponent(currentBoardName)}`);
        if (response.ok) {
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${currentProjectName}-${currentBoardName}.md`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }
    } catch (error) {
        console.error('Export error:', error);
        alert('导出失败');
    }
}

// 导入功能
function importBoard() {
    const fileInput = document.getElementById('importFile');
    fileInput.click();
}

// 文件选择后处理
document.getElementById('importFile').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            let data;
            if (file.name.endsWith('.json')) {
                data = JSON.parse(event.target.result);
            } else if (file.name.endsWith('.md')) {
                data = parseMarkdownToBoard(event.target.result);
            } else {
                alert('不支持的文件格式，请选择 .json 或 .md 文件');
                return;
            }

            importFileData = data;
            importModal.classList.remove('hidden');

        } catch (error) {
            console.error('Import error:', error);
            alert('文件格式错误，无法解析');
        }
    };
    reader.readAsText(file);
});

// 解析 Markdown 为看板数据
function parseMarkdownToBoard(markdown) {
    const lines = markdown.split('\n');
    const board = { todo: [], doing: [], done: [], archived: [] };
    let currentSection = null;
    let currentCard = null;

    for (const line of lines) {
        if (line.startsWith('## 📋 待办') || line.startsWith('## TODO')) {
            currentSection = 'todo';
        } else if (line.startsWith('## 🔄 进行中') || line.startsWith('## DOING')) {
            currentSection = 'doing';
        } else if (line.startsWith('## ✅ 已完成') || line.startsWith('## DONE')) {
            currentSection = 'done';
        } else if (line.startsWith('## 📁 归档') || line.startsWith('## ARCHIVED')) {
            currentSection = 'archived';
        } else if (line.startsWith('### ') && currentSection) {
            const title = line.replace(/^### \d+\. /, '').trim();
            currentCard = {
                id: Date.now() + Math.random().toString(),
                title: title,
                description: '',
                author: currentUser,
                assignee: null,
                created: new Date().toISOString(),
                deadline: null
            };
            board[currentSection].push(currentCard);
        } else if (line.startsWith('**描述:**') && currentCard) {
            currentCard.description = line.replace('**描述:**', '').trim();
        } else if (line.startsWith('**分配给:**') && currentCard) {
            currentCard.assignee = line.replace('**分配给:**', '').trim();
        }
    }

    return board;
}

// 确认导入
function confirmImport() {
    if (!importFileData) return;

    const importMode = document.querySelector('input[name="importMode"]:checked').value;

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'import-board',
            projectId: currentProjectId,
            boardName: currentBoardName,
            data: importFileData,
            mode: importMode
        }));
    }

    cancelImport();
}

// 取消导入
function cancelImport() {
    importModal.classList.add('hidden');
    importFileData = null;
    document.getElementById('importFile').value = '';
}

// 退出登录
function logout() {
    if (socket) {
        socket.close();
        socket = null;
    }

    currentUser = null;
    currentProjectId = null;
    currentProjectName = null;
    currentBoardName = null;
    boardData = { todo: [], doing: [], done: [], archived: [] };

    localStorage.removeItem('kanbanUser');
    localStorage.removeItem('kanbanPageState');
    localStorage.removeItem('kanbanCurrentProjectId');
    localStorage.removeItem('kanbanCurrentProjectName');
    localStorage.removeItem('kanbanCurrentBoardName');

    showLoginPage();

    // 重置表单
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    formTitle.textContent = '登录';
    submitBtn.textContent = '登录';
    switchText.textContent = '还没有账号？';
    switchMode.textContent = '注册';
}

// 内联编辑任务标题
function editCardTitle(cardId) {
    let card = null;
    let cardStatus = null;

    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            cardStatus = status;
            break;
        }
    }

    if (!card) return;

    // 检查是否已经在编辑状态
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const titleElement = cardElement.querySelector('.card-title');

    if (titleElement.querySelector('.inline-title-input')) {
        // 已经在编辑状态，不要重复创建
        return;
    }

    // 记录当前高度，避免抖动
    const lockedHeight = titleElement.offsetHeight;

    // 创建多行文本编辑框
    const input = document.createElement('textarea');
    input.className = 'inline-title-input';
    input.value = card.title;
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';

    // 保存原始文本
    const originalText = titleElement.innerHTML;

    // 替换内容并锁定高度
    titleElement.innerHTML = '';
    titleElement.style.minHeight = lockedHeight + 'px';
    titleElement.style.height = lockedHeight + 'px';
    titleElement.appendChild(input);

    // 设置卡片为编辑状态
    setCardInlineEditingState(cardId, true);

    // 聚焦并选中文本
    input.focus();
    input.select();

    // 初始高度与后续自适应（不低于原高度）
    input.style.height = Math.max(lockedHeight, input.scrollHeight) + 'px';
    // keep container in sync
    titleElement.style.height = input.style.height;
    // update on input already handled below

    // 保存函数
    const save = () => {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== card.title) {
            // 更新本地数据
            card.title = newTitle;

            // 发送更新请求
            const updates = { title: newTitle };

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'update-card',
                    projectId: currentProjectId,
                    boardName: currentBoardName,
                    cardId: cardId,
                    updates: updates
                }));
            }

            // 显示新标题
            titleElement.innerHTML = escapeHtml(newTitle);
        } else {
            // 恢复原始显示
            titleElement.innerHTML = originalText;
        }
        // 解除高度锁定
        titleElement.style.minHeight = '';
        titleElement.style.height = '';
    };

    // 取消函数
    const cancel = () => {
        titleElement.innerHTML = originalText;
        titleElement.style.minHeight = '';
        titleElement.style.height = '';
    };

    // 绑定事件 - 智能焦点管理
    input.addEventListener('blur', (e) => {
        setTimeout(() => {
            if (!shouldKeepInlineEditingActive(cardId)) {
                setCardInlineEditingState(cardId, false);
                save();
            }
        }, 150);
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            // Ctrl+Enter保存
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    // 阻止事件冒泡
    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // in editCardTitle: blur handler already saves; add fallback timer after focus
    setTimeout(() => {
        if (document.activeElement !== input) return;
        // safety autosave after 8s if still focused
        const t = setInterval(() => {
            if (document.activeElement !== input) { clearInterval(t); return; }
            // no-op: keep alive; autosave is handled on blur/ctrl+enter
        }, 2000);
    }, 50);
}

// 内联编辑任务描述
function editCardDescription(cardId) {
    let card = null;
    let cardStatus = null;

    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            cardStatus = status;
            break;
        }
    }

    if (!card) return;

    // 检查是否已经在编辑状态
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const descriptionElement = cardElement.querySelector('.card-description');

    if (descriptionElement.querySelector('.inline-description-textarea')) {
        // 已经在编辑状态，不要重复创建
        return;
    }

    // 进入编辑前锁定当前高度，避免抖动
    const lockedHeight = descriptionElement.offsetHeight;

    // 创建文本框
    const textarea = document.createElement('textarea');
    textarea.className = 'inline-description-textarea';
    textarea.value = card.description || '';
    textarea.placeholder = '输入任务描述...';
    textarea.rows = 2;
    textarea.style.width = '100%';
    textarea.style.boxSizing = 'border-box';

    // 保存原始文本
    const originalText = descriptionElement.innerHTML;

    // 替换内容并锁定容器高度
    descriptionElement.innerHTML = '';
    descriptionElement.style.minHeight = lockedHeight + 'px';
    descriptionElement.style.height = lockedHeight + 'px';
    descriptionElement.appendChild(textarea);

    // 聚焦并选中文本
    textarea.focus();
    textarea.select();

    // 先设置为锁定高度
    textarea.style.height = Math.max(lockedHeight, textarea.scrollHeight) + 'px';
    // keep container in sync
    descriptionElement.style.height = textarea.style.height;

    // 自动调整高度（不低于初始高度）
    textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        const newH = Math.max(lockedHeight, textarea.scrollHeight);
        textarea.style.height = newH + 'px';
        descriptionElement.style.height = newH + 'px';
    });

    // 保存函数
    const save = () => {
        const newDescription = textarea.value.trim();
        if (newDescription !== card.description) {
            // 更新本地数据
            card.description = newDescription;

            // 发送更新请求
            const updates = { description: newDescription };

            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'update-card',
                    projectId: currentProjectId,
                    boardName: currentBoardName,
                    cardId: cardId,
                    updates: updates
                }));
            }

            // 显示新描述
            const displayText = newDescription || '点击添加描述...';
            descriptionElement.innerHTML = escapeHtml(displayText);
        } else {
            // 恢复原始显示
            descriptionElement.innerHTML = originalText;
        }
        // 解除锁定高度
        descriptionElement.style.minHeight = '';
        descriptionElement.style.height = '';
    };

    // 取消函数
    const cancel = () => {
        descriptionElement.innerHTML = originalText;
        descriptionElement.style.minHeight = '';
        descriptionElement.style.height = '';
    };

    // 绑定事件 - 智能焦点管理
    textarea.addEventListener('blur', (e) => {
        setTimeout(() => {
            if (!shouldKeepInlineEditingActive(cardId)) {
                save();
            }
        }, 150);
    });

    textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
            // Ctrl+Enter保存
            e.preventDefault();
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    // 阻止事件冒泡
    textarea.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // strengthen blur saving and add fallback timer
    setTimeout(() => {
        if (document.activeElement !== textarea) return;
        const t2 = setInterval(() => {
            if (document.activeElement !== textarea) { clearInterval(t2); return; }
        }, 2000);
    }, 50);
}

// 内联编辑分配用户
function editCardAssignee(cardId) {
    let card = null;
    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) { card = found; break; }
    }
    if (!card) return;

    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const assigneeElement = cardElement.querySelector('.card-assignee');

    // 移除已有下拉
    const existingDropdown = document.querySelector('.assignee-dropdown');
    if (existingDropdown) existingDropdown.remove();

    // 浮层菜单
    const menu = document.createElement('div');
    menu.className = 'assignee-dropdown';

    const userList = [''].concat(window.currentOnlineUsers || []);
    userList.forEach(user => {
        const item = document.createElement('div');
        item.className = 'assignee-option' + (((user || null) === (card.assignee || null)) ? ' selected' : '');
        item.textContent = user ? `@${user}` : '未分配';
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const newAssignee = user || null;
            updateCardField(cardId, 'assignee', newAssignee);
            card.assignee = newAssignee; // 本地立即更新
            closeDropdown();
            setTimeout(() => renderBoard(), 50);
        });
        menu.appendChild(item);
    });

    // 定位
    const rect = assigneeElement.getBoundingClientRect();
    menu.style.position = 'absolute';
    menu.style.top = (rect.bottom + window.scrollY + 4) + 'px';
    menu.style.left = (rect.left + window.scrollX) + 'px';
    menu.style.minWidth = Math.max(120, Math.floor(rect.width)) + 'px';
    document.body.appendChild(menu);

    function closeDropdown() {
        document.removeEventListener('click', onDocClick, true);
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
    }
    function onDocClick(ev) {
        if (!menu.contains(ev.target)) closeDropdown();
    }
    setTimeout(() => document.addEventListener('click', onDocClick, true), 0);
}

// 内联编辑截止日期
function editCardDeadline(cardId) {
    let card = null;
    let cardStatus = null;

    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            cardStatus = status;
            break;
        }
    }

    if (!card) return;

    // 检查是否已经在编辑状态
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const deadlineElement = cardElement.querySelector('.card-deadline');

    if (deadlineElement.querySelector('.inline-date-input')) {
        // 已经在编辑状态，不要重复创建
        return;
    }

    // 测量现有尺寸并锁定，避免抖动
    const lockedW = Math.max(deadlineElement.offsetWidth, 136); // ensure enough width for YYYY-MM-DD
    const lockedH = deadlineElement.offsetHeight;

    // 创建日期输入框
    const input = document.createElement('input');
    input.type = 'date';
    input.className = 'inline-date-input';
    input.value = card.deadline || '';
    input.style.boxSizing = 'border-box';

    // 阻止事件冒泡
    input.onclick = function(e) {
        e.stopPropagation();
    };

    // 替换为输入框并锁定尺寸
    deadlineElement.innerHTML = '';
    deadlineElement.style.minWidth = lockedW + 'px';
    deadlineElement.style.minHeight = lockedH + 'px';
    input.style.width = lockedW + 'px';
    input.style.height = lockedH + 'px';
    deadlineElement.appendChild(input);

    // 延迟focus，确保元素已经插入DOM
    setTimeout(() => {
        input.focus();
        input.showPicker && input.showPicker(); // 自动打开日期选择器（如果支持）
    }, 50);

    // 处理日期变更
    input.onchange = function(e) {
        e.stopPropagation();
        const newDeadline = this.value || null;
        updateCardField(cardId, 'deadline', newDeadline);
        // 立即恢复显示
        setTimeout(() => renderBoard(), 50);
    };

    // 处理键盘事件
    input.onkeydown = function(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            renderBoard();
        } else if (e.key === 'Enter') {
            e.stopPropagation();
            const newDeadline = this.value || null;
            updateCardField(cardId, 'deadline', newDeadline);
            setTimeout(() => renderBoard(), 50);
        }
    };

    // 处理失去焦点 - 智能焦点管理
    input.onblur = function(e) {
        setTimeout(() => {
            // 检查元素是否还存在且是否还在编辑状态
            const currentInput = cardElement.querySelector('.inline-date-input');
            if (currentInput && !shouldKeepInlineEditingActive(cardId)) {
                renderBoard();
            }
        }, 150);
    };
}

// 智能焦点管理辅助函数
function shouldKeepInlineEditingActive(cardId) {
    const activeElement = document.activeElement;
    return activeElement &&
           activeElement.closest(`[data-card-id="${cardId}"]`) &&
           (activeElement.classList.contains('inline-date-input') ||
            activeElement.classList.contains('inline-assignee-select') ||
            activeElement.classList.contains('inline-title-input') ||
            activeElement.classList.contains('inline-description-textarea'));
}

// 管理卡片的内联编辑状态
function setCardInlineEditingState(cardId, isEditing) {
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardElement) {
        if (isEditing) {
            cardElement.classList.add('inline-editing');
        } else {
            cardElement.classList.remove('inline-editing');
        }
    }
}

// 更新卡片字段
function updateCardField(cardId, field, value) {
    const updates = {};
    updates[field] = value;

    // 先更新本地数据，避免界面闪烁或数据短暂丢失
    for (const status of ['todo', 'doing', 'done', 'archived']) {
        const idx = (boardData[status] || []).findIndex(c => c.id === cardId);
        if (idx !== -1) {
            const current = boardData[status][idx];
            boardData[status][idx] = Object.assign({}, current, { [field]: value });
            break;
        }
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'update-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: cardId,
            updates: updates
        }));
    }
}

// HTML转义
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