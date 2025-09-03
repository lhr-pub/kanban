// 全局变量
let socket;
let currentUser = null;
let currentProjectId = null;
let currentProjectName = null;
let currentBoardName = null;
let boardData = { todo: [], doing: [], done: [], archived: [] };
let editingCardId = null;
let previousPage = null; // 记录上一个页面
let lastEditTime = 0;
let pendingBoardUpdate = false;
let pendingRenderTimer = null;
let inlineEditorOpening = false;
let pendingFocusSelector = null;
let pendingFocusCaretIndex = null;

// Board switcher state
let boardSwitcherMenu = null;
let boardSwitcherOpen = false;
let boardSwitcherBodyClickHandler = null;
let boardSwitcherKeyHandler = null;
let boardSwitcherFocusInHandler = null;
let projectBoardsCache = Object.create(null);

// 拖拽状态（支持跨列）
let draggingCardId = null;
let draggingFromStatus = null;

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

// ===== Trello-like Lists Adapter (frontend only, keeps backend payloads) =====
// Map legacy sections to dynamic lists on the client. Persist via existing fields.
let clientLists = null; // { listIds:[], lists:{id:{id,title,pos,status}}, order:['todo','doing','done'] }

function getClientListsStorageKey(){
    const pid = currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanClientLists:${pid}:${bname}`;
}
function loadClientListsFromStorage(){
    try {
        const raw = localStorage.getItem(getClientListsStorageKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.listIds) && parsed.lists) return parsed;
    } catch(e) { console.warn('Load clientLists failed', e); }
    return null;
}
function saveClientListsToStorage(){
    try { localStorage.setItem(getClientListsStorageKey(), JSON.stringify(clientLists)); } catch(e) { console.warn('Save clientLists failed', e); }
}

function ensureClientLists() {
    if (clientLists) return clientLists;
    const restored = loadClientListsFromStorage();
    if (restored) { clientLists = restored; return clientLists; }
    const defaults = [
        { id: 'todo', title: '待办', pos: 0, status: 'todo' },
        { id: 'doing', title: '进行中', pos: 1, status: 'doing' },
        { id: 'done', title: '已完成', pos: 2, status: 'done' }
    ];
    clientLists = { listIds: defaults.map(l=>l.id), lists: Object.fromEntries(defaults.map(l=>[l.id,l])) };
    saveClientListsToStorage();
    return clientLists;
}

function getCardsByStatus(status) { return (boardData[status] || []).slice(); }

function getAllStatusKeys(){
    return Object.keys(boardData).filter(k => Array.isArray(boardData[k]));
}

// History navigation state
let isHandlingPopstate = false;
function updateHistory(page, replace) {
    if (isHandlingPopstate) return;
    const state = {
        page,
        projectId: currentProjectId,
        projectName: currentProjectName,
        boardName: currentBoardName
    };
    try {
        if (replace) {
            window.history.replaceState(state, '');
        } else {
            window.history.pushState(state, '');
        }
    } catch (e) {}
}
function bindPopstateRouter() {
    window.addEventListener('popstate', function(e) {
        const s = e.state || {};
        isHandlingPopstate = true;
        try {
            switch (s.page) {
                case 'board':
                    currentProjectId = s.projectId || currentProjectId;
                    currentProjectName = s.projectName || currentProjectName;
                    currentBoardName = s.boardName || currentBoardName;
                    showBoard(true);
                    break;
                case 'boardSelect':
                    currentProjectId = s.projectId || currentProjectId;
                    currentProjectName = s.projectName || currentProjectName;
                    showBoardSelectPage(true);
                    break;
                case 'archive':
                    currentProjectId = s.projectId || currentProjectId;
                    currentProjectName = s.projectName || currentProjectName;
                    currentBoardName = s.boardName || currentBoardName;
                    showArchive(true);
                    break;
                case 'project':
                default:
                    showProjectPage(true);
                    break;
            }
        } finally {
            isHandlingPopstate = false;
        }
    });
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 渲染静态图标
    renderIconsInDom(document);

    // 邮箱验证成功提示
    try {
        const url = new URL(window.location.href);
        if (url.searchParams.get('verified') === '1') {
            const authMessage = document.getElementById('authMessage');
            if (authMessage) {
                authMessage.textContent = '邮箱验证成功，请登录。';
            }
            // 清除参数，避免刷新重复提示
            url.searchParams.delete('verified');
            window.history.replaceState({}, document.title, url.pathname + url.search);
        }
        // 如果存在重置密码令牌，提示用户设置新密码
        const resetToken = url.searchParams.get('resetToken');
        if (resetToken) {
            // 显示登录页以便弹窗
            showLoginPage();
            setTimeout(async () => {
                const data = await openPasswordDialog('设置新密码', false);
                if (!data) return;
                try {
                    const rs = await fetch('/api/reset-password', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ token: resetToken, newPassword: data.newPwd })
                    });
                    const rj = await rs.json().catch(()=>({}));
                    if (rs.ok) {
                        uiToast('密码已重置，请使用新密码登录','success');
                        url.searchParams.delete('resetToken');
                        window.history.replaceState({}, document.title, url.pathname + url.search);
                    } else {
                        uiToast(rj.message || '重置失败','error');
                    }
                } catch(e) {
                    uiToast('网络错误，请稍后再试','error');
                }
            }, 50);
        }
    } catch {}

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
                showBoardSelectPage(true);
            } else if (savedPageState === 'board' && savedCurrentBoardName) {
                currentBoardName = savedCurrentBoardName;
                showBoard(true);
            } else if (savedPageState === 'archive' && savedCurrentBoardName) {
                currentBoardName = savedCurrentBoardName;
                showBoard(true);
                // 稍后显示归档页面
                setTimeout(() => showArchive(), 100);
            } else {
                showProjectPage(true);
            }
        } else {
            showProjectPage(true);
        }
    } else {
        showLoginPage();
    }

    // 绑定事件
    authForm.addEventListener('submit', handleAuth);
    switchMode.addEventListener('click', toggleAuthMode);

    // 项目页面事件
    document.getElementById('logoutFromProject').addEventListener('click', logout);
    const invitesBtn = document.getElementById('invitesBtn');
    if (invitesBtn) invitesBtn.addEventListener('click', openInvitesModal);
    const changePwdProj = document.getElementById('changePasswordProject');
    if (changePwdProj) changePwdProj.addEventListener('click', changePasswordFlow);

    // 看板选择页面事件
    document.getElementById('backToProjects').addEventListener('click', showProjectPage);
    document.getElementById('logoutFromBoard').addEventListener('click', logout);
    const manageBtn = document.getElementById('manageMembersBtn');
    if (manageBtn) manageBtn.addEventListener('click', openMembersModal);

    // 看板页面事件
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('exportBtn').addEventListener('click', exportMarkdown);
    document.getElementById('importBtn').addEventListener('click', importBoard);
    document.getElementById('archiveBtn').addEventListener('click', showArchive);
    document.getElementById('backToBoardSelect').addEventListener('click', goBack);
    document.getElementById('backToBoard').addEventListener('click', showBoard);
    const changePwdBoard = document.getElementById('changePasswordBoard');
    if (changePwdBoard) changePwdBoard.addEventListener('click', changePasswordFlow);

    // 绑定模态框事件
    editModal.addEventListener('click', function(e) {
        if (e.target === editModal) {
            closeEditModal();
        }
    });

    // 看板名称下拉切换
    const currentBoardNameEl = document.getElementById('currentBoardName');
    if (currentBoardNameEl) {
        currentBoardNameEl.addEventListener('click', openBoardSwitcher);
        currentBoardNameEl.setAttribute('title', '切换看板');
    }

    // 忘记密码链接
    const forgotLink = document.getElementById('forgotPasswordLink');
    if (forgotLink) {
        forgotLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const email = await uiPrompt('请输入注册邮箱（或直接提交用户名字段后点确定）', '', '找回密码');
            const username = document.getElementById('username')?.value?.trim();
            if (!email && !username) { uiToast('请先填写邮箱或用户名','error'); return; }
            try {
                const rs = await fetch('/api/forgot-password', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(email ? { email } : { username })
                });
                const rj = await rs.json().catch(()=>({}));
                if (rs.ok) {
                    uiToast('如果该邮箱存在，我们已发送重置邮件','success');
                } else {
                    uiToast(rj.message || '发送失败','error');
                }
            } catch(e) {
                uiToast('网络错误，请稍后再试','error');
            }
        });
    }

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
            let inputLock = false;
            titleInput.addEventListener('keydown', function(e) {
                if (e.isComposing || e.keyCode === 229) return; // IME composing
                if (e.key === 'Enter' && this.value.trim()) {
                    e.preventDefault();
                    if (inputLock) return;
                    inputLock = true;
                    addCard(status, 'bottom');
                    setTimeout(()=>{ inputLock = false; }, 250);
                }
            });
        }
    });

    // 为创建看板输入框绑定回车键事件
    const newBoardNameInput = document.getElementById('newBoardName');
    if (newBoardNameInput) {
        newBoardNameInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && this.value.trim()) {
                e.preventDefault();
                createBoard();
            }
        });
    }

    // Add listener for resizing
    window.addEventListener('resize', adjustBoardCentering);

    // Bind popstate router once
    bindPopstateRouter();
});

// 页面显示函数
function showLoginPage() {
    loginPage.classList.remove('hidden');
    projectPage.classList.add('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');
}

function showProjectPage(replaceHistory) {
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

    // History
    updateHistory('project', !!replaceHistory);

    stopMembershipGuard();
    loadUserInvites();
    loadUserProjects();
}

function showBoardSelectPage(replaceHistory) {
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

    // History
    updateHistory('boardSelect', !!replaceHistory);

    loadProjectBoards();
    startMembershipGuard();
}

function showBoard(replaceHistory) {
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

    // History
    updateHistory('board', !!replaceHistory);

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

function showArchive(replaceHistory) {
    boardPage.classList.add('hidden');
    archivePage.classList.remove('hidden');

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'archive');

    // History
    updateHistory('archive', !!replaceHistory);

    renderArchive();
}

// 返回到项目或看板选择页（不使用历史）
function goBack() {
    if (previousPage === 'boardSelect') {
        showBoardSelectPage();
    } else {
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
        const emailInput = document.getElementById('email');
        if (emailInput) emailInput.style.display = '';
    } else {
        formTitle.textContent = '登录';
        submitBtn.textContent = '登录';
        switchText.textContent = '还没有账号？';
        switchMode.textContent = '注册';
        const emailInput = document.getElementById('email');
        if (emailInput) emailInput.style.display = 'none';
    }
}

// 处理认证
async function handleAuth(e) {
    e.preventDefault();

    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const emailInput = document.getElementById('email');
    const email = emailInput ? emailInput.value.trim() : '';
    const isLogin = submitBtn.textContent === '登录';

    const authMessage = document.getElementById('authMessage');
    const resendContainer = document.getElementById('resendContainer');
    const resendStatus = document.getElementById('resendStatus');
    const resendLink = document.getElementById('resendLink');
    if (authMessage) authMessage.textContent = '';
    if (resendContainer) resendContainer.style.display = 'none';
    if (resendStatus) resendStatus.textContent = '';

    if (!username || !password || (!isLogin && !email)) {
        uiToast(isLogin ? '请填写用户名和密码' : '请填写用户名、邮箱和密码','error');
        return;
    }

    try {
        const response = await fetch(`/api/${isLogin ? 'login' : 'register'}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(isLogin ? { username, password } : { username, password, email })
        });

        const result = await response.json();

        if (response.ok) {
            if (isLogin) {
                const canonical = (result && result.username) ? result.username : username;
                currentUser = canonical;
                localStorage.setItem('kanbanUser', canonical);
                showProjectPage();
            } else {
                if (authMessage) {
                    authMessage.textContent = '注册成功，请前往邮箱验证后再登录。';
                } else {
                    uiToast('注册成功，请前往邮箱验证后再登录。','success');
                }
                formTitle.textContent = '登录';
                submitBtn.textContent = '登录';
                switchText.textContent = '还没有账号？';
                switchMode.textContent = '注册';
                if (emailInput) emailInput.style.display = 'none';
            }
        } else {
            const msg = result && result.message ? result.message : `${isLogin ? '登录' : '注册'}失败`;
            if (isLogin && msg.includes('邮箱未验证')) {
                if (authMessage) authMessage.textContent = msg;
                if (resendContainer) resendContainer.style.display = '';
                if (resendLink) {
                    resendLink.onclick = async (evt) => {
                        evt.preventDefault();
                        resendStatus.textContent = '发送中...';
                        try {
                            const rs = await fetch('/api/resend-verification', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ username })
                            });
                            const rj = await rs.json().catch(() => ({}));
                            if (rs.ok) {
                                resendStatus.textContent = '已发送，请查收邮箱。';
                            } else {
                                resendStatus.textContent = rj.message || '发送失败，请稍后再试。';
                            }
                        } catch (e) {
                            resendStatus.textContent = '网络错误，请稍后再试。';
                        }
                    };
                }
            } else {
                uiToast(msg,'error');
            }
        }
    } catch (error) {
        console.error('Auth error:', error);
        uiToast('网络错误，请稍后重试','error');
    }
}

// 加载用户数据
async function loadUserProjects() {
    if (!currentUser) return;
    const token = ++userProjectsLoadToken;
    try {
        const response = await fetch(`/api/user-projects/${currentUser}`);
        const projects = await response.json();

        // 设置用户名
        document.getElementById('currentUserName').textContent = currentUser;

        if (projects.length === 0) {
            if (token !== userProjectsLoadToken) return;
            const qab = document.getElementById('quickAccessBoards');
            const pl = document.getElementById('projectsList');
            if (qab) qab.innerHTML = '<div class="empty-state">还没有加入任何项目，请先创建或加入一个项目！</div>';
            if (pl) pl.innerHTML = '<div class="empty-state">还没有项目，创建第一个项目开始协作吧！</div>';
            return;
        }

        const quickAccessBoards = document.getElementById('quickAccessBoards');
        const projectsList = document.getElementById('projectsList');

        // 清空现有内容，避免重复
        if (token !== userProjectsLoadToken) return;
        if (quickAccessBoards) quickAccessBoards.innerHTML = '';
        if (projectsList) projectsList.innerHTML = '';

        // 并发获取所有项目的看板数据，并批量渲染，避免逐个等待导致卡顿
        const projectFetches = projects.map(project => (async () => {
            try {
                let boardsData = { boards: [], boardOwners: {} };
                if (project.boardCount > 0) {
                    const boardsResponse = await fetch(`/api/project-boards/${project.id}`);
                    boardsData = await boardsResponse.json();
                }
                return { project, boardsData };
            } catch (error) {
                console.error(`Error loading boards for project ${project.id}:`, error);
                return { project, boardsData: { boards: [], boardOwners: {} } };
            }
        })());

        const results = await Promise.all(projectFetches);

        if (token !== userProjectsLoadToken) return;

        const qabFrag = document.createDocumentFragment();
        const plFrag = document.createDocumentFragment();

        results.forEach(({ project, boardsData }) => {
            // 添加快速访问看板
            (boardsData.boards || []).forEach(boardName => {
                if (token !== userProjectsLoadToken) return;
                const boardCard = document.createElement('div');
                boardCard.className = 'quick-board-card board-card-with-actions';
                boardCard.onclick = () => {
                    currentProjectId = project.id;
                    currentProjectName = project.name;
                    currentBoardName = boardName;
                    previousPage = 'project'; // 从项目首页直接进入看板
                    showBoard();
                };

                const owner = (boardsData.boardOwners && boardsData.boardOwners[boardName]) || '';

                boardCard.innerHTML = `
                    <span class="board-icon" data-icon="boards"></span>
                    <div class="board-details">
                        <h4>${escapeHtml(boardName)}</h4>
                        <span class="board-project">${escapeHtml(project.name)}</span>
                    </div>
                    ${owner ? `<div class=\"card-owner\">创建者：${escapeHtml(owner)}</div>` : ''}
                    <div class="board-card-actions">
                        <button class="board-action-btn rename-btn" onclick="event.stopPropagation(); promptRenameBoardFromHome('${project.id}', '${escapeJs(boardName)}')" title="重命名">✎</button>
                        <button class="board-action-btn delete-btn" onclick="event.stopPropagation(); deleteBoardFromHome('${escapeJs(boardName)}', '${project.id}')" title="删除看板">✕</button>
                    </div>
                `;
                qabFrag.appendChild(boardCard);
            });

            // 添加项目卡片到项目管理Tab
            if (token !== userProjectsLoadToken) return;
            const projectCard = document.createElement('div');
            projectCard.className = 'project-card project-card-with-actions';
            projectCard.onclick = () => selectProject(project.id, project.name);

            projectCard.innerHTML = `
                <h3><span class="project-icon" data-icon="folder"></span>${escapeHtml(project.name)}</h3>
                <div class="project-info">
                    邀请码: <span class="invite-code">${project.inviteCode}</span> <button class="btn-secondary" onclick="event.stopPropagation(); copyCode('${escapeJs(project.inviteCode)}')">复制</button><br>
                    成员: ${project.memberCount}人<br>
                    看板: ${project.boardCount}个<br>
                    创建于: ${new Date(project.created).toLocaleDateString()}
                </div>
                <div class="project-card-actions">
                    <button class="project-action-btn rename-btn" onclick="event.stopPropagation(); renameProjectFromHome('${project.id}', '${escapeJs(project.name)}')" title="重命名项目">✎</button>
                    <button class="project-action-btn delete-btn" onclick="event.stopPropagation(); deleteProjectFromHome('${project.id}', '${escapeJs(project.name)}')" title="删除项目">✕</button>
                </div>
                <div class="card-owner">所有者：${escapeHtml(project.owner || '')}</div>
            `;
            plFrag.appendChild(projectCard);
        });

        if (token !== userProjectsLoadToken) return;
        if (quickAccessBoards) {
            quickAccessBoards.appendChild(qabFrag);
            renderIconsInDom(quickAccessBoards);
        }
        if (projectsList) {
            projectsList.appendChild(plFrag);
            renderIconsInDom(projectsList);
        }

    } catch (error) {
        console.error('Load projects error:', error);
        uiToast('加载项目列表失败','error');
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

// 新增：重命名项目
async function renameProject() {
    const input = await uiPrompt('输入新的项目名称', currentProjectName || '', '重命名项目');
    if (input === null) return;
    const newName = input.trim();
    if (!newName) { uiToast('新名称不能为空','error'); return; }
    if (newName === currentProjectName) return;

    fetch('/api/rename-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: currentProjectId, newName })
    }).then(async (response) => {
        const result = await response.json().catch(() => ({}));
        if (response.ok) {
            currentProjectName = newName;
            localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
            const projectTitle = document.getElementById('projectTitle');
            if (projectTitle) projectTitle.textContent = newName;
            updateBoardHeader();
            if (!projectPage.classList.contains('hidden')) {
                loadUserProjects();
            }
            if (!boardSelectPage.classList.contains('hidden')) {
                loadProjectBoards();
            }
            uiToast('项目重命名成功','success');
        } else {
            uiToast(result.message || '项目重命名失败','error');
        }
    }).catch((error) => {
        console.error('Rename project error:', error);
        uiToast('项目重命名失败','error');
    });
}

// 创建项目
async function createProject() {
    const projectName = document.getElementById('newProjectName').value.trim();
    if (!projectName) {
        uiToast('请输入项目名称','error');
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
            uiToast(`项目创建成功！邀请码：${result.inviteCode}`,'success');
        } else {
            uiToast(result.message || '创建项目失败','error');
        }
    } catch (error) {
        console.error('Create project error:', error);
        uiToast('创建项目失败','error');
    }
}

// 加入项目
async function joinProject() {
    const inviteCode = document.getElementById('inviteCode').value.trim().toUpperCase();
    if (!inviteCode || inviteCode.length !== 6) {
        uiToast('请输入6位邀请码','error');
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
            uiToast('已提交申请，等待项目所有者审批','success');
        } else {
            uiToast(result.message || '加入项目失败','error');
        }
    } catch (error) {
        console.error('Join project error:', error);
        uiToast('加入项目失败','error');
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
        window.currentProjectOwner = data.owner;
        window.currentBoardOwners = data.boardOwners || {};
        window.currentPendingRequests = data.pendingRequests || [];

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

            const owner = (window.currentBoardOwners && window.currentBoardOwners[boardName]) || '';
            const canManage = (currentUser && (currentUser === window.currentProjectOwner || currentUser === owner));

            boardCard.innerHTML = `
                <div class="board-icon" style="display:none"></div>
                <div class="board-details">
                    <h4>${escapeHtml(boardName)}</h4>
                    <span class="board-project">${escapeHtml(currentProjectName)}</span>
                </div>
                ${owner ? `<div class=\"card-owner\">创建者：${escapeHtml(owner)}</div>` : ''}
                <div class="board-card-actions" ${canManage ? '' : 'style="display:none"'}>
                    <button class="board-action-btn rename-btn" onclick="event.stopPropagation(); promptRenameBoard('${escapeJs(boardName)}')" title="重命名">✎</button>
                    <button class="board-action-btn delete-btn" onclick="event.stopPropagation(); deleteBoard('${escapeJs(boardName)}')" title="删除看板">✕</button>
                </div>
            `;

            boardList.appendChild(boardCard);
        });

    } catch (error) {
        console.error('Load boards error:', error);
        uiToast('加载看板列表失败','error');
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
        uiToast('请输入看板名称','error');
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
                boardName,
                actor: currentUser
            })
        });

        const result = await response.json();

        if (response.ok) {
            document.getElementById('newBoardName').value = '';
            loadProjectBoards();
            uiToast('看板创建成功！','success');
        } else {
            uiToast(result.message || '创建看板失败','error');
        }
    } catch (error) {
        console.error('Create board error:', error);
        uiToast('创建看板失败','error');
    }
}

// 删除看板
async function deleteBoard(boardName) {
    const ok = await uiConfirm(`确定要删除看板 "${boardName}" 吗？\n\n⚠️ 删除后看板内的所有任务都将永久丢失，此操作无法撤销！`, '删除看板');
    if (!ok) return;

    try {
        const response = await fetch('/api/delete-board', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectId: currentProjectId,
                boardName,
                actor: currentUser
            })
        });

        const result = await response.json();

        if (response.ok) {
            loadProjectBoards();
            uiToast('看板删除成功！','success');
        } else {
            uiToast(result.message || '删除看板失败','error');
        }
    } catch (error) {
        console.error('Delete board error:', error);
        uiToast('删除看板失败','error');
    }
}

// 从首页删除看板
async function deleteBoardFromHome(boardName, projectId) {
    const ok = await uiConfirm(`确定要删除看板 "${boardName}" 吗？\n\n⚠️ 删除后看板内的所有任务都将永久丢失，此操作无法撤销！`, '删除看板');
    if (!ok) return;

    try {
        const response = await fetch('/api/delete-board', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                projectId: projectId,
                boardName,
                actor: currentUser
            })
        });

        const result = await response.json();

        if (response.ok) {
            loadUserProjects();
            uiToast('看板删除成功！','success');
        } else {
            uiToast(result.message || '删除看板失败','error');
        }
    } catch (error) {
        console.error('Delete board from home error:', error);
        uiToast('删除看板失败','error');
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
                if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
                    clientLists = boardData.lists;
                    // ensure arrays exist for every list status
                    clientLists.listIds.forEach(id => {
                        const st = clientLists.lists[id] && clientLists.lists[id].status;
                        if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                    });
                    saveClientListsToStorage();
                }
                pendingBoardUpdate = true;
                scheduleDeferredRender();
                // 如果编辑模态打开，刷新评论列表
                if (editingCardId && !editModal.classList.contains('hidden')) {
                    const c = getCardById(editingCardId);
                    if (c) { try { renderEditPostsList(c); } catch(e) {} }
                }
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
            uiToast(data.message || '导入成功','success');
            break;
        case 'error':
            uiToast(data.message || '发生错误','error');
            break;
        case 'board-renamed':
            if (data.projectId === currentProjectId && data.oldName === currentBoardName) {
                currentBoardName = data.newName;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                updateBoardHeader();
                try { if (socket) socket.close(); } catch (e) {}
                connectWebSocket();
                loadBoardData();
            }
            break;
        case 'project-renamed':
            if (data.projectId === currentProjectId) {
                currentProjectName = data.newName;
                localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
                const projectTitle = document.getElementById('projectTitle');
                if (projectTitle) projectTitle.textContent = currentProjectName;
                updateBoardHeader();
                if (!boardSelectPage.classList.contains('hidden')) {
                    loadProjectBoards();
                }
            }
            break;
        // 新增：项目被删除
        case 'project-deleted':
            if (data.projectId === currentProjectId) {
                // 当前所在项目被删除，断开连接并返回首页
                if (socket) { try { socket.close(); } catch (e) {} }
                currentProjectId = null;
                currentProjectName = null;
                currentBoardName = null;
                localStorage.removeItem('kanbanCurrentProjectId');
                localStorage.removeItem('kanbanCurrentProjectName');
                localStorage.removeItem('kanbanCurrentBoardName');
                if (typeof projectPage !== 'undefined' && projectPage && projectPage.classList.contains('hidden')) { showProjectPage(); }
                loadUserProjects();
                uiToast('当前项目已被删除','error');
            }
            break;
        case 'member-removed':
            if (data.projectId === currentProjectId && data.username === currentUser) {
                // 自己被移除出项目：断开连接并返回首页
                forceExitCurrentProject('已被移出项目');
            }
            break;
        case 'join-request':
            if (data.projectId === currentProjectId) {
                renderPendingRequests(true);
                // If on board-select or project page, also show a light indicator
                try {
                    const h = document.querySelector('#boardSelectPage .board-select-header h1');
                    if (h) {
                        let badge = document.getElementById('pendingBadge');
                        if (!badge) {
                            badge = document.createElement('span');
                            badge.id = 'pendingBadge';
                            badge.style.marginLeft = '8px';
                            badge.style.fontSize = '12px';
                            badge.style.color = '#2563eb';
                            badge.textContent = '有待审批';
                            h.appendChild(badge);
                        }
                    }
                } catch (e) {}
                const pname = currentProjectName || '项目';
                uiToast(`${data.username} 申请加入「${pname}」`,'info');
            }
            break;
        case 'member-added':
            if (data.projectId === currentProjectId) {
                // 若是我被加入，刷新成员列表
                if (data.username === currentUser) {
                    loadUserProjects();
                }
                // 刷新成员显示
                renderPendingRequests(true);
                loadProjectBoards();
            }
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
    ensureClientLists();
    const container = document.getElementById('listsContainer');
    if (!container) return;

    // capture current columns scroll positions to restore after render
    const prevScrollTop = {};
    try {
        container.querySelectorAll('.column').forEach(col => {
            const st = col.getAttribute('data-status');
            if (st) prevScrollTop[st] = col.scrollTop;
        });
    } catch(e) {}

    container.innerHTML = '';

    clientLists.listIds
        .map(id => clientLists.lists[id])
        .sort((a,b)=>a.pos-b.pos)
        .forEach(list => {
            const section = document.createElement('section');
            section.className = 'list column';
            section.setAttribute('data-status', list.status);
            section.setAttribute('data-id', list.id);

            const header = document.createElement('header');
            header.className = 'list-header';
            header.innerHTML = `
                <h3 class="list-title" tabindex="0">${escapeHtml(list.title)}</h3>
                <div class="list-actions">
                    <button class="list-archive" title="归档此卡组全部卡片" aria-label="归档卡组"></button>
                <button class="list-menu" aria-label="删除"></button>
                </div>
            `;
            section.appendChild(header);

            const cardsEl = document.createElement('div');
            cardsEl.className = 'cards';
            cardsEl.setAttribute('role','list');
            section.appendChild(cardsEl);

            const cards = getCardsByStatus(list.status);
            cards.forEach(c => cardsEl.appendChild(createCardElement(c, list.status)));

            // composer
            const composerWrap = document.createElement('div');
            composerWrap.className = 'card-composer add-card';
            composerWrap.innerHTML = `
                <button class="composer-open add-card-link">添加卡片</button>
                <form class="composer" hidden>
                    <textarea rows="3" placeholder="输入标题或粘贴链接"></textarea>
                    <div class="composer-actions">
                        <button type="submit" class="btn-primary">添加卡片</button>
                        <button type="button" class="composer-cancel" aria-label="取消">×</button>
                    </div>
                </form>
            `;
            section.appendChild(composerWrap);

            container.appendChild(section);
            // binders and drag set later below
        });

    // restore scroll positions per column
    try {
        Object.keys(prevScrollTop).forEach(st => {
            const col = container.querySelector(`.column[data-status="${st}"]`);
            if (col && typeof prevScrollTop[st] === 'number') col.scrollTop = prevScrollTop[st];
        });
    } catch (e) {}

    // bind list title inline rename
    container.querySelectorAll('.list').forEach(section => {
        const id = section.getAttribute('data-id');
        const list = clientLists.lists[id];
        bindListTitleInlineRename(section, list);
        bindListMenu(section, list);
        const archBtn = section.querySelector('.list-archive');
        if (archBtn) archBtn.onclick = async (e)=>{ e.stopPropagation(); await archiveList(list.status); };
        bindComposer(section, list);
        enableColumnDrag(list.status);
    });

    // add-list entry (UI only, maps to new status placeholders if needed)
    renderAddListEntry(container);

    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }

    // enable lists drag after render
    enableListsDrag();

    // Add after renderBoard
    adjustBoardCentering();
}

function renderAddListEntry(container){
    let add = document.getElementById('addListEntry');
    if (add) add.remove();
    add = document.createElement('div');
    add.id = 'addListEntry';
    add.className = 'add-list column';
    add.innerHTML = `
        <button class="add-list-open">+</button>
        <form class="add-list-form" hidden>
            <input type="text" placeholder="输入卡组名称" />
            <div class="actions">
                <button type="submit" class="btn-primary">添加卡组</button>
                <button type="button" class="add-list-cancel">取消</button>
                </div>
        </form>
    `;
    container.appendChild(add);

    const openBtn = add.querySelector('.add-list-open');
    const form = add.querySelector('.add-list-form');
    const input = form.querySelector('input');
    const cancel = form.querySelector('.add-list-cancel');

    openBtn.onclick = ()=>{ openBtn.hidden = true; form.hidden = false; input.focus(); };
    cancel.onclick = ()=>{ form.hidden = true; openBtn.hidden = false; input.value=''; };
    form.addEventListener('submit', (e)=>{
                    e.preventDefault();
        const name = (input.value||'').trim();
        if(!name) return;
        addClientList(name);
        input.value='';
        form.hidden = true; openBtn.hidden = false;
    });
}

function addClientList(title){
    ensureClientLists();
    const id = 'list_' + Date.now().toString(36);
    const pos = clientLists.listIds.length;
    const status = id; // unique status per list
    clientLists.lists[id] = { id, title, pos, status };
    clientLists.listIds.push(id);
    if (!Array.isArray(boardData[status])) boardData[status] = [];
    saveClientListsToStorage();
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'save-lists', projectId: currentProjectId, boardName: currentBoardName, lists: clientLists }));
    }
    renderBoard();
}
function pickAvailableStatusKey(){
    return 'list_' + Math.random().toString(36).slice(2, 8);
}

function bindListTitleInlineRename(section, list){
    const titleEl = section.querySelector('.list-title');
    titleEl.addEventListener('click', ()=>startListRename(titleEl, list));
    titleEl.addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); startListRename(titleEl, list);} });
}
function startListRename(titleEl, list){
    const old = list.title;
    const input = document.createElement('input');
    input.type='text'; input.value=old; input.className='list-title-input';
    titleEl.replaceWith(input); input.focus(); input.select();
    let canceled=false;
    input.addEventListener('keydown', (e)=>{
        if(e.key==='Enter'){ e.preventDefault(); input.blur(); }
        if(e.key==='Escape'){ canceled=true; input.blur(); }
    });
    input.addEventListener('blur', ()=>{
        const val = (input.value||'').trim();
        const next = canceled? old : (val || old);
        list.title = next;
        const h = document.createElement('h3'); h.className='list-title'; h.tabIndex=0; h.textContent=next;
        input.replaceWith(h);
        bindListTitleInlineRename(h.closest('.list'), list);
        saveClientListsToStorage();
        // sync to server
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type:'save-lists', projectId: currentProjectId, boardName: currentBoardName, lists: clientLists }));
        }
    });
}
function bindListMenu(section, list){
    const btn = section.querySelector('.list-menu');
    btn.onclick = async (e)=>{
        e.stopPropagation();
        const ok = await uiConfirm('删除该卡组？','删除卡组');
        if(ok){ removeClientList(list.id); }
    };
}
function removeClientList(listId){
    ensureClientLists();
    clientLists.listIds = clientLists.listIds.filter(id=>id!==listId);
    delete clientLists.lists[listId];
    saveClientListsToStorage();
    // sync to server
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'save-lists', projectId: currentProjectId, boardName: currentBoardName, lists: clientLists }));
    }
    renderBoard();
}

function bindComposer(section, list){
    const opener = section.querySelector('.composer-open');
    const form = section.querySelector('.composer');
    const textarea = form.querySelector('textarea');
    const cancel = section.querySelector('.composer-cancel');

    let isCancelling = false;
    let isSubmitting = false;
    let isComposingIme = false;

    function open(){
        const wrap = section.querySelector('.card-composer');
        wrap.classList.add('is-open');
        form.hidden = false;
        textarea.focus();
    }
    function close(){
        const wrap = section.querySelector('.card-composer');
        wrap.classList.remove('is-open');
        form.hidden = true;
        textarea.value='';
    }

    opener.onclick = (e)=>{ e.preventDefault(); open(); };
    cancel.onmousedown = ()=>{ isCancelling = true; };
    cancel.onclick = (e)=>{ e.preventDefault(); isCancelling = true; close(); setTimeout(()=>{ isCancelling = false; },0); };

    textarea.addEventListener('compositionstart', ()=>{ isComposingIme = true; });
    textarea.addEventListener('compositionend', ()=>{ isComposingIme = false; });

    form.addEventListener('keydown',(e)=>{
        if (e.isComposing || e.keyCode === 229 || isComposingIme) return; // ignore IME confirm
        if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); submit(); }
        if(e.key==='Escape'){ e.preventDefault(); close(); }
    });
    textarea.addEventListener('blur', ()=>{
        if (isSubmitting) return;
        if(isCancelling){ isCancelling=false; return; }
        const active = document.activeElement;
        const isSubmitBtn = active && active.closest && active.closest('.composer-actions') && active.type === 'submit';
        if (isSubmitBtn) return;
        if(textarea.value.trim()) submit(); else close();
    });
    form.addEventListener('submit',(e)=>{ e.preventDefault(); if (!isSubmitting) submit(); });

    // click outside to close when empty
    document.addEventListener('mousedown', (ev)=>{
        const wrap = section.querySelector('.card-composer');
        if (!wrap) return;
        if (!wrap.contains(ev.target) && wrap.classList.contains('is-open')) {
            if (!textarea.value.trim()) close();
        }
    });

    function submit(){
        if (isSubmitting) return;
        isSubmitting = true;
        const title = textarea.value.trim();
        if(!title){ isSubmitting = false; return; }
        const status = list.status;
        const card = {
            id: Date.now().toString(),
            title: title,
            description: '',
            author: currentUser,
            assignee: null,
            created: new Date().toISOString(),
            deadline: null,
            posts: [],
            commentsCount: 0
        };
        if (!Array.isArray(boardData[status])) boardData[status]=[];
        boardData[status] = [...boardData[status], card];
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type:'add-card', projectId: currentProjectId, boardName: currentBoardName, status, card, position:'bottom' }));
        }
        // collapse composer before drawing
        const wrapBefore = section.querySelector('.card-composer');
        if (wrapBefore) { wrapBefore.classList.remove('is-open'); }
        // append card DOM directly to avoid full re-render jitter
        let cardsContainer = section.querySelector('.cards');
        if (!cardsContainer) {
            const col = document.querySelector(`.column[data-status="${status}"]`);
            cardsContainer = col ? col.querySelector('.cards') : null;
        }
        if (cardsContainer) {
            const el = createCardElement(card, status);
            cardsContainer.appendChild(el);
            makeDraggable(el);
        } else {
            renderBoard();
        }
        setTimeout(()=>{ isSubmitting = false; }, 300);
    }
}

// Inline edit card title by clicking title area only (not whole card)
(function bindInlineCardTitle(){
    document.addEventListener('click',(e)=>{
        const title = e.target.closest('.card .card-title');
        if(!title) return;
        const cardEl = title.closest('.card');
        inlineEditCardTitle(cardEl);
        e.stopPropagation();
    });
})();

function inlineEditCardTitle(cardEl){
    const view = cardEl.querySelector('.card-title');
    const old = view ? (view.textContent || '') : '';
    const input = document.createElement('textarea');
    input.className = 'card-title-input';
    input.value = old;
    input.rows = 1;
    if (view) view.replaceWith(input);
    try { autoResizeTextarea(input); } catch(e) {}
    input.focus();
    try { input.setSelectionRange(old.length, old.length); } catch(e) {}
    let canceled = false;
    input.addEventListener('keydown',(e)=>{
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); input.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); canceled = true; input.blur(); }
    });
    input.addEventListener('blur', ()=>{
        const val = input.value.trim();
        const next = (canceled ? old : (val || old));
        const t = document.createElement('div'); t.className='card-title'; t.textContent = next; t.tabIndex = 0;
        input.replaceWith(t);
        if (!canceled && val && val !== old) { saveCardTitle(cardEl.dataset.cardId, val); }
    });
}

function saveCardTitle(cardId, title){ updateCardField(cardId, 'title', title); }
// ===== End Lists Adapter =====

// 渲染归档页面
function renderArchive() {
    const archivedCards = document.getElementById('archivedCards');
    const archivedCount = document.getElementById('archivedCount');

    archivedCards.innerHTML = '';
    const cards = boardData.archived || [];
    archivedCount.textContent = cards.length;

    // 保持当前顺序
    const sortedCards = cards.slice();

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

    const labels = Array.isArray(card.labels) ? card.labels.slice(0, 5) : [];
    const labelDots = labels.map(color => `<span class="label label-${color}"></span>`).join('');

    const dueClass = card.deadline ? (new Date(card.deadline) < new Date() ? 'overdue' : (daysUntil(card.deadline) <= 1 ? 'soon' : '')) : '';
    const descIcon = card.description ? `<span class="badge-icon desc" title="有描述">≡</span>` : '';
    const commentsBadge = card.commentsCount > 0 ? `<span class="badge comments" title="${card.commentsCount} 条评论">💬 ${card.commentsCount}</span>` : '';

    const assigneeHtml = card.assignee
        ? `<span class="card-assignee clickable" onclick="event.stopPropagation(); editCardAssignee('${card.id}')" title="点击修改分配用户">@${escapeHtml(card.assignee)}</span>`
        : '';
    const deadlineHtml = card.deadline
        ? `<span class="card-deadline clickable" onclick="event.stopPropagation(); editCardDeadline('${card.id}')" title="点击修改截止日期">${card.deadline}</span>`
        : '';

    const moreBtn = `<button class="card-quick" onclick="event.stopPropagation(); openEditModal('${card.id}')" aria-label="编辑"></button>`;

    const archiveBtn = (status !== 'archived')
        ? ``
        : '';

    const deleteBtn = (status === 'archived')
        ? `<button class="card-quick-delete" onclick="event.stopPropagation(); deleteArchivedCard('${card.id}')" aria-label="删除"></button>`
        : '';

    const restoreChip = (status === 'archived')
        ? `<div class="card-actions-row"><div class="actions-inline"><button class="restore-chip" onclick="event.stopPropagation(); restoreCard('${card.id}')">还原</button></div></div>`
        : '';

    const badges = `${descIcon}${commentsBadge}${deadlineHtml}${assigneeHtml}`;

    cardElement.innerHTML = `
        <div class="card-labels">${labelDots}</div>
        <div class="card-title">${escapeHtml(card.title || '未命名')}</div>
        ${badges ? `<div class="card-badges">${badges}</div>` : ''}
        ${restoreChip}
        ${archiveBtn}
        ${deleteBtn}
        ${moreBtn}
    `;

    cardElement.addEventListener('click', (e) => {
        if (e.target.closest('.card-quick') || e.target.closest('.card-quick-archive') || e.target.closest('.card-quick-delete') || e.target.closest('.restore-chip')) return;
        if (e.target.closest('.card-assignee') || e.target.closest('.card-deadline')) return;
        // If inline editors are open within this card, keep editing instead of opening details
        const inlineEditor = cardElement.querySelector('.inline-title-input, .card-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown');
        if (inlineEditor) { try { inlineEditor.focus(); } catch(e) {} return; }
        if (e.target.closest('.card-title')) { inlineEditCardTitle(cardElement); return; }
        openEditModal(card.id);
    });

    return cardElement;
}

function formatDue(dateStr) {
    try {
        const d = new Date(dateStr);
        const now = new Date();
        const sameYear = d.getFullYear() === now.getFullYear();
        return sameYear ? `${d.getMonth()+1}-${String(d.getDate()).padStart(2,'0')}` : `${d.getFullYear()}-${d.getMonth()+1}-${String(d.getDate()).padStart(2,'0')}`;
    } catch { return dateStr; }
}
function daysUntil(dateStr) {
    try { return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86400000); } catch { return 9999; }
}
function initials(name){
    if(!name) return '';
    const parts = String(name).trim().split(/\s+/);
    if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

// Drawer state
let drawerCardId = null;
const drawerEl = typeof document !== 'undefined' ? document.getElementById('cardModal') : null;

function openCardModal(cardId){
    // Locate card data
    let card = null;
    let status = null;
    for (const s of getAllStatusKeys()){
        const found = (boardData[s]||[]).find(c=>c.id===cardId);
        if(found){ card = found; status = s; break; }
    }
    if(!card) return;

    drawerCardId = cardId;
    // Fill fields
    const title = document.getElementById('drawerTitle');
    const desc = document.getElementById('drawerDescription');
    const assignee = document.getElementById('drawerAssignee');
    const deadline = document.getElementById('drawerDeadline');
    const priority = document.getElementById('drawerPriority');
    const commentsBadge = document.getElementById('drawerCommentsBadge');
    const attachBadge = document.getElementById('drawerAttachBadge');

    title.value = card.title || '';
    desc.value = card.description || '';

    // members list
    assignee.innerHTML = '<option value="">未分配</option>';
    (window.currentProjectMembers || []).forEach(u=>{
        const op = document.createElement('option'); op.value=u; op.textContent=u; assignee.appendChild(op);
    });
    assignee.value = card.assignee || '';

    deadline.value = card.deadline || '';
    priority.value = card.priority || '';
    commentsBadge.textContent = `💬 ${card.commentsCount||0}`;
    attachBadge.textContent = `📎 ${card.attachmentsCount||0}`;

    // labels
    const labelsWrap = document.getElementById('drawerLabels');
    const current = new Set(card.labels || []);
    labelsWrap.querySelectorAll('input[type="checkbox"]').forEach(chk=>{
        chk.checked = current.has(chk.value);
    });

    // checklist render
    renderDrawerChecklist(card);

    // open
    drawerEl.hidden = false;
    drawerEl.classList.add('open');
    setTimeout(()=>drawerEl.classList.add('open'),0);

    // announce editing
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

    // a11y focus
    try { document.getElementById('drawerTitle').focus(); } catch {}
}

function closeCardModal(){
    if(!drawerEl) return;
    if (drawerCardId && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'card-editing', projectId: currentProjectId, boardName: currentBoardName,
            cardId: drawerCardId, user: currentUser, editing: false
        }));
    }
    drawerCardId = null;
    drawerEl.classList.remove('open');
    drawerEl.hidden = true;
}

function gatherDrawerUpdates(){
    if(!drawerCardId) return null;
    const title = document.getElementById('drawerTitle').value.trim();
    const description = document.getElementById('drawerDescription').value;
    const assignee = document.getElementById('drawerAssignee').value || null;
    const deadline = document.getElementById('drawerDeadline').value || null;
    const priority = document.getElementById('drawerPriority').value || null;

    // labels
    const labels = Array.from(document.querySelectorAll('#drawerLabels input[type="checkbox"]:checked')).map(i=>i.value);

    // checklist
    const checklist = getDrawerChecklist();

    // counters from local badges (comments/attachments are optional, updated via quick inputs)
    const commentsCount = parseInt((document.getElementById('drawerCommentsBadge').textContent||'0').replace(/[^0-9]/g,''),10) || 0;
    const attachmentsCount = parseInt((document.getElementById('drawerAttachBadge').textContent||'0').replace(/[^0-9]/g,''),10) || 0;

    return { title, description, assignee, deadline, priority, labels, checklist, commentsCount, attachmentsCount };
}

function saveCardFromDrawer(){
    if(!drawerCardId) return;
    const updates = gatherDrawerUpdates();
    if (!updates.title) { uiToast('任务标题不能为空','error'); return; }

    // local update to avoid flicker
    for (const s of getAllStatusKeys()){
        const i = (boardData[s]||[]).findIndex(c=>c.id===drawerCardId);
        if(i!==-1){ boardData[s][i] = Object.assign({}, boardData[s][i], updates); break; }
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'update-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: drawerCardId,
            updates
        }));
    }

    closeCardModal();
    renderBoard();
}

async function deleteCardFromDrawer(){
    if(!drawerCardId) return;
    { const ok = await uiConfirm('确定要删除这个任务吗？','删除任务'); if (!ok) return; }
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'delete-card', projectId: currentProjectId, boardName: currentBoardName, cardId: drawerCardId
        }));
    }
    closeCardModal();
}

// Checklist logic (lightweight, local aggregation)
function renderDrawerChecklist(card){
    const wrap = document.getElementById('drawerChecklistList');
    wrap.innerHTML = '';
    const items = (card.checklist && Array.isArray(card.checklist.items)) ? card.checklist.items : [];

    items.forEach((it, idx)=>{
        const row = document.createElement('div');
        row.className = 'drawer-row';
        row.innerHTML = `<input type="checkbox" ${it.done?'checked':''} data-idx="${idx}"> <input type="text" value="${escapeHtml(it.text||'')}" data-idx="${idx}">`;
        wrap.appendChild(row);
    });

    const input = document.getElementById('drawerChecklistInput');
    input.onkeydown = (e)=>{
        if(e.key==='Enter' && input.value.trim()){
            const text = input.value.trim();
            const card = getCardById(drawerCardId);
            const items = (card.checklist && Array.isArray(card.checklist.items)) ? card.checklist.items.slice() : [];
            items.push({ text, done:false });
            const total = items.length; const done = items.filter(i=>i.done).length;
            const updates = { checklist: { items, total, done } };
            updateCardImmediately(drawerCardId, updates);
            input.value='';
            renderDrawerChecklist(getCardById(drawerCardId));
        }
    };

    // bind existing rows
    wrap.querySelectorAll('input[type="checkbox"]').forEach(chk=>{
        chk.onchange = ()=>{
            const idx = parseInt(chk.getAttribute('data-idx'),10);
            const card = getCardById(drawerCardId);
            const items = (card.checklist && Array.isArray(card.checklist.items)) ? card.checklist.items.slice() : [];
            if(items[idx]) items[idx] = Object.assign({}, items[idx], { done: chk.checked });
            const total = items.length; const done = items.filter(i=>i.done).length;
            updateCardImmediately(drawerCardId, { checklist: { items, total, done } });
            renderDrawerChecklist(getCardById(drawerCardId));
        };
    });
    wrap.querySelectorAll('input[type="text"]').forEach(inp=>{
        inp.onblur = ()=>{
            const idx = parseInt(inp.getAttribute('data-idx'),10);
            const card = getCardById(drawerCardId);
            const items = (card.checklist && Array.isArray(card.checklist.items)) ? card.checklist.items.slice() : [];
            if(items[idx]) items[idx] = Object.assign({}, items[idx], { text: inp.value });
            const total = items.length; const done = items.filter(i=>i.done).length;
            updateCardImmediately(drawerCardId, { checklist: { items, total, done } });
        };
    });
}

function getDrawerChecklist(){
    const card = getCardById(drawerCardId) || {};
    return card.checklist || undefined;
}

function getCardById(id){
    for (const s of getAllStatusKeys()){
        const found = (boardData[s]||[]).find(c=>c.id===id);
        if(found) return found;
    }
    return null;
}

function updateCardImmediately(cardId, updates){
    // local
    for (const s of getAllStatusKeys()){
        const i = (boardData[s]||[]).findIndex(c=>c.id===cardId);
        if(i!==-1){ boardData[s][i] = Object.assign({}, boardData[s][i], updates); break; }
    }
    // ws
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'update-card', projectId: currentProjectId, boardName: currentBoardName, cardId, updates }));
    }
}

// quick counters in drawer
(function initDrawerQuickInputs(){
    if (typeof document === 'undefined') return;
    const cmt = document.getElementById('drawerCommentInput');
    const attach = document.getElementById('drawerAttachmentInput');
    if (cmt) cmt.addEventListener('keydown', (e)=>{
        if(e.key==='Enter' && drawerCardId){
            const card = getCardById(drawerCardId) || {};
            const commentsCount = (card.commentsCount||0) + 1;
            updateCardImmediately(drawerCardId, { commentsCount });
            const badge = document.getElementById('drawerCommentsBadge');
            if (badge) badge.textContent = `💬 ${commentsCount}`;
            cmt.value='';
        }
    });
    if (attach) attach.addEventListener('change', ()=>{
        if(drawerCardId){
            const card = getCardById(drawerCardId) || {};
            const attachmentsCount = (card.attachmentsCount||0) + (attach.files ? attach.files.length : 1);
            updateCardImmediately(drawerCardId, { attachmentsCount });
            const badge = document.getElementById('drawerAttachBadge');
            if (badge) badge.textContent = `📎 ${attachmentsCount}`;
            attach.value='';
        }
    });
})();

// keyboard: save with Cmd/Ctrl+Enter on description
(function initDrawerKeys(){
    if (typeof document === 'undefined') return;
    const desc = document.getElementById('drawerDescription');
    if (desc) desc.addEventListener('keydown', (e)=>{
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { saveCardFromDrawer(); }
    });
    document.addEventListener('keydown', (e)=>{
        if (drawerCardId && e.key === 'Escape') closeCardModal();
    });
})();

// 添加卡片
function addCard(status, position = 'bottom') {
    const base = `new${status.charAt(0).toUpperCase() + status.slice(1)}`;
    const isTop = position === 'top';
    const titleInput = document.getElementById(`${base}${isTop ? 'Top' : ''}Title`);
    const assigneeInput = document.getElementById(`${base}${isTop ? 'Top' : ''}Assignee`);
    const deadlineInput = document.getElementById(`${base}${isTop ? 'Top' : ''}Deadline`);

    const title = titleInput.value.trim();
    if (!title) {
        uiToast('请输入任务标题','error');
        return;
    }

    const card = {
        id: Date.now().toString(),
        title: title,
        description: '',
        author: currentUser,
        assignee: assigneeInput.value || null,
        created: new Date().toISOString(),
        deadline: deadlineInput.value || null,
        posts: [],
        commentsCount: 0
    };

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'add-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            status: status,
            card: card,
            position: isTop ? 'top' : 'bottom'
        }));
    }

    // 本地立即更新以确保位置正确反馈
    if (!Array.isArray(boardData[status])) boardData[status] = [];
    if (isTop) {
        boardData[status] = [card, ...boardData[status]];
    } else {
        boardData[status] = [...boardData[status], card];
    }
    // append new card DOM directly to reduce jitter
    const columnEl = document.querySelector(`.column[data-status="${status}"]`);
    const cardsEl = columnEl ? columnEl.querySelector('.cards') : null;
    if (cardsEl) {
        const el = createCardElement(card, status);
        if (isTop) {
            cardsEl.insertBefore(el, cardsEl.firstChild);
        } else {
            cardsEl.appendChild(el);
        }
        makeDraggable(el);
    } else {
        renderBoard();
    }

    titleInput.value = '';
    assigneeInput.value = '';
    deadlineInput.value = '';

    // collapse the add form back
    const addContainer = columnEl ? columnEl.querySelector(isTop ? '.add-card-top' : '.add-card:not(.add-card-top)') : null;
    if (addContainer && addContainer.__collapseAdd) addContainer.__collapseAdd();
}

// 移动卡片
function moveCard(cardId, direction) {
    const statuses = (clientLists && clientLists.listIds || []).map(id => clientLists.lists[id].status);
    if (!statuses.length) { return; }
    let fromStatus = null;
    let cardIndex = -1;

    for (const status of statuses) {
        const arr = Array.isArray(boardData[status]) ? boardData[status] : [];
        const index = arr.findIndex(card => card.id === cardId);
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
    // find card from any non-archived column
    let fromStatus = null;
    let cardObj = null;
    for (const s of ['todo','doing','done']) {
        const idx = (boardData[s] || []).findIndex(c => c.id === cardId);
        if (idx !== -1) { fromStatus = s; cardObj = boardData[s][idx]; boardData[s].splice(idx,1); break; }
    }
    if (!fromStatus) { return; }
    boardData.archived = boardData.archived || [];
    boardData.archived.push(cardObj);

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'archive-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            cardId: cardId,
            fromStatus
        }));
    }
    renderBoard();
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
async function clearArchive() {
    const ok = await uiConfirm('确定要清空所有归档任务吗？此操作不可恢复。','清空归档');
    if (!ok) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'clear-archive', projectId: currentProjectId, boardName: currentBoardName }));
    }
}

// 打开编辑模态框
function openEditModal(cardId) {
    let card = null;

    for (const status of getAllStatusKeys()) {
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
    // ensure initial sizing reflects current content right away
    try {
        autoResizeTextarea(document.getElementById('editCardTitle'));
        autoResizeTextarea(document.getElementById('editCardDescription'));
    } catch (e) {}
    document.getElementById('editCardCreated').textContent = `创建于: ${new Date(card.created).toLocaleString()}`;
    document.getElementById('editCardAuthor').textContent = `创建者: ${card.author}`;

    // 更新分配用户下拉列表
    updateAssigneeOptions();
    document.getElementById('editCardAssignee').value = card.assignee || '';

    // Auto-resize textareas in modal
    try {
        autoResizeTextarea(document.getElementById('editCardTitle'));
        autoResizeTextarea(document.getElementById('editCardDescription'));
        autoResizeTextarea(document.getElementById('editPostsInput'));
    } catch (e) {}

    // 渲染讨论/评论
    try { renderEditPostsList(card); } catch(e) {}
    const postsInput = document.getElementById('editPostsInput');
    const postsSubmit = document.getElementById('editPostsSubmit');
    if (postsSubmit) {
        postsSubmit.onclick = function(e){ e.preventDefault(); submitNewPost(); };
    }
    if (postsInput) {
        postsInput.onkeydown = function(e){ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') { e.preventDefault(); submitNewPost(); } };
    }

    editModal.classList.remove('hidden');
    // After showing, size textareas based on actual rendered content (run multiple ticks)
    (function(){
        const run = () => {
            try {
                autoResizeTextarea(document.getElementById('editCardTitle'));
                autoResizeTextarea(document.getElementById('editCardDescription'));
                autoResizeTextarea(document.getElementById('editPostsInput'));
            } catch (e) {}
        };
        run();
        try { requestAnimationFrame(run); } catch (e) {}
        setTimeout(run, 0);
        setTimeout(run, 50);
    })();

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
        uiToast('任务标题不能为空','error');
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
async function deleteCard() {
    if (!editingCardId) return;
    const ok = await uiConfirm('确定要删除这个任务吗？','删除任务');
    if (!ok) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'delete-card', projectId: currentProjectId, boardName: currentBoardName, cardId: editingCardId
        }));
    }
    closeEditModal();
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

        // 使用项目成员列表（非仅在线）
        let users = window.currentProjectMembers || [];

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
        } else {
            const text = await response.text().catch(()=> '');
            console.error('Export error:', response.status, text);
            uiToast('导出失败','error');
        }
    } catch (error) {
        console.error('Export error:', error);
        uiToast('导出失败','error');
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
                uiToast('不支持的文件格式，请选择 .json 或 .md 文件','error');
                return;
            }

            importFileData = data;
            importModal.classList.remove('hidden');

        } catch (error) {
            console.error('Import error:', error);
            uiToast('文件格式错误，无法解析','error');
        }
    };
    reader.readAsText(file);
});

// 解析 Markdown 为看板数据
function parseMarkdownToBoard(markdown) {
    const lines = markdown.split('\n');
    const board = { archived: [] };
    const listsMeta = { listIds: [], lists: {} };
    let currentSectionKey = null;
    let currentCard = null;
    let listCounter = 0;

    function ensureSection(key){
        if (!Array.isArray(board[key])) board[key] = [];
    }

    function normalizeHeadingToKey(h){
        const t = h.trim().replace(/^##\s+/, '');
        // legacy quick mapping
        if (t.startsWith('📋') || /\bTODO\b/i.test(t)) return 'todo';
        if (t.startsWith('🔄') || /\bDOING\b/i.test(t)) return 'doing';
        if (t.startsWith('✅') || /\bDONE\b/i.test(t)) return 'done';
        if (t.startsWith('📁') || /\bARCHIVED\b/i.test(t)) return 'archived';
        // dynamic: generate a stable status key from title text
        const base = 'list_' + (++listCounter).toString(36);
        return base;
    }

    function addListMetaIfNeeded(title, statusKey){
        // skip archived in lists meta
        if (statusKey === 'archived') return;
        // create a unique stable id for this list title
        // we cannot derive back original id; generate one
        const id = 'list_' + (listsMeta.listIds.length + 1).toString(36) + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        listsMeta.listIds.push(id);
        listsMeta.lists[id] = { id, title: title, pos: listsMeta.listIds.length - 1, status: statusKey };
    }

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (/^##\s+/.test(line)) {
            // New section
            const heading = line;
            const key = normalizeHeadingToKey(heading);
            const title = heading.replace(/^##\s+/, '').trim();
            currentSectionKey = key;
            ensureSection(key);
            if (key !== 'todo' && key !== 'doing' && key !== 'done' && key !== 'archived') {
                addListMetaIfNeeded(title, key);
            } else if (key !== 'archived') {
                // legacy named list, also add meta with localized title
                addListMetaIfNeeded(title, key);
            }
            currentCard = null;
            continue;
        }
        if (line.startsWith('### ') && currentSectionKey) {
            const title = line.replace(/^###\s*\d+\.\s*/, '').trim();
            currentCard = {
                id: Date.now() + Math.random().toString(),
                title: title,
                description: '',
                author: currentUser,
                assignee: null,
                created: new Date().toISOString(),
                deadline: null
            };
            ensureSection(currentSectionKey);
            board[currentSectionKey].push(currentCard);
            continue;
        }
        if (line.startsWith('**描述:**') && currentCard) {
            currentCard.description = line.replace('**描述:**', '').trim();
            continue;
        }
        if (line.startsWith('**分配给:**') && currentCard) {
            currentCard.assignee = line.replace('**分配给:**', '').trim();
            continue;
        }
        if (line.startsWith('**截止日期:**') && currentCard) {
            currentCard.deadline = line.replace('**截止日期:**', '').trim();
            continue;
        }
    }

    // Attach lists meta if any lists were added
    if (listsMeta.listIds.length > 0) {
        board.lists = listsMeta;
    }

    // Ensure legacy buckets exist if no lists meta (optional)
    board.todo = board.todo || [];
    board.doing = board.doing || [];
    board.done = board.done || [];
    board.archived = board.archived || [];

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
    stopMembershipGuard();
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
function editCardTitle(cardId, clickEvent) {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();

    if (Date.now() - lastEditTime < 30) return;
    lastEditTime = Date.now();

    let card = null;
    let cardStatus = null;

    for (const status of getAllStatusKeys()) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            cardStatus = status;
            break;
        }
    }

    if (!card) return;

    // 标记：正在打开新的内联编辑器，避免WS渲染打断
    inlineEditorOpening = true;

    // 检查是否已经在编辑状态
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const titleElement = cardElement.querySelector('.card-title');
    const titleSpan = titleElement.querySelector('.title-span');

    if (titleElement.querySelector('.inline-title-input')) {
        // 已经在编辑状态，不要重复创建
        return;
    }

    // 先基于原始span计算光标位置
    const targetCaretIndex = getCaretIndexFromSpan(titleSpan, clickEvent.clientX, clickEvent.clientY);
    // 设置待聚焦目标为即将创建的标题输入框
    pendingFocusSelector = `[data-card-id="${cardId}"] .inline-title-input`;
    pendingFocusCaretIndex = targetCaretIndex;

    // 测量span的精确位置和尺寸
    const containerRect = titleElement.getBoundingClientRect();
    const spanRect = titleSpan.getBoundingClientRect();

    const relativeLeft = spanRect.left - containerRect.left;
    const relativeHeight = spanRect.height;

    // 记录当前高度，避免抖动
    const lockedHeight = titleElement.offsetHeight;

    // 创建多行文本编辑框
    const input = document.createElement('textarea');
    input.className = 'inline-title-input';
    input.value = card.title;
    // 不设置width，让CSS样式控制宽度以防止突出

    // 先设置样式，包括隐藏
    titleElement.style.position = 'relative'; // 确保容器是relative
    input.style.position = 'absolute';
    input.style.left = '0px';
    input.style.width = '100%';
    input.style.visibility = 'hidden';

    // 添加到DOM
    titleElement.appendChild(input);

    // 使用requestAnimationFrame进行交换和聚焦
    requestAnimationFrame(() => {
        // 显示编辑器并隐藏原文本
        titleSpan.style.visibility = 'hidden';
        input.style.visibility = 'visible';

        // 锁定容器高度
        titleElement.style.minHeight = lockedHeight + 'px';
        titleElement.style.height = lockedHeight + 'px';

        // 设置卡片为编辑状态
        setCardInlineEditingState(cardId, true);

        // 使用计算得到的光标位置聚焦
        const caretIndex = Math.max(0, Math.min(input.value.length, targetCaretIndex));
        focusWithCaret(input, caretIndex);

        // 初始高度与后续自适应（不低于原高度）
        input.style.height = Math.max(lockedHeight, input.scrollHeight) + 'px';
        // keep container in sync
        titleElement.style.height = input.style.height;

        // 添加全局点击监听
        const ignoreClicksUntil = Date.now() + 140; // 忽略打开本编辑器的首次点击
        function onDocClick(ev) {
            if (Date.now() < ignoreClicksUntil) return;
            if (!input.contains(ev.target)) {
                let delay = 0;
                if (ev.target.closest('.inline-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown') || ev.target.closest('.title-text, .description-text, .card-deadline, .card-assignee')) {
                    delay = 80;
                }
                setTimeout(() => {
                    save();
                }, delay);
                document.removeEventListener('click', onDocClick, true);
            }
        }
        setTimeout(() => document.addEventListener('click', onDocClick, true), 0);

        // 新编辑器已完成展示与聚焦，释放"打开中"标记
        setTimeout(() => { inlineEditorOpening = false; }, 0);
    });

    // 保存函数
    const save = async () => {
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
            titleSpan.innerHTML = escapeHtml(newTitle);
        }

        // 记录当前聚焦的内联编辑器（如果不是自己），以便保存后还原
        const preserveFocusEl = (document.activeElement && document.activeElement !== input &&
            (document.activeElement.classList.contains('inline-title-input') ||
             document.activeElement.classList.contains('inline-description-textarea') ||
             document.activeElement.classList.contains('inline-date-input') ||
             document.activeElement.classList.contains('inline-assignee-select')))
            ? document.activeElement : null;

        // 让位给事件循环，确保新编辑器先完成聚焦
        await new Promise(r => setTimeout(r, 0));

        // 清理自身输入框
        input.remove();
        titleSpan.style.visibility = 'visible';
        titleElement.style.minHeight = '';
        titleElement.style.height = '';
        titleElement.style.position = '';
        titleElement.style.width = '';

        // 如果有其他内联编辑器保持激活，主动还原其焦点
        if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
            setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
        }
        // 如果预先声明了待聚焦的目标，尝试恢复
        setTimeout(() => restorePendingFocusIfAny(), 0);

        // Check if no other inline editors active
        setTimeout(() => {
            const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
            if (cardElement && !cardElement.querySelector('.inline-description-textarea') && !cardElement.querySelector('.inline-date-input') && !cardElement.querySelector('.inline-assignee-select')) {
                setCardInlineEditingState(cardId, false);
            }
        }, 50);
    };

    // 取消函数
    const cancel = () => {
        setCardInlineEditingState(cardId, false);
        input.remove();
        titleSpan.style.visibility = 'visible';
        titleElement.style.minHeight = '';
        titleElement.style.height = '';
        titleElement.style.position = '';
        titleElement.style.width = '';
    };

    // 绑定事件 - 智能焦点管理
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
function editCardDescription(cardId, clickEvent) {
    clickEvent.preventDefault();
    clickEvent.stopPropagation();

    if (Date.now() - lastEditTime < 30) return;
    lastEditTime = Date.now();

    let card = null;
    let cardStatus = null;

    for (const status of getAllStatusKeys()) {
        const found = boardData[status].find(c => c.id === cardId);
        if (found) {
            card = found;
            cardStatus = status;
            break;
        }
    }

    if (!card) return;

    // 标记：正在打开新的内联编辑器，避免WS渲染打断
    inlineEditorOpening = true;

    // 检查是否已经在编辑状态
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    const descriptionElement = cardElement.querySelector('.card-description');
    const descriptionSpan = descriptionElement.querySelector('.description-span');

    if (descriptionElement.querySelector('.inline-description-textarea')) {
        // 已经在编辑状态，不要重复创建
        return;
    }

    // 基于原始span计算光标位置
    const targetCaretIndex = getCaretIndexFromSpan(descriptionSpan, clickEvent.clientX, clickEvent.clientY);
    // 设置待聚焦目标为即将创建的描述输入框
    pendingFocusSelector = `[data-card-id="${cardId}"] .inline-description-textarea`;
    pendingFocusCaretIndex = targetCaretIndex;

    // 测量span的精确位置和尺寸
    const containerRect = descriptionElement.getBoundingClientRect();
    const spanRect = descriptionSpan.getBoundingClientRect();

    const relativeLeft = spanRect.left - containerRect.left;
    const relativeHeight = spanRect.height;

    // 进入编辑前锁定当前高度，避免抖动
    const lockedHeight = descriptionElement.offsetHeight;

    // 创建文本框
    const textarea = document.createElement('textarea');
    textarea.className = 'inline-description-textarea';
    textarea.value = card.description || '';
    textarea.placeholder = '输入任务描述...';
    // 不设置width，让CSS样式控制宽度以防止突出

    // 先设置样式，包括隐藏
    descriptionElement.style.position = 'relative'; // 确保容器是relative
    textarea.style.position = 'absolute';
    textarea.style.left = '0px';
    textarea.style.width = '100%';
    textarea.style.visibility = 'hidden';

    // 添加到DOM
    descriptionElement.appendChild(textarea);

    // 使用requestAnimationFrame进行交换和聚焦
    requestAnimationFrame(() => {
        // 显示编辑器并隐藏原文本
        descriptionSpan.style.visibility = 'hidden';
        textarea.style.visibility = 'visible';

        // 锁定容器高度
        descriptionElement.style.minHeight = lockedHeight + 'px';
        descriptionElement.style.height = lockedHeight + 'px';

        // 使用计算得到的光标位置聚焦
        const caretIndex = Math.max(0, Math.min(textarea.value.length, targetCaretIndex));
        focusWithCaret(textarea, caretIndex);

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

        // 添加全局点击监听
        const ignoreClicksUntil = Date.now() + 140; // 忽略打开本编辑器的首次点击
        function onDocClick(ev) {
            if (Date.now() < ignoreClicksUntil) return;
            if (!textarea.contains(ev.target)) {
                let delay = 0;
                if (ev.target.closest('.inline-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown') || ev.target.closest('.title-text, .description-text, .card-deadline, .card-assignee')) {
                    delay = 80;
                }
                setTimeout(() => {
                    save();
                }, delay);
                document.removeEventListener('click', onDocClick, true);
            }
        }
        setTimeout(() => document.addEventListener('click', onDocClick, true), 0);

        // 新编辑器已完成展示与聚焦，释放"打开中"标记
        setTimeout(() => { inlineEditorOpening = false; }, 0);
    });

    // 保存函数
    const save = async () => {
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
            descriptionSpan.innerHTML = escapeHtml(displayText);
        }

        // 记录当前聚焦的内联编辑器（如果不是自己），以便保存后还原
        const preserveFocusEl = (document.activeElement && document.activeElement !== textarea &&
            (document.activeElement.classList.contains('inline-title-input') ||
             document.activeElement.classList.contains('inline-description-textarea') ||
             document.activeElement.classList.contains('inline-date-input') ||
             document.activeElement.classList.contains('inline-assignee-select')))
            ? document.activeElement : null;

        // 让位给事件循环，确保新编辑器先完成聚焦
        await new Promise(r => setTimeout(r, 0));

        // 清理自身输入框
        textarea.remove();
        descriptionSpan.style.visibility = 'visible';
        descriptionElement.style.minHeight = '';
        descriptionElement.style.height = '';
        descriptionElement.style.position = '';
        descriptionElement.style.width = '';

        // 如果有其他内联编辑器保持激活，主动还原其焦点
        if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
            setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
        }
        // 如果预先声明了待聚焦的目标，尝试恢复
        setTimeout(() => restorePendingFocusIfAny(), 0);

        // Check if no other inline editors active
        setTimeout(() => {
            const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
            if (cardElement && !cardElement.querySelector('.inline-title-input') && !cardElement.querySelector('.inline-date-input') && !cardElement.querySelector('.inline-assignee-select')) {
                setCardInlineEditingState(cardId, false);
            }
        }, 50);
    };

    // 取消函数
    const cancel = () => {
        setCardInlineEditingState(cardId, false);
        textarea.remove();
        descriptionSpan.style.visibility = 'visible';
        descriptionElement.style.minHeight = '';
        descriptionElement.style.height = '';
        descriptionElement.style.position = '';
        descriptionElement.style.width = '';
    };

    // 绑定事件 - 智能焦点管理
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
    for (const status of getAllStatusKeys()) {
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

    const userList = [''].concat(window.currentProjectMembers || []);
    userList.forEach(user => {
        const item = document.createElement('div');
        item.className = 'assignee-option' + (((user || null) === (card.assignee || null)) ? ' selected' : '');
        item.textContent = user ? `@${user}` : '未分配';
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const newAssignee = user || null;
            updateCardField(cardId, 'assignee', newAssignee);
            card.assignee = newAssignee; // 本地立即更新

            // 更新DOM而不重新渲染整个板
            if (newAssignee) {
                assigneeElement.textContent = `@${escapeHtml(newAssignee)}`;
                assigneeElement.classList.remove('unassigned');
            } else {
                assigneeElement.textContent = '未分配';
                assigneeElement.classList.add('unassigned');
            }

            closeDropdown();
            // 移除 setTimeout(() => renderBoard(), 50);
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

    for (const status of getAllStatusKeys()) {
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
    input.onchange = async function(e) {
        e.stopPropagation();
        const preserveFocusEl = (document.activeElement && document.activeElement !== input &&
            (document.activeElement.classList.contains('inline-title-input') ||
             document.activeElement.classList.contains('inline-description-textarea') ||
             document.activeElement.classList.contains('inline-date-input') ||
             document.activeElement.classList.contains('inline-assignee-select')))
            ? document.activeElement : null;

        const newDeadline = this.value || null;
        // 让位给事件循环，确保新目标编辑器的聚焦先完成
        await new Promise(r => setTimeout(r, 0));
        updateCardField(cardId, 'deadline', newDeadline);
        // 立即更新DOM而不重新渲染整个板
        deadlineElement.innerHTML = newDeadline ? `📅 ${newDeadline}` : '📅 设置';
        if (!newDeadline) deadlineElement.classList.add('unset');
        else deadlineElement.classList.remove('unset');

        if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
            setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
        }
        // 如果预先声明了待聚焦的目标，尝试恢复
        setTimeout(() => restorePendingFocusIfAny(), 0);
        // 移除 setTimeout(() => renderBoard(), 50);
    };

    // 处理键盘事件
    input.onkeydown = function(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            const preserveFocusEl = (document.activeElement && document.activeElement !== input &&
                (document.activeElement.classList.contains('inline-title-input') ||
                 document.activeElement.classList.contains('inline-description-textarea') ||
                 document.activeElement.classList.contains('inline-date-input') ||
                 document.activeElement.classList.contains('inline-assignee-select')))
                ? document.activeElement : null;

            deadlineElement.innerHTML = card.deadline ? `📅 ${card.deadline}` : '📅 设置';
            if (!card.deadline) deadlineElement.classList.add('unset');
            else deadlineElement.classList.remove('unset');

            if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
                setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
            }
            setTimeout(() => restorePendingFocusIfAny(), 0);
        } else if (e.key === 'Enter') {
            e.stopPropagation();
            const preserveFocusEl = (document.activeElement && document.activeElement !== input &&
                (document.activeElement.classList.contains('inline-title-input') ||
                 document.activeElement.classList.contains('inline-description-textarea') ||
                 document.activeElement.classList.contains('inline-date-input') ||
                 document.activeElement.classList.contains('inline-assignee-select')))
                ? document.activeElement : null;

            const newDeadline = this.value || null;
            updateCardField(cardId, 'deadline', newDeadline);
            deadlineElement.innerHTML = newDeadline ? `📅 ${newDeadline}` : '📅 设置';
            if (!newDeadline) deadlineElement.classList.add('unset');
            else deadlineElement.classList.remove('unset');

            if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
                setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
            }
            setTimeout(() => restorePendingFocusIfAny(), 0);
        }
    };

    // 处理失去焦点 - 智能焦点管理
    input.onblur = function(e) {
        setTimeout(async () => {
            // 检查当前焦点是否还在当前的日期输入框上
            if (document.activeElement !== input) {
                const preserveFocusEl = (document.activeElement && document.activeElement !== input &&
                    (document.activeElement.classList.contains('inline-title-input') ||
                     document.activeElement.classList.contains('inline-description-textarea') ||
                     document.activeElement.classList.contains('inline-date-input') ||
                     document.activeElement.classList.contains('inline-assignee-select')))
                    ? document.activeElement : null;

                const newDeadline = input.value || null;
                // 让位给事件循环，确保新目标编辑器的聚焦先完成
                await new Promise(r => setTimeout(r, 0));
                updateCardField(cardId, 'deadline', newDeadline);
                deadlineElement.innerHTML = newDeadline ? `📅 ${newDeadline}` : '📅 设置';
                if (!newDeadline) deadlineElement.classList.add('unset');
                else deadlineElement.classList.remove('unset');

                if (preserveFocusEl && document.body.contains(preserveFocusEl)) {
                    setTimeout(() => { try { preserveFocusEl.focus(); } catch (e) {} }, 0);
                }
                setTimeout(() => restorePendingFocusIfAny(), 0);
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

// 检测是否有任何内联编辑控件正在打开
function isAnyInlineEditorOpen() {
    return !!document.querySelector('.inline-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown');
}

// 恢复待聚焦的编辑器（带重试）
function restorePendingFocusIfAny(retries = 6) {
    if (!pendingFocusSelector) return;
    const el = document.querySelector(pendingFocusSelector);
    if (el) {
        const caret = typeof pendingFocusCaretIndex === 'number' ? Math.max(0, Math.min((el.value || '').length, pendingFocusCaretIndex)) : (el.value || '').length;
        focusWithCaret(el, caret);
        pendingFocusSelector = null;
        pendingFocusCaretIndex = null;
    } else if (retries > 0) {
        setTimeout(() => restorePendingFocusIfAny(retries - 1), 25);
    }
}

// 在编辑期间延迟渲染，避免新焦点被旧渲染打断
function scheduleDeferredRender() {
    if (pendingRenderTimer) {
        clearTimeout(pendingRenderTimer);
        pendingRenderTimer = null;
    }
    pendingRenderTimer = setTimeout(function check() {
        if (isAnyInlineEditorOpen() || inlineEditorOpening) {
            pendingRenderTimer = setTimeout(check, 60);
            return;
        }
        if (pendingBoardUpdate) {
            pendingBoardUpdate = false;
            renderBoard();
        }
        pendingRenderTimer = null;
    }, 60);
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
    for (const status of getAllStatusKeys()) {
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

// JS字符串转义（用于onclick等）
function escapeJs(text) {
    return text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// SVG 图标：看板
function getBoardIconSVG() {
    return '';
}

// 简易图标库
const Icon = {
    boards: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h4v14H4zM10 5h4v10h-4zM16 5h4v7h-4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h5l2 2h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8.5a4 4 0 0 1 4-4h2a4 4 0 1 1 0 8h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 15.5a4 4 0 0 1-4 4H8a4 4 0 1 1 0-8h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

function renderIconsInDom(root=document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
        const name = el.getAttribute('data-icon');
        if (Icon[name]) {
            el.innerHTML = Icon[name];
            el.setAttribute('aria-hidden','true');
        }
    });
}

// 页面卸载时清理
window.addEventListener('beforeunload', function() {
    if (socket) {
        socket.close();
    }
});

// 新增函数：获取点击位置对应的字符索引
function getCaretIndex(element, clientX, clientY) {
    // 创建镜像元素并对齐到元素的屏幕位置
    const mirror = document.createElement('span');
    const style = window.getComputedStyle(element);
    ['font', 'fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'wordSpacing', 'whiteSpace', 'lineHeight', 'padding', 'border', 'boxSizing', 'textTransform', 'wordBreak', 'overflowWrap', 'width'].forEach(prop => {
        mirror.style[prop] = style[prop];
    });
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    const er = element.getBoundingClientRect();
    mirror.style.left = (er.left + window.scrollX) + 'px';
    mirror.style.top = (er.top + window.scrollY) + 'px';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordBreak = 'break-word';
    mirror.textContent = element.value + ' ';
    document.body.appendChild(mirror);

    let closestIndex = 0;
    let minDistance = Infinity;

    for (let i = 0; i <= element.value.length; i++) {
        const range = document.createRange();
        range.setStart(mirror.firstChild, i);
        range.setEnd(mirror.firstChild, i);
        const rects = range.getClientRects();
        if (rects.length > 0) {
            const rect = rects[0];
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dx = clientX - cx;
            const dy = clientY - cy;
            const dist = dx * dx + dy * dy;
            if (dist < minDistance) {
                minDistance = dist;
                closestIndex = i;
            }
        }
    }

    document.body.removeChild(mirror);
    return closestIndex;
}

// 新增函数：聚焦并设置光标，带重试
function focusWithCaret(element, caretIndex) {
    let attempts = 0;
    function tryFocus() {
        attempts++;
        element.focus();
        try {
            element.setSelectionRange(caretIndex, caretIndex);
        } catch (e) {
            element.selectionStart = caretIndex;
            element.selectionEnd = caretIndex;
        }
        if (document.activeElement !== element && attempts < 6) {
            setTimeout(tryFocus, 30);
        }
    }
    // 下一tick后开始尝试，避免与当前click冲突
    setTimeout(tryFocus, 0);
}

// NEW: Auto-resize helper for textareas
function autoResizeTextarea(el) {
    if (!el) return;
    const resize = () => {
        el.style.height = 'auto';
        const min = parseInt((window.getComputedStyle(el).minHeight || '0'), 10) || 0;
        const next = Math.max(min, el.scrollHeight);
        el.style.height = next + 'px';
    };
    el.style.overflow = 'hidden';
    el.style.resize = 'none';
    if (!el.__autoResizeBound) {
        el.addEventListener('input', resize);
        el.__autoResizeBound = true;
    }
    resize();
}

// 根据原span内容与点击坐标，获取字符索引
function getCaretIndexFromSpan(spanEl, clientX, clientY) {
    if (!spanEl) return 0;
    const textLen = (spanEl.textContent || '').length;

    // 兼容两种API
    function rangeFromPoint(x, y) {
        if (document.caretRangeFromPoint) {
            return document.caretRangeFromPoint(x, y);
        }
        if (document.caretPositionFromPoint) {
            const pos = document.caretPositionFromPoint(x, y);
            if (!pos) return null;
            const r = document.createRange();
            r.setStart(pos.offsetNode, pos.offset);
            r.setEnd(pos.offsetNode, pos.offset);
            return r;
        }
        return null;
    }

    let range = rangeFromPoint(clientX, clientY);
    if (!range) return textLen;

    // 如果不在span内，返回最近端
    if (!spanEl.contains(range.startContainer)) {
        const rect = spanEl.getBoundingClientRect();
        if (clientX <= rect.left) return 0;
        return textLen;
    }

    // 计算相对于整个文本的偏移
    let index = 0;
    const walker = document.createTreeWalker(spanEl, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
        if (node === range.startContainer) {
            index += Math.min(range.startOffset, node.nodeValue.length);
            break;
        } else {
            index += node.nodeValue.length;
        }
    }
    return Math.max(0, Math.min(textLen, index));
}

// 列内拖拽排序
function enableColumnDrag(status) {
    // Support legacy ids and new dynamic containers
    let container = document.getElementById(`${status}Cards`);
    if (!container) {
        const col = document.querySelector(`.column[data-status="${status}"]`);
        container = col ? col.querySelector('.cards') : null;
    }
    if (!container) return;

    container.querySelectorAll('.card').forEach(makeDraggable);

    const handleDragOver = (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const afterEl = getDragAfterElement(container, e.clientY);
        const dragging = document.querySelector('.card.dragging');
        if (!dragging) return;
        if (afterEl == null) {
            container.appendChild(dragging);
        } else {
            container.insertBefore(dragging, afterEl);
        }
    };

    const handleDrop = () => {
        const toStatus = status;
        const fromStatus = draggingFromStatus;
        const movedCardId = draggingCardId;
        const orderedIds = Array.from(container.querySelectorAll('.card')).map(el => el.dataset.cardId);
        if (socket && socket.readyState === WebSocket.OPEN) {
            if (movedCardId && fromStatus && fromStatus !== toStatus) {
                socket.send(JSON.stringify({ type:'move-card', projectId: currentProjectId, boardName: currentBoardName, cardId:movedCardId, fromStatus, toStatus }));
            }
            socket.send(JSON.stringify({ type:'reorder-cards', projectId: currentProjectId, boardName: currentBoardName, status: toStatus, orderedIds }));
        }
        draggingCardId = null;
        draggingFromStatus = null;
        document.body.classList.remove('dragging-cards');
    };

    container.ondragover = handleDragOver;
    container.ondrop = handleDrop;
    const listWrapper = container.closest('.list, .column');
    if (listWrapper) { listWrapper.ondragover = handleDragOver; listWrapper.ondrop = handleDrop; }
}

function makeDraggable(cardEl) {
    cardEl.setAttribute('draggable', 'true');
    cardEl.ondragstart = (e) => {
        cardEl.classList.add('dragging');
        const col = cardEl.closest('.column, .list');
        draggingFromStatus = col ? col.getAttribute('data-status') : null;
        draggingCardId = cardEl.dataset.cardId;
        document.body.classList.add('dragging-cards');
        try { e.dataTransfer && e.dataTransfer.setData('text/plain', draggingCardId); e.dataTransfer.effectAllowed = 'move'; } catch (e) {}
    };
    cardEl.ondragend = () => {
        cardEl.classList.remove('dragging');
        document.body.classList.remove('dragging-cards');
        draggingCardId = null;
        draggingFromStatus = null;
    };
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) {
            return { offset: offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// ===== Lists drag (simple) =====
let draggingListId = null;
let listDragImageEl = null; // not used in simple mode
let listPlaceholderEl = null; // not used in simple mode

function enableListsDrag() {
    const container = document.getElementById('listsContainer');
    if (!container) return;

    // Shared reposition handler (no placeholder; directly reorders DOM)
    const reposition = (e) => {
        if (!draggingListId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        const after = getListAfterElement(container, e.clientX);
        const draggingEl = container.querySelector('.list.dragging');
        if (!draggingEl) return;
        if (after == null) {
            container.insertBefore(draggingEl, container.querySelector('#addListEntry'));
        } else {
            container.insertBefore(draggingEl, after);
        }
    };

    // Shared finalize handler
    const finalizeDrop = () => {
        if (!draggingListId || !clientLists) return;
        // clear dragging class if any remains
        const draggingEl = container.querySelector('.list.dragging');
        if (draggingEl) draggingEl.classList.remove('dragging');
        const ids = Array.from(container.querySelectorAll('.list:not(#addListEntry)'))
            .filter(el => el.classList.contains('list'))
            .map(el => el.getAttribute('data-id'));
        clientLists.listIds = ids;
        clientLists.listIds.forEach((id, idx) => { if (clientLists.lists[id]) clientLists.lists[id].pos = idx; });
        draggingListId = null;
        saveClientListsToStorage();
        if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type:'save-lists', projectId: currentProjectId, boardName: currentBoardName, lists: clientLists }));
        }
        renderBoard();
    };

    // Make entire list and header/title draggable; filter bad start targets
    container.querySelectorAll('.list:not(.add-list)').forEach(listEl => {
        const header = listEl.querySelector('.list-header');
        const title = header ? header.querySelector('.list-title') : null;

        function startDrag(e){
            const isInsideCard = !!(e.target && e.target.closest && e.target.closest('.card'));
            const isComposer = !!(e.target && e.target.closest && e.target.closest('.card-composer, .add-list-form'));
            const isFormControl = !!(e.target && e.target.closest && e.target.closest('input, textarea, button, select'));
            if (isInsideCard || isComposer || isFormControl) { if (e.stopPropagation) e.stopPropagation(); return; }
            const el = (e.currentTarget && e.currentTarget.closest) ? e.currentTarget.closest('.list') : listEl;
            if (!el) return;
            draggingListId = el.getAttribute('data-id');
            el.classList.add('dragging');
            try { e.dataTransfer && e.dataTransfer.setData('text/plain', draggingListId); e.dataTransfer.effectAllowed = 'move'; } catch {}
        }
        function endDrag(){
            const el = container.querySelector('.list.dragging');
            if (el) el.classList.remove('dragging');
            draggingListId = null;
        }

        // set draggable attributes and bind events
        listEl.setAttribute('draggable', 'true');
        listEl.addEventListener('dragstart', startDrag);
        listEl.addEventListener('dragend', endDrag);
        if (header) {
            header.setAttribute('draggable', 'true');
            header.addEventListener('dragstart', startDrag);
            header.addEventListener('dragend', endDrag);
        }
        if (title) {
            title.setAttribute('draggable', 'true');
            title.addEventListener('dragstart', startDrag);
            title.addEventListener('dragend', endDrag);
        }

        // list-level dragover/drop to improve reliability
        listEl.ondragover = reposition;
        listEl.ondrop = (e) => { if (e && e.preventDefault) e.preventDefault(); finalizeDrop(); };
    });

    // container-level handlers
    container.ondragover = reposition;
    container.ondrop = (e) => { if (e && e.preventDefault) e.preventDefault(); finalizeDrop(); };
}
// ===== End Lists drag =====

// 新增：重命名看板（项目看板页）
function promptRenameBoard(oldName) {
    return renameBoardRequest(currentProjectId, oldName, false);
}

// 新增：重命名看板（首页快捷看板）
function promptRenameBoardFromHome(oldName, projectId) {
    return renameBoardRequest(projectId, oldName, true);
}

async function renameBoardRequest(projectId, oldName, isHome) {
    const input = await uiPrompt('输入新的看板名称', oldName, '重命名看板');
    if (input === null) return { success: false };
    const newName = input.trim();
    if (!newName) { uiToast('新名称不能为空','error'); return { success: false }; }
    if (newName === oldName) return { success: false };

    try {
        const response = await fetch('/api/rename-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, oldName, newName, actor: currentUser })
        });
        const result = await response.json();
        if (response.ok) {
            if (isHome) { loadUserProjects(); } else { loadProjectBoards(); }
            if (projectId === currentProjectId && currentBoardName === oldName) {
                currentBoardName = newName;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                updateBoardHeader();
                try { if (socket) socket.close(); } catch (e) {}
                connectWebSocket();
                loadBoardData();
            }
            uiToast('重命名成功','success');
            return { success: true, newName };
        } else {
            uiToast(result.message || '重命名失败','error');
            return { success: false };
        }
    } catch (error) {
        console.error('Rename board error:', error);
        uiToast('重命名失败','error');
        return { success: false };
    }
}

function renameProjectFromHome(projectId, currentName) {
    (async () => {
        const input = await uiPrompt('输入新的项目名称', currentName || '', '重命名项目');
        if (input === null) return;
        const newName = input.trim();
        if (!newName) { uiToast('新名称不能为空','error'); return; }
        if (newName === currentName) return;

        fetch('/api/rename-project', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, newName })
        }).then(async (response) => {
            const result = await response.json().catch(() => ({}));
            if (response.ok) {
                if (currentProjectId === projectId) {
                    currentProjectName = newName;
                    localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
                    const projectTitle = document.getElementById('projectTitle');
                    if (projectTitle) projectTitle.textContent = newName;
                    updateBoardHeader();
                    if (!boardSelectPage.classList.contains('hidden')) { loadProjectBoards(); }
                }
                loadUserProjects();
                uiToast('项目重命名成功','success');
            } else {
                uiToast(result.message || '项目重命名失败','error');
            }
        }).catch((error) => {
            console.error('Rename project (home) error:', error);
            uiToast('项目重命名失败','error');
        });
    })();
}

// 删除项目（项目选择页头部按钮）
function deleteProject() {
    if (!currentProjectId) return;
    (async () => {
        const ok = await uiConfirm(`确定删除项目 "${currentProjectName}" 吗？\n\n此操作不可撤销，将删除项目的所有看板与任务数据。`, '删除项目');
        if (!ok) return;
        fetch('/api/delete-project', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: currentProjectId, actor: currentUser })
        }).then(async (response) => {
            const result = await response.json().catch(() => ({}));
            if (response.ok) {
                if (socket) { try { socket.close(); } catch (e) {} }
                currentProjectId = null;
                currentProjectName = null;
                currentBoardName = null;
                localStorage.removeItem('kanbanCurrentProjectId');
                localStorage.removeItem('kanbanCurrentProjectName');
                localStorage.removeItem('kanbanCurrentBoardName');
                if (typeof projectPage !== 'undefined' && projectPage && projectPage.classList.contains('hidden')) {
                    showProjectPage();
                }
                loadUserProjects();
                uiToast('项目删除成功','success');
            } else {
                uiToast(result.message || '项目删除失败','error');
            }
        }).catch((error) => {
            console.error('Delete project error:', error);
            uiToast('项目删除失败','error');
        });
    })();
}

// 从首页删除项目
function deleteProjectFromHome(projectId, projectName) {
    (async () => {
        const ok = await uiConfirm(`确定删除项目 "${projectName}" 吗？\n\n此操作不可撤销，将删除项目的所有看板与任务数据。`, '删除项目');
        if (!ok) return;
        fetch('/api/delete-project', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, actor: currentUser })
        }).then(async (response) => {
            const result = await response.json().catch(() => ({}));
            if (response.ok) {
                if (currentProjectId === projectId) {
                    if (socket) { try { socket.close(); } catch (e) {} }
                    currentProjectId = null;
                    currentProjectName = null;
                    currentBoardName = null;
                    localStorage.removeItem('kanbanCurrentProjectId');
                    localStorage.removeItem('kanbanCurrentProjectName');
                    localStorage.removeItem('kanbanCurrentBoardName');
                    showProjectPage();
                }
                loadUserProjects();
                uiToast('项目删除成功','success');
            } else {
                uiToast(result.message || '项目删除失败','error');
            }
        }).catch((error) => {
            console.error('Delete project (home) error:', error);
            uiToast('项目删除失败','error');
        });
    })();
}

// Collapsed add-card behavior
function setupAddCardCollapsed(container, status, position) {
    if (!container) return;
    container.classList.add('collapsed');

    // Ensure link exists
    let link = container.querySelector('.add-card-link');
    if (!link) {
        link = document.createElement('button');
        link.type = 'button';
        link.className = 'add-card-link';
        link.textContent = '+ 添加卡片';
        container.insertBefore(link, container.firstChild);
    }

    const input = container.querySelector('.task-title-input');

    function expand() {
        container.classList.remove('collapsed');
        link.style.display = 'none';
        if (input) setTimeout(() => input.focus(), 0);
    }
    function collapse() {
        container.classList.add('collapsed');
        link.style.display = '';
    }

    link.onclick = (e) => { e.preventDefault(); expand(); };

    // Collapse when focus leaves the add area
    container.addEventListener('focusout', () => {
        setTimeout(() => {
            if (!container.contains(document.activeElement)) {
                collapse();
            }
        }, 0);
    }, true);

    // After Enter add, addCard will call collapse too
    container.__collapseAdd = collapse;
}

// 打开看板切换下拉
async function openBoardSwitcher(e) {
    e.preventDefault();
    e.stopPropagation();
    if (boardSwitcherOpen) {
        hideBoardSwitcher();
        return;
    }
    const anchor = e.currentTarget;
    const rect = anchor.getBoundingClientRect();

    let boards = projectBoardsCache[currentProjectId];
    if (!boards) {
        try {
            const resp = await fetch(`/api/project-boards/${currentProjectId}`);
            const data = await resp.json();
            boards = Array.isArray(data.boards) ? data.boards : [];
            projectBoardsCache[currentProjectId] = boards;
        } catch (err) {
            boards = [];
        }
    }
    showBoardSwitcherAt(rect, boards);
    const titleEl = document.getElementById('currentBoardName');
    if (titleEl) titleEl.classList.add('open');
}

function showBoardSwitcherAt(rect, boards) {
    hideBoardSwitcher();
    const menu = document.createElement('div');
    menu.className = 'board-switcher-menu';
    menu.style.left = Math.round(rect.left) + 'px';
    menu.style.top = Math.round(rect.bottom + 6) + 'px';

    // Header with search and create
    const header = document.createElement('div');
    header.className = 'board-switcher-header';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'board-switcher-search';
    search.placeholder = '搜索看板...';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'board-switcher-create';
    createBtn.textContent = '创建新看板';
    createBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const name = search.value.trim();
        if (!name) return;
        try {
            const response = await fetch('/api/create-board', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: currentProjectId, boardName: name, actor: currentUser })
            });
            const result = await response.json();
            if (response.ok) {
                projectBoardsCache[currentProjectId] = null; // invalidate cache
                currentBoardName = name;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                hideBoardSwitcher();
                loadProjectBoards();
                showBoard();
            } else {
                uiToast(result.message || '创建失败','error');
            }
        } catch (e) {
            uiToast('创建失败','error');
        }
    };
    header.appendChild(search);
    header.appendChild(createBtn);
    menu.appendChild(header);

    const list = document.createElement('div');
    list.className = 'board-switcher-list';

    function renderList(filterText) {
        list.innerHTML = '';
        const ft = (filterText || '').toLowerCase();
        const filtered = boards.filter(n => n.toLowerCase().includes(ft));
        filtered.forEach((name) => {
            const item = document.createElement('div');
            item.className = 'board-switcher-item' + (name === currentBoardName ? ' active' : '');
            const label = document.createElement('span');
            label.className = 'board-switcher-label';
            label.textContent = name;
            const actions = document.createElement('div');
            actions.className = 'board-switcher-actions';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'board-switcher-rename';
            editBtn.title = '重命名';
            editBtn.textContent = '✎';
            editBtn.onclick = async (ev) => {
                ev.stopPropagation();
                const result = await promptRenameBoard(name);
                if (!result || !result.success) return;
                try {
                    const resp = await fetch(`/api/project-boards/${currentProjectId}`);
                    const data = await resp.json();
                    boards = Array.isArray(data.boards) ? data.boards : [];
                    projectBoardsCache[currentProjectId] = boards;
                    renderList(search.value);
                } catch {}
            };
            item.onclick = (ev) => {
                ev.stopPropagation();
                hideBoardSwitcher();
                if (name !== currentBoardName) {
                    selectBoard(name);
                }
            };
            actions.appendChild(editBtn);
            item.appendChild(label);
            item.appendChild(actions);
            list.appendChild(item);
        });
        if (filtered.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'board-switcher-empty';
            empty.textContent = '没有匹配的看板';
            list.appendChild(empty);
        }
    }

    renderList('');

    search.addEventListener('input', (ev) => {
        renderList(search.value);
    });

    menu.appendChild(list);
    document.body.appendChild(menu);
    boardSwitcherMenu = menu;
    boardSwitcherOpen = true;

    setTimeout(() => {
        boardSwitcherBodyClickHandler = (ev) => {
            if (!boardSwitcherMenu) return;
            if (!boardSwitcherMenu.contains(ev.target)) {
                hideBoardSwitcher();
            }
        };
        boardSwitcherKeyHandler = (ev) => { if (ev.key === 'Escape') hideBoardSwitcher(); };
        boardSwitcherFocusInHandler = (ev) => {
            if (!boardSwitcherMenu) return;
            if (!boardSwitcherMenu.contains(ev.target)) {
                hideBoardSwitcher();
            }
        };
        document.addEventListener('click', boardSwitcherBodyClickHandler);
        document.addEventListener('keydown', boardSwitcherKeyHandler);
        document.addEventListener('focusin', boardSwitcherFocusInHandler);
        search.focus();
    }, 0);
}

function hideBoardSwitcher() {
    if (boardSwitcherBodyClickHandler) { document.removeEventListener('click', boardSwitcherBodyClickHandler); boardSwitcherBodyClickHandler = null; }
    if (boardSwitcherKeyHandler) { document.removeEventListener('keydown', boardSwitcherKeyHandler); boardSwitcherKeyHandler = null; }
    if (boardSwitcherFocusInHandler) { document.removeEventListener('focusin', boardSwitcherFocusInHandler); boardSwitcherFocusInHandler = null; }
    if (boardSwitcherMenu && boardSwitcherMenu.parentNode) {
        boardSwitcherMenu.parentNode.removeChild(boardSwitcherMenu);
    }
    boardSwitcherMenu = null;
    boardSwitcherOpen = false;
    const titleEl = document.getElementById('currentBoardName');
    if (titleEl) titleEl.classList.remove('open');
}

// === In-app dialog & toast helpers ===
function createBaseModal(titleText) {
    const overlay = document.createElement('div');
    overlay.className = 'modal';
    const content = document.createElement('div');
    content.className = 'modal-content edit-modal';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const h = document.createElement('h3');
    h.textContent = titleText || '';
    const close = document.createElement('button');
    close.className = 'close-btn';
    close.textContent = '×';
    header.appendChild(h);
    header.appendChild(close);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const footer = document.createElement('div');
    footer.className = 'modal-footer';

    content.appendChild(header);
    content.appendChild(body);
    content.appendChild(footer);
    overlay.appendChild(content);

    return { overlay, content, header, body, footer, close };
}

function uiAlert(message, title) {
    return new Promise((resolve) => {
        const { overlay, body, footer, close } = createBaseModal(title || '提示');
        const p = document.createElement('div');
        p.textContent = message;
        body.appendChild(p);
        const ok = document.createElement('button');
        ok.className = 'btn-primary';
        ok.textContent = '确定';
        ok.onclick = () => { document.body.removeChild(overlay); resolve(); };
        close.onclick = ok.onclick;
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => ok.focus(), 0);
    });
}

function uiConfirm(message, title) {
    return new Promise((resolve) => {
        const { overlay, body, footer, close } = createBaseModal(title || '确认操作');
        const p = document.createElement('div');
        p.textContent = message;
        body.appendChild(p);
        const cancel = document.createElement('button');
        cancel.className = 'btn-secondary';
        cancel.textContent = '取消';
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(false); };
        const ok = document.createElement('button');
        ok.className = 'btn-danger';
        ok.textContent = '确认';
        ok.onclick = () => { document.body.removeChild(overlay); resolve(true); };
        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => ok.focus(), 0);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancel.click();
            if (e.key === 'Enter') ok.click();
        });
    });
}

function uiPrompt(message, defaultValue, title) {
    return new Promise((resolve) => {
        const { overlay, body, footer, close } = createBaseModal(title || '输入名称');
        const label = document.createElement('div');
        label.textContent = message;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue || '';
        input.style.width = '100%';
        input.style.height = '36px';
        input.style.border = '1px solid #e5e7eb';
        input.style.borderRadius = '6px';
        input.style.padding = '0 10px';
        input.style.marginTop = '10px';
        body.appendChild(label);
        body.appendChild(input);
        const cancel = document.createElement('button');
        cancel.className = 'btn-secondary';
        cancel.textContent = '取消';
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };
        const ok = document.createElement('button');
        ok.className = 'btn-primary';
        ok.textContent = '确定';
        ok.onclick = () => { const v = (input.value || '').trim(); if (!v) return; document.body.removeChild(overlay); resolve(v); };
        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancel.click();
            if (e.key === 'Enter') ok.click();
        });
    });
}

function ensureToastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toastContainer';
        c.className = 'toast-container';
        document.body.appendChild(c);
    }
    return c;
}

function uiToast(message, type) {
    const container = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast ' + (type ? 'toast-' + type : '');
    t.textContent = message;
    container.appendChild(t);
    setTimeout(() => { t.classList.add('show'); }, 10);
    setTimeout(() => { t.classList.remove('show'); t.addEventListener('transitionend', () => t.remove(), { once: true }); }, 2500);
}

// 删除归档卡片
async function deleteArchivedCard(cardId){
    const ok = await uiConfirm('确定要删除该归档任务吗？此操作不可恢复。','删除任务');
    if (!ok) return;
    const idx = (boardData.archived||[]).findIndex(c=>c.id===cardId);
    if (idx !== -1) { boardData.archived.splice(idx,1); }
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type:'delete-card', projectId: currentProjectId, boardName: currentBoardName, cardId }));
    }
    renderArchive();
}

// 归档整列（卡组）
async function archiveList(status){
    const cards = (boardData[status]||[]);
    if (!cards.length) { uiToast('此卡组没有可归档的卡片','info'); return; }
    const ok = await uiConfirm('将该卡组的所有卡片归档？','归档卡组');
    if (!ok) return;
    boardData.archived = boardData.archived || [];
    // copy array to avoid mutation during iteration
    const moving = cards.slice();
    boardData.archived.push(...moving);
    boardData[status] = [];
    if (socket && socket.readyState === WebSocket.OPEN) {
        moving.forEach(c => {
            socket.send(JSON.stringify({ type:'archive-card', projectId: currentProjectId, boardName: currentBoardName, cardId: c.id, fromStatus: status }));
        });
    }
    renderBoard();
    uiToast('已归档该卡组全部卡片','success');
}

// === Posts (讨论/评论) helpers ===

function renderEditPostsList(card){
    const listEl = document.getElementById('editPostsList');
    if (!listEl) return;
    listEl.innerHTML = '';
    const posts = Array.isArray(card.posts) ? card.posts : [];
    posts.forEach((p)=>{
        const item = document.createElement('div');
        item.className = 'post-item';
        item.dataset.postId = String(p.id||'');
        const content = document.createElement('div');
        content.className = 'post-content';
        content.innerHTML = `<div class="post-text">${escapeHtml(p.text||'')}</div>`;
        const actions = document.createElement('div');
        actions.className = 'post-actions has-meta';
        const meta = document.createElement('div');
        meta.className = 'post-meta';
        meta.textContent = `${p.author || ''} · ${new Date(p.created||Date.now()).toLocaleString()}`;
        actions.appendChild(meta);
        const btns = document.createElement('div');
        btns.className = 'post-actions-buttons';
        if ((p.author||'') === (currentUser||'')){
            const editBtn = document.createElement('button'); editBtn.className='btn-link'; editBtn.textContent='编辑'; editBtn.onclick = ()=> startEditPost(p.id);
            const delBtn = document.createElement('button'); delBtn.className='btn-link'; delBtn.textContent='删除'; delBtn.onclick = ()=> deletePost(p.id);
            btns.appendChild(editBtn); btns.appendChild(delBtn);
        }
        actions.appendChild(btns);
        item.appendChild(content);
        item.appendChild(actions);
        listEl.appendChild(item);
    });
}

function submitNewPost(){
    if (!editingCardId) return;
    const input = document.getElementById('editPostsInput');
    if (!input) return;
    const text = (input.value||'').trim();
    if (!text) return;
    const card = getCardById(editingCardId);
    if (!card) return;
    const newPost = { id: Date.now().toString(), author: currentUser, text, created: new Date().toISOString() };
    const posts = Array.isArray(card.posts) ? card.posts.slice() : [];
    posts.push(newPost);
    const commentsCount = (card.commentsCount||0) + 1;
    updateCardImmediately(editingCardId, { posts, commentsCount });
    input.value = '';
    renderEditPostsList(getCardById(editingCardId));
}

function startEditPost(postId){
    const card = getCardById(editingCardId);
    if (!card) return;
    const listEl = document.getElementById('editPostsList');
    const item = listEl && listEl.querySelector(`[data-post-id="${postId}"]`);
    if (!item) return;
    const p = (card.posts||[]).find(pp=>String(pp.id)===String(postId));
    if (!p) return;
    item.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'post-edit-textarea';
    ta.value = p.text || '';
    const saveBtn = document.createElement('button'); saveBtn.className='btn-primary'; saveBtn.textContent='保存'; saveBtn.onclick = ()=> saveEditPost(postId, ta.value.trim());
    const cancelBtn = document.createElement('button'); cancelBtn.className='btn-secondary'; cancelBtn.textContent='取消'; cancelBtn.onclick = ()=> renderEditPostsList(card);
    item.appendChild(ta);
    const actions = document.createElement('div'); actions.className='post-actions'; actions.appendChild(saveBtn); actions.appendChild(cancelBtn); item.appendChild(actions);
    // After insertion, run multi-tick autosize to avoid initial 1-line flash
    (function(){
        const run = () => { try { autoResizeTextarea(ta); } catch (e) {} };
        run();
        try { requestAnimationFrame(run); } catch (e) {}
        setTimeout(run, 0);
        setTimeout(run, 50);
    })();
}

function saveEditPost(postId, newText){
    const card = getCardById(editingCardId);
    if (!card) return;
    const posts = Array.isArray(card.posts) ? card.posts.slice() : [];
    const idx = posts.findIndex(p=>String(p.id)===String(postId));
    if (idx===-1) return;
    if (!newText) { uiToast('内容不能为空','error'); return; }
    posts[idx] = Object.assign({}, posts[idx], { text: newText, edited: new Date().toISOString() });
    updateCardImmediately(editingCardId, { posts });
    renderEditPostsList(getCardById(editingCardId));
}

async function deletePost(postId){
    const ok = await uiConfirm('删除这条评论？','删除评论');
    if (!ok) return;
    const card = getCardById(editingCardId);
    if (!card) return;
    const posts = Array.isArray(card.posts) ? card.posts.slice() : [];
    const idx = posts.findIndex(p=>String(p.id)===String(postId));
    if (idx===-1) return;
    posts.splice(idx,1);
    const commentsCount = Math.max(0, (card.commentsCount||0) - 1);
    updateCardImmediately(editingCardId, { posts, commentsCount });
    renderEditPostsList(getCardById(editingCardId));
}

function getListAfterElement(container, x) {
    const lists = [...container.querySelectorAll('.list:not(.dragging):not(#addListEntry):not(.add-list):not(.list-placeholder)')];
    return lists.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = x - (box.left + box.width / 2);
        if (offset < 0 && offset > closest.offset) {
            return { offset, element: child };
        } else {
            return closest;
        }
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// Add after renderBoard
function adjustBoardCentering() {
    const container = document.getElementById('listsContainer');
    if (!container) return;

    const lists = container.querySelectorAll('.list:not(#addListEntry)');
    const n = lists.length;
    if (n === 0) {
        container.style.paddingLeft = '0px';
        return;
    }

    const listWidth = 272; // var(--list-width)
    const gap = 12; // var(--list-gap)
    const totalWidth = n * listWidth + (n - 1) * gap;

    const viewportWidth = container.clientWidth;
    if (totalWidth < viewportWidth) {
        const padding = (viewportWidth - totalWidth) / 2;
        container.style.paddingLeft = `${padding}px`;
    } else {
        container.style.paddingLeft = '0px';
    }
}

// Call after render and on resize
window.addEventListener('resize', adjustBoardCentering);

// 成员管理：打开/关闭
function openMembersModal() {
    const modal = document.getElementById('membersModal');
    if (!modal) return;
    // 填充邀请码与成员列表
    document.getElementById('inviteCodeText').textContent = document.getElementById('projectInviteCode').textContent || '------';
    const isOwner = window.currentProjectOwner && currentUser === window.currentProjectOwner;
    const addRow = document.getElementById('addMemberRow');
    if (addRow) addRow.style.display = isOwner ? '' : '';
    const regenBtn = document.getElementById('regenerateInviteBtn');
    if (regenBtn) regenBtn.style.display = isOwner ? '' : 'none';
    renderMembersList();
    renderPendingRequests();
    modal.classList.remove('hidden');
}

function closeMembersModal() {
    const modal = document.getElementById('membersModal');
    if (modal) modal.classList.add('hidden');
}

function renderMembersList() {
    const wrap = document.getElementById('membersList');
    if (!wrap) return;
    const members = (window.currentProjectMembers || []).slice();
    const owner = window.currentProjectOwner;
    const isOwner = owner && currentUser === owner;
    if (!members.length) {
        wrap.innerHTML = '<div class="empty-state">暂无成员</div>';
        return;
    }
    wrap.innerHTML = members.map(u => {
        const isOwnerUser = owner && u === owner;
        // 只有所有者能移除他人；非所有者只能移除自己
        let right = '';
        if (isOwnerUser) {
            right = '<span style="font-size:12px;color:#6b7280">所有者</span>';
        } else if (isOwner || u === currentUser) {
            right = `<button class="btn-secondary" data-remove="${escapeHtml(u)}">移除</button>`;
        } else {
            right = '';
        }
        return `<div class=\"card-info\" style=\"margin-bottom:8px; display:flex; align-items:center; justify-content:space-between\"><span>${escapeHtml(u)}</span><span>${right}</span></div>`;
    }).join('');
    wrap.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const username = e.currentTarget.getAttribute('data-remove');
            if (!username) return;
            const ok = await uiConfirm(`确定移除成员 “${username}” 吗？`, '移除成员');
            if (!ok) return;
            try {
                const resp = await fetch('/api/remove-project-member', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ projectId: currentProjectId, username, actor: currentUser })
                });
                const result = await resp.json();
                if (resp.ok) {
                    // 若是自我移除，立即退出项目
                    if (username === currentUser) {
                        try { if (socket) socket.close(); } catch (e2) {}
                        currentProjectId = null;
                        currentProjectName = null;
                        currentBoardName = null;
                        localStorage.removeItem('kanbanCurrentProjectId');
                        localStorage.removeItem('kanbanCurrentProjectName');
                        localStorage.removeItem('kanbanCurrentBoardName');
                        showProjectPage();
                        loadUserProjects();
                        uiToast('已退出项目','success');
                        return;
                    }
                    window.currentProjectMembers = result.members || [];
                    renderMembersList();
                    document.getElementById('projectMembers').textContent = (window.currentProjectMembers || []).join(', ');
                    updateAssigneeOptions();
                    uiToast('已移除成员','success');
                } else {
                    uiToast(result.message || '移除成员失败','error');
                }
            } catch (err) {
                console.error('remove member error', err);
                uiToast('移除成员失败','error');
            }
        });
    });
}

async function addProjectMember() {
    const input = document.getElementById('addMemberInput');
    if (!input) return;
    const username = (input.value || '').trim();
    if (!username) { uiToast('请输入用户名','error'); return; }
    try {
        const resp = await fetch('/api/request-add-member', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: currentProjectId, username, actor: currentUser })
        });
        const result = await resp.json();
        if (resp.ok) {
            input.value = '';
            renderPendingRequests(true);
            uiToast(result.message || '已提交添加请求，待审批','success');
        } else {
            uiToast(result.message || '添加成员失败','error');
        }
    } catch (err) {
        console.error('add member error', err);
        uiToast('添加成员失败','error');
    }
}

function copyInviteCode() {
    const code = document.getElementById('inviteCodeText').textContent || '';
    if (!code) { uiToast('暂无邀请码','error'); return; }
    try {
        navigator.clipboard.writeText(code).then(() => uiToast('邀请码已复制','success'));
    } catch (e) {
        uiToast('复制失败','error');
    }
}

// Add: copy project invite code from project page (boardSelectPage)
function copyProjectInviteCode() {
    try {
        const el = document.getElementById('projectInviteCode');
        const code = (el && el.textContent) ? el.textContent.trim() : '';
        if (!code || code === '------') { uiToast('暂无邀请码','error'); return; }
        navigator.clipboard.writeText(code).then(() => uiToast('邀请码已复制','success'));
    } catch (e) {
        uiToast('复制失败','error');
    }
}

// Add: generic copy helper for cards
function copyCode(code) {
    const text = (code || '').trim();
    if (!text) { uiToast('暂无邀请码','error'); return; }
    try {
        navigator.clipboard.writeText(text).then(() => uiToast('邀请码已复制','success'));
    } catch (e) {
        uiToast('复制失败','error');
    }
}

async function regenerateInviteCode() {
    try {
        const ok = await uiConfirm('确定要重置当前项目的邀请码吗？已有旧码将失效。', '重置邀请码');
        if (!ok) return;
        const resp = await fetch('/api/regenerate-invite-code', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: currentProjectId, actor: currentUser })
        });
        const result = await resp.json();
        if (resp.ok) {
            document.getElementById('projectInviteCode').textContent = result.inviteCode;
            document.getElementById('inviteCodeText').textContent = result.inviteCode;
            uiToast('邀请码已重置','success');
        } else {
            uiToast(result.message || '重置失败','error');
        }
    } catch (err) {
        console.error('regen invite error', err);
        uiToast('重置失败','error');
    }
}

function renderPendingRequests(forceReload) {
    const list = document.getElementById('pendingRequestsList');
    if (!list) return;
    const owner = window.currentProjectOwner;
    const isOwner = owner && currentUser === owner;
    const isMember = (window.currentProjectMembers || []).includes(currentUser);
    if (!isMember) { list.innerHTML = ''; return; }
    const fetchAndRender = async () => {
        try {
            const resp = await fetch(`/api/join-requests/${currentProjectId}`);
            const data = await resp.json();
            const requests = (data && data.requests) || [];
            if (!requests.length) { list.innerHTML = '<div class="empty-state">暂无申请</div>'; return; }
            list.innerHTML = requests.map(r => {
                const canAct = isOwner; // 仅所有者可审批
                const actions = canAct ? `<button class=\"btn-primary\" data-approve=\"${escapeHtml(r.username)}\">同意</button> <button class=\"btn-secondary\" data-deny=\"${escapeHtml(r.username)}\">拒绝</button>` : '<span style=\"font-size:12px;color:#6b7280\">等待项目所有者审批</span>';
                return `<div class=\"card-info\" style=\"margin:6px 0; display:flex; align-items:center; justify-content:space-between\"><span>${escapeHtml(r.username)} <small style=\"color:#6b7280\">申请加入</small></span><span>${actions}</span></div>`;
            }).join('');
            // bind actions
            list.querySelectorAll('button[data-approve]').forEach(btn => {
                btn.addEventListener('click', () => approveJoin(btn.getAttribute('data-approve')));
            });
            list.querySelectorAll('button[data-deny]').forEach(btn => {
                btn.addEventListener('click', () => denyJoin(btn.getAttribute('data-deny')));
            });
        } catch (e) {
            console.error('load requests error', e);
        }
    };
    if (forceReload) fetchAndRender(); else fetchAndRender();
}

async function approveJoin(username) {
    try {
        const resp = await fetch('/api/approve-join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: currentProjectId, username, actor: currentUser }) });
        const result = await resp.json();
        if (resp.ok) {
            window.currentProjectMembers = result.members || window.currentProjectMembers;
            document.getElementById('projectMembers').textContent = (window.currentProjectMembers || []).join(', ');
            updateAssigneeOptions();
            renderMembersList();
            renderPendingRequests(true);
            uiToast('已同意加入','success');
        } else uiToast(result.message || '操作失败','error');
    } catch (e) { console.error('approve join error', e); uiToast('操作失败','error'); }
}

async function denyJoin(username) {
    try {
        const resp = await fetch('/api/deny-join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: currentProjectId, username, actor: currentUser }) });
        const result = await resp.json();
        if (resp.ok) {
            renderPendingRequests(true);
            uiToast('已拒绝申请','success');
        } else uiToast(result.message || '操作失败','error');
    } catch (e) { console.error('deny join error', e); uiToast('操作失败','error'); }
}

// 我的邀请：加载并渲染在首页
async function loadUserInvites() {
    try {
        const badge = document.getElementById('invitesBadge');
        const resp = await fetch(`/api/user-invites/${currentUser}`);
        const data = await resp.json();
        const invites = (data && data.invites) || [];
        // 更新导航栏徽标（先用收到的邀请占位，稍后叠加审批数）
        if (badge) {
            if (invites.length > 0) { badge.style.display = ''; badge.textContent = String(invites.length); }
            else { badge.style.display = 'none'; badge.textContent = '0'; }
        }
        // 同步模态框列表
        const modalList = document.getElementById('invitesModalList');
        if (modalList) {
            let html = '';
            // 邀请码加入项目（作为申请人）
            html += `<div class=\"form-group\" style=\"margin-bottom:12px\"><div class=\"card-info\" style=\"gap:8px; align-items:center\"><div style=\"flex:1\">通过邀请码加入项目</div><div style=\"display:inline-flex; gap:8px\"><input id=\"inviteCodeInput\" type=\"text\" placeholder=\"输入 6 位邀请码\" style=\"width:140px; height:36px; border:1px solid #e5e7eb; border-radius:6px; padding:0 10px\"> <button class=\"btn-primary\" id=\"inviteCodeJoinBtn\">提交申请</button></div></div></div>`;
            // 我收到的邀请（我同意/拒绝）
            html += `<h4 style=\"margin:8px 0\">我收到的邀请</h4>`;
            if (invites.length) {
                html += invites.map(i => {
                    const info = `加入「${escapeHtml(i.projectName)}」 · 邀请人：${escapeHtml(i.invitedBy)}`;
                    return `<div class=\"project-card\" style=\"display:flex; align-items:center; justify-content:space-between; gap:8px\"><div>${info}</div><div style=\"display:inline-flex; gap:8px\"><button class=\"btn-primary\" data-accept-modal=\"${escapeHtml(i.projectId)}\" data-project-name=\"${escapeHtml(i.projectName)}\">接受</button><button class=\"btn-secondary\" data-decline-modal=\"${escapeHtml(i.projectId)}\" data-project-name=\"${escapeHtml(i.projectName)}\">拒绝</button></div></div>`;
                }).join('');
            } else {
                html += `<div class=\"empty-state\">暂无邀请</div>`;
            }
            // 我需要审批的"通过邀请码加入项目"的申请（仅当我是项目所有者）
            try {
                const approvalsResp = await fetch(`/api/user-approvals/${currentUser}`);
                const approvalsData = await approvalsResp.json();
                const approvals = (approvalsData && approvalsData.approvals) || [];
                // 叠加审批数到徽标
                if (badge) {
                    const total = invites.length + approvals.length;
                    if (total > 0) { badge.style.display = ''; badge.textContent = String(total); }
                    else { badge.style.display = 'none'; badge.textContent = '0'; }
                }
                html += `<h4 style=\"margin:12px 0 8px\">待我处理的加入申请</h4>`;
                if (approvals.length) {
                    html += approvals.map(a => {
                        const text = `${escapeHtml(a.username)} 申请加入「${escapeHtml(a.projectName)}」`;
                        return `<div class=\"project-card\" style=\"display:flex; align-items:center; justify-content:space-between; gap:8px\"><div>${text}</div><div style=\"display:inline-flex; gap:8px\"><button class=\"btn-primary\" data-approve-join=\"${escapeHtml(a.projectId)}::${escapeHtml(a.username)}\" data-project-name=\"${escapeHtml(a.projectName)}\">同意</button><button class=\"btn-secondary\" data-deny-join=\"${escapeHtml(a.projectId)}::${escapeHtml(a.username)}\" data-project-name=\"${escapeHtml(a.projectName)}\">拒绝</button></div></div>`;
                    }).join('');
                } else {
                    html += `<div class=\"empty-state\">暂无待审批</div>`;
                }
                modalList.innerHTML = html;
                // 绑定收到的邀请按钮
                modalList.querySelectorAll('button[data-accept-modal]').forEach(btn => {
                    btn.addEventListener('click', () => acceptInvite(btn.getAttribute('data-accept-modal'), btn.getAttribute('data-project-name') || ''));
                });
                modalList.querySelectorAll('button[data-decline-modal]').forEach(btn => {
                    btn.addEventListener('click', () => declineInvite(btn.getAttribute('data-decline-modal'), btn.getAttribute('data-project-name') || ''));
                });
                // 绑定待审批按钮（仅所有者有效，后端会校验）
                modalList.querySelectorAll('button[data-approve-join]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const [pid, uname] = btn.getAttribute('data-approve-join').split('::');
                        const pname = btn.getAttribute('data-project-name') || '';
                        try {
                            const resp = await fetch('/api/approve-join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: pid, username: uname, actor: currentUser }) });
                            const result = await resp.json();
                            if (resp.ok) { uiToast(`已同意 ${uname} 加入「${pname}」`,'success'); loadUserInvites(); loadUserProjects(); }
                            else { uiToast(result.message || '操作失败','error'); }
                        } catch (e) { uiToast('操作失败','error'); }
                    });
                });
                modalList.querySelectorAll('button[data-deny-join]').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const [pid, uname] = btn.getAttribute('data-deny-join').split('::');
                        const pname = btn.getAttribute('data-project-name') || '';
                        try {
                            const resp = await fetch('/api/deny-join', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ projectId: pid, username: uname, actor: currentUser }) });
                            const result = await resp.json();
                            if (resp.ok) { uiToast(`已拒绝加入「${pname}」的申请`,'success'); loadUserInvites(); }
                            else { uiToast(result.message || '操作失败','error'); }
                        } catch (e) { uiToast('操作失败','error'); }
                    });
                });
            } catch (e) {
                modalList.innerHTML = html;
            }
            const joinBtn = document.getElementById('inviteCodeJoinBtn');
            const input = document.getElementById('inviteCodeInput');
            if (joinBtn && input) {
                joinBtn.addEventListener('click', async () => {
                    const code = (input.value || '').trim().toUpperCase();
                    if (!code || code.length !== 6) { uiToast('请输入 6 位邀请码','error'); return; }
                    try {
                        const response = await fetch('/api/join-project', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, inviteCode: code }) });
                        const result = await response.json();
                        if (response.ok) { uiToast(result.message || '申请已提交，等待所有者审批','success'); input.value=''; }
                        else { uiToast(result.message || '加入项目失败','error'); }
                    } catch (e) { uiToast('加入项目失败','error'); }
                });
            }
        }
    } catch (e) {
        console.error('Load invites error', e);
    }
}

function openInvitesModal() {
    const modal = document.getElementById('invitesModal');
    if (!modal) return;
    modal.classList.remove('hidden');
}

function closeInvitesModal() {
    const modal = document.getElementById('invitesModal');
    if (!modal) return;
    modal.classList.add('hidden');
}

async function acceptInvite(projectId, projectName) {
    try {
        const resp2 = await fetch('/api/accept-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, projectId }) });
        const result = await resp2.json();
        if (resp2.ok) {
            const pname = projectName || '项目';
            uiToast(`已接受邀请，已加入「${pname}」`,'success');
            loadUserInvites();
            loadUserProjects();
        } else uiToast(result.message || '操作失败','error');
    } catch (e) { uiToast('操作失败','error'); }
}

async function declineInvite(projectId, projectName) {
    try {
        const resp2 = await fetch('/api/decline-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, projectId }) });
        const result = await resp2.json();
        if (resp2.ok) {
            const pname = projectName || '项目';
            uiToast(`已拒绝加入「${pname}」的邀请`,'success');
            loadUserInvites();
        } else uiToast(result.message || '操作失败','error');
    } catch (e) { uiToast('操作失败','error'); }
}

let membershipGuardTimer = null;
let userProjectsLoadToken = 0;

function forceExitCurrentProject(toastMsg) {
    if (!currentUser) { stopMembershipGuard(); return; }
    try { if (socket) socket.close(); } catch (e) {}
    currentProjectId = null;
    currentProjectName = null;
    currentBoardName = null;
    localStorage.removeItem('kanbanCurrentProjectId');
    localStorage.removeItem('kanbanCurrentProjectName');
    localStorage.removeItem('kanbanCurrentBoardName');
    showProjectPage();
    loadUserProjects();
    if (toastMsg) uiToast(toastMsg, 'error');
}

function startMembershipGuard() {
    stopMembershipGuard();
    if (!currentProjectId) return;
    membershipGuardTimer = setInterval(async () => {
        if (!currentUser || !currentProjectId) { stopMembershipGuard(); return; }
        try {
            const resp = await fetch(`/api/project-boards/${currentProjectId}`);
            if (!resp.ok) { forceExitCurrentProject('已被移出项目'); return; }
            const data = await resp.json().catch(()=>null);
            if (!data || !Array.isArray(data.members) || !data.members.includes(currentUser)) {
                forceExitCurrentProject('已被移出项目');
            }
        } catch(e) {}
    }, 2000);
}

function stopMembershipGuard() {
    if (membershipGuardTimer) { clearInterval(membershipGuardTimer); membershipGuardTimer = null; }
}

// 修改密码流程（需要旧密码）
async function changePasswordFlow() {
    try {
        const data = await openPasswordDialog('修改密码', true);
        if (!data) return;
        const rs = await fetch('/api/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, oldPassword: data.oldPwd, newPassword: data.newPwd })
        });
        const rj = await rs.json().catch(()=>({}));
        if (rs.ok) {
            uiToast('密码已更新','success');
        } else {
            uiToast(rj.message || '修改失败','error');
        }
    } catch(e) {
        uiToast('网络错误，请稍后再试','error');
    }
}

// 单次对话框：可选旧密码 + 新密码两次确认
function openPasswordDialog(title, needOld) {
    return new Promise((resolve) => {
        const { overlay, body, footer, close } = createBaseModal(title || '设置密码');

        function makeRow(labelText, type = 'password', autocompleteValue, nameValue, lpIgnore) {
            const wrap = document.createElement('div');
            const label = document.createElement('div');
            label.textContent = labelText;
            label.style.marginTop = '6px';
            const input = document.createElement('input');
            input.type = type;
            if (autocompleteValue) input.autocomplete = autocompleteValue;
            if (nameValue) input.name = nameValue;
            if (lpIgnore) input.setAttribute('data-lpignore', 'true');
            input.setAttribute('autocapitalize','off');
            input.setAttribute('autocorrect','off');
            input.setAttribute('spellcheck','false');
            input.style.width = '100%';
            input.style.height = '36px';
            input.style.border = '1px solid #e5e7eb';
            input.style.borderRadius = '6px';
            input.style.padding = '0 10px';
            input.style.marginTop = '6px';
            // 防密码管理器自动填充：默认只读，用户交互后解锁并清空
            input.readOnly = true;
            const unlock = () => { input.readOnly = false; input.value = ''; };
            input.addEventListener('focus', unlock, { once: true });
            input.addEventListener('mousedown', unlock, { once: true });
            wrap.appendChild(label);
            wrap.appendChild(input);
            return { wrap, input };
        }

        // 蜜罐：诱导密码管理器自动填充到隐藏输入，而非真实字段
        const honeyWrap = document.createElement('div');
        honeyWrap.style.position = 'absolute';
        honeyWrap.style.width = '1px';
        honeyWrap.style.height = '1px';
        honeyWrap.style.overflow = 'hidden';
        honeyWrap.style.opacity = '0';
        const honeyUser = document.createElement('input');
        honeyUser.type = 'text';
        honeyUser.autocomplete = 'username';
        const honeyPass = document.createElement('input');
        honeyPass.type = 'password';
        honeyPass.autocomplete = 'current-password';
        honeyWrap.appendChild(honeyUser);
        honeyWrap.appendChild(honeyPass);
        body.appendChild(honeyWrap);

        let oldRow = null;
        if (needOld) {
            oldRow = makeRow('当前密码', 'password', 'off', 'opwd', true);
            body.appendChild(oldRow.wrap);
            // 强制用户手输旧密码：彻底屏蔽自动填充
            try {
                oldRow.input.setAttribute('autocomplete', 'off');
                oldRow.input.setAttribute('data-1p-ignore', 'true');
                oldRow.input.setAttribute('data-lpignore', 'true');
                oldRow.input.setAttribute('data-form-type', 'other');
                oldRow.input.name = 'opwd-' + Math.random().toString(36).slice(2);
                oldRow.input.value = '';
                oldRow.input.readOnly = true;
                oldRow.input.type = 'text';
                const forceUnlock = () => { oldRow.input.type = 'password'; oldRow.input.readOnly = false; oldRow.input.value = ''; };
                oldRow.input.addEventListener('focus', forceUnlock, { once: true });
                oldRow.input.addEventListener('mousedown', forceUnlock, { once: true });
                setTimeout(() => { try { oldRow.input.value = ''; } catch(e){} }, 0);
                setTimeout(() => { try { oldRow.input.value = ''; } catch(e){} }, 300);
            } catch(e) {}
        }
        const newRow = makeRow('新密码（至少6位）', 'password', 'new-password', 'new-password', true);
        const confirmRow = makeRow('确认新密码', 'password', 'new-password', 'new-password', true);
        body.appendChild(newRow.wrap);
        body.appendChild(confirmRow.wrap);

        const cancel = document.createElement('button');
        cancel.className = 'btn-secondary';
        cancel.textContent = '取消';
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };

        const ok = document.createElement('button');
        ok.className = 'btn-primary';
        ok.textContent = '确定';
        ok.onclick = () => {
            const oldPwd = needOld ? (oldRow.input.value || '') : null;
            const p1 = (newRow.input.value || '').trim();
            const p2 = (confirmRow.input.value || '').trim();
            if (needOld && !oldPwd) { oldRow.input.focus(); return; }
            if (p1.length < 6) { uiToast('新密码至少6位','error'); newRow.input.focus(); return; }
            if (p1 !== p2) { uiToast('两次输入的密码不一致','error'); confirmRow.input.focus(); return; }
            document.body.removeChild(overlay);
            resolve({ oldPwd, newPwd: p1 });
        };

        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => { (needOld ? oldRow.input : newRow.input).focus(); }, 0);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') cancel.click();
            if (e.key === 'Enter') ok.click();
        });
    });
}

function ensureToastContainer() {
    let c = document.getElementById('toastContainer');
    if (!c) {
        c = document.createElement('div');
        c.id = 'toastContainer';
        c.className = 'toast-container';
        document.body.appendChild(c);
    }
    return c;
}