// 全局变量
let socket;
let bgMenuOutsideClickHandler = null;
let bgMenuKeyHandler = null;
let onlineUsersMenuOutsideClickHandler = null;
let onlineUsersMenuKeyHandler = null;
let currentUser = null;
let currentUserDisplayName = '';
let userDisplayNameMap = Object.create(null);
let currentProjectId = null;
let currentProjectName = null;
let currentBoardName = null;
let boardData = { archived: [], lists: { listIds: [], lists: {} } };
let editingCardId = null;
let previousPage = null; // 记录上一个页面
let lastEditTime = 0;
let pendingBoardUpdate = false;
let pendingRenderTimer = null;
let inlineEditorOpening = false;
let pendingFocusSelector = null;
let pendingFocusCaretIndex = null;
// Guard to avoid double initial render and provide WS fallback
let initialBoardRendered = false;
let initialBoardTimeout = null;
const inlineEditingCardIds = new Set();

// Snapshot & WS join tracking to reduce flicker and redundant loads
let lastLoadedBoardKey = null;
let lastJoinedBoardKey = null;
let lastFetchBoardKey = null;
let lastFetchTime = 0;
let ignoreFirstBoardUpdate = false;

// Board switcher state
let boardSwitcherMenu = null;
let boardSwitcherOpen = false;
let boardSwitcherBodyClickHandler = null;
let boardSwitcherKeyHandler = null;
let boardSwitcherFocusInHandler = null;
let projectBoardsCache = Object.create(null);
let isCreatingBoard = false;
let pendingWindowScroll = null;
let wsReconnectTimer = null;
let suppressAutoReconnect = false;
// Guard: suppress global Enter handlers (e.g., open composer) after inline rename submit
let enterComposerSuppressUntil = 0;

// Project switcher state
let projectSwitcherMenu = null;
let projectSwitcherOpen = false;
let projectSwitcherBodyClickHandler = null;
let projectSwitcherKeyHandler = null;
let projectSwitcherFocusInHandler = null;

// First-visit and dirtiness tracking for homepage (projects list)
let homeLoadedOnce = false;
let homeDirty = false;
// Track board-select (project page) loads to avoid stale overwrites
let projectBoardsLoadToken = 0;
let lastLoadedProjectIdForBoards = null;
let projectBoardsAbortController = null;
let boardSelectPendingShow = false;
// Keep add-list form open for consecutive list creation
let keepAddingLists = false;

// Track last time we handled Esc for add-list to avoid keyup double-handling
let escAddListHandledAt = 0;

function setCurrentUserDisplayName(name) {
    const trimmed = (name && String(name).trim()) || '';
    currentUserDisplayName = trimmed;
    if (currentUser) {
        userDisplayNameMap[currentUser] = trimmed || currentUser;
    }
    try { localStorage.setItem('kanbanDisplayName', trimmed); } catch(_) {}
}

function mergeUserDisplayNames(map) {
    if (!map || typeof map !== 'object') return;
    Object.keys(map).forEach((key) => {
        const val = map[key];
        if (val) userDisplayNameMap[key] = String(val);
    });
}

function getDisplayNameForUser(username) {
    if (!username) return '';
    if (currentUser && username === currentUser && currentUserDisplayName) {
        return currentUserDisplayName;
    }
    return (userDisplayNameMap && userDisplayNameMap[username]) ? userDisplayNameMap[username] : username;
}

function formatUserList(usernames) {
    if (!Array.isArray(usernames)) return '';
    return usernames.map(u => getDisplayNameForUser(u)).join(', ');
}

async function refreshCurrentUserProfile() {
    if (!currentUser) return;
    try {
        const resp = await fetch(`/api/user-profile/${encodeURIComponent(currentUser)}`);
        if (!resp.ok) return;
        const data = await resp.json().catch(()=>null);
        if (data && data.displayName) {
            setCurrentUserDisplayName(data.displayName);
            const nameEl = document.getElementById('currentUserName');
            if (nameEl) nameEl.textContent = getDisplayNameForUser(currentUser);
            const membersEl = document.getElementById('projectMembers');
            if (membersEl && window.currentProjectMembers) {
                membersEl.textContent = formatUserList(window.currentProjectMembers);
            }
            updateAssigneeOptions();
            if (window.currentOnlineUsers) updateOnlineUsers(window.currentOnlineUsers);
        }
    } catch(_) {}
}

// Unified closer for the add-list entry. Returns true if it closed something.
function closeAddListEntry(e) {
    try {
        const add = document.getElementById('addListEntry');
        if (!add) return false;
        const form = add.querySelector('.add-list-form');
        const openBtn = add.querySelector('.add-list-open');
        if (!form || !openBtn || form.hidden) return false;
        if (e) {
            try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}
        }
        keepAddingLists = false;
        form.hidden = true;
        openBtn.hidden = false;
        const input = form.querySelector('input');
        if (input) { try { input.value = ''; } catch(_){} }
        try { openBtn.focus(); } catch(_){}
        escAddListHandledAt = Date.now();
        return true;
    } catch(_) {
        return false;
    }
}

// Bind once: click outside add-list to close
let addListOutsideHandlerBound = false;
function bindAddListOutsideClose(){
    if (addListOutsideHandlerBound) return;
    addListOutsideHandlerBound = true;
    document.addEventListener('mousedown', (ev) => {
        const add = document.getElementById('addListEntry');
        if (!add) return;
        const form = add.querySelector('.add-list-form');
        if (!form || form.hidden) return;
        if (!add.contains(ev.target)) {
            // Do not cancel the outside click; just close the add-list entry
            closeAddListEntry();
        }
    }, true);
}

// ensure binding active
try { bindAddListOutsideClose(); } catch(_){}

// 拖拽状态（支持跨列）
let draggingCardId = null;
let draggingFromStatus = null;
let draggingOriginContainer = null;
let draggingCurrentContainer = null;
let draggingCardPlaceholder = null;
let draggingCardEl = null;
let showCompletedCards = false;
let pendingListsSyncKey = null;
let archiveListFilter = 'all';
let listHeaderLineStyle = 'title';
let boardDragScrollEnabled = false;
let faviconStyle = 'board';
let undoStack = [];
let redoStack = [];
let undoBoardKey = null;
let undoRedoInProgress = false;
const CARD_ADD_RETRY_MS = 8000;
const CARD_ADD_MAX_RETRIES = 4;
const UNDO_LIMIT = 20;
const UNDO_TTL_MS = 10 * 60 * 1000;
const EDIT_UNDO_MERGE_MS = 1500;
const CARD_EDIT_FIELDS = new Set(['title', 'description', 'assignee', 'deadline', 'priority', 'labels', 'checklist']);
const LOCAL_BOARD_RENDER_SKIP_MS = 800;
const LOCAL_BOARD_RENDER_MAX_PENDING = 3;
const pendingLocalCardUpdates = new Map();

// DOM 元素
const loginPage = document.getElementById('loginPage');
const projectPage = document.getElementById('projectPage');
const boardSelectPage = document.getElementById('boardSelectPage');
const boardPage = document.getElementById('boardPage');
const archivePage = document.getElementById('archivePage');
const authForm = document.getElementById('authForm');
const formTitle = document.getElementById('formTitle');
const loginSubtitle = document.getElementById('loginSubtitle');
const submitBtn = document.getElementById('submitBtn');
const emailField = document.getElementById('emailField');
const switchMode = document.getElementById('switchMode');
const switchText = document.getElementById('switchText');
const editModal = document.getElementById('editModal');
const importModal = document.getElementById('importModal');
const importTextModal = document.getElementById('importTextModal');
const importTextArea = document.getElementById('importTextArea');
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

function getShowCompletedStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanShowCompleted:${pid}:${bname}`;
}

function getArchiveFilterStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanArchiveFilter:${pid}:${bname}`;
}

function getListHeaderLineStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanListHeaderLine:${pid}:${bname}`;
}

function getBoardDragScrollStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanBoardDragScroll:${pid}:${bname}`;
}

function getFaviconStyleStorageKey(){
    return 'kanbanFaviconStyle';
}

function getPendingCardAddsStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanPendingCardAdds:${pid}:${bname}`;
}

function loadPendingCardAdds(){
    try {
        const raw = localStorage.getItem(getPendingCardAddsStorageKey());
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function savePendingCardAdds(items){
    try { localStorage.setItem(getPendingCardAddsStorageKey(), JSON.stringify(items || [])); } catch (_) {}
}

function dropPendingCardAddsForStatus(status){
    if (!status) return;
    const pending = loadPendingCardAdds();
    if (!pending.length) return;
    const next = pending.filter(item => item && item.status !== status);
    if (next.length !== pending.length) savePendingCardAdds(next);
}

function dropPendingCardAddsByIds(idSet){
    const pending = loadPendingCardAdds();
    if (!pending.length) return;
    const ids = (idSet instanceof Set) ? idSet : new Set(idSet || []);
    if (!ids.size) return;
    const next = pending.filter(item => !(item && item.card && ids.has(item.card.id)));
    if (next.length !== pending.length) savePendingCardAdds(next);
}

function queuePendingCardAdd(status, card, position){
    if (!status || !card || !card.id) return;
    const pending = loadPendingCardAdds();
    if (pending.some(item => item && item.card && item.card.id === card.id)) return;
    pending.push({ status, card, position: position || 'bottom', sentAt: 0, retries: 0 });
    savePendingCardAdds(pending);
}

function doesCardExistInBoardData(cardId){
    if (!cardId) return false;
    for (const s of getAllStatusKeys()){
        const found = (boardData[s] || []).some(c => c && c.id === cardId);
        if (found) return true;
    }
    return false;
}

function prunePendingCardAdds(){
    const pending = loadPendingCardAdds();
    if (!pending.length) return;
    const next = pending.filter(item => !(item && item.card && doesCardExistInBoardData(item.card.id)));
    if (next.length !== pending.length) savePendingCardAdds(next);
}

function applyPendingCardAddsToBoardData(){
    const pending = loadPendingCardAdds();
    if (!pending.length) return;
    const listStatuses = new Set();
    if (clientLists && clientLists.listIds && clientLists.lists) {
        clientLists.listIds.forEach(id => {
            const st = clientLists.lists[id] && clientLists.lists[id].status;
            if (st) listStatuses.add(st);
        });
    }
    pending.forEach(item => {
        if (!item || !item.card || !item.card.id) return;
        if (doesCardExistInBoardData(item.card.id)) return;
        const status = item.status;
        if (!status) return;
        if (listStatuses.size > 0 && !listStatuses.has(status)) return;
        if (!Array.isArray(boardData[status])) boardData[status] = [];
        if (item.position === 'top') {
            boardData[status] = [item.card, ...boardData[status]];
        } else {
            boardData[status] = [...boardData[status], item.card];
        }
    });
}

function flushPendingCardAdds(){
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const pending = loadPendingCardAdds();
    if (!pending.length) return;
    const now = Date.now();
    const listStatuses = new Set();
    if (clientLists && clientLists.listIds && clientLists.lists) {
        clientLists.listIds.forEach(id => {
            const st = clientLists.lists[id] && clientLists.lists[id].status;
            if (st) listStatuses.add(st);
        });
    }
    const next = [];
    pending.forEach(item => {
        if (!item || !item.card || !item.card.id) return;
        if (doesCardExistInBoardData(item.card.id)) return;
        const sentAt = item.sentAt || 0;
        const retries = item.retries || 0;
        if (listStatuses.size > 0 && !listStatuses.has(item.status)) return;
        if (retries >= CARD_ADD_MAX_RETRIES) return;
        if (!sentAt || (now - sentAt) > CARD_ADD_RETRY_MS) {
            socket.send(JSON.stringify({
                type:'add-card',
                projectId: currentProjectId,
                boardName: currentBoardName,
                actor: currentUser,
                status: item.status,
                card: item.card,
                position: item.position || 'bottom'
            }));
            item.sentAt = now;
            item.retries = retries + 1;
        }
        next.push(item);
    });
    savePendingCardAdds(next);
}

function sendCardAdd(status, card, position){
    if (!currentProjectId || !currentBoardName || !status || !card) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        status,
        card,
        position: position || 'bottom'
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ type:'add-card' }, payload)));
    }
    if (typeof fetch === 'function') {
        fetch('/api/add-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function sendArchiveCard(cardId, fromStatus){
    if (!currentProjectId || !currentBoardName || !cardId) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        cardId,
        fromStatus
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ type:'archive-card' }, payload)));
    }
    if (typeof fetch === 'function') {
        fetch('/api/archive-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function sendRestoreCard(cardId){
    if (!currentProjectId || !currentBoardName || !cardId) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        cardId
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ type:'restore-card' }, payload)));
    }
    if (typeof fetch === 'function') {
        fetch('/api/restore-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function sendDeleteCard(cardId){
    if (!currentProjectId || !currentBoardName || !cardId) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        cardId
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ type:'delete-card' }, payload)));
    }
    if (typeof fetch === 'function') {
        fetch('/api/delete-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function sendAddArchivedCard(card){
    if (!currentProjectId || !currentBoardName || !card || !card.id) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        card
    };
    if (typeof fetch === 'function') {
        fetch('/api/add-archived-card', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function sendArchiveList(status){
    if (!currentProjectId || !currentBoardName || !status) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        status
    };
    if (typeof fetch === 'function') {
        fetch('/api/archive-list', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function performDeleteCardById(cardId){
    if (!cardId) return;
    removeCardByIdFromBoardData(cardId);
    dropPendingCardAddsByIds(new Set([cardId]));
    sendDeleteCard(cardId);
    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

function restoreDeletedCard(card, status, index){
    if (!card || !card.id) return;
    removeCardByIdFromBoardData(card.id);
    if (status === 'archived') {
        insertCardIntoStatus(card, 'archived', index);
        sendAddArchivedCard(card);
    } else {
        ensureListExistsForStatus(status);
        insertCardIntoStatus(card, status, index);
        const pos = index === 0 ? 'top' : 'bottom';
        queuePendingCardAdd(status, card, pos);
        sendCardAdd(status, card, pos);
    }
    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

function restoreArchivedCard(cardSnapshot, fromStatus, index){
    if (!cardSnapshot || !cardSnapshot.id) return;
    removeCardByIdFromBoardData(cardSnapshot.id);
    const restoredCard = cloneDeep(cardSnapshot);
    delete restoredCard.archivedFrom;
    delete restoredCard.archivedAt;
    ensureListExistsForStatus(fromStatus);
    insertCardIntoStatus(restoredCard, fromStatus, index);
    sendRestoreCard(restoredCard.id);
    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

function registerDeleteCardUndo(cardId){
    if (undoRedoInProgress) return;
    const loc = getCardLocation(cardId);
    if (!loc || !loc.card) return;
    const cardCopy = cloneDeep(loc.card);
    pushUndoAction({
        type: 'delete-card',
        label: '删除任务',
        createdAt: Date.now(),
        undo: () => restoreDeletedCard(cardCopy, loc.status, loc.index),
        redo: () => performDeleteCardById(cardCopy.id)
    });
}

function sendListsSync(lists){
    if (!currentProjectId || !currentBoardName || !lists) return;
    const payload = {
        projectId: currentProjectId,
        boardName: currentBoardName,
        actor: currentUser,
        lists
    };
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(Object.assign({ type:'save-lists' }, payload)));
    }
    if (typeof fetch === 'function') {
        fetch('/api/save-lists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }
}

function loadArchiveFilterPreference(){
    try {
        const key = getArchiveFilterStorageKey();
        const stored = localStorage.getItem(key);
        archiveListFilter = stored || 'all';
    } catch(_) {
        archiveListFilter = 'all';
    }
}

function saveArchiveFilterPreference(){
    try {
        const key = getArchiveFilterStorageKey();
        localStorage.setItem(key, archiveListFilter || 'all');
    } catch(_) {}
}

function getPendingListsSyncStorageKey(projectId, boardName){
    const pid = projectId || currentProjectId || localStorage.getItem('kanbanCurrentProjectId') || '__';
    const bname = boardName || currentBoardName || localStorage.getItem('kanbanCurrentBoardName') || '__';
    return `kanbanPendingListsSync:${pid}:${bname}`;
}

function markPendingListsSync(){
    try { localStorage.setItem(getPendingListsSyncStorageKey(), 'true'); } catch(_) {}
}

function clearPendingListsSync(){
    try { localStorage.removeItem(getPendingListsSyncStorageKey()); } catch(_) {}
}

function hasPendingListsSync(){
    try { return localStorage.getItem(getPendingListsSyncStorageKey()) === 'true'; } catch(_) { return false; }
}

function listsMatch(localLists, remoteLists){
    if (!localLists || !remoteLists) return false;
    if (!Array.isArray(localLists.listIds) || !Array.isArray(remoteLists.listIds)) return false;
    if (localLists.listIds.length !== remoteLists.listIds.length) return false;
    for (let i = 0; i < localLists.listIds.length; i++) {
        const id = localLists.listIds[i];
        if (id !== remoteLists.listIds[i]) return false;
        const localMeta = localLists.lists && localLists.lists[id];
        const remoteMeta = remoteLists.lists && remoteLists.lists[id];
        if (!localMeta || !remoteMeta) return false;
        if (localMeta.status !== remoteMeta.status) return false;
        if (localMeta.title !== remoteMeta.title) return false;
    }
    return true;
}

function registerLocalCardUpdate(cardId, fields){
    if (!cardId || !Array.isArray(fields) || fields.length === 0) return;
    pendingLocalCardUpdates.set(cardId, { fields: fields.slice(), ts: Date.now() });
}

function pruneLocalCardUpdates(){
    const now = Date.now();
    for (const [cardId, entry] of pendingLocalCardUpdates.entries()) {
        if (!entry || (now - entry.ts) > LOCAL_BOARD_RENDER_SKIP_MS) {
            pendingLocalCardUpdates.delete(cardId);
        }
    }
}

function getBoardArrayKeys(board){
    if (!board || typeof board !== 'object') return [];
    return Object.keys(board).filter(k => Array.isArray(board[k]));
}

function boardsHaveSameCardOrder(prevBoard, nextBoard){
    if (!prevBoard || !nextBoard) return false;
    const prevKeys = getBoardArrayKeys(prevBoard).sort();
    const nextKeys = getBoardArrayKeys(nextBoard).sort();
    if (prevKeys.length !== nextKeys.length) return false;
    for (let i = 0; i < prevKeys.length; i++) {
        if (prevKeys[i] !== nextKeys[i]) return false;
    }
    for (const key of prevKeys) {
        const prevArr = prevBoard[key] || [];
        const nextArr = nextBoard[key] || [];
        if (prevArr.length !== nextArr.length) return false;
        for (let i = 0; i < prevArr.length; i++) {
            const prevCard = prevArr[i];
            const nextCard = nextArr[i];
            if (!prevCard || !nextCard || prevCard.id !== nextCard.id) return false;
        }
    }
    return true;
}

function shouldSkipBoardRenderForLocalUpdate(actor, prevBoard, nextBoard){
    if (!actor || actor !== currentUser) return false;
    pruneLocalCardUpdates();
    if (pendingLocalCardUpdates.size === 0) return false;
    if (!prevBoard || !nextBoard) return false;
    if (pendingLocalCardUpdates.size > LOCAL_BOARD_RENDER_MAX_PENDING) return false;
    if (prevBoard.lists && nextBoard.lists && !listsMatch(prevBoard.lists, nextBoard.lists)) return false;

    for (const [cardId, entry] of pendingLocalCardUpdates.entries()) {
        if (!entry || !Array.isArray(entry.fields) || entry.fields.length !== 1 || entry.fields[0] !== 'deferred') {
            return false;
        }
    }

    if (!boardsHaveSameCardOrder(prevBoard, nextBoard)) return false;
    pendingLocalCardUpdates.clear();
    return true;
}

function updateCompletedToggleButton(){
    const btn = document.getElementById('toggleCompletedBtn');
    if (!btn) return;
    btn.textContent = showCompletedCards ? '隐藏已完成' : '显示已完成';
    btn.setAttribute('aria-pressed', showCompletedCards ? 'true' : 'false');
}

function updateListHeaderLineButton(){
    const btn = document.getElementById('listHeaderLineBtn');
    if (!btn) return;
    const label = listHeaderLineStyle === 'none'
        ? '无'
        : (listHeaderLineStyle === 'title' ? '随标题' : '短');
    btn.textContent = `标题线: ${label}`;
}

function updateFaviconStyleButton(){
    const btn = document.getElementById('faviconStyleBtn');
    if (!btn) return;
    const label = faviconStyle === 'classic'
        ? '经典'
        : (faviconStyle === 'board' ? '看板' : (faviconStyle === 'k-yellow' ? '黄色K' : '字母'));
    btn.textContent = `图标: ${label}`;
}

function updateBoardDragScrollButton(){
    const btn = document.getElementById('boardDragScrollBtn');
    if (!btn) return;
    const label = boardDragScrollEnabled ? '大' : '常规';
    btn.textContent = `拖动范围: ${label}`;
    btn.setAttribute('aria-pressed', boardDragScrollEnabled ? 'true' : 'false');
    if (btn.classList && btn.classList.toggle) {
        btn.classList.toggle('active', boardDragScrollEnabled);
    }
}

function applyBoardDragScrollState(){
    const container = document.getElementById('listsContainer');
    if (container) {
        container.classList.remove('drag-scroll-disabled');
        if (boardDragScrollEnabled) {
            container.dataset.boardPanOffset = '';
        }
    }
    updateBoardDragScrollButton();
}

function applyListHeaderLineStyle(){
    const page = document.getElementById('boardPage');
    if (!page) return;
    const style = (listHeaderLineStyle === 'none' || listHeaderLineStyle === 'title') ? listHeaderLineStyle : 'short';
    page.setAttribute('data-list-header-line', style);
    updateListHeaderLineButton();
}

function applyFaviconStyle(){
    const link = document.getElementById('faviconLink');
    if (!link) return;
    const href = faviconStyle === 'classic'
        ? 'favicon-classic.svg'
        : (faviconStyle === 'board' ? 'favicon-board.svg' : (faviconStyle === 'k-yellow' ? 'favicon-k-yellow.svg' : 'favicon-k.svg'));
    link.setAttribute('href', href);
    updateFaviconStyleButton();
}

function loadShowCompletedPreference(){
    try {
        const key = getShowCompletedStorageKey();
        showCompletedCards = localStorage.getItem(key) === 'true';
    } catch(_) {
        showCompletedCards = false;
    }
    updateCompletedToggleButton();
}

function loadListHeaderLinePreference(){
    try {
        const key = getListHeaderLineStorageKey();
        const stored = localStorage.getItem(key);
        listHeaderLineStyle = (stored === 'none' || stored === 'title') ? stored : 'title';
    } catch(_) {
        listHeaderLineStyle = 'title';
    }
    applyListHeaderLineStyle();
}

function loadFaviconStylePreference(){
    try {
        const key = getFaviconStyleStorageKey();
        const stored = localStorage.getItem(key);
        faviconStyle = (stored === 'classic' || stored === 'board' || stored === 'k' || stored === 'k-yellow') ? stored : 'board';
    } catch(_) {
        faviconStyle = 'board';
    }
    applyFaviconStyle();
}

function loadBoardDragScrollPreference(){
    try {
        const key = getBoardDragScrollStorageKey();
        const stored = localStorage.getItem(key);
        boardDragScrollEnabled = stored === 'true';
    } catch(_) {
        boardDragScrollEnabled = false;
    }
    applyBoardDragScrollState();
    if (!boardDragScrollEnabled) {
        stopBoardDragScroll();
    }
}

function saveShowCompletedPreference(){
    try {
        const key = getShowCompletedStorageKey();
        localStorage.setItem(key, showCompletedCards ? 'true' : 'false');
    } catch(_) {}
}

function saveListHeaderLinePreference(){
    try {
        const key = getListHeaderLineStorageKey();
        const style = (listHeaderLineStyle === 'none' || listHeaderLineStyle === 'title') ? listHeaderLineStyle : 'short';
        localStorage.setItem(key, style);
    } catch(_) {}
}

function saveFaviconStylePreference(){
    try {
        const key = getFaviconStyleStorageKey();
        localStorage.setItem(key, faviconStyle);
    } catch(_) {}
}

function saveBoardDragScrollPreference(){
    try {
        const key = getBoardDragScrollStorageKey();
        localStorage.setItem(key, boardDragScrollEnabled ? 'true' : 'false');
    } catch(_) {}
}

function toggleCompletedView(){
    showCompletedCards = !showCompletedCards;
    saveShowCompletedPreference();
    updateCompletedToggleButton();
    renderBoard();
}

function toggleListHeaderLineStyle(){
    if (listHeaderLineStyle === 'short') {
        listHeaderLineStyle = 'title';
    } else if (listHeaderLineStyle === 'title') {
        listHeaderLineStyle = 'none';
    } else {
        listHeaderLineStyle = 'short';
    }
    saveListHeaderLinePreference();
    applyListHeaderLineStyle();
}

function toggleFaviconStyle(){
    if (faviconStyle === 'classic') {
        faviconStyle = 'board';
    } else if (faviconStyle === 'board') {
        faviconStyle = 'k';
    } else if (faviconStyle === 'k') {
        faviconStyle = 'k-yellow';
    } else {
        faviconStyle = 'classic';
    }
    saveFaviconStylePreference();
    applyFaviconStyle();
}

function toggleBoardDragScroll(){
    boardDragScrollEnabled = !boardDragScrollEnabled;
    saveBoardDragScrollPreference();
    applyBoardDragScrollState();
    if (!boardDragScrollEnabled) {
        stopBoardDragScroll();
    }
    adjustBoardCentering();
}

function getCurrentBoardKey(){
    return `${currentProjectId || ''}|${currentBoardName || ''}`;
}

function resetUndoRedo(){
    undoStack = [];
    redoStack = [];
    undoBoardKey = getCurrentBoardKey();
}

function pruneUndoRedo(){
    const now = Date.now();
    undoStack = undoStack.filter(item => item && (now - item.createdAt) <= UNDO_TTL_MS);
    redoStack = redoStack.filter(item => item && (now - item.createdAt) <= UNDO_TTL_MS);
}

function pushUndoAction(action){
    if (!action || undoRedoInProgress) return;
    const key = getCurrentBoardKey();
    if (undoBoardKey !== key) {
        resetUndoRedo();
    }
    pruneUndoRedo();
    undoStack.push(action);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    redoStack = [];
}

function performUndo(){
    pruneUndoRedo();
    if (undoBoardKey !== getCurrentBoardKey()) {
        resetUndoRedo();
        return false;
    }
    const action = undoStack.pop();
    if (!action || typeof action.undo !== 'function') return false;
    undoRedoInProgress = true;
    try { action.undo(); } catch(_) {} finally { undoRedoInProgress = false; }
    redoStack.push(action);
    uiToast(`已撤销${action.label ? '：' + action.label : ''}`, 'info');
    return true;
}

function performRedo(){
    pruneUndoRedo();
    if (undoBoardKey !== getCurrentBoardKey()) {
        resetUndoRedo();
        return false;
    }
    const action = redoStack.pop();
    if (!action || typeof action.redo !== 'function') return false;
    undoRedoInProgress = true;
    try { action.redo(); } catch(_) {} finally { undoRedoInProgress = false; }
    undoStack.push(action);
    uiToast(`已重做${action.label ? '：' + action.label : ''}`, 'info');
    return true;
}

function cloneDeep(value){
    if (!value) return value;
    try { return JSON.parse(JSON.stringify(value)); } catch(_) { return value; }
}

function normalizeCardEditState(state){
    const s = state || {};
    return {
        title: typeof s.title === 'string' ? s.title : '',
        description: typeof s.description === 'string' ? s.description : '',
        assignee: s.assignee || null,
        deadline: s.deadline || null,
        priority: s.priority || null,
        labels: Array.isArray(s.labels) ? s.labels.slice() : [],
        checklist: s.checklist ? cloneDeep(s.checklist) : null
    };
}

function extractCardEditState(card){
    return normalizeCardEditState(card || {});
}

function filterCardEditUpdates(updates){
    const result = {};
    if (!updates || typeof updates !== 'object') return result;
    CARD_EDIT_FIELDS.forEach((field) => {
        if (Object.prototype.hasOwnProperty.call(updates, field)) {
            result[field] = updates[field];
        }
    });
    return result;
}

function areEditValuesEqual(a, b){
    if (a === b) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch(_) { return false; }
}

function diffCardEditState(beforeState, afterState){
    const before = normalizeCardEditState(beforeState);
    const after = normalizeCardEditState(afterState);
    const diffBefore = {};
    const diffAfter = {};
    CARD_EDIT_FIELDS.forEach((field) => {
        if (!areEditValuesEqual(before[field], after[field])) {
            diffBefore[field] = cloneDeep(before[field]);
            diffAfter[field] = cloneDeep(after[field]);
        }
    });
    return { before: diffBefore, after: diffAfter };
}

function mergeCardEditState(baseState, updates){
    const next = normalizeCardEditState(baseState);
    const patch = filterCardEditUpdates(updates);
    Object.keys(patch).forEach((field) => {
        if (field === 'labels') {
            next.labels = Array.isArray(patch.labels) ? patch.labels.slice() : [];
        } else if (field === 'checklist') {
            next.checklist = patch.checklist ? cloneDeep(patch.checklist) : null;
        } else if (field === 'title' || field === 'description') {
            next[field] = typeof patch[field] === 'string' ? patch[field] : '';
        } else {
            next[field] = patch[field] || null;
        }
    });
    return normalizeCardEditState(next);
}

function applyCardEdits(cardId, updates){
    if (!updates || typeof updates !== 'object') return;
    updateCardImmediately(cardId, updates);
    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

function registerCardEditUndo(cardId, beforeState, afterState, label){
    if (undoRedoInProgress) return;
    const diff = diffCardEditState(beforeState, afterState);
    const hasChanges = Object.keys(diff.before).length > 0;
    if (!hasChanges) return;

    const now = Date.now();
    if (undoBoardKey !== getCurrentBoardKey()) {
        resetUndoRedo();
    }
    pruneUndoRedo();

    const last = undoStack[undoStack.length - 1];
    if (last && last.type === 'edit-card' && last.cardId === cardId && (now - last.createdAt) <= EDIT_UNDO_MERGE_MS) {
        const mergedBefore = Object.assign({}, last.before);
        const mergedAfter = Object.assign({}, last.after);
        Object.keys(diff.before).forEach((field) => {
            if (!Object.prototype.hasOwnProperty.call(mergedBefore, field)) {
                mergedBefore[field] = diff.before[field];
            }
            mergedAfter[field] = diff.after[field];
        });
        last.before = mergedBefore;
        last.after = mergedAfter;
        last.createdAt = now;
        if (label) last.label = label;
        last.undo = () => applyCardEdits(cardId, mergedBefore);
        last.redo = () => applyCardEdits(cardId, mergedAfter);
        redoStack = [];
        return;
    }

    pushUndoAction({
        type: 'edit-card',
        label: label || '编辑任务',
        createdAt: now,
        cardId,
        before: diff.before,
        after: diff.after,
        undo: () => applyCardEdits(cardId, diff.before),
        redo: () => applyCardEdits(cardId, diff.after)
    });
}

function applyCardEditsWithUndo(cardId, updates, options){
    if (!updates || typeof updates !== 'object') return;
    const opts = options || {};
    const editUpdates = filterCardEditUpdates(updates);
    const shouldTrack = !opts.skipUndo && Object.keys(editUpdates).length > 0;
    const card = shouldTrack ? getCardById(cardId) : null;
    const beforeState = (shouldTrack && card) ? extractCardEditState(card) : null;

    updateCardImmediately(cardId, updates);

    if (shouldTrack && beforeState) {
        const afterState = mergeCardEditState(beforeState, updates);
        registerCardEditUndo(cardId, beforeState, afterState, opts.label);
    }
}

function getCardLocation(cardId){
    if (!cardId) return null;
    for (const s of getAllStatusKeys()){
        const arr = boardData[s] || [];
        const idx = arr.findIndex(c => c && c.id === cardId);
        if (idx !== -1) {
            return { card: arr[idx], status: s, index: idx };
        }
    }
    return null;
}

function removeCardByIdFromBoardData(cardId){
    if (!cardId) return null;
    for (const s of getAllStatusKeys()){
        const arr = boardData[s] || [];
        const idx = arr.findIndex(c => c && c.id === cardId);
        if (idx !== -1) {
            const card = arr.splice(idx, 1)[0];
            return { card, status: s, index: idx };
        }
    }
    return null;
}

function insertCardIntoStatus(card, status, index){
    if (!card || !status) return;
    if (!Array.isArray(boardData[status])) boardData[status] = [];
    const arr = boardData[status];
    const idx = (typeof index === 'number' && index >= 0 && index <= arr.length) ? index : arr.length;
    arr.splice(idx, 0, card);
}

function ensureListExistsForStatus(status, title){
    if (!status) return null;
    ensureClientLists();
    const existingId = findListIdByStatus(status);
    if (existingId) return existingId;
    const id = status;
    const pos = clientLists.listIds.length;
    const titleMap = { todo: '待办', doing: '进行中', done: '已完成' };
    const listTitle = title || titleMap[status] || status;
    clientLists.lists[id] = { id, title: listTitle, pos, status };
    clientLists.listIds.push(id);
    saveClientListsToStorage();
    queueListsSync();
    return id;
}

function queueListsSync(){
    pendingListsSyncKey = getCurrentBoardKey();
    markPendingListsSync();
    trySyncListsToServer();
}

function trySyncListsToServer(){
    if (!pendingListsSyncKey || pendingListsSyncKey !== getCurrentBoardKey()) return;
    if (clientLists) {
        sendListsSync(clientLists);
    }
}

function ensureClientLists() {
    if (clientLists) return clientLists;
    // Prefer server-provided lists metadata if present
    if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
        if (hasPendingListsSync()) {
            const localLists = loadClientListsFromStorage();
            if (localLists) {
                clientLists = localLists;
                const allowed = new Set();
                clientLists.listIds.forEach(id => {
                    const st = clientLists.lists[id] && clientLists.lists[id].status;
                    if (st) allowed.add(st);
                });
                Object.keys(boardData || {}).forEach(k => {
                    if (k !== 'archived' && Array.isArray(boardData[k]) && !allowed.has(k)) {
                        delete boardData[k];
                    }
                });
                clientLists.listIds.forEach(id => {
                    const st = clientLists.lists[id] && clientLists.lists[id].status;
                    if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                });
                queueListsSync();
                return clientLists;
            }
        }
        clientLists = boardData.lists;
        saveClientListsToStorage();
        return clientLists;
    }
    // Try restore from localStorage
    const restored = loadClientListsFromStorage();
    if (restored) { clientLists = restored; return clientLists; }
    // Fallback: infer from legacy arrays on the client (if any), else start empty
    try {
        const keys = Object.keys(boardData || {});
        const statuses = keys.filter(k => Array.isArray(boardData[k]) && k !== 'archived');
        if (statuses.length) {
            const order = ['todo','doing','done'];
            const ord = [];
            order.forEach(k => { if (statuses.includes(k)) ord.push(k); });
            statuses.forEach(k => { if (!ord.includes(k)) ord.push(k); });
            const lists = {};
            ord.forEach((st, idx) => {
                const titleMap = { todo: '待办', doing: '进行中', done: '已完成' };
                lists[st] = { id: st, title: titleMap[st] || st, pos: idx, status: st };
            });
            clientLists = { listIds: ord, lists };
            saveClientListsToStorage();
            return clientLists;
        }
    } catch(_){}
    clientLists = { listIds: [], lists: {} };
    saveClientListsToStorage();
    return clientLists;
}

function resolveArchivedStatus(card){
    if (!card) return null;
    const from = card.archivedFrom || card.archivedStatus;
    if (from && from !== 'archived' && Array.isArray(boardData[from])) return from;
    const ordered = getOrderedStatusKeys();
    if (ordered.includes('done')) return 'done';
    return ordered.length ? ordered[ordered.length - 1] : null;
}

function getArchivedFilterStatus(card){
    if (!card) return null;
    const from = card.archivedFrom || card.archivedStatus;
    if (from && from !== 'archived') return from;
    return resolveArchivedStatus(card);
}

function getCardsByStatus(status) {
    const active = (boardData[status] || []).slice();
    if (!showCompletedCards) return active;
    const archived = (boardData.archived || [])
        .filter(card => resolveArchivedStatus(card) === status)
        .map(card => Object.assign({}, card, { __archivedInList: true }));
    return active.concat(archived);
}

function getAllStatusKeys(){
    return Object.keys(boardData).filter(k => Array.isArray(boardData[k]));
}

function findListIdByStatus(status){
    if (!clientLists || !Array.isArray(clientLists.listIds)) return null;
    return clientLists.listIds.find(id => clientLists.lists[id] && clientLists.lists[id].status === status) || null;
}

function reindexClientLists(){
    if (!clientLists || !Array.isArray(clientLists.listIds)) return;
    clientLists.listIds.forEach((id, idx) => { if (clientLists.lists[id]) clientLists.lists[id].pos = idx; });
}

function getOrderedStatusKeys() {
    ensureClientLists();
    if (clientLists && Array.isArray(clientLists.listIds)) {
        return clientLists.listIds
            .map(id => clientLists.lists[id])
            .filter(meta => meta && meta.status && meta.status !== 'archived')
            .sort((a, b) => (a.pos || 0) - (b.pos || 0))
            .map(meta => meta.status);
    }
    return getAllStatusKeys().filter(st => st !== 'archived');
}

function getAdjacentStatusKey(currentStatus, direction) {
    if (!currentStatus) return null;
    const ordered = getOrderedStatusKeys();
    const idx = ordered.indexOf(currentStatus);
    if (idx === -1) return null;
    if (direction === 'prev') return ordered[idx - 1] || null;
    if (direction === 'next') return ordered[idx + 1] || null;
    return null;
}

function moveCardToStatusAtIndex(cardId, toStatus, insertIndex, options) {
    const opts = options || {};
    if (!cardId || !toStatus) return;
    const loc = getCardLocation(cardId);
    if (!loc || !loc.card) return;
    const fromStatus = loc.status;
    if (!fromStatus || fromStatus === toStatus) return;

    const removed = removeCardByIdFromBoardData(cardId);
    if (!removed || !removed.card) return;
    insertCardIntoStatus(removed.card, toStatus, insertIndex);

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'move-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            actor: currentUser,
            cardId,
            fromStatus,
            toStatus
        }));
        if (!opts.skipReorder) {
            const orderedIds = (boardData[toStatus] || []).map(c => c && c.id).filter(Boolean);
            socket.send(JSON.stringify({
                type: 'reorder-cards',
                projectId: currentProjectId,
                boardName: currentBoardName,
                actor: currentUser,
                status: toStatus,
                orderedIds
            }));
        }
    }

    if (!opts.skipRender) {
        renderBoard();
    }
}

function moveCardToAdjacent(cardId, fromStatus, direction) {
    if (!cardId || !fromStatus) return;
    const loc = getCardLocation(cardId);
    const actualFromStatus = (loc && loc.status) ? loc.status : fromStatus;
    const toStatus = getAdjacentStatusKey(actualFromStatus, direction);
    if (!toStatus || toStatus === actualFromStatus) return;
    const fromList = Array.isArray(boardData[actualFromStatus]) ? boardData[actualFromStatus] : null;
    if (!fromList) return;
    const index = fromList.findIndex(card => card.id === cardId);
    if (index === -1) return;
    const [card] = fromList.splice(index, 1);
    if (!Array.isArray(boardData[toStatus])) boardData[toStatus] = [];
    const toIndex = boardData[toStatus].length;
    boardData[toStatus].push(card);
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'move-card',
            projectId: currentProjectId,
            boardName: currentBoardName,
            actor: currentUser,
            cardId,
            fromStatus: actualFromStatus,
            toStatus
        }));
    }
    renderBoard();

    if (!undoRedoInProgress) {
        pushUndoAction({
            type: 'move-card',
            label: '移动任务',
            createdAt: Date.now(),
            undo: () => moveCardToStatusAtIndex(cardId, actualFromStatus, index, { skipReorder: false }),
            redo: () => moveCardToStatusAtIndex(cardId, toStatus, toIndex, { skipReorder: false })
        });
    }
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

// === Homepage: quick boards search ===
function bindQuickBoardsSearch(){
    const input = document.getElementById('quickBoardsSearch');
    if (!input || input._bound) return;
    input._bound = true;
    input.addEventListener('input', applyQuickBoardsFilter);
}
function applyQuickBoardsFilter(){
    const input = document.getElementById('quickBoardsSearch');
    const grid = document.getElementById('quickAccessBoards');
    if (!grid) return;
    const q = (input && input.value ? input.value.trim().toLowerCase() : '');
    grid.querySelectorAll('.quick-board-card').forEach(card => {
        const title = (card.querySelector('h4')?.textContent || '').trim().toLowerCase();
        const proj = (card.querySelector('.board-project')?.textContent || '').trim().toLowerCase();
        const show = !q || title.includes(q) || proj.includes(q);
        card.style.display = show ? '' : 'none';
    });
}
function bindPopstateRouter() {
    window.addEventListener('popstate', function(e) {
        const s = e.state || {};
        isHandlingPopstate = true;

        // 检查是否从归档页面后退（归档页面正在显示）
        const isCurrentlyOnArchive = !archivePage.classList.contains('hidden');

        try {
            // 如果当前在归档页面且后退，优先回到看板页面
            if (isCurrentlyOnArchive && s.page !== 'archive') {
                // 从归档页面后退，始终回到看板页面
                currentProjectId = s.projectId || currentProjectId;
                currentProjectName = s.projectName || currentProjectName;
                currentBoardName = s.boardName || currentBoardName;
                showBoard(true);
                return;
            }

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

// New: track last hovered list section for Enter-to-open
let lastHoveredListSection = null;

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    // 渲染静态图标
    renderIconsInDom(document);
    loadFaviconStylePreference();

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
        try {
            const savedDisplayName = localStorage.getItem('kanbanDisplayName');
            setCurrentUserDisplayName(savedDisplayName || currentUser);
        } catch(_) {}
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
    const changeDisplayNameProj = document.getElementById('changeDisplayNameProject');
    if (changeDisplayNameProj) changeDisplayNameProj.addEventListener('click', changeDisplayNameFlow);
    const changePwdProj = document.getElementById('changePasswordProject');
    if (changePwdProj) changePwdProj.addEventListener('click', changePasswordFlow);
    const userBackupBtn = document.getElementById('userBackupBtn');
    if (userBackupBtn) userBackupBtn.addEventListener('click', toggleUserBackupMenu);

    // 看板选择页面事件
    document.getElementById('backToProjects').addEventListener('click', showProjectPage);
    document.getElementById('logoutFromBoard').addEventListener('click', logout);
    const manageBtn = document.getElementById('manageMembersBtn');
    if (manageBtn) manageBtn.addEventListener('click', openMembersModal);
    // 首页“所有看板”搜索
    bindQuickBoardsSearch();
    // Project title: do not open switcher; inline rename for owners only (binding after owner info ready)

    // 看板页面事件
    document.getElementById('logoutBtn').addEventListener('click', logout);
    // 移除旧的导入/导出按钮绑定，改为下拉菜单
    const ioMenuBtn = document.getElementById('ioMenuBtn');
    if (ioMenuBtn) ioMenuBtn.addEventListener('click', toggleIOMenu);
    const onlineUsersToggle = document.getElementById('onlineUsersToggle');
    if (onlineUsersToggle) onlineUsersToggle.addEventListener('click', toggleOnlineUsersMenu);
    const toggleCompletedBtn = document.getElementById('toggleCompletedBtn');
    if (toggleCompletedBtn) toggleCompletedBtn.addEventListener('click', toggleCompletedView);
    document.getElementById('archiveBtn').addEventListener('click', showArchive);
    document.getElementById('backToBoardSelect').addEventListener('click', goBack);
    document.getElementById('backToBoard').addEventListener('click', showBoard);
    const changePwdBoard = document.getElementById('changePasswordBoard');
    if (changePwdBoard) changePwdBoard.addEventListener('click', changePasswordFlow);
    bindBoardDragScroll();

    // 背景菜单（默认/导入(本地)/清除）
    const bgBtn = document.getElementById('bgBtn');
    const bgUploadFile = document.getElementById('bgUploadFile');
    if (bgBtn) bgBtn.addEventListener('click', toggleBgMenu);
    if (bgUploadFile) {
        bgUploadFile.addEventListener('change', async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            if (!/^image\//.test(file.type)) { uiToast('请选择图片文件','error'); e.target.value=''; return; }
            try {
                const dataUrl = await fileToDataURL(file);
                const rs = await fetch('/api/user-background/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, imageData: dataUrl }) });
                const rj = await rs.json().catch(()=>({}));
                if (rs.ok && rj && rj.url) { applyBoardBackground(rj.url); uiToast('背景已上传','success'); } else { uiToast((rj && rj.message) || '上传失败','error'); }
            } catch (err) { uiToast('上传失败','error'); } finally { try { e.target.value=''; }catch(_){} }
        });
    }

    // 绑定模态框事件
    let editModalBackdropGuard = false;
    editModal.addEventListener('mousedown', function(e) {
        if (e.target === editModal) {
            const ae = document.activeElement;
            editModalBackdropGuard = !!(ae && ae !== document.body && editModal.contains(ae) && ((ae.tagName === 'TEXTAREA') || (ae.tagName === 'INPUT') || ae.isContentEditable));
        } else {
            editModalBackdropGuard = false;
        }
    });
    editModal.addEventListener('touchstart', function(e) {
        if (e.target === editModal) {
            const ae = document.activeElement;
            editModalBackdropGuard = !!(ae && ae !== document.body && editModal.contains(ae) && ((ae.tagName === 'TEXTAREA') || (ae.tagName === 'INPUT') || ae.isContentEditable));
        } else {
            editModalBackdropGuard = false;
        }
    }, { passive: true });
    editModal.addEventListener('click', function(e) {
        if (e.target === editModal) {
            if (editModalBackdropGuard) { editModalBackdropGuard = false; return; }
            closeEditModal();
        }
    });

    // 看板名称：不再展开面包屑，仅在有权限时内联重命名（点击行为在更新头部时应用）
    // 看板页面包屑
    const breadcrumbHome = document.getElementById('breadcrumbHome');
    if (breadcrumbHome) {
        breadcrumbHome.addEventListener('click', function(e){ e.preventDefault(); showProjectPage(); });
    }
    // Board page project caret (unique ID to avoid clash with project page)
    const boardProjectCaret = document.getElementById('boardProjectCaret');
    if (boardProjectCaret) {
        boardProjectCaret.addEventListener('click', function(e){ e.preventDefault(); openProjectSwitcher(e); });
    }
    const currentProjectNameEl2 = document.getElementById('currentProjectName');
    if (currentProjectNameEl2) {
        currentProjectNameEl2.addEventListener('click', function(e){ e.preventDefault(); goToProjectBoards(); });
        currentProjectNameEl2.setAttribute('title', '返回项目');
    }
    const boardCaret = document.getElementById('boardCaret');
    if (boardCaret) {
        boardCaret.addEventListener('click', function(e){ e.preventDefault(); openBoardSwitcher(e); });
    }
    const currentBoardNameEl2 = document.getElementById('currentBoardName');
    if (currentBoardNameEl2) {
        currentBoardNameEl2.addEventListener('click', startInlineBoardRename);
    }
    // Fallback: delegated click to ensure binding after refresh/race (board name)
    document.addEventListener('click', function(e){
        try {
            const t = e.target;
            const nameEl = document.getElementById('currentBoardName');
            if (!nameEl || document.querySelector('.breadcrumb-rename-input')) return;
            if (t === nameEl || (t.closest && t.closest('#currentBoardName'))) {
                if (canRenameCurrentBoard()) { startInlineBoardRename(e); }
            }
        } catch(_){}
    }, true);
    // Fallback: delegated click for project title (project page)
    document.addEventListener('click', function(e){
        try {
            const t = e.target;
            const nameEl = document.getElementById('projectTitle');
            if (!nameEl || document.querySelector('.breadcrumb-rename-input')) return;
            if (t === nameEl || (t.closest && t.closest('#projectTitle'))) {
                if (canRenameCurrentProject()) { startInlineProjectRename(e); }
            }
        } catch(_){}
    }, true);

// Inline rename for breadcrumb board name
function startInlineBoardRename(e){
    e.preventDefault();
    e.stopPropagation();
    const span = document.getElementById('currentBoardName');
    if (!span || span._editing) return;
    const oldName = currentBoardName || (span.textContent || '').trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'breadcrumb-rename-input';
    span._editing = true;
    const parent = span.parentNode;
    // Insert input right after caret to keep layout stable
    span.style.display = 'none';
    parent.insertBefore(input, span.nextSibling);
    try { input.focus(); input.select(); } catch(_){ }

    let committed = false;
    let submittedByEnter = false;
    const cleanup = () => {
        const latest = (input.value || '').trim();
        span.textContent = committed && latest ? latest : oldName;
        try { input.remove(); } catch(_){ }
        span.style.display = '';
        span._editing = false;
    };

    input.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            try { ev.stopPropagation(); ev.stopImmediatePropagation && ev.stopImmediatePropagation(); } catch(_){ }
            const newName = (input.value || '').trim();
            if (!newName || newName === oldName) { committed = false; cleanup(); return; }
            const res = await renameBoardDirect(currentProjectId, oldName, newName);
            committed = !!(res && res.success);
            submittedByEnter = committed;
            // suppress global Enter handlers (keyup) shortly after committing
            try { enterComposerSuppressUntil = Date.now() + 500; } catch(_){ }
            cleanup();
        } else if (ev.key === 'Escape') {
            ev.preventDefault();
            committed = false; cleanup();
        }
    });
    input.addEventListener('blur', async () => {
        if (submittedByEnter) { return; } // already handled on Enter
        const newName = (input.value || '').trim();
        if (!newName || newName === oldName) { committed = false; cleanup(); return; }
        const res = await renameBoardDirect(currentProjectId, oldName, newName);
        committed = !!(res && res.success);
        cleanup();
    });
}
    // 项目页面面包屑（首页/项目）
    const projectHomeLink = document.getElementById('projectHomeLink');
    if (projectHomeLink) {
        projectHomeLink.addEventListener('click', function(e){ e.preventDefault(); showProjectPage(); });
    }
    // Ensure project page caret works
    const projectPageCaret = document.getElementById('projectCaret');
    if (projectPageCaret) {
        projectPageCaret.addEventListener('click', function(e){ e.preventDefault(); openProjectSwitcher(e); });
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
            // Do not close edit/drawer if cursor is inside an editable field
            try {
                const ae = document.activeElement;
                const isEditable = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable);
                const inEditModal = isEditable && editModal && !editModal.classList.contains('hidden') && editModal.contains(ae);
                const inDrawer = isEditable && typeof drawerEl !== 'undefined' && drawerEl && drawerEl.classList.contains('open') && drawerEl.contains(ae);
                if (inEditModal || inDrawer) { e.preventDefault(); e.stopPropagation(); return; }
            } catch (_) {}
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
            if (e.isComposing || e.keyCode === 229) return;
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

    // No header text auto-adjust; navbar style is background-independent
});

function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function applyBoardBackground(url) {
    let v = 'none';
    const hasWallpaper = !!(url && typeof url === 'string' && url.trim());
    if (hasWallpaper) {
        let raw = url.trim();
        // Add cache-buster for same-origin or local uploads to ensure immediate refresh
        const isData = /^data:/i.test(raw);
        if (!isData) {
            try {
                // If path-only or same-origin, treat as same-origin
                const a = document.createElement('a');
                a.href = raw;
                const isSameOrigin = raw.startsWith('/') || a.origin === window.location.origin;
                if (isSameOrigin) {
                    raw = raw + (raw.includes('?') ? '&' : '?') + 't=' + Date.now();
                }
            } catch(_){}
        }
        v = `url('${raw}')`;
    } else {
        v = 'none';
    }
    try { document.documentElement.style.setProperty('--board-bg-url', v); } catch(_){}
    try {
        const boardRoot = document.getElementById('boardPage');
        if (boardRoot) {
            if (hasWallpaper) boardRoot.classList.add('has-wallpaper');
            else boardRoot.classList.remove('has-wallpaper');
        }
    } catch(_){}
    // Navbar text does not adapt to background; fixed styles
}

// Auto header text detection removed per design: navbar colors are fixed

async function loadUserBackground() {
    if (!currentUser) return;
    try {
        const rs = await fetch(`/api/user-background/${currentUser}`);
        if (rs.ok) {
            const rj = await rs.json().catch(()=>({}));
            const url = (rj && typeof rj.url === 'string') ? rj.url : '';
            applyBoardBackground(url);
        }
    } catch(_) { applyBoardBackground(''); }
}

function toggleBgMenu(e){
    e && e.preventDefault();
    const btn = document.getElementById('bgBtn');
    const menu = document.getElementById('bgMenu');
    if (!btn || !menu) return;
    const isHidden = menu.classList.contains('hidden');
    if (isHidden) {
        // position near button
        const rect = btn.getBoundingClientRect();
        menu.style.top = `${window.scrollY + rect.bottom + 6}px`;
        menu.style.left = `${window.scrollX + rect.left}px`;
        menu.classList.remove('hidden');
        bindBgMenuOnce();
        updateListHeaderLineButton();
        updateBoardDragScrollButton();
        updateFaviconStyleButton();
    } else {
        hideBgMenu();
    }
}

function bindBgMenuOnce(){
    const menu = document.getElementById('bgMenu');
    if (!menu) return;
    const useDefault = document.getElementById('bgUseDefault');
    const clearBg = document.getElementById('bgClear');
    const uploadServer = document.getElementById('bgUploadServer');
    const listHeaderLineBtn = document.getElementById('listHeaderLineBtn');
    const boardDragScrollBtn = document.getElementById('boardDragScrollBtn');
    const faviconStyleBtn = document.getElementById('faviconStyleBtn');
    // Expand default options if multiple defaults available
    if (!menu._defaultsBound) {
        menu._defaultsBound = true;
        try {
            fetch('/api/default-backgrounds').then(r => r.json()).then(data => {
                const defs = (data && Array.isArray(data.defaults)) ? data.defaults : [];
                if (defs.length > 1) {
                    // Rename the base item and add more
                    if (useDefault) useDefault.textContent = '默认背景 1';
                    const list = menu.querySelector('.board-switcher-list');
                    for (let i = 1; i < Math.min(defs.length, 3); i++) {
                        const item = document.createElement('div');
                        item.className = 'board-switcher-item';
                        item.textContent = `默认背景 ${i+1}`;
                        item.dataset.index = String(i);
                        item.onclick = async () => { hideBgMenu(); try { const rs = await fetch('/api/user-background/set-default', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, index: i }) }); const rj = await rs.json().catch(()=>({})); if (rs.ok && rj && rj.url) { applyBoardBackground(rj.url); uiToast('已应用默认背景','success'); } else { uiToast((rj && rj.message) || '设置失败','error'); } } catch(_) { uiToast('设置失败','error'); } };
                        list && list.insertBefore(item, uploadServer);
                    }
                }
            }).catch(()=>{});
        } catch(_){}
    }
    if (useDefault) useDefault.onclick = async () => { hideBgMenu(); try { const rs = await fetch('/api/user-background/set-default', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, index: 0 }) }); const rj = await rs.json().catch(()=>({})); if (rs.ok && rj && rj.url) { applyBoardBackground(rj.url); uiToast('已应用默认背景','success'); } else { uiToast((rj && rj.message) || '设置失败','error'); } } catch(_) { uiToast('设置失败','error'); } };
    // no manual text color options
    if (uploadServer) uploadServer.onclick = () => { hideBgMenu(); const fileInput = document.getElementById('bgUploadFile'); fileInput && fileInput.click(); };
    if (clearBg) clearBg.onclick = async () => { hideBgMenu(); try { const rs = await fetch('/api/user-background/clear', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser }) }); if (rs.ok) { applyBoardBackground(''); uiToast('已清除背景','success'); } else { const rj = await rs.json().catch(()=>({})); uiToast((rj && rj.message) || '清除失败','error'); } } catch (err) { uiToast('清除失败','error'); } };
    if (listHeaderLineBtn) listHeaderLineBtn.onclick = () => { hideBgMenu(); toggleListHeaderLineStyle(); };
    if (boardDragScrollBtn) boardDragScrollBtn.onclick = () => { hideBgMenu(); toggleBoardDragScroll(); };
    if (faviconStyleBtn) faviconStyleBtn.onclick = () => { hideBgMenu(); toggleFaviconStyle(); };
    if (!bgMenuOutsideClickHandler) {
        bgMenuOutsideClickHandler = (ev) => {
            const m = document.getElementById('bgMenu');
            const b = document.getElementById('bgBtn');
            if (m && !m.classList.contains('hidden')) {
                if (!m.contains(ev.target) && (!b || !b.contains(ev.target))) hideBgMenu();
            }
        };
        document.addEventListener('click', bgMenuOutsideClickHandler);
    }
    if (!bgMenuKeyHandler) {
        bgMenuKeyHandler = (ev) => { if (ev.key === 'Escape') { hideBgMenu(); } };
        document.addEventListener('keydown', bgMenuKeyHandler, true);
    }
}

function hideBgMenu(){
    const menu = document.getElementById('bgMenu');
    if (menu) menu.classList.add('hidden');
}

function toggleOnlineUsersMenu(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    const btn = document.getElementById('onlineUsersToggle');
    const menu = document.getElementById('onlineUsersMenu');
    if (!btn || !menu) return;
    const wasHidden = menu.classList.contains('hidden');
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
    if (wasHidden) {
        menu.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        bindOnlineUsersMenuOnce();
    }
}

function bindOnlineUsersMenuOnce() {
    if (!onlineUsersMenuOutsideClickHandler) {
        onlineUsersMenuOutsideClickHandler = (ev) => {
            const menu = document.getElementById('onlineUsersMenu');
            const btn = document.getElementById('onlineUsersToggle');
            if (!menu || menu.classList.contains('hidden')) return;
            if (!menu.contains(ev.target) && (!btn || !btn.contains(ev.target))) {
                hideOnlineUsersMenu();
            }
        };
        document.addEventListener('click', onlineUsersMenuOutsideClickHandler);
    }
    if (!onlineUsersMenuKeyHandler) {
        onlineUsersMenuKeyHandler = (ev) => {
            if (ev.key === 'Escape') hideOnlineUsersMenu();
        };
        document.addEventListener('keydown', onlineUsersMenuKeyHandler, true);
    }
}

function hideOnlineUsersMenu() {
    const menu = document.getElementById('onlineUsersMenu');
    if (menu) menu.classList.add('hidden');
    const btn = document.getElementById('onlineUsersToggle');
    if (btn) btn.setAttribute('aria-expanded', 'false');
}

// manual text preference removed; header text mode is auto-detected

// 页面显示函数前添加清理浮层的工具函数
function cleanupTransientOverlays() {
    try { hideBoardSwitcher(); } catch (_) {}
    try { hideProjectSwitcher(); } catch (_) {}
    try { hideIOMenu(); } catch (_) {}
    try { hideBgMenu(); } catch (_) {}
    try { hideOnlineUsersMenu(); } catch (_) {}
    try {
        document.querySelectorAll('.assignee-dropdown, .board-switcher-menu, .project-switcher-menu').forEach(el => {
            if (!el) return;
            const id = el.id;
            if (id === 'ioMenu' || id === 'bgMenu') {
                el.classList.add('hidden');
                return;
            }
            el.remove();
        });
    } catch (_) {}
}

// 页面显示函数
function showLoginPage() {
    cleanupTransientOverlays();
    loginPage.classList.remove('hidden');
    projectPage.classList.add('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');

    // 重新启用登录表单输入框
    try {
        const authForm = document.getElementById('authForm');
        if (authForm) {
            const pwdInput = authForm.querySelector('#password');
            const userInput = authForm.querySelector('#username');
            if (pwdInput) { pwdInput.disabled = false; }
            if (userInput) { userInput.disabled = false; }
        }
    } catch(e) {}
}

function showProjectPage(replaceHistory) {
    previousPage = 'project';
    loginPage.classList.add('hidden');
    projectPage.classList.remove('hidden');
    boardSelectPage.classList.add('hidden');
    boardPage.classList.add('hidden');
    archivePage.classList.add('hidden');

    // 清空并禁用登录表单，防止密码管理器弹出
    try {
        const authForm = document.getElementById('authForm');
        if (authForm) {
            const pwdInput = authForm.querySelector('#password');
            const userInput = authForm.querySelector('#username');
            if (pwdInput) { pwdInput.value = ''; pwdInput.disabled = true; }
            if (userInput) { userInput.value = ''; userInput.disabled = true; }
        }
    } catch(e) {}

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'project');
    localStorage.removeItem('kanbanCurrentProjectId');
    localStorage.removeItem('kanbanCurrentProjectName');
    localStorage.removeItem('kanbanCurrentBoardName');

    // History
    updateHistory('project', !!replaceHistory);

    stopMembershipGuard();
    try { refreshCurrentUserProfile(); } catch(_) {}
    loadUserInvites();
    // First load shows lightweight placeholders; subsequent loads only when marked dirty
    const qab = document.getElementById('quickAccessBoards');
    const pl = document.getElementById('projectsList');
    if (!homeLoadedOnce) {
        // if (qab) qab.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent='加载中...'; return d; })());
        // if (pl) pl.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent='加载中...'; return d; })());
        if (qab) qab.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent=''; return d; })());
        if (pl) pl.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent=''; return d; })());
        homeLoadedOnce = true;
        loadUserProjects();
    } else if (homeDirty) {
        homeDirty = false;
        loadUserProjects();
    }
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

    // 首次/脏数据占位（避免显示上一次残留）
    try {
        const list = document.getElementById('boardList');
        if (typeof window.boardSelectLoadedOnce === 'undefined') window.boardSelectLoadedOnce = false;
        if (typeof window.boardSelectDirty === 'undefined') window.boardSelectDirty = false;
        const key = String(currentProjectId || '');
        if (!window.boardSelectLoadedOnce || window.boardSelectProjectKey !== key) {
            // 延迟揭示：先隐藏实际列表，用纯透明占位避免闪视觉占位
            if (list) {
                list.style.visibility = 'hidden';
                list.style.minHeight = '140px';
            }
            window.boardSelectLoadedOnce = true;
            window.boardSelectProjectKey = key;
            boardSelectPendingShow = true;
            loadProjectBoards();
        } else if (window.boardSelectDirty) {
            window.boardSelectDirty = false;
            if (list) list.setAttribute('aria-busy','true');
            boardSelectPendingShow = true;
            loadProjectBoards();
        }
    } catch(_) {}

    // History
    updateHistory('boardSelect', !!replaceHistory);

    // 已有触发条件时，这里不重复触发，避免竞态
    if (!window.boardSelectLoadedOnce || window.boardSelectDirty || window.boardSelectProjectKey !== String(currentProjectId || '')) {
        loadProjectBoards();
    }
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

    // 应用用户背景
    try { loadUserBackground(); } catch(_){}

    // 保存页面状态
    localStorage.setItem('kanbanPageState', 'board');
    localStorage.setItem('kanbanCurrentProjectId', currentProjectId);
    localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
    localStorage.setItem('kanbanCurrentBoardName', currentBoardName);

    // History
    updateHistory('board', !!replaceHistory);

    updateBoardHeader();
    loadShowCompletedPreference();
    loadListHeaderLinePreference();
    loadBoardDragScrollPreference();
    const desiredKey = `${currentProjectId}|${currentBoardName}`;
    if (lastLoadedBoardKey === desiredKey) {
        // 同一个看板：直接渲染并确保 WS 已加入，不再重复拉取
        connectWebSocket();
        renderBoard();
    } else {
        resetUndoRedo();
        // 切换到新看板：先占位避免显示旧内容，再拉取与加入
        // 重置 clientLists，使其从新看板的 localStorage 或默认值初始化，避免沿用上一个看板的表头
        clientLists = null;
        const cont = document.getElementById('listsContainer');
        // if (cont) cont.innerHTML = '<div class="board-loading">加载中…</div>';
        if (cont) cont.innerHTML = '<div class="board-loading"></div>';
        // 先拉取渲染；为避免与 JOIN 后的首次 WS 更新重复渲染，忽略下一条 board-update
        ignoreFirstBoardUpdate = true;
        loadBoardData();
        connectWebSocket();
    }

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

    // History: 确保后退时能回到看板页面
    // 如果不是 replaceHistory 模式，先确保 board 状态存在，再 push archive
    if (!replaceHistory && !isHandlingPopstate) {
        // 先用 replaceState 确保当前状态是 board，再 pushState archive
        const boardState = {
            page: 'board',
            projectId: currentProjectId,
            projectName: currentProjectName,
            boardName: currentBoardName
        };
        try { window.history.replaceState(boardState, ''); } catch(e){}
        const archiveState = {
            page: 'archive',
            projectId: currentProjectId,
            projectName: currentProjectName,
            boardName: currentBoardName
        };
        try { window.history.pushState(archiveState, ''); } catch(e){}
    } else {
        updateHistory('archive', !!replaceHistory);
    }

    const search = document.getElementById('archiveSearch');
    if (search) {
        search.style.display = '';
        if (!search._bound) {
            search._bound = true;
            search.addEventListener('input', ()=> renderArchive());
        }
        setTimeout(()=>{ try{ search.focus(); }catch(_){} }, 0);
    }

    const filter = document.getElementById('archiveListFilter');
    if (filter && !filter._bound) {
        filter._bound = true;
        filter.addEventListener('change', () => {
            archiveListFilter = filter.value || 'all';
            saveArchiveFilterPreference();
            renderArchive();
        });
    }
    loadArchiveFilterPreference();

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

    const emailInput = document.getElementById('email');

    if (isLogin) {
        formTitle.textContent = '注册';
        submitBtn.textContent = '注册';
        switchText.textContent = '已有账号？';
        switchMode.textContent = '登录';
        if (loginSubtitle) loginSubtitle.textContent = '创建账号即可随时开始协作。';
        if (emailField) emailField.style.display = '';
        if (emailInput) {
            emailInput.style.display = '';
            emailInput.required = true;
        }
    } else {
        formTitle.textContent = '登录';
        submitBtn.textContent = '登录';
        switchText.textContent = '还没有账号？';
        switchMode.textContent = '注册';
        if (loginSubtitle) loginSubtitle.textContent = '欢迎使用协作看板，一起提升团队效率。';
        if (emailField) emailField.style.display = 'none';
        if (emailInput) {
            emailInput.style.display = 'none';
            emailInput.required = false;
            emailInput.value = '';
        }
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
                const displayName = (result && result.displayName) ? result.displayName : canonical;
                setCurrentUserDisplayName(displayName);
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
                if (loginSubtitle) loginSubtitle.textContent = '欢迎使用协作看板，一起提升团队效率。';
                if (emailField) emailField.style.display = 'none';
                if (emailInput) {
                    emailInput.style.display = 'none';
                    emailInput.required = false;
                    emailInput.value = '';
                }
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
    // If homepage is not visible, defer and mark dirty to avoid offscreen flicker
    try { if (!projectPage || projectPage.classList.contains('hidden')) { homeDirty = true; return; } } catch (_) {}
    const token = ++userProjectsLoadToken;
    try {
        const response = await fetch(`/api/user-projects/${currentUser}`);
        const projects = await response.json();
        const prevScrollY = window.scrollY;

        // 设置显示名
        document.getElementById('currentUserName').textContent = getDisplayNameForUser(currentUser);

        if (projects.length === 0) {
            if (token !== userProjectsLoadToken) return;
            const qab = document.getElementById('quickAccessBoards');
            const pl = document.getElementById('projectsList');
            if (qab) qab.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent='还没有加入任何项目，请先创建或加入一个项目！'; return d; })());
            if (pl) pl.replaceChildren((() => { const d = document.createElement('div'); d.className='empty-state'; d.textContent='还没有项目，创建第一个项目开始协作吧！'; return d; })());
            renderStarredBoards();
            // restore scroll after empty render
            try { setTimeout(()=> window.scrollTo({ top: prevScrollY }), 0); } catch(e) {}
            return;
        }

        const quickAccessBoards = document.getElementById('quickAccessBoards');
        const projectsList = document.getElementById('projectsList');

        // 不立即清空，先离线构建，最后一次性替换，避免闪烁
        if (token !== userProjectsLoadToken) return;
        if (quickAccessBoards) quickAccessBoards.setAttribute('aria-busy', 'true');
        if (projectsList) projectsList.setAttribute('aria-busy', 'true');
        // keep homepage scroll while re-rendering
        const restoreHomeScroll = () => { try { window.scrollTo({ top: prevScrollY }); } catch(e) {} };

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

        // 获取置顶分组状态
        let pinnedProjectsArr = [];
        try {
            const presp = await fetch(`/api/user-pinned/${currentUser}`);
            const pdata = await presp.json().catch(()=>({}));
            if (presp.ok && pdata && Array.isArray(pdata.pinnedProjects)) pinnedProjectsArr = pdata.pinnedProjects;
        } catch(_) {}
        const pinnedSet = new Set(pinnedProjectsArr);
        const mapById = new Map();
        results.forEach(r => { if (r && r.project) mapById.set(r.project.id, r); });
        const pinnedResults = pinnedProjectsArr.map(id => mapById.get(id)).filter(Boolean);
        const normalResults = results.filter(r => !pinnedSet.has(r.project.id));

        const qabFrag = document.createDocumentFragment();
        const plFrag = document.createDocumentFragment();

        const renderOne = ({ project, boardsData }, isPinned) => {
            mergeUserDisplayNames(boardsData.userDisplayNames);
            // 添加快速访问看板
            const archivedSet = new Set(Array.isArray(boardsData.archivedBoards) ? boardsData.archivedBoards : []);
            (Array.isArray(boardsData.boards) ? boardsData.boards : []).filter(n => !archivedSet.has(n)).forEach(boardName => {
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
                const isStar = isBoardStarred(project.id, boardName);

                const details = document.createElement('div');
                details.className = 'board-details';
                details.innerHTML = `<h4>${escapeHtml(boardName)}</h4><span class="board-project">${escapeHtml(project.name)}</span>`;
                const ownerLabel = owner ? getDisplayNameForUser(owner) : '';
                const ownerEl = owner ? (()=>{ const d=document.createElement('div'); d.className='card-owner'; d.textContent=`创建者：${ownerLabel}`; d.title = owner; return d; })() : null;
                const actions = document.createElement('div');
                actions.className = 'board-card-actions';
                const canManage = currentUser && (currentUser === (project.owner || '') || currentUser === owner);
                actions.innerHTML = `
                        <button class="board-action-btn star-btn ${isStar ? 'active' : ''}" data-project-id="${project.id}" data-board-name="${escapeHtml(boardName)}" onclick="event.stopPropagation(); toggleBoardStarFromHome('${project.id}', '${escapeJs(boardName)}', '${escapeJs(project.name)}', this)" title="${isStar ? '取消星标' : '加星'}">★</button>
                        ${canManage ? `<button class=\"board-action-btn more-btn\" onclick=\"event.stopPropagation(); openBoardActionsMenu('home','${project.id}','${escapeJs(boardName)}', this)\" title=\"更多操作\">⋮</button>` : ''}
                        ${canManage ? `<button class=\"board-action-btn delete-btn\" onclick=\"event.stopPropagation(); deleteBoardFromHome('${escapeJs(boardName)}', '${project.id}')\" title=\"删除看板\">✕</button>` : ''}`;

                boardCard.appendChild(details);
                if (ownerEl) boardCard.appendChild(ownerEl);
                boardCard.appendChild(actions);
                qabFrag.appendChild(boardCard);
            });

            // 添加项目卡片到项目管理Tab
            if (token !== userProjectsLoadToken) return;
            const projectCard = document.createElement('div');
            projectCard.className = 'project-card project-card-with-actions';
            projectCard.onclick = () => selectProject(project.id, project.name);

            // build DOM incrementally to avoid innerHTML measuring/reflow
            const h3 = document.createElement('h3');
            h3.innerHTML = `${pinIconMarkup('project', !!isPinned)}${escapeHtml(project.name)}`;
            const info = document.createElement('div');
            info.className = 'project-info';
            info.innerHTML = `邀请码: <span class="invite-code">${project.inviteCode}</span> <button class="btn-secondary" onclick="event.stopPropagation(); copyCode('${escapeJs(project.inviteCode)}')">复制</button><br>成员: ${project.memberCount}人<br>看板: ${project.boardCount}个<br>创建于: ${new Date(project.created).toLocaleDateString()}`;
            const actions = document.createElement('div');
            actions.className = 'project-card-actions';
            {
                let actionsHtml = '';
                actionsHtml += `<button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${project.id}', 'first')" title="移到最前">⇧</button>`;
                actionsHtml += `<button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${project.id}', 'last')" title="移到最后">⇩</button>`;
                if (currentUser === (project.owner || '')) {
                    actionsHtml += `<button class=\"project-action-btn rename-btn\" onclick=\"event.stopPropagation(); renameProjectFromHome('${project.id}', '${escapeJs(project.name)}')\" title=\"重命名项目\">✎</button>`;
                    actionsHtml += `<button class=\"project-action-btn delete-btn\" onclick=\"event.stopPropagation(); deleteProjectFromHome('${project.id}', '${escapeJs(project.name)}')\" title=\"删除项目\">✕</button>`;
                }
                actions.innerHTML = actionsHtml;
            }
            const ownerEl = document.createElement('div');
            ownerEl.className = 'card-owner';
            ownerEl.textContent = `所有者：${getDisplayNameForUser(project.owner || '')}`;
            if (project.owner) ownerEl.title = project.owner;

            projectCard.appendChild(h3);
            projectCard.appendChild(info);
            projectCard.appendChild(actions);
            projectCard.appendChild(ownerEl);
            // 绑定悬停显示的 pin 图标点击置顶
            setupProjectCardPinToggle(projectCard, project.id, !!isPinned);
            plFrag.appendChild(projectCard);
        };

        // 置顶分组在前，普通组在后（带分隔标题）
        if (pinnedResults.length) plFrag.appendChild(createGroupSeparator('置顶'));
        pinnedResults.forEach(r => renderOne(r, true));
        if (pinnedResults.length && normalResults.length) plFrag.appendChild(createGroupSeparator('全部'));
        normalResults.forEach(r => renderOne(r, false));

        if (token !== userProjectsLoadToken) return;
        if (quickAccessBoards) {
            quickAccessBoards.replaceChildren(qabFrag);
            quickAccessBoards.removeAttribute('aria-busy');
            renderIconsInDom(quickAccessBoards);
            try { applyQuickBoardsFilter(); } catch(e){}
        }
        if (projectsList) {
            projectsList.replaceChildren(plFrag);
            projectsList.removeAttribute('aria-busy');
            renderIconsInDom(projectsList);
        }
        ensureStarNames(projects);
        renderStarredBoards();
        // restore homepage scroll after full render
        try {
            setTimeout(restoreHomeScroll, 0);
            setTimeout(restoreHomeScroll, 50);
            setTimeout(restoreHomeScroll, 120);
        } catch(e) {}

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
        body: JSON.stringify({ projectId: currentProjectId, newName, actor: currentUser })
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

            const projectsList = document.getElementById('projectsList');
            const quickAccessBoards = document.getElementById('quickAccessBoards');
            if (projectsList && projectsList.firstElementChild && projectsList.firstElementChild.classList.contains('empty-state')) {
                projectsList.innerHTML = '';
            }
            if (quickAccessBoards && quickAccessBoards.firstElementChild && quickAccessBoards.firstElementChild.classList.contains('empty-state')) {
                quickAccessBoards.innerHTML = '';
            }

            const newProject = {
                id: result.projectId,
                name: projectName,
                inviteCode: result.inviteCode,
                memberCount: 1,
                boardCount: 0,
                created: new Date().toISOString(),
                owner: currentUser
            };

            const projectCard = document.createElement('div');
            projectCard.className = 'project-card project-card-with-actions';
            projectCard.onclick = () => selectProject(newProject.id, newProject.name);
            const ownerLabel = getDisplayNameForUser(newProject.owner || '');
            projectCard.innerHTML = `
                <h3>${pinIconMarkup('project', false)}${escapeHtml(newProject.name)}</h3>
                <div class="project-info">
                    邀请码: <span class="invite-code">${newProject.inviteCode}</span> <button class="btn-secondary" onclick="event.stopPropagation(); copyCode('${escapeJs(newProject.inviteCode)}')">复制</button><br>
                    成员: ${newProject.memberCount}人<br>
                    看板: ${newProject.boardCount}个<br>
                    创建于: ${new Date(newProject.created).toLocaleDateString()}
                </div>
                <div class="project-card-actions">
                    <button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${newProject.id}', 'first')" title="移到最前">⇧</button>
                    <button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${newProject.id}', 'last')" title="移到最后">⇩</button>
                    <button class="project-action-btn rename-btn" onclick="event.stopPropagation(); renameProjectFromHome('${newProject.id}', '${escapeJs(newProject.name)}')" title="重命名项目">✎</button>
                    <button class="project-action-btn delete-btn" onclick="event.stopPropagation(); deleteProjectFromHome('${newProject.id}', '${escapeJs(newProject.name)}')" title="删除项目">✕</button>
                </div>
                <div class="card-owner" title="${escapeHtml(newProject.owner || '')}">所有者：${escapeHtml(ownerLabel)}</div>
            `;
            // setup hover-to-pin icon
            setupProjectCardPinToggle(projectCard, newProject.id, false);

            if (projectsList) {
                insertProjectCardAtCorrectPosition(projectsList, projectCard);
                renderIconsInDom(projectCard);
            }

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

        // 保存项目成员/所有者/看板拥有者用于权限判断（如内联重命名）
        window.currentProjectMembers = data.members;
        window.currentProjectOwner = data.owner;
        window.currentBoardOwners = data.boardOwners || {};
        mergeUserDisplayNames(data.userDisplayNames);

        // 更新分配用户选项
        updateAssigneeOptions();
        // 更新看板名称点击行为（需在 owner 信息就绪后）
        try { applyBoardNameClickBehavior(); } catch(_){ }
    } catch (error) {
        console.error('Load project members error:', error);
    }
}

// 加载项目看板列表
async function loadProjectBoards() {
    // 如果页面不可见，标记脏并跳过，避免离屏刷新残留
    try { if (!boardSelectPage || boardSelectPage.classList.contains('hidden')) { window.boardSelectDirty = true; return; } } catch(_) {}

    // Cancel any in-flight load for a different project
    const token = ++projectBoardsLoadToken;
    try { if (projectBoardsAbortController) projectBoardsAbortController.abort(); } catch(_) {}
    projectBoardsAbortController = new AbortController();
    const signal = projectBoardsAbortController.signal;

    // preserve board-select scroll positions
    let ps = null;
    try {
        const list = document.getElementById('boardList');
        if (list) { ps = { y: window.scrollY }; }
    } catch(e) {}
    try {
        const response = await fetch(`/api/project-boards/${currentProjectId}`, { signal });
        const data = await response.json();
        if (token !== projectBoardsLoadToken) return;

        document.getElementById('projectInviteCode').textContent = data.inviteCode;
        mergeUserDisplayNames(data.userDisplayNames);
        document.getElementById('projectMembers').textContent = formatUserList(data.members);
        try {
            projectBoardsCache[currentProjectId] = getActiveBoardsFromProjectData(data);
        } catch (_) {}

        // 保存项目成员列表用于分配用户选项
        window.currentProjectMembers = data.members;
        window.currentProjectOwner = data.owner;
        window.currentBoardOwners = data.boardOwners || {};
        window.currentPendingRequests = data.pendingRequests || [];
        window.currentArchivedBoards = Array.isArray(data.archivedBoards) ? data.archivedBoards : [];

        const boardList = document.getElementById('boardList');
        if (!boardList) return;
        try { applyProjectTitleClickBehavior(); } catch(_){}

        // 离线构建，最后一次性替换，避免残留和闪烁
        const frag = document.createDocumentFragment();

        if (data.boards.length === 0 && (!window.currentArchivedBoards || window.currentArchivedBoards.length === 0)) {
            const empty = document.createElement('div');
            empty.className = 'empty-state';
            empty.textContent = '还没有看板，创建第一个看板吧！';
            frag.appendChild(empty);
            boardList.replaceChildren(frag);
            // 确保显示空态（之前开启了延迟揭示）
            try {
                if (boardSelectPendingShow) {
                    boardSelectPendingShow = false;
                    boardList.style.visibility = '';
                    boardList.style.minHeight = '';
                    boardList.removeAttribute('aria-busy');
                }
            } catch(_) {}
            return;
        }

        // 获取当前项目置顶看板顺序
        let pinnedBoardsArr = [];
        try {
            const presp = await fetch(`/api/user-pinned/${currentUser}`);
            const pdata = await presp.json().catch(()=>({}));
            if (presp.ok && pdata && pdata.pinnedBoards && Array.isArray(pdata.pinnedBoards[currentProjectId])) pinnedBoardsArr = pdata.pinnedBoards[currentProjectId];
        } catch(_) {}
        const setBoards = new Set(Array.isArray(data.boards) ? data.boards : []);
        const orderedPinned = pinnedBoardsArr.filter(n => setBoards.has(n));
        const normalList = (data.boards || []).filter(n => !orderedPinned.includes(n));

        const renderBoard = (boardName, isPinned) => {
            const boardCard = document.createElement('div');
            boardCard.className = 'quick-board-card board-card-with-actions';
            boardCard.onclick = () => selectBoard(boardName);

            const owner = (window.currentBoardOwners && window.currentBoardOwners[boardName]) || '';
            const canManage = (currentUser && (currentUser === window.currentProjectOwner || currentUser === owner));
            const isStar = isBoardStarred(currentProjectId, boardName);

            const details = document.createElement('div');
            details.className = 'board-details';
            details.innerHTML = `<h4>${pinIconMarkup('board', !!isPinned)}${escapeHtml(boardName)}</h4><span class="board-project">${escapeHtml(currentProjectName)}</span>`;

            const ownerLabel = owner ? getDisplayNameForUser(owner) : '';
            const ownerEl = owner ? (()=>{ const d=document.createElement('div'); d.className='card-owner'; d.textContent=`创建者：${ownerLabel}`; d.title = owner; return d; })() : null;

            const actions = document.createElement('div');
            actions.className = 'board-card-actions';
            actions.innerHTML = `
                <button class="board-action-btn" onclick="event.stopPropagation(); reorderBoardToEdge('${currentProjectId}', '${escapeJs(boardName)}', 'first')" title="移到最前">⇧</button>
                <button class="board-action-btn" onclick="event.stopPropagation(); reorderBoardToEdge('${currentProjectId}', '${escapeJs(boardName)}', 'last')" title="移到最后">⇩</button>
                <button class="board-action-btn star-btn ${isStar ? 'active' : ''}" data-project-id="${currentProjectId}" data-board-name="${escapeHtml(boardName)}" onclick="event.stopPropagation(); toggleBoardStarFromHome('${currentProjectId}', '${escapeJs(boardName)}', '${escapeJs(currentProjectName)}', this)" title="${isStar ? '取消星标' : '加星'}">★</button>
                ${canManage ? `<button class=\"board-action-btn more-btn\" onclick=\"event.stopPropagation(); openBoardActionsMenu('project','${currentProjectId}','${escapeJs(boardName)}', this)\" title=\"更多操作\">⋮</button>` : ''}
                ${canManage ? `<button class=\"board-action-btn delete-btn\" onclick=\"event.stopPropagation(); deleteBoard('${escapeJs(boardName)}')\" title=\"删除看板\">✕</button>` : ''}
            `;

            boardCard.appendChild(details);
            if (ownerEl) boardCard.appendChild(ownerEl);
            boardCard.appendChild(actions);
            setupBoardCardPinToggle(boardCard, currentProjectId, boardName, !!isPinned);

            frag.appendChild(boardCard);
        };

        if (orderedPinned.length) frag.appendChild(createGroupSeparator('置顶'));
        orderedPinned.forEach(name => renderBoard(name, true));
        if (orderedPinned.length && normalList.length) frag.appendChild(createGroupSeparator('全部'));
        normalList.forEach(name => renderBoard(name, false));

        // Archived boards section
        if (window.currentArchivedBoards && window.currentArchivedBoards.length) {
            const archivedWrap = document.createElement('div');
            archivedWrap.className = 'archived-boards-wrap';

            const header = document.createElement('div');
            header.className = 'archived-boards-header';
            const savedQ = (typeof window.boardArchivedSearch === 'string') ? window.boardArchivedSearch : '';
            const allInitial = (window.currentArchivedBoards || []).slice();
            const initialBoards = savedQ ? allInitial.filter(name => name.toLowerCase().includes(savedQ.toLowerCase())) : allInitial;
            header.innerHTML = `<div class=\"archived-left\"><h3 id=\"archivedHeaderTitle\">归档的看板 <span class=\"count\" id=\"archivedBoardsCount\">${initialBoards.length}</span></h3><input id=\"archivedBoardsSearch\" type=\"text\" placeholder=\"搜索归档看板...\" value=\"${escapeHtml(savedQ)}\"><button id=\"toggleArchivedBtn\" class=\"btn-secondary\" aria-expanded=\"false\">展开</button></div>`;
            archivedWrap.appendChild(header);

            const listContainer = document.createElement('div');
            listContainer.className = 'archived-boards-list hidden';
            archivedWrap.appendChild(listContainer);

            function renderArchivedList() {
                const qEl = document.getElementById('archivedBoardsSearch');
                const countEl = document.getElementById('archivedBoardsCount');
                const q = (qEl && qEl.value ? qEl.value.trim().toLowerCase() : '');
                listContainer.innerHTML = '';
                const all = (window.currentArchivedBoards || []).slice();
                const boards = q ? all.filter(name => name.toLowerCase().includes(q)) : all;
                if (countEl) countEl.textContent = String(boards.length);
                if (!boards.length) {
                    const msg = document.createElement('div');
                    msg.className = 'empty-state';
                    msg.textContent = q ? '暂无匹配的归档看板' : '暂无归档看板';
                    listContainer.appendChild(msg);
                    return;
                }
                boards.forEach(boardName => {
                    const boardCard = document.createElement('div');
                    boardCard.className = 'quick-board-card board-card-with-actions';
                    const owner = (window.currentBoardOwners && window.currentBoardOwners[boardName]) || '';
                    const canManage = (currentUser && (currentUser === window.currentProjectOwner || currentUser === owner));
                    boardCard.innerHTML = `
                        <div class=\"board-icon\" style=\"display:none\"></div>
                        <div class=\"board-details\">
                            <h4>${escapeHtml(boardName)}</h4>
                            <span class=\"board-project\">${escapeHtml(currentProjectName)} · 已归档</span>
                        </div>
                        ${owner ? `<div class=\\\"card-owner\\\" title=\\\"${escapeHtml(owner)}\\\">创建者：${escapeHtml(getDisplayNameForUser(owner))}</div>` : ''}
                        <div class=\"board-card-actions\">
                            ${canManage ? `<button class=\"board-action-btn\" onclick=\"event.stopPropagation(); unarchiveBoard('${escapeJs(boardName)}')\" title=\"还原看板\">↩︎</button>
                            <button class=\"board-action-btn delete-btn\" onclick=\"event.stopPropagation(); deleteBoard('${escapeJs(boardName)}')\" title=\"删除看板\">✕</button>` : ''}
                        </div>
                    `;
                    listContainer.appendChild(boardCard);
                });
            }

            // 初始数量已在 header 模板中写入，无需额外初始化

            const toggleBtn = header.querySelector('#toggleArchivedBtn');
            toggleBtn.onclick = () => {
                const isHidden = listContainer.classList.contains('hidden');
                if (isHidden) {
                    listContainer.classList.remove('hidden');
                    toggleBtn.textContent = '收起';
                    toggleBtn.setAttribute('aria-expanded','true');
                    renderArchivedList();
                    try { window.boardArchivedExpanded = true; } catch(_){}
                } else {
                    listContainer.classList.add('hidden');
                    toggleBtn.textContent = '展开';
                    toggleBtn.setAttribute('aria-expanded','false');
                    try { window.boardArchivedExpanded = false; } catch(_){}
                }
            };
            const title = header.querySelector('#archivedHeaderTitle');
            if (title) { title.onclick = () => toggleBtn.click(); }

            frag.appendChild(archivedWrap);

            const searchInput = header.querySelector('#archivedBoardsSearch');
            if (searchInput && !searchInput._bound) {
                searchInput._bound = true;
                searchInput.addEventListener('input', () => {
                    // Always update count immediately
                    try {
                        const countEl = document.getElementById('archivedBoardsCount');
                        const q = (searchInput && searchInput.value ? searchInput.value.trim().toLowerCase() : '');
                        try { window.boardArchivedSearch = searchInput.value || ''; } catch(_){}
                        const all = (window.currentArchivedBoards || []).slice();
                        const boards = q ? all.filter(name => name.toLowerCase().includes(q)) : all;
                        if (countEl) countEl.textContent = String(boards.length);
                    } catch(_){ }
                    // Only render list content when expanded
                    if (!listContainer.classList.contains('hidden')) renderArchivedList();
                });
            }

            // Respect persisted expanded state
            try {
                if (window.boardArchivedExpanded) {
                    listContainer.classList.remove('hidden');
                    const toggle = header.querySelector('#toggleArchivedBtn');
                    if (toggle) { toggle.textContent = '收起'; toggle.setAttribute('aria-expanded','true'); }
                    renderArchivedList();
                }
            } catch(_){ }
        }

        boardList.replaceChildren(frag);
        try { renderIconsInDom(boardList); } catch(_){}
        // 延迟揭示：完成替换后再显示，避免用户看到占位跳帧
        try {
            if (boardSelectPendingShow) {
                boardSelectPendingShow = false;
                boardList.style.visibility = '';
                boardList.style.minHeight = '';
                boardList.removeAttribute('aria-busy');
            }
        } catch(_) {}
        // restore scroll
        try {
            if (ps && typeof ps.y === 'number') {
                setTimeout(() => window.scrollTo({ top: ps.y }), 0);
                setTimeout(() => window.scrollTo({ top: ps.y }), 50);
                setTimeout(() => window.scrollTo({ top: ps.y }), 120);
            }
        } catch(e) {}
    } catch (error) {
        if (error && (error.name === 'AbortError' || (error.code === 20))) {
            // 请求被取消（切换项目/重复加载），忽略提示
            return;
        }
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

    // Guard against double submit (e.g., duplicate listeners or rapid Enter)
    if (isCreatingBoard) return;
    isCreatingBoard = true;

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

            const boardList = document.getElementById('boardList');
            if (boardList && boardList.firstElementChild && boardList.firstElementChild.classList.contains('empty-state')) {
                boardList.innerHTML = '';
            }

            const owner = (result && result.owner) ? result.owner : currentUser;
            window.currentBoardOwners = window.currentBoardOwners || {};
            window.currentBoardOwners[boardName] = owner;
            const ownerLabel = owner ? getDisplayNameForUser(owner) : '';

            if (Array.isArray(projectBoardsCache[currentProjectId])) {
                projectBoardsCache[currentProjectId].unshift(boardName);
            } else {
                projectBoardsCache[currentProjectId] = [boardName];
            }

            const canManage = (currentUser && (currentUser === window.currentProjectOwner || currentUser === owner));
            const isStar = isBoardStarred(currentProjectId, boardName);
            const boardCard = document.createElement('div');
            boardCard.className = 'quick-board-card board-card-with-actions';
            boardCard.onclick = () => selectBoard(boardName);
            boardCard.innerHTML = `
                <div class="board-details">
                    <h4>${pinIconMarkup('board', false)}${escapeHtml(boardName)}</h4>
                    <span class="board-project">${escapeHtml(currentProjectName)}</span>
                </div>
                ${owner ? `<div class=\"card-owner\" title=\"${escapeHtml(owner)}\">创建者：${escapeHtml(ownerLabel)}</div>` : ''}
                <div class="board-card-actions">
                    <button class="board-action-btn" onclick="event.stopPropagation(); reorderBoardToEdge('${currentProjectId}', '${escapeJs(boardName)}', 'first')" title="移到最前">⇧</button>
                    <button class="board-action-btn" onclick="event.stopPropagation(); reorderBoardToEdge('${currentProjectId}', '${escapeJs(boardName)}', 'last')" title="移到最后">⇩</button>
                    <button class="board-action-btn star-btn ${isStar ? 'active' : ''}" data-project-id="${currentProjectId}" data-board-name="${escapeHtml(boardName)}" onclick="event.stopPropagation(); toggleBoardStarFromHome('${currentProjectId}', '${escapeJs(boardName)}', '${escapeJs(currentProjectName)}', this)" title="${isStar ? '取消星标' : '加星'}">★</button>
                    ${canManage ? `<button class="board-action-btn more-btn" onclick="event.stopPropagation(); openBoardActionsMenu('project','${currentProjectId}','${escapeJs(boardName)}', this)" title="更多操作">⋮</button>` : ''}
                    ${canManage ? `<button class="board-action-btn delete-btn" onclick="event.stopPropagation(); deleteBoard('${escapeJs(boardName)}')" title="删除看板">✕</button>` : ''}
                </div>
            `;
            // setup hover-to-pin icon on board title
            setupBoardCardPinToggle(boardCard, currentProjectId, boardName, false);

            if (boardList) {
                insertBoardCardAtCorrectPosition(boardList, boardCard);
                try { renderIconsInDom(boardCard); } catch(_){}
            }

            uiToast('看板创建成功！','success');
            isCreatingBoard = false;
        } else {
            uiToast(result.message || '创建看板失败','error');
            isCreatingBoard = false;
        }
    } catch (error) {
        console.error('Create board error:', error);
        uiToast('创建看板失败','error');
        isCreatingBoard = false;
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
            removeStarIfExists(currentProjectId, boardName);
            renderStarredBoards();
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
            removeStarIfExists(projectId, boardName);
            renderStarredBoards();
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
    try {
        if (!document.querySelector('.breadcrumb-rename-input')) {
            applyBoardNameClickBehavior();
        }
    } catch(_){}
}

function canRenameCurrentBoard(){
    try {
        const owner = (window.currentBoardOwners && window.currentBoardOwners[currentBoardName]) || '';
        const projOwner = window.currentProjectOwner || '';
        return !!(currentUser && (currentUser === projOwner || currentUser === owner));
    } catch(_) { return false; }
}

function applyBoardNameClickBehavior(){
    const el = document.getElementById('currentBoardName');
    if (!el) return;
    if (document.querySelector('.breadcrumb-rename-input') || el._editing) return;
    // Remove any previous click listeners by cloning
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    if (canRenameCurrentBoard()) {
        clone.setAttribute('title', '重命名看板');
        clone.style.cursor = 'text';
        clone.addEventListener('click', startInlineBoardRename);
    } else {
        clone.removeAttribute('title');
        clone.style.cursor = 'default';
    }
}

function canRenameCurrentProject(){
    try { return !!(currentUser && window.currentProjectOwner && currentUser === window.currentProjectOwner); } catch(_) { return false; }
}

function applyProjectTitleClickBehavior(){
    const el = document.getElementById('projectTitle');
    if (!el) return;
    if (el._editing) return;
    const clone = el.cloneNode(true);
    el.parentNode.replaceChild(clone, el);
    if (canRenameCurrentProject()) {
        clone.setAttribute('title', '重命名项目');
        clone.style.cursor = 'text';
        clone.addEventListener('click', startInlineProjectRename);
    } else {
        clone.removeAttribute('title');
        clone.style.cursor = 'default';
    }
}

function startInlineProjectRename(e){
    e.preventDefault();
    e.stopPropagation();
    const span = document.getElementById('projectTitle');
    if (!span || span._editing) return;
    const oldName = currentProjectName || (span.textContent || '').trim();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = oldName;
    input.className = 'breadcrumb-rename-input';
    span._editing = true;
    span.style.display = 'none';
    span.parentNode.insertBefore(input, span.nextSibling);
    try { input.focus(); input.select(); } catch(_){ }

    let committed = false;
    const cleanup = () => {
        const latest = (input.value || '').trim();
        span.textContent = committed && latest ? latest : oldName;
        try { input.remove(); } catch(_){ }
        span.style.display = '';
        span._editing = false;
        applyProjectTitleClickBehavior();
    };
    input.addEventListener('keydown', async (ev) => {
        if (ev.key === 'Enter') {
            ev.preventDefault();
            const newName = (input.value || '').trim();
            if (!newName || newName === oldName) { committed = false; cleanup(); return; }
            const res = await renameProjectDirect(currentProjectId, newName);
            committed = !!(res && res.success);
            cleanup();
        } else if (ev.key === 'Escape') {
            ev.preventDefault(); committed = false; cleanup();
        }
    });
    input.addEventListener('blur', async () => {
        const newName = (input.value || '').trim();
        if (!newName || newName === oldName) { committed = false; cleanup(); return; }
        const res = await renameProjectDirect(currentProjectId, newName);
        committed = !!(res && res.success);
        cleanup();
    });
}

async function renameProjectDirect(projectId, newName){
    const trimmed = (newName||'').trim();
    if (!trimmed || !projectId) return { success:false };
    try {
        const rs = await fetch('/api/rename-project', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, newName: trimmed, actor: currentUser })
        });
        const rj = await rs.json().catch(()=>({}));
        if (rs.ok) {
            currentProjectName = trimmed;
            localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
            const pt = document.getElementById('projectTitle');
            if (pt) pt.textContent = currentProjectName;
            updateBoardHeader();
            try { loadUserProjects(); } catch(_){ }
            try { renderStarredBoards(); } catch(_){ }
            uiToast('项目重命名成功','success');
            return { success:true };
        } else {
            uiToast(rj.message || '项目重命名失败','error');
            return { success:false };
        }
    } catch(e) {
        uiToast('项目重命名失败','error');
        return { success:false };
    }
}

// WebSocket 连接
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    socket = new WebSocket(wsUrl);

    socket.onopen = function() {
        console.log('WebSocket connected');
        const key = `${currentProjectId}|${currentBoardName}`;
        if (lastJoinedBoardKey !== key) {
            socket.send(JSON.stringify({
                type: 'join',
                user: currentUser,
                projectId: currentProjectId,
                boardName: currentBoardName
            }));
            lastJoinedBoardKey = key;
        }
        trySyncListsToServer();
        flushPendingCardAdds();
    };

    socket.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            handleWebSocketMessage(data);
        } catch (e) {
            console.error('WebSocket message parse error:', e);
        }
    };

    socket.onclose = function() {
        console.log('WebSocket disconnected');
        if (suppressAutoReconnect) { return; }
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
                // Suppress the first WS update right after an initial fetch-render to avoid double render
                if (ignoreFirstBoardUpdate) { ignoreFirstBoardUpdate = false; lastLoadedBoardKey = `${currentProjectId}|${currentBoardName}`; break; }
                const prevBoardData = boardData;
                boardData = data.board;
                if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
                    if (hasPendingListsSync()) {
                        const localLists = loadClientListsFromStorage();
                        if (localLists && listsMatch(localLists, boardData.lists)) {
                            clearPendingListsSync();
                            pendingListsSyncKey = null;
                            clientLists = boardData.lists;
                            // ensure arrays exist for every list status
                            clientLists.listIds.forEach(id => {
                                const st = clientLists.lists[id] && clientLists.lists[id].status;
                                if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                            });
                            saveClientListsToStorage();
                        } else if (localLists) {
                            clientLists = localLists;
                            boardData.lists = localLists;
                            const allowed = new Set();
                            clientLists.listIds.forEach(id => {
                                const st = clientLists.lists[id] && clientLists.lists[id].status;
                                if (st) allowed.add(st);
                            });
                            Object.keys(boardData || {}).forEach(k => {
                                if (k !== 'archived' && Array.isArray(boardData[k]) && !allowed.has(k)) {
                                    delete boardData[k];
                                }
                            });
                            clientLists.listIds.forEach(id => {
                                const st = clientLists.lists[id] && clientLists.lists[id].status;
                                if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                            });
                            queueListsSync();
                        } else {
                            clientLists = boardData.lists;
                            saveClientListsToStorage();
                        }
                    } else {
                        clientLists = boardData.lists;
                        // ensure arrays exist for every list status
                        clientLists.listIds.forEach(id => {
                            const st = clientLists.lists[id] && clientLists.lists[id].status;
                            if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                        });
                        saveClientListsToStorage();
                    }
                }
                prunePendingCardAdds();
                applyPendingCardAddsToBoardData();
                flushPendingCardAdds();
                const skipRender = shouldSkipBoardRenderForLocalUpdate(data.actor, prevBoardData, boardData);
                if (!skipRender) pendingBoardUpdate = true;
                initialBoardRendered = true;
                if (initialBoardTimeout) { try{ clearTimeout(initialBoardTimeout); }catch(_){} initialBoardTimeout = null; }
                if (!skipRender) scheduleDeferredRender();
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
                try {
                    const oldKey = getShowCompletedStorageKey(currentProjectId, data.oldName);
                    const newKey = getShowCompletedStorageKey(currentProjectId, data.newName);
                    const stored = localStorage.getItem(oldKey);
                    if (stored !== null) {
                        localStorage.setItem(newKey, stored);
                        localStorage.removeItem(oldKey);
                    }
                } catch (_) {}
                try {
                    const oldKey = getListHeaderLineStorageKey(currentProjectId, data.oldName);
                    const newKey = getListHeaderLineStorageKey(currentProjectId, data.newName);
                    const stored = localStorage.getItem(oldKey);
                    if (stored !== null) {
                        localStorage.setItem(newKey, stored);
                        localStorage.removeItem(oldKey);
                    }
                } catch (_) {}
                try {
                    const oldKey = getArchiveFilterStorageKey(currentProjectId, data.oldName);
                    const newKey = getArchiveFilterStorageKey(currentProjectId, data.newName);
                    const stored = localStorage.getItem(oldKey);
                    if (stored !== null) {
                        localStorage.setItem(newKey, stored);
                        localStorage.removeItem(oldKey);
                    }
                } catch (_) {}
                try {
                    const oldKey = getBoardDragScrollStorageKey(currentProjectId, data.oldName);
                    const newKey = getBoardDragScrollStorageKey(currentProjectId, data.newName);
                    const stored = localStorage.getItem(oldKey);
                    if (stored !== null) {
                        localStorage.setItem(newKey, stored);
                        localStorage.removeItem(oldKey);
                    }
                } catch (_) {}
                currentBoardName = data.newName;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                updateBoardHeader();
                loadShowCompletedPreference();
                loadListHeaderLinePreference();
                loadBoardDragScrollPreference();
                // Keep history state consistent without reloading UI
                try { updateHistory('board', true); } catch (e) {}
                // Re-join the renamed board on the existing socket (no reconnect to avoid flicker)
                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({
                            type: 'join',
                            user: currentUser,
                            projectId: currentProjectId,
                            boardName: currentBoardName
                        }));
                    }
                } catch (e) {}
            }
            updateStarsOnBoardRenamed(data.projectId, data.oldName, data.newName);
            break;
        case 'board-moved':
            if (data.boardName === currentBoardName && data.fromProjectId === currentProjectId) {
                // Switch to the new project context and rejoin
                currentProjectId = data.toProjectId;
                currentProjectName = data.toProjectName || currentProjectName;
                localStorage.setItem('kanbanCurrentProjectId', currentProjectId);
                if (currentProjectName) localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
                updateBoardHeader();
                try { updateHistory('board', true); } catch (e) {}
                try {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        socket.send(JSON.stringify({ type:'join', user: currentUser, projectId: currentProjectId, boardName: currentBoardName }));
                    }
                } catch (e) {}
                // Refresh project members and lists lazily
                try { if (!boardSelectPage.classList.contains('hidden')) loadProjectBoards(); } catch(e){}
            }
            // Update local stars cache for moved board
            try { updateStarsOnBoardMoved(data.fromProjectId, data.toProjectId, data.boardName, data.toProjectName || ''); } catch(e) {}
            try { renderStarredBoards(); } catch(e) {}
            break;
        case 'project-renamed':
            if (data.projectId === currentProjectId) {
                currentProjectName = data.newName;
                localStorage.setItem('kanbanCurrentProjectName', currentProjectName);
                const projectTitle = document.getElementById('projectTitle');
                if (projectTitle) projectTitle.textContent = currentProjectName;
                updateBoardHeader();
                // Avoid full reload to prevent flicker; update board list labels inline if on board-select page
                if (!boardSelectPage.classList.contains('hidden')) {
                    try {
                        document.querySelectorAll('#boardList .board-project').forEach(el => { el.textContent = currentProjectName; });
                    } catch (e) {}
                }
            }
            updateStarsOnProjectRenamed(data.projectId, data.newName);
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
            purgeStarsForProject(data.projectId);
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
                const label = getDisplayNameForUser(data.username);
                uiToast(`${label} 申请加入「${pname}」`,'info');
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
        const now = Date.now();
        const key = `${currentProjectId}|${currentBoardName}`;
        // Prevent redundant fetches when the same board is opened repeatedly within 500ms
        if (lastFetchBoardKey === key && now - lastFetchTime < 500) return;
        lastFetchBoardKey = key;
        lastFetchTime = now;

        const response = await fetch(`/api/board/${currentProjectId}/${encodeURIComponent(currentBoardName)}`);
        if (response.ok) {
            boardData = await response.json();
            // Hydrate clientLists from server so list headers refresh immediately on board switch
            if (boardData && boardData.lists && Array.isArray(boardData.lists.listIds) && boardData.lists.lists) {
                if (hasPendingListsSync()) {
                    const localLists = loadClientListsFromStorage();
                    if (localLists && listsMatch(localLists, boardData.lists)) {
                        clearPendingListsSync();
                        pendingListsSyncKey = null;
                        clientLists = boardData.lists;
                        clientLists.listIds.forEach(id => {
                            const st = clientLists.lists[id] && clientLists.lists[id].status;
                            if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                        });
                        saveClientListsToStorage();
                    } else if (localLists) {
                        clientLists = localLists;
                        boardData.lists = localLists;
                        const allowed = new Set();
                        clientLists.listIds.forEach(id => {
                            const st = clientLists.lists[id] && clientLists.lists[id].status;
                            if (st) allowed.add(st);
                        });
                        Object.keys(boardData || {}).forEach(k => {
                            if (k !== 'archived' && Array.isArray(boardData[k]) && !allowed.has(k)) {
                                delete boardData[k];
                            }
                        });
                        clientLists.listIds.forEach(id => {
                            const st = clientLists.lists[id] && clientLists.lists[id].status;
                            if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                        });
                        queueListsSync();
                    } else {
                        clientLists = boardData.lists;
                        clientLists.listIds.forEach(id => {
                            const st = clientLists.lists[id] && clientLists.lists[id].status;
                            if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                        });
                        saveClientListsToStorage();
                    }
                } else {
                    clientLists = boardData.lists;
                    clientLists.listIds.forEach(id => {
                        const st = clientLists.lists[id] && clientLists.lists[id].status;
                        if (st && !Array.isArray(boardData[st])) boardData[st] = [];
                    });
                    saveClientListsToStorage();
                }
            } else {
                // Fallback to per-board storage/defaults when server has no lists meta
                clientLists = null;
            }
            lastLoadedBoardKey = key;
            prunePendingCardAdds();
            applyPendingCardAddsToBoardData();
            flushPendingCardAdds();
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
    let prevScrollLeft = 0;
    try {
        prevScrollLeft = container.scrollLeft;
        container.querySelectorAll('.column').forEach(col => {
            const st = col.getAttribute('data-status');
            if (st) prevScrollTop[st] = col.scrollTop;
        });
    } catch(e) {}

    container.innerHTML = '';

    const listCount = clientLists.listIds.length;

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
                <h3 class="list-title" tabindex="0" draggable="false">${escapeHtml(list.title)}</h3>
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
            const activeCards = cards.filter(c => c && !c.deferred);
            const deferredCards = cards.filter(c => c && c.deferred);
            activeCards.forEach(c => cardsEl.appendChild(createCardElement(c, list.status)));
            if (deferredCards.length) {
                const divider = document.createElement('div');
                divider.className = 'card-group-divider';
                divider.textContent = '稍后';
                cardsEl.appendChild(divider);
                deferredCards.forEach(c => cardsEl.appendChild(createCardElement(c, list.status)));
            }
            updateContainerEmptyState(cardsEl);

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

    // no-op: centering handled in adjustBoardCentering()

    // restore scroll positions per column and container
    try {
        container.scrollLeft = prevScrollLeft || 0;
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
        // track hover target for Enter-to-open
        section.addEventListener('mouseenter', ()=>{ lastHoveredListSection = section; });
    });

    // add-list entry (UI only, maps to new status placeholders if needed)
    renderAddListEntry(container);
    // Toggle a style hook for empty-board visuals (centering handled in JS)
    try {
        const listCount = (clientLists && Array.isArray(clientLists.listIds)) ? clientLists.listIds.length : 0;
        if (listCount === 0) container.classList.add('empty-board');
        else container.classList.remove('empty-board');
    } catch(_){}

    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }

    // enable lists drag after render
    enableListsDrag();

    adjustBoardCentering();

    // Restore pending window/list scroll if queued (after render settles)
    try {
        if (pendingWindowScroll) {
            const target = { x: pendingWindowScroll.x || 0, y: pendingWindowScroll.y || 0 };
            const apply = () => {
                const cont = document.getElementById('listsContainer');
                if (cont) cont.scrollLeft = target.x;
                window.scrollTo({ top: target.y });
            };
            setTimeout(apply, 0);
            setTimeout(apply, 50);
            setTimeout(apply, 120);
            pendingWindowScroll = null;
        }
    } catch (e) {}
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

    // Keep default button content; empty-board appearance handled via CSS only

    openBtn.onclick = ()=>{ openBtn.hidden = true; form.hidden = false; input.focus(); };
    cancel.onclick = ()=>{ form.hidden = true; openBtn.hidden = false; input.value=''; keepAddingLists = false; try{ openBtn.focus(); }catch(_){} };
    // Allow Esc to cancel from input (even during IME composition)
    input.addEventListener('keydown', (e)=>{
        if (e.key === 'Escape') {
            if (closeAddListEntry(e)) return;
        }
        const composing = e.isComposing || e.keyCode === 229;
        if (composing) return;
    }, true);
    // Capture Esc on form as well to avoid needing a second press after blur
    form.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (closeAddListEntry(e)) return;
    }, true);
    // Close when focus leaves the form (e.g., click elsewhere)
    form.addEventListener('focusout', () => {
        setTimeout(() => {
            const add = document.getElementById('addListEntry');
            if (!add) return;
            const active = document.activeElement;
            if (!active || !add.contains(active)) {
                closeAddListEntry();
            }
        }, 0);
    }, true);
    // If user was in consecutive add mode, reopen immediately
    if (keepAddingLists) { openBtn.hidden = true; form.hidden = false; try { input.focus(); input.select(); } catch(_){} }
    form.addEventListener('submit', (e)=>{
        e.preventDefault();
        const name = (input.value||'').trim();
        if(!name) return;
        // keep adding next list; also suppress global Enter keyup side-effects
        keepAddingLists = true;
        try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){ }
        addClientList(name);
        // note: renderBoard() will rerender add entry and reopen due to keepAddingLists
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
    queueListsSync();
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
        if(e.key==='Enter'){ e.preventDefault(); try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; input.blur(); }
        if(e.key==='Escape'){ canceled=true; input.blur(); }
    });
    input.addEventListener('blur', ()=>{
        const val = (input.value||'').trim();
        const next = canceled? old : (val || old);
        list.title = next;
        const h = document.createElement('h3'); h.className='list-title'; h.tabIndex=0; h.draggable=false; h.textContent=next;
        input.replaceWith(h);
        bindListTitleInlineRename(h.closest('.list'), list);
        saveClientListsToStorage();
        // sync to server
        queueListsSync();
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
function removeClientList(listId, options){
    const opts = options || {};
    ensureClientLists();
    // 获取列表的 status，以便清理 boardData
    const list = clientLists.lists[listId];
    const status = list ? list.status : null;

    if (!opts.skipUndo && !undoRedoInProgress && list && status) {
        const listIndex = clientLists.listIds.indexOf(listId);
        const listSnapshot = cloneDeep(list);
        const cardsSnapshot = Array.isArray(boardData[status]) ? boardData[status].map(cloneDeep) : [];
        pushUndoAction({
            type: 'delete-list',
            label: '删除卡组',
            createdAt: Date.now(),
            undo: () => {
                ensureClientLists();
                const existingId = findListIdByStatus(listSnapshot.status);
                if (!existingId) {
                    const id = listSnapshot.id || listSnapshot.status;
                    const pos = Math.max(0, Math.min(listIndex, clientLists.listIds.length));
                    clientLists.listIds.splice(pos, 0, id);
                    clientLists.lists[id] = { id, title: listSnapshot.title, pos, status: listSnapshot.status };
                    reindexClientLists();
                    saveClientListsToStorage();
                    queueListsSync();
                }
                if (!Array.isArray(boardData[listSnapshot.status])) boardData[listSnapshot.status] = [];
                const incoming = cardsSnapshot.map(cloneDeep);
                const incomingIds = new Set(incoming.map(c => c && c.id));
                const existing = boardData[listSnapshot.status].filter(c => !(c && incomingIds.has(c.id)));
                boardData[listSnapshot.status] = incoming.concat(existing);
                incoming.forEach(card => {
                    if (!card || !card.id) return;
                    queuePendingCardAdd(listSnapshot.status, card, 'bottom');
                    sendCardAdd(listSnapshot.status, card, 'bottom');
                });
                renderBoard();
            },
            redo: () => removeClientList(listSnapshot.id, { skipUndo: true })
        });
    }

    clientLists.listIds = clientLists.listIds.filter(id=>id!==listId);
    delete clientLists.lists[listId];

    // 清理 boardData 中的残留数据
    if (status && boardData && Array.isArray(boardData[status])) {
        delete boardData[status];
    }
    dropPendingCardAddsForStatus(status);

    saveClientListsToStorage();
    // sync to server
    queueListsSync();
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

    // Open composer with Enter when closed, when focus is within this list
    section.addEventListener('keydown', (e) => {
        const t = e.target;
        const isIme = e.isComposing || e.keyCode === 229;
        if (isIme && t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (e.key !== 'Enter' || e.shiftKey) return;
        if (!form.hidden) return;
        // ignore when typing in inputs or interactive elements
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('button, select, .composer, .add-list-form, .list-actions'))) return;
        // ignore if event happens inside a card
        if (t && t.closest('.card')) return;
        e.preventDefault();
        open();
    }, true);

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
            commentsCount: 0,
            starred: false,
            deferred: false
        };
        if (!Array.isArray(boardData[status])) boardData[status]=[];
        boardData[status] = [...boardData[status], card];
        queuePendingCardAdd(status, card, 'bottom');
        sendCardAdd(status, card, 'bottom');
        // keep composer open for quick multi-add
        // append new card DOM directly
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
            // avoid full re-render while composer is open
        }
        // clear and focus for next entry
        textarea.value = '';
        try { textarea.focus(); } catch(e) {}
        try { autoResizeTextarea(textarea); } catch(e) {}
        setTimeout(()=>{ isSubmitting = false; }, 120);
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
    if (!cardEl) return;
    if (cardEl.querySelector('.card-title-input')) return;
    const view = cardEl.querySelector('.card-title');
    if (!view) return;
    const cardId = cardEl.dataset.cardId;
    const card = cardId ? getCardById(cardId) : null;
    const old = (card && typeof card.title === 'string') ? card.title : (view.textContent || '');
    const input = document.createElement('textarea');
    input.className = 'card-title-input';
    input.value = old;
    input.rows = 1;
    if (view) view.replaceWith(input);
    try { autoResizeTextarea(input); } catch(e) {}
    input.focus();
    try { input.setSelectionRange(old.length, old.length); } catch(e) {}
    setCardInlineEditingState(cardId, true);
    let settled = false;
    const commit = () => {
        if (settled) return;
        settled = true;
        const val = input.value.trim();
        const isEmpty = !val;
        const display = isEmpty ? '未命名' : val;
        const t = document.createElement('div'); t.className = `card-title${isEmpty ? ' is-empty' : ''}`; t.textContent = display; t.tabIndex = 0;
        input.replaceWith(t);
        if (val !== old) { saveCardTitle(cardId, val); }
        setCardInlineEditingState(cardId, false);
    };
    const cancel = () => {
        if (settled) return;
        settled = true;
        const isEmpty = !String(old || '').trim();
        const display = isEmpty ? '未命名' : old;
        const t = document.createElement('div'); t.className = `card-title${isEmpty ? ' is-empty' : ''}`; t.textContent = display; t.tabIndex = 0;
        input.replaceWith(t);
        setCardInlineEditingState(cardId, false);
    };
    input.addEventListener('keydown',(e)=>{
        if (e.key === 'Enter') {
            e.preventDefault();
            try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; 
            commit();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });
    input.addEventListener('blur', ()=>{
        commit();
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

    const filterEl = document.getElementById('archiveListFilter');
    const listMetas = (clientLists && clientLists.listIds)
        ? clientLists.listIds
            .map(id => clientLists.lists[id])
            .filter(Boolean)
            .sort((a, b) => (a.pos || 0) - (b.pos || 0))
        : [];
    const knownStatuses = new Set(listMetas.map(m => m.status));
    const hasUnknown = cards.some(card => {
        const st = getArchivedFilterStatus(card);
        return !st || (knownStatuses.size > 0 && !knownStatuses.has(st));
    });

    if (filterEl) {
        const currentValue = archiveListFilter || filterEl.value || 'all';
        const options = [{ value: 'all', label: '全部卡组' }];
        listMetas.forEach(meta => {
            if (meta && meta.status) options.push({ value: meta.status, label: meta.title || meta.status });
        });
        if (hasUnknown) options.push({ value: 'unknown', label: '已删除卡组' });

        filterEl.innerHTML = '';
        options.forEach(opt => {
            const option = document.createElement('option');
            option.value = opt.value;
            option.textContent = opt.label;
            filterEl.appendChild(option);
        });
        if (options.some(opt => opt.value === currentValue)) {
            filterEl.value = currentValue;
        } else {
            filterEl.value = 'all';
            archiveListFilter = 'all';
            saveArchiveFilterPreference();
        }
    }

    const search = document.getElementById('archiveSearch');
    const q = (search && search.value ? search.value.trim().toLowerCase() : '');
    const activeFilter = (filterEl && filterEl.value) ? filterEl.value : (archiveListFilter || 'all');

    const filtered = q
        ? cards.filter(c => {
            const st = getArchivedFilterStatus(c);
            const isUnknown = !st || (knownStatuses.size > 0 && !knownStatuses.has(st));
            if (activeFilter === 'unknown') { if (!isUnknown) return false; }
            else if (activeFilter !== 'all' && st !== activeFilter) return false;
            return ((c.title||'').toLowerCase().includes(q)) ||
                ((c.description||'').toLowerCase().includes(q)) ||
                ((Array.isArray(c.labels)?c.labels.join(','):'').toLowerCase().includes(q)) ||
                ((c.assignee||'').toLowerCase().includes(q));
          })
        : cards.filter(c => {
            const st = getArchivedFilterStatus(c);
            const isUnknown = !st || (knownStatuses.size > 0 && !knownStatuses.has(st));
            if (activeFilter === 'unknown') return isUnknown;
            if (activeFilter !== 'all') return st === activeFilter;
            return true;
          });

    archivedCount.textContent = filtered.length;

    const sortedCards = filtered.slice();

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
    const isArchivedInList = !!card.__archivedInList;
    const isArchivedView = status === 'archived' || isArchivedInList;
    if (isArchivedInList) {
        cardElement.classList.add('card-archived');
        cardElement.dataset.archived = 'true';
    }
    if (inlineEditingCardIds.has(card.id)) {
        cardElement.classList.add('inline-editing');
    }

    const labels = Array.isArray(card.labels) ? card.labels.slice(0, 5) : [];
    const labelDots = labels.map(color => `<span class="label label-${color}"></span>`).join('');

    const dueClass = card.deadline ? (new Date(card.deadline) < new Date() ? 'overdue' : (daysUntil(card.deadline) <= 1 ? 'soon' : '')) : '';
    const descIcon = card.description ? `<span class="badge-icon desc" title="有描述">≡</span>` : '';
    const commentsBadge = card.commentsCount > 0 ? `<span class="badge comments" title="${card.commentsCount} 条评论">💬 ${card.commentsCount}</span>` : '';
    const isStarred = !!card.starred;
    const isDeferred = !!card.deferred;

    const titleRaw = (typeof card.title === 'string') ? card.title : '';
    const titleEmpty = !titleRaw.trim();
    const titleText = titleEmpty ? '未命名' : escapeHtml(titleRaw);
    const titleClass = titleEmpty ? 'card-title is-empty' : 'card-title';

    const assigneeHtml = card.assignee
        ? `<span class="card-assignee clickable" onclick="event.stopPropagation(); editCardAssignee('${card.id}')" title="点击修改分配用户">@${escapeHtml(getDisplayNameForUser(card.assignee))}</span>`
        : '';
    const deadlineHtml = card.deadline
        ? `<span class="card-deadline clickable" onclick="event.stopPropagation(); editCardDeadline('${card.id}')" title="点击修改截止日期">${card.deadline}</span>`
        : '';

    if (isStarred) {
        cardElement.classList.add('card-starred');
    }
    if (isDeferred) {
        cardElement.classList.add('card-deferred');
    }

    const isInlineEditing = inlineEditingCardIds.has(card.id);
    const showQuickActions = !isArchivedView && !isInlineEditing;
    const moreBtn = isInlineEditing ? '' : `<button class="card-quick" onclick="event.stopPropagation(); openEditModal('${card.id}')" aria-label="编辑"></button>`;
    const copyBtn = isInlineEditing ? '' : `<button class="card-quick-copy" onclick="event.stopPropagation(); copyCardText('${card.id}')" aria-label="复制" title="复制卡片内容"></button>`;
    const starBtn = showQuickActions ? `<button class="card-quick-star${isStarred ? ' active' : ''}" onclick="event.stopPropagation(); toggleCardStar('${card.id}', this)" aria-pressed="${isStarred ? 'true' : 'false'}" aria-label="${isStarred ? '取消星标' : '星标'}" title="${isStarred ? '取消星标' : '星标'}">★</button>` : '';
    const deferBtn = showQuickActions ? `<button class="card-quick-defer${isDeferred ? ' active' : ''}" onclick="event.stopPropagation(); toggleCardDeferred('${card.id}', this)" aria-pressed="${isDeferred ? 'true' : 'false'}" aria-label="${isDeferred ? '取消稍后' : '稍后'}" title="${isDeferred ? '取消稍后' : '稍后'}">${isDeferred ? '↥' : '↧'}</button>` : '';
    const archiveBtnHtml = (!isArchivedView && !isInlineEditing)
        ? `<button class="card-quick-archive" onclick="event.stopPropagation(); archiveCard('${card.id}', '${escapeJs(status)}')" aria-label="归档" title="完成归档"></button>`
        : '';
    const deleteBtnHtml = (!isArchivedView && !isInlineEditing)
        ? `<button class="card-quick-trash" onclick="event.stopPropagation(); deleteCardById('${card.id}')" aria-label="删除" title="删除卡片"></button>`
        : '';

    const archiveBtn = (!isArchivedView)
        ? ``
        : '';

    const deleteBtn = (status === 'archived')
        ? `<button class="card-quick-delete" onclick="event.stopPropagation(); deleteArchivedCard('${card.id}')" aria-label="删除"></button>`
        : '';

    const headerRow = (isArchivedView)
        ? `<div class="card-header"><button class="restore-chip" onclick="event.stopPropagation(); restoreCard('${card.id}')">还原</button><div class="${titleClass}">${titleText}</div></div>`
        : `<div class="${titleClass}">${titleText}</div>`;

    const badges = `${descIcon}${commentsBadge}${deadlineHtml}${assigneeHtml}`;

    cardElement.innerHTML = `
        <div class="card-labels">${labelDots}</div>
        ${headerRow}
        ${badges ? `<div class="card-badges">${badges}</div>` : ''}
        ${archiveBtn}
        ${deleteBtn}
        ${deleteBtnHtml}
        ${archiveBtnHtml}
        ${deferBtn}
        ${starBtn}
        ${moreBtn}
        ${copyBtn}
    `;

    if (!isArchivedView) {
        const prevStatus = getAdjacentStatusKey(status, 'prev');
        const nextStatus = getAdjacentStatusKey(status, 'next');
        if (prevStatus) {
            const leftBtn = document.createElement('button');
            leftBtn.type = 'button';
            leftBtn.className = 'card-move-button card-move-left';
            leftBtn.setAttribute('aria-label', '移动到左侧卡组');
            leftBtn.textContent = '‹';
            leftBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                moveCardToAdjacent(card.id, status, 'prev');
            });
            cardElement.appendChild(leftBtn);
        }
        if (nextStatus) {
            const rightBtn = document.createElement('button');
            rightBtn.type = 'button';
            rightBtn.className = 'card-move-button card-move-right';
            rightBtn.setAttribute('aria-label', '移动到右侧卡组');
            rightBtn.textContent = '›';
            rightBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                moveCardToAdjacent(card.id, status, 'next');
            });
            cardElement.appendChild(rightBtn);
        }
    }

    cardElement.addEventListener('click', (e) => {
        if (e.target.closest('.card-quick') || e.target.closest('.card-quick-archive') || e.target.closest('.card-quick-delete') || e.target.closest('.card-quick-copy') || e.target.closest('.card-quick-trash') || e.target.closest('.card-quick-star') || e.target.closest('.card-quick-defer') || e.target.closest('.restore-chip')) return;
        if (e.target.closest('.card-assignee') || e.target.closest('.card-deadline')) return;
        // If inline editors are open within this card, keep editing instead of opening details
        const inlineEditor = cardElement.querySelector('.inline-title-input, .card-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown');
        if (inlineEditor) { try { inlineEditor.focus(); } catch(e) {} return; }
        if (e.target.closest('.card-title')) { e.stopPropagation(); inlineEditCardTitle(cardElement); return; }
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

// 复制卡片文本到剪贴板
function copyCardText(cardId) {
    const card = getCardById(cardId);
    if (!card) {
        uiToast('卡片未找到', 'error');
        return;
    }

    // 构建复制内容：标题 + 描述（如有）
    let textToCopy = card.title || '';
    if (card.description && card.description.trim()) {
        textToCopy += '\n\n' + card.description.trim();
    }

    navigator.clipboard.writeText(textToCopy).then(() => {
        uiToast('已复制到剪贴板', 'success');
    }).catch(err => {
        console.error('复制失败:', err);
        uiToast('复制失败', 'error');
    });
}

function toggleCardStar(cardId, btn) {
    const card = getCardById(cardId);
    if (!card) return;
    const next = !card.starred;
    updateCardImmediately(cardId, { starred: next });
    const cardEl = btn && btn.closest ? btn.closest('.card') : document.querySelector(`.card[data-card-id="${cardId}"]`);
    if (cardEl) cardEl.classList.toggle('card-starred', next);
    if (btn) {
        btn.classList.toggle('active', next);
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        const label = next ? '取消星标' : '星标';
        btn.setAttribute('aria-label', label);
        btn.setAttribute('title', label);
    }
}

function toggleCardDeferred(cardId, btn) {
    const card = getCardById(cardId);
    if (!card) return;
    const next = !card.deferred;
    registerLocalCardUpdate(cardId, ['deferred']);
    updateCardImmediately(cardId, { deferred: next });
    const cardEl = btn && btn.closest ? btn.closest('.card') : document.querySelector(`.card[data-card-id="${cardId}"]`);
    const deferBtn = btn || (cardEl ? cardEl.querySelector('.card-quick-defer') : null);
    if (deferBtn) {
        deferBtn.classList.toggle('active', next);
        deferBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
        deferBtn.textContent = next ? '↥' : '↧';
        const label = next ? '取消稍后' : '稍后';
        deferBtn.setAttribute('aria-label', label);
        deferBtn.setAttribute('title', label);
    }
    if (cardEl) cardEl.classList.toggle('card-deferred', next);
    if (!moveDeferredCardInDom(cardId, next, cardEl)) {
        renderBoard();
    }
}

function moveDeferredCardInDom(cardId, deferred, cardEl) {
    const el = cardEl || document.querySelector(`.card[data-card-id="${cardId}"]`);
    if (!el) return false;
    const cardsEl = el.closest('.cards');
    if (!cardsEl) return false;
    const listEl = el.closest('.list');
    const status = listEl ? listEl.getAttribute('data-status') : null;
    if (!status || !Array.isArray(boardData[status])) return false;

    const replacement = findReplacementCardForMove(el);
    const listCards = boardData[status];
    const index = listCards.findIndex(c => c && c.id === cardId);
    if (index === -1) return false;

    let divider = cardsEl.querySelector('.card-group-divider');
    if (deferred && !divider) {
        divider = document.createElement('div');
        divider.className = 'card-group-divider';
        divider.textContent = '稍后';
        let insertAfter = null;
        for (let i = listCards.length - 1; i >= 0; i--) {
            const c = listCards[i];
            if (!c || c.deferred) continue;
            const ref = cardsEl.querySelector(`.card[data-card-id="${c.id}"]`);
            if (ref) { insertAfter = ref; break; }
        }
        if (insertAfter) insertAfter.after(divider);
        else cardsEl.prepend(divider);
    }

    let refAfter = null;
    for (let i = index - 1; i >= 0; i--) {
        const c = listCards[i];
        if (!c || !!c.deferred !== deferred) continue;
        const ref = cardsEl.querySelector(`.card[data-card-id="${c.id}"]`);
        if (ref) { refAfter = ref; break; }
    }
    let refBefore = null;
    if (!refAfter) {
        for (let i = index + 1; i < listCards.length; i++) {
            const c = listCards[i];
            if (!c || !!c.deferred !== deferred) continue;
            const ref = cardsEl.querySelector(`.card[data-card-id="${c.id}"]`);
            if (ref) { refBefore = ref; break; }
        }
    }

    if (refAfter) {
        refAfter.after(el);
    } else if (refBefore) {
        refBefore.before(el);
    } else if (deferred && divider) {
        divider.after(el);
    } else if (!deferred && divider) {
        divider.before(el);
    } else {
        cardsEl.appendChild(el);
    }

    if (divider && !cardsEl.querySelector('.card.card-deferred')) {
        divider.remove();
    }
    updateContainerEmptyState(cardsEl);
    suppressCardHover(cardsEl);
    if (replacement && replacement.isConnected) boostCardQuickActions(replacement);
    return true;
}

function suppressCardHover(container, duration = 160) {
    if (!container) return;
    if (container._hoverSuppressTimer) {
        clearTimeout(container._hoverSuppressTimer);
    }
    container.classList.add('suppress-card-hover');
    container._hoverSuppressTimer = setTimeout(() => {
        container.classList.remove('suppress-card-hover');
        container._hoverSuppressTimer = null;
    }, duration);
}

function findReplacementCardForMove(cardEl) {
    if (!cardEl) return null;
    let candidate = cardEl.nextElementSibling;
    while (candidate && !candidate.classList.contains('card')) {
        candidate = candidate.nextElementSibling;
    }
    if (candidate) return candidate;
    candidate = cardEl.previousElementSibling;
    while (candidate && !candidate.classList.contains('card')) {
        candidate = candidate.previousElementSibling;
    }
    return candidate || null;
}

function boostCardQuickActions(cardEl, duration = 200) {
    if (!cardEl) return;
    if (cardEl._quickBoostTimer) {
        clearTimeout(cardEl._quickBoostTimer);
    }
    cardEl.classList.add('quick-actions-boost');
    cardEl._quickBoostTimer = setTimeout(() => {
        cardEl.classList.remove('quick-actions-boost');
        cardEl._quickBoostTimer = null;
    }, duration);
}

// 通过 ID 删除卡片
async function deleteCardById(cardId) {
    const ok = await uiConfirm('确定要删除这个任务吗？', '删除任务');
    if (!ok) return;
    registerDeleteCardUndo(cardId);
    performDeleteCardById(cardId);
    uiToast('卡片已删除', 'success');
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
    applyCardEditsWithUndo(drawerCardId, updates, { label: '编辑任务' });

    closeCardModal();
    renderBoard();
}

async function deleteCardFromDrawer(){
    if(!drawerCardId) return;
    { const ok = await uiConfirm('确定要删除这个任务吗？','删除任务'); if (!ok) return; }
    registerDeleteCardUndo(drawerCardId);
    performDeleteCardById(drawerCardId);
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
            applyCardEditsWithUndo(drawerCardId, updates, { label: '编辑任务' });
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
            applyCardEditsWithUndo(drawerCardId, { checklist: { items, total, done } }, { label: '编辑任务' });
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
            applyCardEditsWithUndo(drawerCardId, { checklist: { items, total, done } }, { label: '编辑任务' });
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
        socket.send(JSON.stringify({ type:'update-card', projectId: currentProjectId, boardName: currentBoardName, actor: currentUser, cardId, updates }));
    }
}

// quick counters in drawer
(function initDrawerQuickInputs(){
    if (typeof document === 'undefined') return;
    const cmt = document.getElementById('drawerCommentInput');
    const attach = document.getElementById('drawerAttachmentInput');
    if (cmt) cmt.addEventListener('keydown', (e)=>{
        if (e.isComposing || e.keyCode === 229) return; // IME composing
        if(e.key==='Enter' && !e.shiftKey && drawerCardId){
            e.preventDefault();
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
        if (drawerCardId && e.key === 'Escape') {
            // Do not close drawer if focus is inside an editable field
            try {
                const ae = document.activeElement;
                const isEditable = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable);
                const inDrawer = isEditable && drawerEl && drawerEl.classList.contains('open') && drawerEl.contains(ae);
                if (inDrawer) { e.preventDefault(); e.stopPropagation(); return; }
            } catch(_){}
            closeCardModal();
        }
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
        commentsCount: 0,
        starred: false,
        deferred: false
    };

    queuePendingCardAdd(status, card, isTop ? 'top' : 'bottom');
    sendCardAdd(status, card, isTop ? 'top' : 'bottom');

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
            actor: currentUser,
            cardId: cardId,
            fromStatus: fromStatus,
            toStatus: toStatus
        }));
    }
}

// 归档卡片
function archiveCard(cardId, hintStatus, options) {
    const opts = options || {};
    // find card from any non-archived column (supports dynamic lists)
    let fromStatus = null;
    let cardObj = null;
    let cardIndex = -1;

    const candidates = [];
    try {
        if (hintStatus && hintStatus !== 'archived' && Array.isArray(boardData[hintStatus])) {
            candidates.push(hintStatus);
        }
    } catch (_) {}

    try {
        // Prefer ordered statuses derived from clientLists (user-defined columns)
        getOrderedStatusKeys().forEach(s => {
            if (s && s !== 'archived' && !candidates.includes(s)) candidates.push(s);
        });
    } catch (_) {}

    try {
        // Fallback: any array-backed status on boardData
        getAllStatusKeys().forEach(s => {
            if (s && s !== 'archived' && !candidates.includes(s)) candidates.push(s);
        });
    } catch (_) {}

    for (const s of candidates) {
        const arr = boardData[s] || [];
        const idx = arr.findIndex(c => c && c.id === cardId);
        if (idx !== -1) {
            fromStatus = s;
            cardObj = arr[idx];
            cardIndex = idx;
            arr.splice(idx, 1);
            break;
        }
    }

    if (!fromStatus || !cardObj) {
        // Silent no-op: card might already be archived / deleted / moved by another client
        return;
    }

    const cardSnapshot = cloneDeep(cardObj);
    if (!opts.skipUndo && !undoRedoInProgress) {
        pushUndoAction({
            type: 'archive-card',
            label: '归档任务',
            createdAt: Date.now(),
            undo: () => restoreArchivedCard(cardSnapshot, fromStatus, cardIndex),
            redo: () => archiveCard(cardId, fromStatus, { skipUndo: true })
        });
    }

    cardObj.archivedFrom = fromStatus;
    cardObj.archivedAt = Date.now();
    boardData.archived = Array.isArray(boardData.archived) ? boardData.archived : [];
    boardData.archived.push(cardObj);

    sendArchiveCard(cardId, fromStatus);
    if (!opts.skipRender) {
        renderBoard();
    }
}

// 还原卡片
function restoreCard(cardId, options) {
    const opts = options || {};
    let restored = false;
    let targetStatus = null;
    if (Array.isArray(boardData.archived)) {
        const idx = boardData.archived.findIndex(card => card.id === cardId);
        if (idx !== -1) {
            const card = boardData.archived.splice(idx, 1)[0];
            targetStatus = resolveArchivedStatus(card) || 'done';
            if (!Array.isArray(boardData[targetStatus])) boardData[targetStatus] = [];
            delete card.archivedFrom;
            delete card.archivedAt;
            if (!boardData[targetStatus].some(c => c.id === cardId)) {
                boardData[targetStatus].push(card);
            }
            restored = true;
        }
    }
    if (restored && !opts.skipUndo && !undoRedoInProgress) {
        pushUndoAction({
            type: 'restore-card',
            label: '还原任务',
            createdAt: Date.now(),
            undo: () => archiveCard(cardId, targetStatus, { skipUndo: true }),
            redo: () => restoreCard(cardId, { skipUndo: true })
        });
    }
    if (restored && !opts.skipRender) {
        renderBoard();
        if (!archivePage.classList.contains('hidden')) {
            renderArchive();
        }
    }
    sendRestoreCard(cardId);
}

// 清空归档
async function clearArchive() {
    const ok = await uiConfirm('确定要清空所有归档任务吗？此操作不可恢复。','清空归档');
    if (!ok) return;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'clear-archive', projectId: currentProjectId, boardName: currentBoardName, actor: currentUser }));
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
    document.getElementById('editCardAuthor').textContent = `创建者: ${getDisplayNameForUser(card.author)}`;

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
        postsInput.onkeydown = function(e){
            if (e.isComposing || e.keyCode === 229) return; // IME composing
            if (e.key==='Enter' && !e.shiftKey) { e.preventDefault(); submitNewPost(); }
        };
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

    const updates = { title, description, assignee, deadline };

    applyCardEditsWithUndo(editingCardId, updates, { label: '编辑任务' });

    closeEditModal();
    renderBoard();
}

// 删除卡片
async function deleteCard() {
    if (!editingCardId) return;
    const ok = await uiConfirm('确定要删除这个任务吗？','删除任务');
    if (!ok) return;
    registerDeleteCardUndo(editingCardId);
    performDeleteCardById(editingCardId);
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
    const list = Array.isArray(users) ? users : [];
    const countEl = document.getElementById('onlineCount');
    if (countEl) countEl.textContent = String(list.length);
    const listEl = document.getElementById('userList');
    if (listEl) {
        listEl.innerHTML = list.length
            ? list.map(user =>
                `<span class="online-user" title="${escapeHtml(user)}">${escapeHtml(getDisplayNameForUser(user))}</span>`
            ).join('')
            : '<span class="online-users-empty">暂无在线用户</span>';
    }

    // 同时更新分配用户选项
    window.currentOnlineUsers = list;
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
            option.textContent = getDisplayNameForUser(user);
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

// 安全触发下载，避免立即撤销 URL 导致的二次下载失效
function triggerBlobDownload(blob, filename) {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    // 使用同步点击，但延迟撤销 URL，兼容部分浏览器
    a.click();
    // 延迟移除与撤销，确保下载流程已开始（修复再次点击无反应问题）
    setTimeout(() => {
        try { document.body.removeChild(a); } catch (_) {}
        try { window.URL.revokeObjectURL(url); } catch (_) {}
    }, 200);
}

// 通过临时 <a> 直接触发下载（首选方案）
function anchorDownload(url, filename){
    try {
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        // 提供文件名提示；服务器端也会通过 Content-Disposition 指定
        if (filename) a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { try { document.body.removeChild(a); } catch(_){} }, 200);
        return true;
    } catch(_) {
        return false;
    }
}

// 通过页面导航触发下载，规避"多文件下载阻止"策略
function navigateDownload(url){
    try {
        const finalUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        window.location.href = finalUrl;
        return true;
    } catch(_) {
        return false;
    }
}

// 使用隐藏 iframe 方式下载，避免部分浏览器对重复下载的限制
function directDownload(url){
    try {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        // 加时间戳避免缓存
        iframe.src = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        document.body.appendChild(iframe);
        // 一段时间后清理
        setTimeout(() => { try { document.body.removeChild(iframe); } catch(_){} }, 15000);
        return true;
    } catch(_) {
        return false;
    }
}

function sanitizeFilenamePart(name) {
    if (!name || typeof name !== 'string') return '未命名';
    const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
    return cleaned || '未命名';
}

function getBoardExportContext() {
    let projectId = currentProjectId;
    let projectName = currentProjectName;
    let boardName = currentBoardName;

    try {
        if (!projectId) {
            const storedId = localStorage.getItem('kanbanCurrentProjectId');
            if (storedId) projectId = storedId;
        }
    } catch(_){}
    try {
        if (!projectName) {
            const storedProjectName = localStorage.getItem('kanbanCurrentProjectName');
            if (storedProjectName) projectName = storedProjectName;
        }
    } catch(_){}
    try {
        if (!boardName) {
            const storedBoardName = localStorage.getItem('kanbanCurrentBoardName');
            if (storedBoardName) boardName = storedBoardName;
        }
    } catch(_){}

    if ((!projectName || !String(projectName).trim())) {
        try {
            const projectEl = document.getElementById('currentProjectName');
            if (projectEl && projectEl.textContent) {
                projectName = projectEl.textContent.trim();
            }
        } catch(_){}
    }
    if ((!boardName || !String(boardName).trim())) {
        try {
            const boardEl = document.getElementById('currentBoardName');
            if (boardEl && boardEl.textContent) {
                boardName = boardEl.textContent.trim();
            }
        } catch(_){}
    }

    return {
        projectId: projectId ? String(projectId).trim() : '',
        projectName: projectName ? String(projectName).trim() : '',
        boardName: boardName ? String(boardName).trim() : ''
    };
}

function ensureBoardExportContext() {
    const ctx = getBoardExportContext();
    if (!ctx.projectId || !ctx.boardName) {
        uiToast('当前看板信息缺失，无法导出','error');
        return null;
    }
    if (!ctx.projectName) ctx.projectName = '未命名项目';
    return ctx;
}

// 导出 Markdown（详细格式）
async function exportMarkdown() {
    const ctx = ensureBoardExportContext();
    if (!ctx) return;
    const { projectId, projectName, boardName } = ctx;
    const fileName = `${sanitizeFilenamePart(projectName)}-${sanitizeFilenamePart(boardName)}.md`;
    const url = `/api/export/${projectId}/${encodeURIComponent(boardName)}`;
    // 直接通过 <a> 触发下载（更稳定，点击即下载）
    if (anchorDownload(url, fileName)) return;
    if (navigateDownload(url)) return;
    // 回退：隐藏 iframe
    if (directDownload(url)) return;
    // 最后回退到 Blob 方式
    try {
        const finalUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const response = await fetch(finalUrl, { credentials: 'include' });
        if (response.ok) {
            const blob = await response.blob();
            triggerBlobDownload(blob, fileName);
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

// 导出 TaskPaper（简洁格式）
async function exportTaskPaper() {
    const ctx = ensureBoardExportContext();
    if (!ctx) return;
    const { projectId, projectName, boardName } = ctx;
    const fileName = `${sanitizeFilenamePart(projectName)}-${sanitizeFilenamePart(boardName)}.taskpaper`;
    const url = `/api/export-taskpaper/${projectId}/${encodeURIComponent(boardName)}`;
    // 直接通过 <a> 触发下载（更稳定，点击即下载）
    if (anchorDownload(url, fileName)) return;
    if (navigateDownload(url)) return;
    // 回退：隐藏 iframe
    if (directDownload(url)) return;
    // 最后回退到 Blob 方式
    try {
        const finalUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const response = await fetch(finalUrl, { credentials: 'include' });
        if (response.ok) {
            const blob = await response.blob();
            triggerBlobDownload(blob, fileName);
        } else {
            const text = await response.text().catch(()=> '');
            console.error('Export TaskPaper error:', response.status, text);
            uiToast('导出失败','error');
        }
    } catch (error) {
        console.error('Export TaskPaper error:', error);
        uiToast('导出失败','error');
    }
}

// 导入功能
function importBoard() {
    const fileInput = document.getElementById('importFile');
    fileInput.click();
}

function openImportText() {
    if (importTextArea) { importTextArea.value = ''; }
    if (importTextModal) {
        importTextModal.classList.remove('hidden');
        setTimeout(() => { if (importTextArea) importTextArea.focus(); }, 0);
    }
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
            } else if (file.name.endsWith('.md') || file.name.endsWith('.taskpaper')) {
                // Markdown 和 TaskPaper 都用同一个解析函数（自动检测格式）
                data = parseMarkdownToBoard(event.target.result);
            } else {
                uiToast('不支持的文件格式，请选择 .json / .md / .taskpaper 文件','error');
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

function parseImportText() {
    const raw = importTextArea ? importTextArea.value.trim() : '';
    if (!raw) { uiToast('请输入要导入的文本','error'); return; }
    try {
        let data = null;
        // 优先尝试 JSON
        try {
            data = JSON.parse(raw);
        } catch (_) {
            data = null;
        }
        if (!data) {
            // 回退为 Markdown 解析
            data = parseMarkdownToBoard(raw);
        }
        importFileData = data;
        if (importTextModal) importTextModal.classList.add('hidden');
        if (importModal) importModal.classList.remove('hidden');
    } catch (err) {
        console.error('Import text parse error:', err);
        uiToast('文本格式错误，无法解析为 JSON 或 Markdown','error');
    }
}

function cancelImportText() {
    if (importTextModal) importTextModal.classList.add('hidden');
    if (importTextArea) importTextArea.value = '';
}

function isTaskPaperHeaderLine(line){
    const trimmed = (line || '').trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false;
    if (!/[：:]$/.test(trimmed)) return false;
    if (trimmed.includes('://') || trimmed.includes('：//')) return false;
    return true;
}

function getTaskPaperHeaderTitle(line){
    if (!isTaskPaperHeaderLine(line)) return null;
    return line.trim().replace(/[：:]$/, '').trim();
}

// 解析 Markdown 为看板数据
/**
 * TaskPaper 风格解析（兼容旧格式）
 *
 * 新格式：
 * ```
 * 待办:
 *
 * - 完成登录功能 @张三 @due(2024-03-15)
 * - 修复 bug
 * ```
 *
 * 旧格式（仍然支持）：
 * ```
 * ## 📋 待办
 * ### 1. 任务标题
 * **描述:** ...
 * **分配给:** ...
 * ```
 */
function parseMarkdownToBoard(markdown) {
    const lines = markdown.split('\n');
    const board = { archived: [] };
    const listsMeta = { listIds: [], lists: {} };
    let currentSectionKey = null;
    let currentCard = null;
    let listCounter = 0;

    // 检测是否为 TaskPaper 格式（简单判断：有 "xxx:" 开头的行且没有 ## 开头的行）
    const hasTaskPaperHeaders = lines.some(l => isTaskPaperHeaderLine(l));
    const hasMarkdownHeaders = lines.some(l => /^##\s+/.test(l));
    const isTaskPaperFormat = hasTaskPaperHeaders && !hasMarkdownHeaders;

    function ensureSection(key){
        if (!Array.isArray(board[key])) board[key] = [];
    }

    function normalizeHeadingToKey(h){
        const t = h.trim().replace(/^##\s+/, '').replace(/[：:]$/, '');
        // legacy quick mapping
        if (t.startsWith('📋') || /\bTODO\b/i.test(t) || t === '待办') return 'todo';
        if (t.startsWith('🔄') || /\bDOING\b/i.test(t) || t === '进行中') return 'doing';
        if (t.startsWith('✅') || /\bDONE\b/i.test(t) || t === '已完成') return 'done';
        if (t.startsWith('📁') || /\bARCHIVED\b/i.test(t) || t === '归档') return 'archived';
        // dynamic: generate a stable status key from title text
        const base = 'list_' + (++listCounter).toString(36);
        return base;
    }

    function addListMetaIfNeeded(title, statusKey){
        // skip archived in lists meta
        if (statusKey === 'archived') return;
        // create a unique stable id for this list title
        const id = 'list_' + (listsMeta.listIds.length + 1).toString(36) + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
        listsMeta.listIds.push(id);
        listsMeta.lists[id] = { id, title: title, pos: listsMeta.listIds.length - 1, status: statusKey };
    }

    // TaskPaper 格式解析
    function parseTaskPaperItem(content) {
        let title = content;
        let assignee = null;
        let deadline = null;

        // 解析 @due(日期)
        const dueMatch = title.match(/@due\(([^)]+)\)/);
        if (dueMatch) {
            deadline = dueMatch[1].trim();
            title = title.replace(/@due\([^)]+\)/, '').trim();
        }

        // 解析 @用户名（排除特殊标签）
        const assigneeMatch = title.match(/@(\S+)/);
        if (assigneeMatch && !assigneeMatch[1].includes('(')) {
            assignee = assigneeMatch[1];
            title = title.replace(/@\S+/, '').trim();
        }

        return { title: title.trim(), assignee, deadline };
    }

    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        const trimmedLine = line.trim();

        // 跳过空行
        if (!trimmedLine) continue;

        // TaskPaper 格式：列名以冒号结尾（不是 URL）
        if (isTaskPaperFormat && isTaskPaperHeaderLine(trimmedLine)) {
            const columnName = getTaskPaperHeaderTitle(trimmedLine);
            if (columnName) {
                const key = normalizeHeadingToKey(columnName);
                currentSectionKey = key;
                ensureSection(key);
                if (key !== 'archived') {
                    addListMetaIfNeeded(columnName, key);
                }
                currentCard = null;
            }
            continue;
        }

        // 旧格式：## 标题
        if (/^##\s+/.test(line)) {
            const heading = line;
            const key = normalizeHeadingToKey(heading);
            const title = heading.replace(/^##\s+/, '').trim();
            currentSectionKey = key;
            ensureSection(key);
            if (key !== 'todo' && key !== 'doing' && key !== 'done' && key !== 'archived') {
                addListMetaIfNeeded(title, key);
            } else if (key !== 'archived') {
                addListMetaIfNeeded(title, key);
            }
            currentCard = null;
            continue;
        }

        // TaskPaper 格式：- 开头的条目
        if (isTaskPaperFormat && trimmedLine.startsWith('- ') && currentSectionKey) {
            const itemContent = trimmedLine.substring(2);
            const { title, assignee, deadline } = parseTaskPaperItem(itemContent);

            if (title) {
                currentCard = {
                    id: Date.now() + Math.random().toString(),
                    title: title,
                    description: '',
                    author: currentUser,
                    assignee: assignee,
                    created: new Date().toISOString(),
                    deadline: deadline
                };
                board[currentSectionKey].push(currentCard);
            }
            continue;
        }

        // 旧格式：### 标题
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

        // 旧格式：元数据
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
            actor: currentUser,
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
    currentUserDisplayName = '';
    userDisplayNameMap = Object.create(null);
    currentProjectId = null;
    currentProjectName = null;
    currentBoardName = null;
    boardData = { archived: [], lists: { listIds: [], lists: {} } };

    localStorage.removeItem('kanbanUser');
    localStorage.removeItem('kanbanDisplayName');
    localStorage.removeItem('kanbanPageState');
    localStorage.removeItem('kanbanCurrentProjectId');
    localStorage.removeItem('kanbanCurrentProjectName');
    localStorage.removeItem('kanbanCurrentBoardName');

    resetUndoRedo();

    showLoginPage();

    // 重置表单
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    formTitle.textContent = '登录';
    submitBtn.textContent = '登录';
    switchText.textContent = '还没有账号？';
    switchMode.textContent = '注册';
    if (loginSubtitle) loginSubtitle.textContent = '欢迎使用协作看板，一起提升团队效率。';
    const emailInput = document.getElementById('email');
    if (emailField) emailField.style.display = 'none';
    if (emailInput) {
        emailInput.style.display = 'none';
        emailInput.required = false;
        emailInput.value = '';
    }
}

// === Project switcher (like board switcher) ===
async function openProjectSwitcher(e) {
    e.preventDefault();
    e.stopPropagation();
    if (projectSwitcherOpen) { hideProjectSwitcher(); return; }
    try { hideBoardSwitcher(); } catch (_) {}
    const anchor = e.currentTarget || document.getElementById('projectTitle');
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let projects = [];
    try {
        const resp = await fetch(`/api/user-projects/${currentUser}`);
        projects = await resp.json();
    } catch (_) { projects = []; }
    showProjectSwitcherAt(rect, Array.isArray(projects) ? projects : []);
    const titleEl = document.getElementById('projectTitle');
    if (titleEl) titleEl.classList.add('open');
    const caretProjectPage = document.getElementById('projectCaret');
    if (caretProjectPage) caretProjectPage.classList.add('open');
    const caretBoardPage = document.getElementById('boardProjectCaret');
    if (caretBoardPage) caretBoardPage.classList.add('open');
}

function showProjectSwitcherAt(rect, projects) {
    hideProjectSwitcher();
    const menu = document.createElement('div');
    menu.className = 'board-switcher-menu project-switcher-menu';
    menu.style.left = Math.round(rect.left) + 'px';
    menu.style.top = Math.round(rect.bottom + 6) + 'px';

    // Header with search and create
    const header = document.createElement('div');
    header.className = 'board-switcher-header';
    const search = document.createElement('input');
    search.type = 'text';
    search.className = 'board-switcher-search';
    search.placeholder = '搜索或创建项目...';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'board-switcher-create';
    createBtn.textContent = '创建新项目';
    createBtn.disabled = true;
    const updateCreateBtn = () => { createBtn.disabled = !((search.value||'').trim()); };
    createBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const name = (search.value || '').trim();
        if (!name) return;
        try {
            const rs = await fetch('/api/create-project', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: currentUser, projectName: name })
            });
            const rj = await rs.json().catch(()=>({}));
            if (rs.ok && rj && rj.projectId) {
                try { loadUserProjects(); } catch(_){ }
                hideProjectSwitcher();
                selectProject(rj.projectId, name);
                uiToast('项目创建成功','success');
            } else {
                uiToast(rj.message || '创建失败','error');
            }
        } catch(_) { uiToast('创建失败','error'); }
    };
    header.appendChild(search);
    header.appendChild(createBtn);
    menu.appendChild(header);

    const list = document.createElement('div');
    list.className = 'board-switcher-list';

    function renderList(filterText) {
        list.innerHTML = '';
        const ft = (filterText || '').toLowerCase();
        const filtered = (projects || []).filter(p => (p.name||'').toLowerCase().includes(ft));
        filtered.forEach(p => {
            const item = document.createElement('div');
            item.className = 'board-switcher-item' + ((String(p.id) === String(currentProjectId)) ? ' active' : '');
            const label = document.createElement('span');
            label.className = 'board-switcher-label';
            label.textContent = p.name || '';
            item.onclick = (ev) => {
                ev.stopPropagation();
                hideProjectSwitcher();
                if (String(p.id) !== String(currentProjectId)) {
                    selectProject(p.id, p.name);
                }
            };
            item.appendChild(label);
            list.appendChild(item);
        });
        if (!filtered.length) {
            const empty = document.createElement('div');
            empty.className = 'board-switcher-empty';
            empty.textContent = '没有匹配的项目';
            list.appendChild(empty);
        }
    }

    renderList('');
    search.addEventListener('input', () => { renderList(search.value); updateCreateBtn(); });
    updateCreateBtn();

    menu.appendChild(list);
    document.body.appendChild(menu);
    projectSwitcherMenu = menu;
    projectSwitcherOpen = true;

    setTimeout(() => {
        projectSwitcherBodyClickHandler = (ev) => {
            if (!projectSwitcherMenu) return;
            if (!projectSwitcherMenu.contains(ev.target)) { hideProjectSwitcher(); }
        };
        projectSwitcherKeyHandler = (ev) => { if (ev.key === 'Escape') hideProjectSwitcher(); };
        projectSwitcherFocusInHandler = (ev) => {
            if (!projectSwitcherMenu) return;
            if (!projectSwitcherMenu.contains(ev.target)) { hideProjectSwitcher(); }
        };
        document.addEventListener('click', projectSwitcherBodyClickHandler);
        document.addEventListener('keydown', projectSwitcherKeyHandler);
        document.addEventListener('focusin', projectSwitcherFocusInHandler);
        try { search.focus(); } catch(_){}
    }, 0);
}

function hideProjectSwitcher() {
    if (projectSwitcherBodyClickHandler) { document.removeEventListener('click', projectSwitcherBodyClickHandler); projectSwitcherBodyClickHandler = null; }
    if (projectSwitcherKeyHandler) { document.removeEventListener('keydown', projectSwitcherKeyHandler); projectSwitcherKeyHandler = null; }
    if (projectSwitcherFocusInHandler) { document.removeEventListener('focusin', projectSwitcherFocusInHandler); projectSwitcherFocusInHandler = null; }
    if (projectSwitcherMenu && projectSwitcherMenu.parentNode) {
        projectSwitcherMenu.parentNode.removeChild(projectSwitcherMenu);
    }
    projectSwitcherMenu = null;
    projectSwitcherOpen = false;
    const titleEl = document.getElementById('projectTitle');
    if (titleEl) titleEl.classList.remove('open');
    const caretProjectPage = document.getElementById('projectCaret');
    if (caretProjectPage) caretProjectPage.classList.remove('open');
    const caretBoardPage = document.getElementById('boardProjectCaret');
    if (caretBoardPage) caretBoardPage.classList.remove('open');
    // no legacy arrow in breadcrumb anymore
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

    let settled = false;

    // 保存函数
    const save = async () => {
        if (settled) return;
        settled = true;
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
                    actor: currentUser,
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
        if (settled) return;
        settled = true;
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
        if (e.key === 'Enter') {
            // Enter保存（不再需要Ctrl）
            e.preventDefault();
            try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){};
            save();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
        }
    });

    input.addEventListener('blur', () => {
        if (settled) return;
        save();
    });

    // 阻止事件冒泡
    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

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

    let settled = false;

    // 保存函数
    const save = async () => {
        if (settled) return;
        settled = true;
        const newDescription = textarea.value.trim();
        if (newDescription !== card.description) {
            const updates = { description: newDescription };
            applyCardEditsWithUndo(cardId, updates, { label: '编辑任务' });

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
        if (settled) return;
        settled = true;
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

    textarea.addEventListener('blur', () => {
        if (settled) return;
        save();
    });

    // 阻止事件冒泡
    textarea.addEventListener('click', (e) => {
        e.stopPropagation();
    });

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
        item.textContent = user ? `@${getDisplayNameForUser(user)}` : '未分配';
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const newAssignee = user || null;
            updateCardField(cardId, 'assignee', newAssignee);
            card.assignee = newAssignee; // 本地立即更新

            // 更新DOM而不重新渲染整个板
            if (newAssignee) {
                assigneeElement.textContent = `@${escapeHtml(getDisplayNameForUser(newAssignee))}`;
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
    return !!document.querySelector('.inline-title-input, .card-title-input, .inline-description-textarea, .inline-date-input, .assignee-dropdown, .card-composer.is-open');
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
            pendingRenderTimer = setTimeout(check, 80);
            return;
        }
        if (pendingBoardUpdate) {
            pendingBoardUpdate = false;
            renderBoard();
        }
        pendingRenderTimer = null;
    }, 80);
}

// 管理卡片的内联编辑状态
function setCardInlineEditingState(cardId, isEditing) {
    if (isEditing) inlineEditingCardIds.add(cardId);
    else inlineEditingCardIds.delete(cardId);
    const cardElement = document.querySelector(`[data-card-id="${cardId}"]`);
    if (cardElement) {
        if (isEditing) {
            cardElement.classList.add('inline-editing');
        } else {
            cardElement.classList.remove('inline-editing');
        }
        const quickBtn = cardElement.querySelector('.card-quick');
        if (quickBtn) {
            if (isEditing) {
                quickBtn.dataset.inlineHidden = 'true';
                quickBtn.style.display = 'none';
            } else {
                delete quickBtn.dataset.inlineHidden;
                quickBtn.style.display = '';
            }
        }
    }
}

// 更新卡片字段
function updateCardField(cardId, field, value) {
    const updates = {};
    updates[field] = value;
    applyCardEditsWithUndo(cardId, updates, { label: '编辑任务' });
}

// HTML转义
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// JS字符串转义（用于onclick等）
function escapeJs(text) {
    if (text == null) return '';
    return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
}

// SVG 图标：看板
function getBoardIconSVG() {
    return '';
}

// 简易图标库
const Icon = {
    boards: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19,0H5C2.24,0,0,2.24,0,5v14c0,2.76,2.24,5,5,5h14c2.76,0,5-2.24,5-5V5c0-2.76-2.24-5-5-5Zm3,19c0,1.65-1.35,3-3,3H5c-1.65,0-3-1.35-3-3V5c0-1.65,1.35-3,3-3h14c1.65,0,3,1.35,3,3v14ZM11,6v5c0,.55-.45,1-1,1s-1-.45-1-1V6c0-.55,.45-1,1-1s1,.45,1,1Zm-4,0V14c0,.55-.45,1-1,1s-1-.45-1-1V6c0-.55,.45-1,1-1s1,.45,1,1Zm8,0v12c0,.55-.45,1-1,1s-1-.45-1-1V6c0-.55,.45-1,1-1s1,.45,1,1Zm4,0v3c0,.55-.45,1-1,1s-1-.45-1-1v-3c0-.55,.45-1,1-1s1,.45,1,1Z" fill="currentColor"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h5l2 2h9a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 8.5a4 4 0 0 1 4-4h2a4 4 0 1 1 0 8h-2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 15.5a4 4 0 0 1-4 4H8a4 4 0 1 1 0-8h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8l-1 5 3 3v2H6v-2l3-3-1-5z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M12 14v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    'pin-off': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M8 4h8l-1 5 3 3v2H9M12 14v6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>'
};

function renderIconsInDom(root=document) {
    root.querySelectorAll('[data-icon]').forEach(el => {
        const name = el.getAttribute('data-icon');
        if (Icon[name]) {
            el.innerHTML = Icon[name];
            el.setAttribute('aria-hidden','true');
            el.classList.add('icon-ready');
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

function updateContainerEmptyState(container) {
    if (!container) return;
    const hasCards = container.querySelector('.card');
    if (hasCards) {
        delete container.dataset.empty;
    } else {
        container.dataset.empty = 'true';
    }
}

function placeDraggingCard(container) {
    if (!draggingCardEl) return;
    if (draggingCardPlaceholder) {
        if (container && draggingCardPlaceholder.parentNode !== container) {
            container.appendChild(draggingCardPlaceholder);
        }
        if (draggingCardPlaceholder.parentNode) {
            draggingCardPlaceholder.replaceWith(draggingCardEl);
        }
        draggingCardPlaceholder = null;
    }
    draggingCardEl.classList.remove('drag-hidden');
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
        const dragging = draggingCardEl || document.querySelector('.card.dragging');
        if (!dragging) return;
        const previousContainer = (draggingCurrentContainer && draggingCurrentContainer !== container) ? draggingCurrentContainer : null;
        delete container.dataset.empty;
        const afterEl = getDragAfterElement(container, e.clientY);
        const firstArchived = container.querySelector('.card[data-archived="true"]');
        if (!draggingCardPlaceholder) {
            if (afterEl == null) {
                if (firstArchived) {
                    container.insertBefore(dragging, firstArchived);
                } else {
                    container.appendChild(dragging);
                }
            } else {
                container.insertBefore(dragging, afterEl);
            }
        } else if (afterEl == null) {
            if (firstArchived) {
                container.insertBefore(draggingCardPlaceholder, firstArchived);
            } else {
                container.appendChild(draggingCardPlaceholder);
            }
        } else {
            container.insertBefore(draggingCardPlaceholder, afterEl);
        }
        draggingCurrentContainer = container;
        if (previousContainer && previousContainer !== container) {
            updateContainerEmptyState(previousContainer);
        }
    };

    const handleDrop = () => {
        delete container.dataset.empty;
        placeDraggingCard(container);
        const toStatus = status;
        const fromStatus = draggingFromStatus;
        const movedCardId = draggingCardId;
        const orderedIds = Array.from(container.querySelectorAll('.card:not([data-archived="true"])'))
            .map(el => el.dataset.cardId);
        if (socket && socket.readyState === WebSocket.OPEN) {
            if (movedCardId && fromStatus && fromStatus !== toStatus) {
                socket.send(JSON.stringify({ type:'move-card', projectId: currentProjectId, boardName: currentBoardName, actor: currentUser, cardId:movedCardId, fromStatus, toStatus }));
            }
            socket.send(JSON.stringify({ type:'reorder-cards', projectId: currentProjectId, boardName: currentBoardName, actor: currentUser, status: toStatus, orderedIds }));
        }
        draggingCardId = null;
        draggingFromStatus = null;
        document.body.classList.remove('dragging-cards');
        if (draggingOriginContainer && draggingOriginContainer !== container) {
            updateContainerEmptyState(draggingOriginContainer);
        }
        draggingCurrentContainer = container;
    };

    container.ondragover = handleDragOver;
    container.ondrop = handleDrop;
    const listWrapper = container.closest('.list, .column');
    if (listWrapper) { listWrapper.ondragover = handleDragOver; listWrapper.ondrop = handleDrop; }
}

function makeDraggable(cardEl) {
    if (cardEl.dataset.archived === 'true') {
        cardEl.setAttribute('draggable', 'false');
        return;
    }
    cardEl.setAttribute('draggable', 'true');
    cardEl.ondragstart = (e) => {
        cardEl.classList.add('dragging');
        draggingCardEl = cardEl;
        const col = cardEl.closest('.column, .list');
        draggingFromStatus = col ? col.getAttribute('data-status') : null;
        draggingCardId = cardEl.dataset.cardId;
        draggingOriginContainer = cardEl.closest('.cards');
        draggingCurrentContainer = draggingOriginContainer;
        if (draggingCardPlaceholder && draggingCardPlaceholder.parentNode) {
            draggingCardPlaceholder.remove();
        }
        draggingCardPlaceholder = document.createElement('div');
        draggingCardPlaceholder.className = 'card-placeholder';
        draggingCardPlaceholder.setAttribute('aria-hidden', 'true');
        try {
            const rect = cardEl.getBoundingClientRect();
            draggingCardPlaceholder.style.height = `${rect.height}px`;
            const style = window.getComputedStyle(cardEl);
            draggingCardPlaceholder.style.marginTop = style.marginTop;
            draggingCardPlaceholder.style.marginBottom = style.marginBottom;
        } catch (e) {}
        if (draggingOriginContainer) {
            cardEl.after(draggingCardPlaceholder);
        }
        requestAnimationFrame(() => {
            if (draggingCardPlaceholder && cardEl.classList.contains('dragging')) {
                cardEl.classList.add('drag-hidden');
            }
        });
        if (draggingOriginContainer) delete draggingOriginContainer.dataset.empty;
        document.body.classList.add('dragging-cards');
        try { e.dataTransfer && e.dataTransfer.setData('text/plain', draggingCardId); e.dataTransfer.effectAllowed = 'move'; } catch (e) {}
    };
    cardEl.ondragend = () => {
        cardEl.classList.remove('dragging');
        document.body.classList.remove('dragging-cards');
        placeDraggingCard(draggingCurrentContainer || draggingOriginContainer);
        const currentContainer = cardEl.closest('.cards');
        updateContainerEmptyState(currentContainer);
        if (draggingOriginContainer && draggingOriginContainer !== currentContainer) {
            updateContainerEmptyState(draggingOriginContainer);
        }
        if (draggingCurrentContainer && draggingCurrentContainer !== currentContainer && draggingCurrentContainer !== draggingOriginContainer) {
            updateContainerEmptyState(draggingCurrentContainer);
        }
        draggingCardId = null;
        draggingFromStatus = null;
        draggingOriginContainer = null;
        draggingCurrentContainer = null;
        draggingCardEl = null;
    };
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.card:not(.dragging):not([data-archived="true"])')];
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

// ===== Board drag scroll =====
let boardDragBound = false;
let boardDragActive = false;
let boardDragStartX = 0;
let boardDragStartScrollLeft = 0;
let boardDragOnMouseMove = null;
let boardDragOnMouseUp = null;

function bindBoardDragScroll() {
    if (boardDragBound) return;
    const container = document.getElementById('listsContainer');
    if (!container) return;
    boardDragBound = true;

    const isBlockedTarget = (target) => {
        if (!target) return true;
        return !!target.closest([
            'button',
            'input',
            'textarea',
            'select',
            'a',
            '[contenteditable="true"]',
            '.card',
            '.card-composer',
            '.add-card',
            '.add-list',
            '.list-header',
            '.list-actions',
            '.list-menu',
            '.list-archive',
            '.list-title',
            '.list-title-input',
            '.card-quick',
            '.card-center-actions',
            '.card-move-button',
            '.card-title-input',
            '.list-drag-placeholder'
        ].join(', '));
    };

    const onMouseMove = (e) => {
        if (!boardDragActive) return;
        e.preventDefault();
        const delta = e.clientX - boardDragStartX;
        container.scrollLeft = boardDragStartScrollLeft - delta;
    };

    const stopDrag = () => {
        if (!boardDragActive) return;
        boardDragActive = false;
        container.classList.remove('drag-scroll-active');
        document.body.classList.remove('dragging-board');
        if (boardDragOnMouseMove) document.removeEventListener('mousemove', boardDragOnMouseMove);
        if (boardDragOnMouseUp) document.removeEventListener('mouseup', boardDragOnMouseUp);
    };
    boardDragOnMouseMove = onMouseMove;
    boardDragOnMouseUp = stopDrag;

    const onMouseDown = (e) => {
        if (e.button !== 0) return;
        if (e.defaultPrevented) return;
        if (draggingListEl || draggingCardEl || document.body.classList.contains('dragging-cards')) return;
        if (isAnyInlineEditorOpen()) return;
        if (isBlockedTarget(e.target)) return;

        boardDragActive = true;
        boardDragStartX = e.clientX;
        boardDragStartScrollLeft = container.scrollLeft;
        container.classList.add('drag-scroll-active');
        document.body.classList.add('dragging-board');
        e.preventDefault();

        document.addEventListener('mousemove', boardDragOnMouseMove);
        document.addEventListener('mouseup', boardDragOnMouseUp);
    };

    container.addEventListener('mousedown', onMouseDown);
}
// ===== End Board drag scroll =====

function stopBoardDragScroll(){
    if (!boardDragActive) return;
    boardDragActive = false;
    const container = document.getElementById('listsContainer');
    if (container) container.classList.remove('drag-scroll-active');
    document.body.classList.remove('dragging-board');
    if (boardDragOnMouseMove) document.removeEventListener('mousemove', boardDragOnMouseMove);
    if (boardDragOnMouseUp) document.removeEventListener('mouseup', boardDragOnMouseUp);
}

// ===== Lists drag (mouse-based) =====
let draggingListEl = null;
let listDragOffsetX = 0;
let listDragOffsetY = 0;
let listDragPlaceholder = null;

function enableListsDrag() {
    const container = document.getElementById('listsContainer');
    if (!container) return;

    // Save new order to server
    const saveListOrder = () => {
        if (!clientLists) return;
        const ids = Array.from(container.querySelectorAll('.list:not(#addListEntry):not(.add-list):not(.list-drag-placeholder)'))
            .map(el => el.getAttribute('data-id'))
            .filter(Boolean);
        clientLists.listIds = ids;
        ids.forEach((id, idx) => { if (clientLists.lists[id]) clientLists.lists[id].pos = idx; });
        saveClientListsToStorage();
        queueListsSync();
    };

    // Mouse move handler
    const onMouseMove = (e) => {
        if (!draggingListEl) return;
        e.preventDefault();

        // Move the dragging element
        draggingListEl.style.left = (e.clientX - listDragOffsetX) + 'px';
        draggingListEl.style.top = (e.clientY - listDragOffsetY) + 'px';

        // Find where to insert placeholder
        const after = getListAfterElement(container, e.clientX);
        if (listDragPlaceholder) {
            if (after == null) {
                container.insertBefore(listDragPlaceholder, container.querySelector('#addListEntry'));
            } else if (after !== listDragPlaceholder) {
                container.insertBefore(listDragPlaceholder, after);
            }
        }
    };

    // Mouse up handler
    const onMouseUp = (e) => {
        if (!draggingListEl) return;

        // Remove drag styles
        draggingListEl.classList.remove('dragging');
        draggingListEl.style.position = '';
        draggingListEl.style.left = '';
        draggingListEl.style.top = '';
        draggingListEl.style.zIndex = '';
        draggingListEl.style.pointerEvents = '';

        // Insert element where placeholder is
        if (listDragPlaceholder && listDragPlaceholder.parentNode) {
            container.insertBefore(draggingListEl, listDragPlaceholder);
            listDragPlaceholder.remove();
        }

        // Save order
        saveListOrder();

        // Cleanup
        draggingListEl = null;
        listDragPlaceholder = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };

    // Make list header draggable via mouse
    container.querySelectorAll('.list:not(.add-list)').forEach(listEl => {
        const header = listEl.querySelector('.list-header');
        if (!header) return;

        // Disable native drag
        listEl.setAttribute('draggable', 'false');
        header.setAttribute('draggable', 'false');

        header.addEventListener('mousedown', (e) => {
            // Ignore if clicking on buttons, inputs, or actions, or list title (for inline rename)
            if (e.target.closest('button, input, textarea, select, .list-actions, .list-menu, .list-archive, .list-title, .list-title-input')) return;
            if (e.button !== 0) return; // Only left click

            e.preventDefault();

            const rect = listEl.getBoundingClientRect();
            listDragOffsetX = e.clientX - rect.left;
            listDragOffsetY = e.clientY - rect.top;

            // Create placeholder
            listDragPlaceholder = document.createElement('div');
            listDragPlaceholder.className = 'list list-drag-placeholder';
            listDragPlaceholder.style.width = rect.width + 'px';
            listDragPlaceholder.style.height = rect.height + 'px';
            listEl.parentNode.insertBefore(listDragPlaceholder, listEl);

            // Style dragging element
            draggingListEl = listEl;
            listEl.classList.add('dragging');
            listEl.style.position = 'fixed';
            listEl.style.left = rect.left + 'px';
            listEl.style.top = rect.top + 'px';
            listEl.style.width = rect.width + 'px';
            listEl.style.zIndex = '1000';
            listEl.style.pointerEvents = 'none';

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });
    });
}
// ===== End Lists drag =====

// 新增：重命名看板（项目看板页）
function promptRenameBoard(oldName) {
    try { hideBoardSwitcher(); } catch (e) {}
    return renameBoardRequest(currentProjectId, oldName, false);
}

// 新增：重命名看板（首页快捷看板）
function promptRenameBoardFromHome(projectId, oldName) {
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
            if (isHome) {
                // Inline update on homepage to avoid flicker
                try {
                    // Update Quick Access boards
                    document.querySelectorAll('#quickAccessBoards .star-btn').forEach(btn => {
                        const pid = btn.getAttribute('data-project-id');
                        const bname = btn.getAttribute('data-board-name');
                        if (String(pid) === String(projectId) && bname === oldName) {
                            btn.setAttribute('data-board-name', newName);
                            const card = btn.closest('.quick-board-card');
                            if (card) {
                                const titleEl = card.querySelector('h4');
                                if (titleEl) titleEl.textContent = newName;
                                // rebind card click to use new board name
                                card.onclick = () => {
                                    currentProjectId = projectId;
                                    const projEl = card.querySelector('.board-project');
                                    currentProjectName = projEl ? projEl.textContent : currentProjectName;
                                    currentBoardName = newName;
                                    previousPage = 'project';
                                    showBoard();
                                };
                                // update action buttons
                                const renameBtn = card.querySelector('.rename-btn');
                                if (renameBtn) renameBtn.setAttribute('onclick', "event.stopPropagation(); promptRenameBoardFromHome('" + projectId + "', '" + escapeJs(newName) + "')");
                                const delBtn = card.querySelector('.delete-btn');
                                if (delBtn) delBtn.setAttribute('onclick', "event.stopPropagation(); deleteBoardFromHome('" + escapeJs(newName) + "', '" + projectId + "')");
                            }
                        }
                    });
                } catch (e) {}
            } else {
                if (!boardSelectPage.classList.contains('hidden')) {
                    // Update the single renamed card inline to avoid flicker
                    try {
                        const cards = document.querySelectorAll('#boardList .quick-board-card');
                        cards.forEach(c => {
                            const titleEl = c.querySelector('h4');
                            const projEl = c.querySelector('.board-project');
                            if (titleEl && titleEl.textContent === oldName) {
                                titleEl.textContent = newName;
                                if (projEl) projEl.textContent = currentProjectName || projEl.textContent;
                                // update card click to open the renamed board
                                c.onclick = () => selectBoard(newName);
                                // also update star and action buttons to use new name
                                const starBtn = c.querySelector('.star-btn');
                                if (starBtn) {
                                    starBtn.setAttribute('data-board-name', newName);
                                    starBtn.onclick = function(ev){ ev.stopPropagation(); toggleBoardStarFromHome(String(currentProjectId), newName, String(currentProjectName), this); };
                                }
                                const renameBtn = c.querySelector('.rename-btn');
                                if (renameBtn) { renameBtn.onclick = function(ev){ ev.stopPropagation(); promptRenameBoard(newName); }; }
                                const delBtn = c.querySelector('.delete-btn');
                                if (delBtn) { delBtn.onclick = function(ev){ ev.stopPropagation(); deleteBoard(newName); }; }
                            }
                        });
                    } catch (e) {}
                }
            }
            // 更新缓存
            try {
                if (Array.isArray(projectBoardsCache[projectId])) {
                    const idx = projectBoardsCache[projectId].indexOf(oldName);
                    if (idx !== -1) {
                        projectBoardsCache[projectId][idx] = newName;
                    }
                }
            } catch(e) {}
            updateStarsOnBoardRenamed(projectId, oldName, newName);
            if (projectId === currentProjectId && currentBoardName === oldName) {
                currentBoardName = newName;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                updateBoardHeader();
                // Defer reconnect and data reload to WS 'board-renamed' to avoid duplicate refreshes
            }
            // Ensure all pages reflect the new name for future operations
            try { updateBoardNameInDom(projectId, oldName, newName); } catch(e) {}
            // 刷新项目看板列表页以确保显示正确
            try { if (!boardSelectPage.classList.contains('hidden')) loadProjectBoards(); } catch(e) {}
            try { renderStarredBoards(); } catch(e) {}
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

// Direct rename without prompt (used by breadcrumb inline input)
async function renameBoardDirect(projectId, oldName, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed || trimmed === oldName) return { success: false };
    try {
        const response = await fetch('/api/rename-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, oldName, newName: trimmed, actor: currentUser })
        });
        const result = await response.json().catch(()=>({}));
        if (response.ok) {
            if (projectId === currentProjectId && currentBoardName === oldName) {
                currentBoardName = trimmed;
                localStorage.setItem('kanbanCurrentBoardName', currentBoardName);
                updateBoardHeader();
            }
            // Update cached board lists to prevent stale entries causing errors
            try {
                if (Array.isArray(projectBoardsCache[projectId])) {
                    const arr = projectBoardsCache[projectId];
                    const idx = arr.indexOf(oldName);
                    if (idx !== -1) { arr[idx] = trimmed; }
                }
            } catch(e){}
            // Update owners map
            try {
                if (window.currentBoardOwners && window.currentBoardOwners[oldName]) {
                    window.currentBoardOwners[trimmed] = window.currentBoardOwners[oldName];
                    delete window.currentBoardOwners[oldName];
                }
            } catch(e){}
            try { updateBoardNameInDom(projectId, oldName, trimmed); } catch(e){}
            try { updateStarsOnBoardRenamed(projectId, oldName, trimmed); } catch(e){}
            try { if (!boardSelectPage.classList.contains('hidden')) loadProjectBoards(); } catch(e){}
            try { renderStarredBoards(); } catch(e){}
            // Re-join renamed board without waiting WS, to avoid transient not found
            try {
                if (socket && socket.readyState === WebSocket.OPEN && projectId === currentProjectId) {
                    socket.send(JSON.stringify({ type:'join', user: currentUser, projectId: currentProjectId, boardName: currentBoardName }));
                }
            } catch(e){}
            uiToast('重命名成功','success');
            return { success: true, newName: trimmed };
        } else {
            uiToast(result.message || '重命名失败','error');
            return { success: false };
        }
    } catch (e) {
        uiToast('重命名失败','error');
        return { success: false };
    }
}

// Helper: keep homepage and board-select handlers in sync after a board rename
function updateBoardNameInDom(projectId, oldName, newName){
    try {
        // Homepage quick access boards
        document.querySelectorAll('#quickAccessBoards .quick-board-card').forEach(card => {
            const starBtn = card.querySelector('.star-btn');
            if (!starBtn) return;
            const pid = starBtn.getAttribute('data-project-id');
            const bname = starBtn.getAttribute('data-board-name');
            if (String(pid) !== String(projectId) || bname !== oldName) return;
            // Update title
            const titleEl = card.querySelector('h4');
            if (titleEl) titleEl.textContent = newName;
            // Update dataset and handlers
            starBtn.setAttribute('data-board-name', newName);
            card.onclick = () => {
                currentProjectId = projectId;
                const projEl = card.querySelector('.board-project');
                currentProjectName = projEl ? projEl.textContent : currentProjectName;
                currentBoardName = newName;
                previousPage = 'project';
                showBoard();
            };
            const renameBtn = card.querySelector('.rename-btn');
            if (renameBtn) renameBtn.setAttribute('onclick', `event.stopPropagation(); promptRenameBoardFromHome('${projectId}', '${escapeJs(newName)}')`);
            const delBtn = card.querySelector('.delete-btn');
            if (delBtn) delBtn.setAttribute('onclick', `event.stopPropagation(); deleteBoardFromHome('${escapeJs(newName)}', '${projectId}')`);
        });
    } catch(e) {}
    try {
        // Project board-select list
        document.querySelectorAll('#boardList .quick-board-card').forEach(card => {
            const starBtn = card.querySelector('.star-btn');
            const pid = starBtn ? starBtn.getAttribute('data-project-id') : String(currentProjectId || '');
            const titleEl = card.querySelector('h4');
            if (!titleEl) return;
            if (String(pid) !== String(projectId) || titleEl.textContent !== oldName) return;
            titleEl.textContent = newName;
            card.onclick = () => selectBoard(newName);
            const sbtn = card.querySelector('.star-btn');
            if (sbtn) sbtn.setAttribute('data-board-name', newName);
            const rbtn = card.querySelector('.rename-btn');
            if (rbtn) rbtn.setAttribute('onclick', `event.stopPropagation(); promptRenameBoard('${escapeJs(newName)}')`);
            const dbtn = card.querySelector('.delete-btn');
            if (dbtn) dbtn.setAttribute('onclick', `event.stopPropagation(); deleteBoard('${escapeJs(newName)}')`);
        });
    } catch(e) {}
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
            body: JSON.stringify({ projectId, newName, actor: currentUser })
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
                // Inline updates on homepage instead of full reload to avoid flicker
                try {
                    // Update project cards in projectsList
                    const projectsList = document.getElementById('projectsList');
                    if (projectsList) {
                        projectsList.querySelectorAll('.project-card').forEach(card => {
                            const renameBtn = card.querySelector('.project-card-actions .rename-btn');
                            const delBtn = card.querySelector('.project-card-actions .delete-btn');
                            const on1 = renameBtn ? (renameBtn.getAttribute('onclick') || '') : '';
                            const on2 = delBtn ? (delBtn.getAttribute('onclick') || '') : '';
                            if (on1.includes("'" + projectId + "'") || on2.includes("'" + projectId + "'")) {
                                const h3 = card.querySelector('h3');
                                if (h3) {
                                    const wasPinned = !!card.querySelector('h3 .pin-wrap.pinned');
                                    h3.innerHTML = `${pinIconMarkup('project', wasPinned)}${escapeHtml(newName)}`;
                                    try { renderIconsInDom(card); } catch(_){}
                                    try { setupProjectCardPinToggle(card, projectId, wasPinned); } catch(_){}
                                }
                                if (renameBtn) renameBtn.setAttribute('onclick', `event.stopPropagation(); renameProjectFromHome('${projectId}', '${escapeJs(newName)}')`);
                                card.onclick = () => selectProject(projectId, newName);
                            }
                        });
                    }
                    // Update quick access board cards' project label and click handler
                    document.querySelectorAll(`#quickAccessBoards .star-btn[data-project-id="${projectId}"]`).forEach(btn => {
                        const card = btn.closest('.quick-board-card');
                        if (card) {
                            const projEl = card.querySelector('.board-project');
                            if (projEl) projEl.textContent = newName;
                            card.onclick = () => {
                                currentProjectId = projectId;
                                currentProjectName = newName;
                                const titleEl = card.querySelector('h4');
                                currentBoardName = titleEl ? titleEl.textContent : currentBoardName;
                                previousPage = 'project';
                                showBoard();
                            };
                        }
                    });
                } catch (e) {}
                updateStarsOnProjectRenamed(projectId, newName);
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

// 置前项目（首页项目卡片按钮）
// Legacy pin-to-front helpers removed (superseded by pin groups UI)

// === Starred boards independent pin order ===
async function pinStarBoardToFront(projectId, boardName){
    if (!currentUser || !projectId || !boardName) return;
    try {
        const resp = await fetch('/api/user-star-pins/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, projectId, boardName })
        });
        const result = await resp.json().catch(()=>({}));
        if (resp.ok) {
            try { renderStarredBoards(); } catch(e){}
            uiToast('已置前','success');
        } else {
            uiToast(result.message || '置前失败','error');
        }
    } catch(e) {
        uiToast('置前失败','error');
    }
}

// === Pin Group helpers (toggle + reorder) ===
function setupProjectCardPinToggle(card, projectId, initiallyPinned){
    try {
        const wrap = card.querySelector('h3 .pin-wrap');
        if (!wrap) return;
        let isPinned = !!initiallyPinned;
        const base = wrap.querySelector('.icon-base');
        const hover = wrap.querySelector('.icon-hover');
        const apply = () => {
            wrap.classList.toggle('pinned', isPinned);
            if (base) base.setAttribute('data-icon', isPinned ? 'pin' : 'folder');
            if (hover) hover.setAttribute('data-icon', isPinned ? 'pin-off' : 'pin');
            try { renderIconsInDom(wrap); } catch(_){}
        };
        apply();
        const stop = (e)=>{ try{e.stopPropagation();}catch(_){} try{e.preventDefault();}catch(_){} };
        const activate = async (e)=>{
            stop(e);
            try {
                const resp = await fetch('/api/toggle-pin-project', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ username: currentUser, projectId, pinned: !isPinned })
                });
                const rj = await resp.json().catch(()=>({}));
                if (resp.ok){
                    isPinned = !isPinned;
                    apply();
                    try { await loadUserProjects(); } catch(_){ }
                    uiToast(isPinned ? '已置顶' : '已取消置顶','success');
                } else { uiToast(rj.message || '操作失败','error'); }
            } catch(_) { uiToast('网络错误','error'); }
        };
        ['mousedown','mouseup','pointerdown','pointerup','touchstart'].forEach(evt => wrap.addEventListener(evt, stop, true));
        wrap.addEventListener('click', activate);
        wrap.setAttribute('tabindex','0'); wrap.setAttribute('role','button');
        wrap.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') activate(e); });
    } catch(_){}
}
// toggleProjectPinned removed (handled by setupProjectCardPinToggle)

async function reorderProjectToEdge(projectId, where){
    if (!currentUser || !projectId || !where) return;
    try {
        const resp = await fetch('/api/reorder-project', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, projectId, where })
        });
        const result = await resp.json().catch(()=>({}));
        if (resp.ok){
            try { await loadUserProjects(); } catch(_){}
            uiToast(where === 'first' ? '已移到最前' : '已移到最后','success');
        } else { uiToast(result.message || '调整失败','error'); }
    } catch(e) { uiToast('网络错误','error'); }
}

// toggleBoardPinned removed (handled by setupBoardCardPinToggle)

async function reorderBoardToEdge(projectId, boardName, where){
    if (!currentUser || !projectId || !boardName || !where) return;
    try {
        const resp = await fetch('/api/reorder-board', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, projectId, boardName, where })
        });
        const result = await resp.json().catch(()=>({}));
        if (resp.ok){
            try { if (!boardSelectPage.classList.contains('hidden')) await loadProjectBoards(); } catch(_){}
            try { if (!projectPage.classList.contains('hidden')) await loadUserProjects(); } catch(_){}
            uiToast(where === 'first' ? '已移到最前' : '已移到最后','success');
        } else { uiToast(result.message || '调整失败','error'); }
    } catch(e) { uiToast('网络错误','error'); }
}

// Insert a new project card right after pinned group
function insertProjectCardAtCorrectPosition(container, card){
    try {
        const seps = container.querySelectorAll('.group-separator');
        if (seps.length >= 2) {
            const afterSep = seps[1].nextSibling;
            if (afterSep) container.insertBefore(card, afterSep); else container.appendChild(card);
            return;
        }
        const pinnedIcons = container.querySelectorAll('.project-card .pin-wrap.pinned');
        if (pinnedIcons.length > 0) {
            const lastPinnedCard = pinnedIcons[pinnedIcons.length - 1].closest('.project-card');
            if (lastPinnedCard && lastPinnedCard.nextSibling) container.insertBefore(card, lastPinnedCard.nextSibling); else container.appendChild(card);
            return;
        }
        container.insertBefore(card, container.firstChild);
    } catch(_) { container.appendChild(card); }
}

// Insert a new board card right after pinned group
function insertBoardCardAtCorrectPosition(container, card){
    try {
        const seps = container.querySelectorAll('.group-separator');
        if (seps.length >= 2) {
            const afterSep = seps[1].nextSibling;
            if (afterSep) container.insertBefore(card, afterSep); else container.appendChild(card);
            return;
        }
        const pinnedIcons = container.querySelectorAll('.quick-board-card .pin-wrap.pinned');
        if (pinnedIcons.length > 0) {
            const lastPinnedCard = pinnedIcons[pinnedIcons.length - 1].closest('.quick-board-card');
            if (lastPinnedCard && lastPinnedCard.nextSibling) container.insertBefore(card, lastPinnedCard.nextSibling); else container.appendChild(card);
            return;
        }
        container.insertBefore(card, container.firstChild);
    } catch(_) { container.appendChild(card); }
}

function setupBoardCardPinToggle(card, projectId, boardName, initiallyPinned){
    try {
        const wrap = card.querySelector('h4 .pin-wrap');
        if (!wrap) return;
        let isPinned = !!initiallyPinned;
        const base = wrap.querySelector('.icon-base');
        const hover = wrap.querySelector('.icon-hover');
        const apply = () => {
            wrap.classList.toggle('pinned', isPinned);
            if (base) base.setAttribute('data-icon', isPinned ? 'pin' : 'boards');
            if (hover) hover.setAttribute('data-icon', isPinned ? 'pin-off' : 'pin');
            try { renderIconsInDom(wrap); } catch(_){}
        };
        apply();
        const stop = (e)=>{ try{e.stopPropagation();}catch(_){} try{e.preventDefault();}catch(_){} };
        const activate = async (e)=>{
            stop(e);
            try {
                const resp = await fetch('/api/toggle-pin-board', {
                    method:'POST', headers:{'Content-Type':'application/json'},
                    body: JSON.stringify({ username: currentUser, projectId, boardName, pinned: !isPinned })
                });
                const rj = await resp.json().catch(()=>({}));
                if (resp.ok){
                    isPinned = !isPinned;
                    apply();
                    try { await loadProjectBoards(); } catch(_){ }
                    uiToast(isPinned ? '已置顶' : '已取消置顶','success');
                } else { uiToast(rj.message || '操作失败','error'); }
            } catch(_) { uiToast('网络错误','error'); }
        };
        ['mousedown','mouseup','pointerdown','pointerup','touchstart'].forEach(evt => wrap.addEventListener(evt, stop, true));
        wrap.addEventListener('click', activate);
        wrap.setAttribute('tabindex','0'); wrap.setAttribute('role','button');
        wrap.addEventListener('keydown', (e)=>{ if (e.key==='Enter' || e.key===' ') activate(e); });
    } catch(_){}
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
                const deletedProjectId = currentProjectId;
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
                try { purgeStarsForProject(deletedProjectId); } catch(e) {}
                try { renderStarredBoards(); } catch(e) {}
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
                try { purgeStarsForProject(projectId); } catch(e) {}
                try { renderStarredBoards(); } catch(e) {}
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

    let boards = Array.isArray(projectBoardsCache[currentProjectId])
        ? projectBoardsCache[currentProjectId].slice()
        : null;
    let menuShown = false;
    if (boards && boards.length) {
        showBoardSwitcherAt(rect, boards);
        menuShown = true;
    }
    try {
        const resp = await fetch(`/api/project-boards/${currentProjectId}`);
        const data = await resp.json();
        const freshBoards = getActiveBoardsFromProjectData(data);
        projectBoardsCache[currentProjectId] = freshBoards;
        if (boardSwitcherOpen && boardSwitcherMenu && boardSwitcherMenu._updateBoards) {
            boardSwitcherMenu._updateBoards(freshBoards);
        } else if (!menuShown) {
            showBoardSwitcherAt(rect, freshBoards);
            menuShown = true;
        }
    } catch (err) {
        if (!menuShown) {
            showBoardSwitcherAt(rect, boards || []);
        }
    }
    const titleEl = document.getElementById('currentBoardName');
    if (titleEl) titleEl.classList.add('open');
    const caretEl = document.getElementById('boardCaret');
    if (caretEl) caretEl.classList.add('open');
}

function getActiveBoardsFromProjectData(data) {
    let boards = Array.isArray(data && data.boards) ? data.boards.slice() : [];
    const archived = Array.isArray(data && data.archivedBoards) ? data.archivedBoards : [];
    if (archived && archived.length) {
        const set = new Set(archived);
        boards = boards.filter(n => !set.has(n));
    }
    return boards;
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
    search.placeholder = '搜索或创建看板...';
    const createBtn = document.createElement('button');
    createBtn.type = 'button';
    createBtn.className = 'board-switcher-create';
    createBtn.textContent = '创建新看板';
    createBtn.disabled = true;
    const updateCreateBtn = () => { createBtn.disabled = !((search.value||'').trim()); };
    createBtn.onclick = async (ev) => {
        ev.stopPropagation();
        const name = (search.value || '').trim();
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
                    // exclude archived boards from switcher
                    const archived = Array.isArray(data.archivedBoards) ? data.archivedBoards : [];
                    if (archived && archived.length) {
                        const set = new Set(archived);
                        boards = boards.filter(n => !set.has(n));
                    }
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

    search.addEventListener('input', () => { renderList(search.value); updateCreateBtn(); });
    updateCreateBtn();

    menu.appendChild(list);
    document.body.appendChild(menu);
    menu._updateBoards = (nextBoards) => {
        boards = Array.isArray(nextBoards) ? nextBoards : [];
        renderList(search.value);
    };
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
    const caretEl = document.getElementById('boardCaret');
    if (caretEl) caretEl.classList.remove('open');
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
        ok.onclick = () => { try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; document.body.removeChild(overlay); resolve(); };
        close.onclick = ok.onclick;
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => ok.focus(), 0);
        overlay.addEventListener('keydown', (e) => {
            const composing = e.isComposing || e.keyCode === 229;
            if (!composing && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){} }
            if (!composing && (e.key === 'Escape' || e.key === 'Enter')) { try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; ok.click(); }
        }, true);
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
        ok.onclick = () => { try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; document.body.removeChild(overlay); resolve(true); };
        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => ok.focus(), 0);
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); }
            if (e.key === 'Escape') cancel.click();
            if (e.key === 'Enter') { try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; ok.click(); }
        }, true);
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
        ok.onclick = () => { const v = (input.value || '').trim(); if (!v) return; try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; document.body.removeChild(overlay); resolve(v); };
        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => { input.focus(); input.select(); }, 0);
        // Ensure single-press Esc/Enter works even when focus is on the input
        input.addEventListener('keydown', (e) => {
            const composing = e.isComposing || e.keyCode === 229;
            if (composing) return;
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}; cancel.click(); }
            if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}; try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; ok.click(); }
        }, true);
        overlay.addEventListener('keydown', (e) => {
            const composing = e.isComposing || e.keyCode === 229;
            if (!composing && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); try { e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){} }
            if (!composing && e.key === 'Escape') cancel.click();
            if (!composing && e.key === 'Enter') { try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}; ok.click(); }
        }, true);
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

function uiToastAction(message, actionLabel, onAction, type, timeoutMs){
    const container = ensureToastContainer();
    const t = document.createElement('div');
    t.className = 'toast toast-action ' + (type ? 'toast-' + type : '');
    const msg = document.createElement('div');
    msg.className = 'toast-message';
    msg.textContent = message;
    const btn = document.createElement('button');
    btn.className = 'toast-action-btn';
    btn.type = 'button';
    btn.textContent = actionLabel || '撤销';
    let closed = false;
    let timer = null;
    const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        t.classList.remove('show');
        t.addEventListener('transitionend', () => t.remove(), { once: true });
    };
    btn.onclick = () => { if (typeof onAction === 'function') onAction(); close(); };
    t.appendChild(msg);
    t.appendChild(btn);
    container.appendChild(t);
    setTimeout(() => { t.classList.add('show'); }, 10);
    const delay = typeof timeoutMs === 'number' ? timeoutMs : 5000;
    timer = setTimeout(close, delay);
}

// 删除归档卡片
async function deleteArchivedCard(cardId){
    const ok = await uiConfirm('确定要删除该归档任务吗？此操作不可恢复。','删除任务');
    if (!ok) return;
    registerDeleteCardUndo(cardId);
    performDeleteCardById(cardId);
}

// 归档整列（卡组）
async function archiveList(status, options){
    const opts = options || {};
    const cards = (boardData[status]||[]);
    if (!cards.length) { uiToast('此卡组没有可归档的卡片','info'); return; }
    if (!opts.skipConfirm) {
        const ok = await uiConfirm('将该卡组的所有卡片归档？','归档卡组');
        if (!ok) return;
    }
    const cardIds = cards.map(c => c && c.id).filter(Boolean);
    if (!opts.skipUndo && !undoRedoInProgress && cardIds.length) {
        pushUndoAction({
            type: 'archive-list',
            label: '归档卡组',
            createdAt: Date.now(),
            undo: () => {
                cardIds.forEach(id => restoreCard(id, { skipUndo: true, skipRender: true }));
                renderBoard();
                if (!archivePage.classList.contains('hidden')) {
                    renderArchive();
                }
            },
            redo: () => {
                cardIds.forEach(id => archiveCard(id, status, { skipUndo: true, skipRender: true }));
                renderBoard();
            }
        });
    }
    boardData.archived = boardData.archived || [];
    // copy array to avoid mutation during iteration
    const moving = cards.slice();
    moving.forEach(c => {
        if (!c) return;
        c.archivedFrom = status;
        c.archivedAt = Date.now();
    });
    boardData.archived.push(...moving);
    boardData[status] = [];
    sendArchiveList(status);
    if (!opts.skipRender) {
        renderBoard();
    }
    if (!opts.skipToast) {
        uiToast('已归档该卡组全部卡片','success');
    }
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
        const authorName = p.author ? getDisplayNameForUser(p.author) : '';
        meta.textContent = `${authorName} · ${new Date(p.created||Date.now()).toLocaleString()}`;
        actions.appendChild(meta);
        const btns = document.createElement('div');
        btns.className = 'post-actions-buttons';
                 if ((p.author || '') === (currentUser || '')) {
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
    const listWidth = 272; // var(--list-width)
    const gap = 12; // var(--list-gap)
    const addListBias = (boardDragScrollEnabled && n > 0) ? (listWidth + gap) : 0;
    const calcPanSlack = (viewportWidth, targetWidth, basePad) => {
        if (!boardDragScrollEnabled) return 0;
        const needed = Math.max(0, Math.floor((viewportWidth - targetWidth) / 2));
        if (typeof basePad === 'number') {
            return Math.max(0, needed - basePad);
        }
        return needed;
    };
    // When there are no lists, center the add-list entry horizontally
    if (n === 0) {
        const add = document.getElementById('addListEntry');
        // fallback width if measurement fails
        let addWidth = 272;
        try {
            if (add) {
                const rect = add.getBoundingClientRect();
                if (rect && rect.width) addWidth = rect.width;
            }
        } catch(_){}
        const viewportWidth = container.clientWidth || 0;
        const centerPad = Math.max(0, Math.floor((viewportWidth - addWidth) / 2));
        const panSlack = calcPanSlack(viewportWidth, addWidth, centerPad);
        const pad = centerPad + panSlack;
        container.style.paddingLeft = `${pad}px`;
        container.style.paddingRight = `${pad}px`;
        primeBoardPan(container, panSlack, 0);
        return;
    }

    const totalWidth = n * listWidth + (n - 1) * gap;

    const viewportWidth = container.clientWidth;
    let panSlack = 0;
    if (totalWidth <= viewportWidth) {
        const centerPad = Math.max(0, (viewportWidth - totalWidth) / 2);
        panSlack = calcPanSlack(viewportWidth, listWidth, centerPad);
        const leftPad = centerPad + panSlack + addListBias;
        const rightPad = centerPad + panSlack;
        container.style.paddingLeft = `${leftPad}px`;
        container.style.paddingRight = `${rightPad}px`;
    } else {
        panSlack = calcPanSlack(viewportWidth, listWidth);
        const leftPad = panSlack + addListBias;
        const rightPad = panSlack;
        container.style.paddingLeft = leftPad ? `${leftPad}px` : '';
        container.style.paddingRight = rightPad ? `${rightPad}px` : '';
    }
    primeBoardPan(container, panSlack, addListBias);
}

function primeBoardPan(container, panSlack, leftBias){
    if (!container || !boardDragScrollEnabled) return;
    const offset = Math.max(0, (panSlack || 0) + (leftBias || 0));
    const key = getCurrentBoardKey();
    if (container.dataset.boardPanKey !== key) {
        container.dataset.boardPanKey = key;
        container.dataset.boardPanOffset = '';
    }
    if (container.dataset.boardPanOffset === String(offset)) return;
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth);
    const desired = Math.min(offset, maxScroll);
    container.scrollLeft = desired;
    container.dataset.boardPanOffset = String(offset);
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
        const displayName = getDisplayNameForUser(u);
        // 只有所有者能移除他人；非所有者只能移除自己
        let right = '';
        if (isOwnerUser) {
            right = '<span style="font-size:12px;color:#6b7280">所有者</span>';
        } else if (isOwner || u === currentUser) {
            right = `<button class="btn-secondary" data-remove="${escapeHtml(u)}">移除</button>`;
        } else {
            right = '';
        }
        return `<div class=\"card-info\" style=\"margin-bottom:8px; display:flex; align-items:center; justify-content:space-between\"><span title="${escapeHtml(u)}">${escapeHtml(displayName)}</span><span>${right}</span></div>`;
    }).join('');
    wrap.querySelectorAll('button[data-remove]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const username = e.currentTarget.getAttribute('data-remove');
            if (!username) return;
            const label = getDisplayNameForUser(username);
            const ok = await uiConfirm(`确定移除成员 "${label}" 吗？`, '移除成员');
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
                        const exitingProjectId = currentProjectId;
                        try { if (socket) socket.close(); } catch (e2) {}
                        currentProjectId = null;
                        currentProjectName = null;
                        currentBoardName = null;
                        localStorage.removeItem('kanbanCurrentProjectId');
                        localStorage.removeItem('kanbanCurrentProjectName');
                        localStorage.removeItem('kanbanCurrentBoardName');
                        showProjectPage();
                        loadUserProjects();
                        try { purgeStarsForProject(exitingProjectId); } catch(e) {}
                        try { renderStarredBoards(); } catch(e) {}
                        uiToast('已退出项目','success');
                        return;
                    }
                    window.currentProjectMembers = result.members || [];
                    renderMembersList();
                    document.getElementById('projectMembers').textContent = formatUserList(window.currentProjectMembers || []);
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
                const label = getDisplayNameForUser(r.username);
                return `<div class=\"card-info\" style=\"margin:6px 0; display:flex; align-items:center; justify-content:space-between\"><span title="${escapeHtml(r.username)}">${escapeHtml(label)} <small style=\"color:#6b7280\">申请加入</small></span><span>${actions}</span></div>`;
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
            document.getElementById('projectMembers').textContent = formatUserList(window.currentProjectMembers || []);
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
            mergeUserDisplayNames(data.userDisplayNames);
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
                    const inviter = getDisplayNameForUser(i.invitedBy);
                    const info = `加入「${escapeHtml(i.projectName)}」 · 邀请人：<span title="${escapeHtml(i.invitedBy || '')}">${escapeHtml(inviter)}</span>`;
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
                mergeUserDisplayNames(approvalsData.userDisplayNames);
                // 叠加审批数到徽标
                if (badge) {
                    const total = invites.length + approvals.length;
                    if (total > 0) { badge.style.display = ''; badge.textContent = String(total); }
                    else { badge.style.display = 'none'; badge.textContent = '0'; }
                }
                html += `<h4 style=\"margin:12px 0 8px\">待我处理的加入申请</h4>`;
                if (approvals.length) {
                    html += approvals.map(a => {
                        const label = getDisplayNameForUser(a.username);
                        const text = `<span title="${escapeHtml(a.username)}">${escapeHtml(label)}</span> 申请加入「${escapeHtml(a.projectName)}」`;
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
                            if (resp.ok) { uiToast(`已同意 ${getDisplayNameForUser(uname)} 加入「${pname}」`,'success'); loadUserInvites(); loadUserProjects(); }
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
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); joinBtn.click(); }
                    if (e.key === 'Escape') { e.preventDefault(); closeInvitesModal(); }
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
    // Refresh immediately on open
    try { loadUserInvites(); } catch (e) {}
    // Start lightweight polling while modal remains open
    if (invitesRefreshTimer) { try { clearInterval(invitesRefreshTimer); } catch (e) {} }
    invitesRefreshTimer = setInterval(() => {
        const m = document.getElementById('invitesModal');
        if (!m || m.classList.contains('hidden')) {
            try { clearInterval(invitesRefreshTimer); } catch (e) {}
            invitesRefreshTimer = null;
            return;
        }
        try { loadUserInvites(); } catch (e) {}
    }, 3000);
    modal.classList.remove('hidden');
}

function closeInvitesModal() {
    const modal = document.getElementById('invitesModal');
    if (!modal) return;
    modal.classList.add('hidden');
    // Stop polling when modal closed
    if (invitesRefreshTimer) {
        try { clearInterval(invitesRefreshTimer); } catch (e) {}
        invitesRefreshTimer = null;
    }
}

async function acceptInvite(projectId, projectName) {
    try {
        const resp2 = await fetch('/api/accept-invite', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username: currentUser, projectId }) });
        const result = await resp2.json();
        if (resp2.ok) {
            const pname = projectName || '项目';
            uiToast(`已接受邀请，已加入「${pname}」`,'success');
            loadUserInvites();

            const projectsList = document.getElementById('projectsList');
            const quickAccessBoards = document.getElementById('quickAccessBoards');
            if (projectsList && projectsList.firstElementChild && projectsList.firstElementChild.classList.contains('empty-state')) {
                projectsList.innerHTML = '';
            }
            if (quickAccessBoards && quickAccessBoards.firstElementChild && quickAccessBoards.firstElementChild.classList.contains('empty-state')) {
                quickAccessBoards.innerHTML = '';
            }

            let boardsData = { boards: [], owner: '', inviteCode: '' };
            try {
                const resp3 = await fetch(`/api/project-boards/${projectId}`);
                boardsData = await resp3.json();
                mergeUserDisplayNames(boardsData.userDisplayNames);
            } catch (e) {}

            const newProject = {
                id: projectId,
                name: pname,
                inviteCode: boardsData.inviteCode || '',
                memberCount: Array.isArray(result.members) ? result.members.length : 1,
                boardCount: Array.isArray(boardsData.boards) ? boardsData.boards.length : 0,
                created: new Date().toISOString(),
                owner: boardsData.owner || ''
            };

            const projectCard = document.createElement('div');
            projectCard.className = 'project-card project-card-with-actions';
            projectCard.onclick = () => selectProject(newProject.id, newProject.name);
            const ownerLabel = getDisplayNameForUser(newProject.owner || '');
            projectCard.innerHTML = `
                <h3>${pinIconMarkup('project', false)}${escapeHtml(newProject.name)}</h3>
                <div class="project-info">
                    邀请码: <span class="invite-code">${newProject.inviteCode}</span> <button class="btn-secondary" onclick="event.stopPropagation(); copyCode('${escapeJs(newProject.inviteCode)}')">复制</button><br>
                    成员: ${newProject.memberCount}人<br>
                    看板: ${newProject.boardCount}个<br>
                    创建于: ${new Date(newProject.created).toLocaleDateString()}
                </div>
                <div class="project-card-actions">
                    <button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${newProject.id}', 'first')" title="移到最前">⇧</button>
                    <button class="project-action-btn" onclick="event.stopPropagation(); reorderProjectToEdge('${newProject.id}', 'last')" title="移到最后">⇩</button>
                    <button class="project-action-btn rename-btn" onclick="event.stopPropagation(); renameProjectFromHome('${newProject.id}', '${escapeJs(newProject.name)}')" title="重命名项目">✎</button>
                    <button class="project-action-btn delete-btn" onclick="event.stopPropagation(); deleteProjectFromHome('${newProject.id}', '${escapeJs(newProject.name)}')" title="删除项目">✕</button>
                </div>
                <div class="card-owner" title="${escapeHtml(newProject.owner || '')}">所有者：${escapeHtml(ownerLabel)}</div>
            `;
            // setup hover-to-pin icon
            setupProjectCardPinToggle(projectCard, newProject.id, false);

            if (projectsList) {
                insertProjectCardAtCorrectPosition(projectsList, projectCard);
                renderIconsInDom(projectCard);
            }
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
let invitesRefreshTimer = null;

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

// 修改显示名流程（需要密码）
async function changeDisplayNameFlow() {
    if (!currentUser) return;
    try {
        const data = await openDisplayNameDialog(currentUserDisplayName || currentUser);
        if (!data) return;
        const trimmed = (data.displayName || '').trim();
        if (!trimmed) { uiToast('请输入显示名','error'); return; }
        if (trimmed === currentUserDisplayName) { uiToast('显示名未变化','error'); return; }
        const rs = await fetch('/api/change-display-name', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, password: data.password, displayName: trimmed })
        });
        const rj = await rs.json().catch(()=>({}));
        if (rs.ok) {
            const nextName = rj.displayName || trimmed;
            setCurrentUserDisplayName(nextName);
            const nameEl = document.getElementById('currentUserName');
            if (nameEl) nameEl.textContent = getDisplayNameForUser(currentUser);
            const membersEl = document.getElementById('projectMembers');
            if (membersEl && window.currentProjectMembers) {
                membersEl.textContent = formatUserList(window.currentProjectMembers);
            }
            updateAssigneeOptions();
            try { renderMembersList(); } catch(_) {}
            try { if (window.currentOnlineUsers) updateOnlineUsers(window.currentOnlineUsers); } catch(_) {}
            try { loadUserProjects(); } catch(e) {}
            try { if (boardPage && !boardPage.classList.contains('hidden')) renderBoard(); } catch(_) {}
            uiToast('显示名已更新','success');
        } else {
            uiToast(rj.message || '修改失败','error');
        }
    } catch(e) {
        uiToast('网络错误，请稍后再试','error');
    }
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

// 单次对话框：修改显示名（显示名 + 当前密码）
function openDisplayNameDialog(currentName) {
    return new Promise((resolve) => {
        const { overlay, body, footer, close } = createBaseModal('修改显示名');

        function makeRow(labelText, type = 'text') {
            const wrap = document.createElement('div');
            const label = document.createElement('div');
            label.textContent = labelText;
            label.style.marginTop = '6px';
            const input = document.createElement('input');
            input.type = type;
            input.setAttribute('autocapitalize','off');
            input.setAttribute('autocorrect','off');
            input.setAttribute('spellcheck','false');
            input.style.width = '100%';
            input.style.height = '36px';
            input.style.border = '1px solid #e5e7eb';
            input.style.borderRadius = '6px';
            input.style.padding = '0 10px';
            input.style.marginTop = '6px';
            wrap.appendChild(label);
            wrap.appendChild(input);
            return { wrap, input };
        }

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

        const nameRow = makeRow('显示名', 'text');
        nameRow.input.value = currentName || '';
        nameRow.input.autocomplete = 'off';
        body.appendChild(nameRow.wrap);

        const passRow = makeRow('当前密码', 'password');
        passRow.input.autocomplete = 'off';
        passRow.input.readOnly = true;
        const unlock = () => { passRow.input.readOnly = false; passRow.input.value = ''; };
        passRow.input.addEventListener('focus', unlock, { once: true });
        passRow.input.addEventListener('mousedown', unlock, { once: true });
        body.appendChild(passRow.wrap);

        const cancel = document.createElement('button');
        cancel.className = 'btn-secondary';
        cancel.textContent = '取消';
        cancel.onclick = () => { document.body.removeChild(overlay); resolve(null); };

        const ok = document.createElement('button');
        ok.className = 'btn-primary';
        ok.textContent = '确定';
        ok.onclick = () => {
            const displayName = (nameRow.input.value || '').trim();
            const password = passRow.input.value || '';
            if (!displayName) { nameRow.input.focus(); return; }
            if (!password) { passRow.input.focus(); return; }
            try { enterComposerSuppressUntil = Date.now() + 600; } catch(_){}
            document.body.removeChild(overlay);
            resolve({ displayName, password });
        };

        close.onclick = cancel.onclick;
        footer.appendChild(cancel);
        footer.appendChild(ok);
        document.body.appendChild(overlay);
        setTimeout(() => { nameRow.input.focus(); nameRow.input.select(); }, 0);

        const bindKeys = (el) => {
            if (!el) return;
            el.addEventListener('keydown', (e) => {
                const composing = e.isComposing || e.keyCode === 229;
                if (composing) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; cancel.click(); }
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; ok.click(); }
            }, true);
        };
        bindKeys(nameRow.input);
        bindKeys(passRow.input);
        overlay.addEventListener('keydown', (e) => {
            const composing = e.isComposing || e.keyCode === 229;
            if (!composing && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){} }
            if (!composing && e.key === 'Escape') cancel.click();
            if (!composing && e.key === 'Enter') ok.click();
        }, true);
    });
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
        const bindInstantKeys = (el) => {
            if (!el) return;
            el.addEventListener('keydown', (e) => {
                const composing = e.isComposing || e.keyCode === 229;
                if (composing) return;
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; cancel.click(); }
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; ok.click(); }
            }, true);
        };
        if (needOld && oldRow && oldRow.input) bindInstantKeys(oldRow.input);
        bindInstantKeys(newRow.input);
        bindInstantKeys(confirmRow.input);
        overlay.addEventListener('keydown', (e) => {
            const composing = e.isComposing || e.keyCode === 229;
            if (!composing && (e.key === 'Escape' || e.key === 'Enter')) { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){} }
            if (!composing && e.key === 'Escape') cancel.click();
            if (!composing && e.key === 'Enter') ok.click();
        }, true);
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

// 绑定模态框事件（已在上文添加了带防误触的版本，这里移除重复）

// 其他模态框键盘处理
if (importModal) {
    importModal.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){} }
        if (e.key === 'Escape') { cancelImport(); }
        if (e.key === 'Enter') { confirmImport(); }
    }, true);
}
const importTextModalEl = document.getElementById('importTextModal');
if (importTextModalEl) {
    importTextModalEl.addEventListener('keydown', (e) => {
        // Esc 关闭
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation();
            try{ e.stopImmediatePropagation(); }catch(_){}
            cancelImportText();
            return;
        }
        // Enter 在 textarea 中应换行，不提交；Ctrl+Enter 提交
        if (e.key === 'Enter') {
            const isTextArea = e.target && e.target.tagName === 'TEXTAREA';
            if (isTextArea && !e.ctrlKey && !e.metaKey) {
                // 允许 textarea 内正常换行
                return;
            }
            // Ctrl+Enter 或非 textarea 中按 Enter 则提交
            e.preventDefault(); e.stopPropagation();
            try{ e.stopImmediatePropagation(); }catch(_){}
            parseImportText();
        }
    }, true);
}
const invitesModalEl = document.getElementById('invitesModal');
if (invitesModalEl) {
    invitesModalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; closeInvitesModal(); }
    }, true);
}
const membersModalEl = document.getElementById('membersModal');
if (membersModalEl) {
    membersModalEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; closeMembersModal(); }
    }, true);
}
const createProjectOverlay = document.getElementById('createProjectForm');
if (createProjectOverlay) {
    createProjectOverlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; hideCreateProjectForm(); }
    }, true);
}
const joinProjectOverlay = document.getElementById('joinProjectForm');
if (joinProjectOverlay) {
    joinProjectOverlay.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; hideJoinProjectForm(); }
    }, true);
}
// ... existing code ...
// 绑定键盘事件
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        // Prefer closing dynamic modals (uiPrompt/uiConfirm/uiAlert/password) first
        const dynamicModals = Array.from(document.querySelectorAll('body > .modal')).filter(m => !m.id && !m.classList.contains('hidden'));
        const top = dynamicModals.length ? dynamicModals[dynamicModals.length - 1] : null;
        if (top) {
            const btn = top.querySelector('.close-btn');
            if (btn) { e.preventDefault(); btn.click(); return; }
        }
        if (!editModal.classList.contains('hidden')) { closeEditModal(); }
        if (!importModal.classList.contains('hidden')) { cancelImport(); }
        const cp = document.getElementById('createProjectForm');
        if (cp && !cp.classList.contains('hidden')) { hideCreateProjectForm(); }
        const jp = document.getElementById('joinProjectForm');
        if (jp && !jp.classList.contains('hidden')) { hideJoinProjectForm(); }
        const iv = document.getElementById('invitesModal');
        if (iv && !iv.classList.contains('hidden')) { closeInvitesModal(); }
        const mm = document.getElementById('membersModal');
        if (mm && !mm.classList.contains('hidden')) { closeMembersModal(); }
    }
});
// 在捕获阶段也拦截一次，确保一次 Esc 生效
document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    // First priority: close add-list if open to ensure single-press Esc behavior
    if (closeAddListEntry(e)) return;
    let handled = false;
    const dynamicModals = Array.from(document.querySelectorAll('body > .modal')).filter(m => !m.id && !m.classList.contains('hidden'));
    const top = dynamicModals.length ? dynamicModals[dynamicModals.length - 1] : null;
    if (top) {
        const btn = top.querySelector('.close-btn');
        if (btn) { btn.click(); handled = true; }
    } else {
        const cp = document.getElementById('createProjectForm');
        if (!handled && cp && !cp.classList.contains('hidden')) { hideCreateProjectForm(); handled = true; }
        const jp = document.getElementById('joinProjectForm');
        if (!handled && jp && !jp.classList.contains('hidden')) { hideJoinProjectForm(); handled = true; }
        const iv = document.getElementById('invitesModal');
        if (!handled && iv && !iv.classList.contains('hidden')) { closeInvitesModal(); handled = true; }
        const mm = document.getElementById('membersModal');
        if (!handled && mm && !mm.classList.contains('hidden')) { closeMembersModal(); handled = true; }
        if (!handled && typeof importModal !== 'undefined' && importModal && !importModal.classList.contains('hidden')) { cancelImport(); handled = true; }
        if (!handled && typeof editModal !== 'undefined' && editModal && !editModal.classList.contains('hidden')) { closeEditModal(); handled = true; }
    }
    if (handled) {
        try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}
    }
}, true);
// 也拦截 keyup，避免某些浏览器在 keyup 再次触发处理
document.addEventListener('keyup', function(e){
    if (e.key !== 'Escape') return;
    if (e.isComposing) return;
    let handled = false;
    const dynamicModals = Array.from(document.querySelectorAll('body > .modal')).filter(m => !m.id && !m.classList.contains('hidden'));
    const top = dynamicModals.length ? dynamicModals[dynamicModals.length - 1] : null;
    if (top) {
        const btn = top.querySelector('.close-btn');
        if (btn) { try { btn.click(); handled = true; } catch(_){} }
    } else {
        const cp = document.getElementById('createProjectForm');
        if (!handled && cp && !cp.classList.contains('hidden')) { try { hideCreateProjectForm(); handled = true; } catch(_){} }
        const jp = document.getElementById('joinProjectForm');
        if (!handled && jp && !jp.classList.contains('hidden')) { try { hideJoinProjectForm(); handled = true; } catch(_){} }
        const iv = document.getElementById('invitesModal');
        if (!handled && iv && !iv.classList.contains('hidden')) { try { closeInvitesModal(); handled = true; } catch(_){} }
        const mm = document.getElementById('membersModal');
        if (!handled && mm && !mm.classList.contains('hidden')) { try { closeMembersModal(); handled = true; } catch(_){} }
        if (!handled && typeof importModal !== 'undefined' && importModal && !importModal.classList.contains('hidden')) { try { cancelImport(); handled = true; } catch(_){} }
        if (!handled && typeof editModal !== 'undefined' && editModal && !editModal.classList.contains('hidden')) { try { closeEditModal(); handled = true; } catch(_){} }
    }
    if (handled) {
        try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}
    }
}, true);

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

// 为创建项目输入框绑定回车/ESC事件
const newProjectNameEl = document.getElementById('newProjectName');
if (newProjectNameEl) {
    newProjectNameEl.addEventListener('keydown', function(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && this.value.trim()) { e.preventDefault(); createProject(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; hideCreateProjectForm(); }
    });
}

// 为加入项目输入框绑定回车/ESC事件
const inviteCodeEl = document.getElementById('inviteCode');
if (inviteCodeEl) {
    inviteCodeEl.addEventListener('keydown', function(e) {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && this.value.trim()) { e.preventDefault(); joinProject(); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); try{ e.stopImmediatePropagation(); }catch(_){}; hideJoinProjectForm(); }
    });
}

// ... existing code ...
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
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); joinBtn.click(); }
        if (e.key === 'Escape') { e.preventDefault(); closeInvitesModal(); }
    });
}

// === Starred boards (local) ===
function getStarredStorageKey(){
    const u = currentUser || localStorage.getItem('kanbanUser') || '__';
    return 'kanbanStarredBoards:' + u;
}
function loadStarredBoards(){
    try {
        const raw = localStorage.getItem(getStarredStorageKey());
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch(e){ return []; }
}
function saveStarredBoards(list){
    try { localStorage.setItem(getStarredStorageKey(), JSON.stringify(list)); } catch(e){}
}
function isBoardStarred(projectId, boardName){
    const list = loadStarredBoards();
    return list.some(it => it && it.projectId === projectId && it.boardName === boardName);
}
function toggleBoardStar(projectId, boardName, projectName, btn){
    const list = loadStarredBoards();
    const idx = list.findIndex(it => it && it.projectId === projectId && it.boardName === boardName);
    if (idx !== -1){
        list.splice(idx,1);
        if (btn) btn.classList.remove('active');
    } else {
        list.unshift({ projectId, boardName, projectName: projectName || '', starredAt: Date.now() });
        if (btn) btn.classList.add('active');
    }
    saveStarredBoards(list);
    renderStarredBoards();
}
function removeStarIfExists(projectId, boardName){
    const list = loadStarredBoards();
    const idx = list.findIndex(it => it && it.projectId === projectId && it.boardName === boardName);
    if (idx !== -1){ list.splice(idx,1); saveStarredBoards(list); renderStarredBoards(); }
}
function purgeStarsForProject(projectId){
    const list = loadStarredBoards();
    const next = list.filter(it => it && it.projectId !== projectId);
    if (next.length !== list.length){ saveStarredBoards(next); renderStarredBoards(); }
}
function updateStarsOnBoardRenamed(projectId, oldName, newName){
    const list = loadStarredBoards();
    let changed = false;
    list.forEach(it => { if (it.projectId === projectId && it.boardName === oldName){ it.boardName = newName; changed = true; } });
    if (changed){ saveStarredBoards(list); renderStarredBoards(); }
}
function updateStarsOnProjectRenamed(projectId, newName){
    const list = loadStarredBoards();
    let changed = false;
    list.forEach(it => { if (it.projectId === projectId){ it.projectName = newName; changed = true; } });
    if (changed){ saveStarredBoards(list); renderStarredBoards(); }
}
function ensureStarNames(projects){
    try {
        const map = Object.create(null);
        (projects||[]).forEach(p => { if (p && p.id) map[p.id] = p.name; });
        const list = loadStarredBoards();
        let changed = false;
        list.forEach(it => { if (it && (!it.projectName || it.projectName==='')) { it.projectName = map[it.projectId] || it.projectName || ''; changed = true; } });
        if (changed) saveStarredBoards(list);
    } catch(e){}
}
function renderStarredBoards(){
    const grid = document.getElementById('starredBoards');
    if (!grid) return;
    const list = loadStarredBoards().slice().sort((a,b)=> (b.starredAt||0) - (a.starredAt||0));
    if (list.length === 0){
        grid.innerHTML = '<div class="empty-state">暂无星标看板</div>';
        return;
    }
    const renderList = (arr) => {
        grid.innerHTML = '';
        arr.forEach(item => {
            const card = document.createElement('div');
            card.className = 'quick-board-card board-card-with-actions';
            card.onclick = () => {
                currentProjectId = item.projectId;
                currentProjectName = item.projectName || currentProjectName;
                currentBoardName = item.boardName;
                previousPage = 'project';
                showBoard();
            };
            const isStar = isBoardStarred(item.projectId, item.boardName);
            card.innerHTML = `
                <div class="board-details">
                    <h4>${escapeHtml(item.boardName)}</h4>
                    <span class="board-project">${escapeHtml(item.projectName || '')}</span>
                </div>
                <div class="board-card-actions">
                    <button class="board-action-btn pin-btn" onclick="event.stopPropagation(); pinStarBoardToFront('${item.projectId}', '${escapeJs(item.boardName)}')" title="置前">⇧</button>
                    <button class="board-action-btn star-btn ${isStar ? 'active' : ''}" data-project-id="${item.projectId}" data-board-name="${escapeHtml(item.boardName)}" onclick="event.stopPropagation(); toggleBoardStarFromHome('${item.projectId}', '${escapeJs(item.boardName)}', '${escapeJs(item.projectName || '')}', this)" title="${isStar ? '取消星标' : '加星'}">★</button>
                </div>
            `;
            grid.appendChild(card);
        });
        renderIconsInDom(grid);
    };
    // first pass
    renderList(list);
    // fetch pins and re-render with pinned-first order
    (async ()=>{
        try {
            const resp = await fetch(`/api/user-star-pins/${currentUser}`);
            const data = await resp.json().catch(()=>({pins:[]}));
            const pins = (resp.ok && data && Array.isArray(data.pins)) ? data.pins : [];
            if (pins.length){
                const map = new Map(list.map(it => [ `${it.projectId}::${it.boardName}`, it ]));
                const ahead = [];
                pins.forEach(k => { const it = map.get(k); if (it){ ahead.push(it); map.delete(k); } });
                const rest = Array.from(map.values());
                renderList(ahead.concat(rest));
            }
        } catch(e) {}
    })();
}
function toggleBoardStarFromHome(projectId, boardName, projectName, btn){
    toggleBoardStar(projectId, boardName, projectName, btn);
}

function pinIconMarkup(kind, isPinned){
    const hover = isPinned ? 'pin-off' : 'pin';
    const text = isPinned ? '取消置顶' : '置顶';
    let baseEl;
    if (isPinned) {
        baseEl = `<span class="icon-base" data-icon="pin"></span>`;
    } else if (kind === 'project') {
        baseEl = `<span class="icon-base" data-icon="folder"></span>`;
    } else {
        // board non-pinned: use inline icon via Icon.boards
        baseEl = `<span class="icon-base" data-icon="boards"></span>`;
    }
    return `<span class="pin-wrap ${isPinned ? 'pinned' : ''}" aria-label="${text}" title="${text}">
                ${baseEl}
                <span class="icon-hover" data-icon="${hover}"></span>
                <span class="pin-label">${text}</span>
            </span>`;
}

function createGroupSeparator(title){
    const sep = document.createElement('div');
    sep.className = 'group-separator';
    sep.innerHTML = `<span class="group-sep-dot"></span><span class="group-sep-text">${title}</span>`;
    return sep;
}

function syncStarButtons(){
    try {
        const list = loadStarredBoards();
        const set = new Set(list.map(it => `${it.projectId}::${it.boardName}`));
        document.querySelectorAll('.board-action-btn.star-btn').forEach(btn => {
            const pid = btn.getAttribute('data-project-id');
            const bname = btn.getAttribute('data-board-name');
            if (!pid || !bname) return;
            const key = `${pid}::${bname}`;
            const active = set.has(key);
            btn.classList.toggle('active', active);
            btn.title = active ? '取消星标' : '加星';
        });
    } catch(e){}
}
// After any star list update or render, call syncStarButtons
(function(){
    const origRenderStarredBoards = renderStarredBoards;
    renderStarredBoards = function(){
        origRenderStarredBoards.apply(this, arguments);
        try { syncStarButtons(); } catch(e){}
    };
})();
// Hook into loadProjectBoards completion to sync
(function(){
    const origLoadProjectBoards = loadProjectBoards;
    loadProjectBoards = async function(){
        await origLoadProjectBoards.apply(this, arguments);
        try { syncStarButtons(); } catch(e){}
    };
})();
// Update after homepage projects/boards load
(function(){
    const origLoadUserProjects = loadUserProjects;
    loadUserProjects = async function(){
        await origLoadUserProjects.apply(this, arguments);
        try { syncStarButtons(); } catch(e){}
    };
})();
// Update on toggle as well
(function(){
    const _toggle = toggleBoardStar;
    toggleBoardStar = function(projectId, boardName, projectName, btn){
        _toggle(projectId, boardName, projectName, btn);
        try { syncStarButtons(); } catch(e){}
    };
})();

// === Collapsed board actions menu ===
let boardActionsMenuEl = null;
let boardActionsMenuCloser = null;
function closeBoardActionsMenu(){
    if (boardActionsMenuCloser) { try { document.removeEventListener('click', boardActionsMenuCloser, true); } catch(_){} boardActionsMenuCloser = null; }
    // Remove hold class from anchored card so actions can hide again
    try { if (boardActionsMenuEl && boardActionsMenuEl._cardEl) { boardActionsMenuEl._cardEl.classList.remove('hold-actions'); } } catch(_){}
    if (boardActionsMenuEl && boardActionsMenuEl.parentNode) { try { boardActionsMenuEl.parentNode.removeChild(boardActionsMenuEl); } catch(_){} }
    boardActionsMenuEl = null;
}
function openBoardActionsMenu(scope, projectId, boardName, anchor){
    try { closeBoardActionsMenu(); } catch(_){ }
    const rect = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.className = 'board-actions-menu';
    menu.innerHTML = `
        <button data-act="rename">重命名</button>
        <button data-act="move">移动到其他项目</button>
        <button data-act="archive">归档看板</button>
    `;
    Object.assign(menu.style, {
        position: 'fixed',
        top: (rect.bottom + 6) + 'px',
        right: (Math.max(8, window.innerWidth - rect.right)) + 'px',
        zIndex: 1000
    });
    document.body.appendChild(menu);
    // Keep the card visually active while interacting with the menu
    try {
        const cardEl = anchor.closest('.board-card-with-actions') || anchor.closest('.quick-board-card');
        if (cardEl) { cardEl.classList.add('hold-actions'); menu._cardEl = cardEl; }
    } catch(_){ }
    boardActionsMenuEl = menu;
    const handler = (e) => {
        if (!menu.contains(e.target)) closeBoardActionsMenu();
    };
    setTimeout(()=>{ document.addEventListener('click', handler, true); boardActionsMenuCloser = handler; }, 0);
    menu.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = ev.target && ev.target.getAttribute('data-act');
        if (!act) return;
        closeBoardActionsMenu();
        if (scope === 'home') {
            if (act === 'rename') return promptRenameBoardFromHome(projectId, boardName);
            if (act === 'move') return promptMoveBoardFromHome(projectId, boardName);
            if (act === 'archive') return archiveBoardFromHome(projectId, boardName);
        } else {
            if (act === 'rename') return promptRenameBoard(boardName);
            if (act === 'move') return promptMoveBoard(boardName);
            if (act === 'archive') return archiveBoard(boardName);
        }
    });
}

// === Starred boards (server-persisted) ===
let cachedStars = [];
async function fetchUserStars(){
    if (!currentUser) { cachedStars = []; return cachedStars; }
    try {
        const resp = await fetch(`/api/user-stars/${currentUser}`);
        const data = await resp.json();
        cachedStars = (resp.ok && data && Array.isArray(data.stars)) ? data.stars : [];
    } catch(e) { cachedStars = []; }
    return cachedStars;
}
function loadStarredBoards(){ return Array.isArray(cachedStars) ? cachedStars : []; }
function saveStarredBoards(list){ cachedStars = Array.isArray(list) ? list : []; }
function isBoardStarred(projectId, boardName){
    const list = loadStarredBoards();
    return list.some(it => it && it.projectId === projectId && it.boardName === boardName);
}
async function toggleBoardStar(projectId, boardName, projectName, btn){
    try {
        const resp = await fetch('/api/user-stars/toggle', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: currentUser, projectId, boardName, projectName })
        });
        const data = await resp.json().catch(()=>({}));
        if (resp.ok && data && Array.isArray(data.stars)) {
            saveStarredBoards(data.stars);
            if (btn) btn.classList.toggle('active', !!data.starred);
            renderStarredBoards();
            try { syncStarButtons(); } catch(e) {}
            return;
        }
    } catch(e) {}
    // 失败时轻提示
    uiToast('星标操作失败','error');
}
function removeStarIfExists(projectId, boardName){
    const list = loadStarredBoards();
    const idx = list.findIndex(it => it && it.projectId === projectId && it.boardName === boardName);
    if (idx !== -1){ list.splice(idx,1); saveStarredBoards(list); renderStarredBoards(); }
}
function purgeStarsForProject(projectId){
    const list = loadStarredBoards();
    const next = list.filter(it => it && it.projectId !== projectId);
    if (next.length !== list.length){ saveStarredBoards(next); renderStarredBoards(); }
}
function updateStarsOnBoardRenamed(projectId, oldName, newName){
    const list = loadStarredBoards();
    let changed = false;
    list.forEach(it => { if (it.projectId === projectId && it.boardName === oldName){ it.boardName = newName; changed = true; } });
    if (changed){ saveStarredBoards(list); renderStarredBoards(); }
}
function updateStarsOnProjectRenamed(projectId, newName){
    const list = loadStarredBoards();
    let changed = false;
    list.forEach(it => { if (it.projectId === projectId){ it.projectName = newName; changed = true; } });
    if (changed){ saveStarredBoards(list); renderStarredBoards(); }
}
function ensureStarNames(projects){
    try {
        const map = Object.create(null);
        (projects||[]).forEach(p => { if (p && p.id) map[p.id] = p.name; });
        const list = loadStarredBoards();
        let changed = false;
        list.forEach(it => { if (it && (!it.projectName || it.projectName==='')) { it.projectName = map[it.projectId] || it.projectName || ''; changed = true; } });
        if (changed) saveStarredBoards(list);
    } catch(e){}
}
async function renderStarredBoards(){
    const grid = document.getElementById('starredBoards');
    if (!grid) return;
    if (!cachedStars || !cachedStars.length) { await fetchUserStars(); }
    const list = loadStarredBoards().slice().sort((a,b)=> (b.starredAt||0) - (a.starredAt||0));
    if (list.length === 0){
        grid.innerHTML = '<div class="empty-state">暂无星标看板</div>';
        return;
    }
    // apply starred pin order from server
    let pins = [];
    try {
        const resp = await fetch(`/api/user-star-pins/${currentUser}`);
        const data = await resp.json().catch(()=>({pins:[]}));
        pins = (resp.ok && data && Array.isArray(data.pins)) ? data.pins : [];
    } catch(e) {}
    const map = new Map(list.map(it => [ `${it.projectId}::${it.boardName}`, it ]));
    const ahead = [];
    pins.forEach(k => { const it = map.get(k); if (it){ ahead.push(it); map.delete(k); } });
    const rest = Array.from(map.values());
    const ordered = ahead.concat(rest);
    grid.innerHTML = '';
    ordered.forEach(item => {
        const card = document.createElement('div');
        card.className = 'quick-board-card board-card-with-actions';
        card.onclick = () => {
            currentProjectId = item.projectId;
            currentProjectName = item.projectName || currentProjectName;
            currentBoardName = item.boardName;
            previousPage = 'project';
            showBoard();
        };
        const isStar = isBoardStarred(item.projectId, item.boardName);
        card.innerHTML = `
            <div class="board-details">
                <h4>${escapeHtml(item.boardName)}</h4>
                <span class="board-project">${escapeHtml(item.projectName || '')}</span>
            </div>
            <div class="board-card-actions">
                <button class="board-action-btn pin-btn" onclick="event.stopPropagation(); pinStarBoardToFront('${item.projectId}', '${escapeJs(item.boardName)}')" title="置前">⇧</button>
                <button class="board-action-btn star-btn ${isStar ? 'active' : ''}" data-project-id="${item.projectId}" data-board-name="${escapeHtml(item.boardName)}" onclick="event.stopPropagation(); toggleBoardStarFromHome('${item.projectId}', '${escapeJs(item.boardName)}', '${escapeJs(item.projectName || '')}', this)" title="${isStar ? '取消星标' : '加星'}">★</button>
            </div>
        `;
        grid.appendChild(card);
    });
    renderIconsInDom(grid);
}
function toggleBoardStarFromHome(projectId, boardName, projectName, btn){
    toggleBoardStar(projectId, boardName, projectName, btn);
}

function syncStarButtons(){
    try {
        const list = loadStarredBoards();
        const set = new Set(list.map(it => `${it.projectId}::${it.boardName}`));
        document.querySelectorAll('.board-action-btn.star-btn').forEach(btn => {
            const pid = btn.getAttribute('data-project-id');
            const bname = btn.getAttribute('data-board-name');
            if (!pid || !bname) return;
            const key = `${pid}::${bname}`;
            const active = set.has(key);
            btn.classList.toggle('active', active);
            btn.title = active ? '取消星标' : '加星';
        });
    } catch(e){}
}
// After any render, call syncStarButtons
(function(){
    const origRenderStarredBoards = renderStarredBoards;
    renderStarredBoards = async function(){
        await origRenderStarredBoards.apply(this, arguments);
        try { syncStarButtons(); } catch(e){}
    };
})();
// Hook into loadProjectBoards completion to sync
(function(){
    const origLoadProjectBoards = loadProjectBoards;
    loadProjectBoards = async function(){
        await origLoadProjectBoards.apply(this, arguments);
        try { if (currentUser) await fetchUserStars(); } catch(e){}
        try { syncStarButtons(); } catch(e){}
    };
})();
// Update after homepage projects/boards load
(function(){
    const origLoadUserProjects = loadUserProjects;
    loadUserProjects = async function(){
        await origLoadUserProjects.apply(this, arguments);
        try { if (currentUser) await fetchUserStars(); } catch(e){}
        try { syncStarButtons(); } catch(e){}
    };
})();
// Update on toggle as well
(function(){
    const _toggle = toggleBoardStar;
    toggleBoardStar = async function(projectId, boardName, projectName, btn){
        await _toggle(projectId, boardName, projectName, btn);
        try { syncStarButtons(); } catch(e){}
    };
})();

// 导出JSON
async function exportJSON() {
    const ctx = ensureBoardExportContext();
    if (!ctx) return;
    const { projectId, projectName, boardName } = ctx;
    const fileName = `${sanitizeFilenamePart(projectName)}-${sanitizeFilenamePart(boardName)}.json`;
    const url = `/api/export-json/${projectId}/${encodeURIComponent(boardName)}`;
    if (anchorDownload(url, fileName)) return;
    if (navigateDownload(url)) return;
    if (directDownload(url)) return;
    // 回退到 Blob 方式
    try {
        const finalUrl = url + (url.includes('?') ? '&' : '?') + 't=' + Date.now();
        const response = await fetch(finalUrl, { credentials: 'include' });
        if (response.ok) {
            const blob = await response.blob();
            triggerBlobDownload(blob, fileName);
        } else {
            const text = await response.text().catch(()=> '');
            console.error('Export JSON error:', response.status, text);
            uiToast('导出失败','error');
        }
    } catch (error) {
        console.error('Export JSON error:', error);
        uiToast('导出失败','error');
    }
}

function toggleIOMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    const btn = document.getElementById('ioMenuBtn');
    const menu = document.getElementById('ioMenu');
    if (!btn || !menu) return;

    const wasHidden = menu.classList.contains('hidden');
    // hide first
    menu.classList.add('hidden');

    if (wasHidden) {
        const rect = btn.getBoundingClientRect();
        // position below button
        menu.style.position = 'fixed';
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        menu.classList.remove('hidden');
        bindIOMenuOnce();
    }
}

let ioMenuOutsideClickHandler = null;
let ioMenuKeyHandler = null;

function bindIOMenuOnce(){
    const menu = document.getElementById('ioMenu');
    if (!menu) return;
    // Bind item clicks
    const importFileItem = document.getElementById('ioImportFile');
    const importTextItem = document.getElementById('ioImportText');
    const exportTaskPaperItem = document.getElementById('ioExportTaskPaper');
    const exportMdItem = document.getElementById('ioExportMarkdown');
    const exportJsonItem = document.getElementById('ioExportJSON');

    if (importFileItem) importFileItem.onclick = () => { hideIOMenu(); importBoard(); };
    if (importTextItem) importTextItem.onclick = () => { hideIOMenu(); openImportText(); };
    if (exportTaskPaperItem) exportTaskPaperItem.onclick = () => { hideIOMenu(); exportTaskPaper(); };
    if (exportMdItem) exportMdItem.onclick = () => { hideIOMenu(); exportMarkdown(); };
    if (exportJsonItem) exportJsonItem.onclick = () => { hideIOMenu(); exportJSON(); };

    // Outside click / ESC
    if (!ioMenuOutsideClickHandler) {
        ioMenuOutsideClickHandler = (ev) => {
            const m = document.getElementById('ioMenu');
            const b = document.getElementById('ioMenuBtn');
            if (!m) return;
            if (m.classList.contains('hidden')) return;
            if (!m.contains(ev.target) && (!b || !b.contains(ev.target))) {
                hideIOMenu();
            }
        };
        document.addEventListener('click', ioMenuOutsideClickHandler);
    }
    if (!ioMenuKeyHandler) {
        ioMenuKeyHandler = (ev) => { if (ev.key === 'Escape') { hideIOMenu(); } };
        document.addEventListener('keydown', ioMenuKeyHandler, true);
    }
}

function hideIOMenu(){
    const menu = document.getElementById('ioMenu');
    if (menu) menu.classList.add('hidden');
}

// ============ 用户数据备份/恢复 ============

function toggleUserBackupMenu(e) {
    e && e.preventDefault();
    e && e.stopPropagation();
    const btn = document.getElementById('userBackupBtn');
    const menu = document.getElementById('userBackupMenu');
    if (!btn || !menu) return;

    const wasHidden = menu.classList.contains('hidden');
    menu.classList.add('hidden');

    if (wasHidden) {
        const rect = btn.getBoundingClientRect();
        menu.style.left = `${Math.round(rect.left)}px`;
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        menu.classList.remove('hidden');
        bindUserBackupMenuOnce();
    }
}

function hideUserBackupMenu() {
    const menu = document.getElementById('userBackupMenu');
    if (menu) menu.classList.add('hidden');
}

let userBackupMenuBound = false;
function bindUserBackupMenuOnce() {
    if (userBackupMenuBound) return;
    userBackupMenuBound = true;

    const backupAllBtn = document.getElementById('backupAllData');
    const restoreBtn = document.getElementById('restoreFromFile');
    const restoreInput = document.getElementById('restoreFileInput');

    if (backupAllBtn) {
        backupAllBtn.onclick = () => {
            hideUserBackupMenu();
            downloadUserBackup();
        };
    }

    if (restoreBtn) {
        restoreBtn.onclick = () => {
            hideUserBackupMenu();
            restoreInput && restoreInput.click();
        };
    }

    if (restoreInput) {
        restoreInput.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const backupData = JSON.parse(text);
                await restoreUserBackup(backupData);
            } catch (err) {
                console.error('Restore error:', err);
                uiToast('备份文件格式错误', 'error');
            } finally {
                e.target.value = '';
            }
        };
    }

    // 点击外部关闭
    document.addEventListener('click', (ev) => {
        const menu = document.getElementById('userBackupMenu');
        const btn = document.getElementById('userBackupBtn');
        if (menu && !menu.classList.contains('hidden')) {
            if (!menu.contains(ev.target) && (!btn || !btn.contains(ev.target))) {
                hideUserBackupMenu();
            }
        }
    });

    // ESC 关闭
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') hideUserBackupMenu();
    }, true);
}

async function downloadUserBackup() {
    if (!currentUser) {
        uiToast('请先登录', 'error');
        return;
    }
    try {
        uiToast('正在导出数据...', 'info');
        const response = await fetch(`/api/user-backup/${encodeURIComponent(currentUser)}`);
        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.message || '导出失败');
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kanban_backup_${currentUser}_${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        uiToast('数据导出成功', 'success');
    } catch (err) {
        console.error('Backup error:', err);
        uiToast(err.message || '导出失败', 'error');
    }
}

async function restoreUserBackup(backupData) {
    if (!currentUser) {
        uiToast('请先登录', 'error');
        return;
    }

    // 验证备份数据
    if (!backupData.version || !backupData.projects) {
        uiToast('无效的备份文件格式', 'error');
        return;
    }

    const projectCount = backupData.projects.length;
    const boardCount = backupData.projects.reduce((sum, p) => sum + (p.boards ? p.boards.length : 0), 0);

    // 确认恢复
    const confirmed = confirm(`确定要恢复此备份吗？\n\n将创建 ${projectCount} 个新项目，共 ${boardCount} 个看板。\n\n原项目数据不会被覆盖。`);
    if (!confirmed) return;

    try {
        uiToast('正在恢复数据...', 'info');
        const response = await fetch('/api/user-restore', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: currentUser,
                backupData: backupData
            })
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(result.message || '恢复失败');
        }

        uiToast(`恢复成功！创建了 ${result.summary.projectCount} 个项目，${result.summary.totalBoards} 个看板`, 'success');

        // 刷新项目列表
        await loadProjects();
    } catch (err) {
        console.error('Restore error:', err);
        uiToast(err.message || '恢复失败', 'error');
    }
}

// ============ 用户数据备份/恢复 END ============

// ... existing code ...
// 在捕获阶段也拦截一次，确保一次 Esc 生效
document.addEventListener('keydown', function(e){
    if (e.key !== 'Escape') return;
    // Highest priority: close add-list if open (avoid needing a second press after blur)
    if (closeAddListEntry(e)) return;

    let handled = false;
    const dynamicModals = Array.from(document.querySelectorAll('body > .modal')).filter(m => !m.id && !m.classList.contains('hidden'));
    const top = dynamicModals.length ? dynamicModals[dynamicModals.length - 1] : null;
    if (top) {
        const btn = top.querySelector('.close-btn');
        if (btn) { btn.click(); handled = true; }
    } else {
        const cp = document.getElementById('createProjectForm');
        if (!handled && cp && !cp.classList.contains('hidden')) { hideCreateProjectForm(); handled = true; }
        const jp = document.getElementById('joinProjectForm');
        if (!handled && jp && !jp.classList.contains('hidden')) { hideJoinProjectForm(); handled = true; }
        const iv = document.getElementById('invitesModal');
        if (!handled && iv && !iv.classList.contains('hidden')) { closeInvitesModal(); handled = true; }
        const mm = document.getElementById('membersModal');
        if (!handled && mm && !mm.classList.contains('hidden')) { closeMembersModal(); handled = true; }
        if (!handled) {
            const ioMenu = document.getElementById('ioMenu');
            if (ioMenu && !ioMenu.classList.contains('hidden')) { hideIOMenu(); handled = true; }
        }
        if (!handled && typeof importModal !== 'undefined' && importModal && !importModal.classList.contains('hidden')) { cancelImport(); handled = true; }
        if (!handled && typeof importTextModal !== 'undefined' && importTextModal && !importTextModal.classList.contains('hidden')) { cancelImportText(); handled = true; }
        if (!handled && typeof editModal !== 'undefined' && editModal && !editModal.classList.contains('hidden')) { closeEditModal(); handled = true; }
    }
    if (handled) {
        try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){ }
    }
}, true);
// Open list composer with Enter when closed (global capture)
document.addEventListener('keydown', function(e){
    // Allow IME Enter when not in an editor
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!boardPage || boardPage.classList.contains('hidden')) return;
    // avoid when dynamic modals or menus visible
    const hasDynamicModal = Array.from(document.querySelectorAll('body > .modal')).some(m => !m.id && !m.classList.contains('hidden'));
    if (hasDynamicModal) return;
    const ioMenu = document.getElementById('ioMenu');
    if (ioMenu && !ioMenu.classList.contains('hidden')) return;
    if (document.querySelector('.board-switcher-menu')) return;
    const t = e.target;
    // ignore interactive/inside-card targets
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable ||
              t.closest('button, select, .composer, .add-list-form, .list-actions, .assignee-dropdown'))) return;
    if (t && t.closest && t.closest('.card')) return;
    // ignore if any composer already open
    if (document.querySelector('.card-composer.is-open')) return;

    let section = (t && t.closest && t.closest('.list:not(.add-list):not(#addListEntry)')) || lastHoveredListSection;
    if (!section || !document.body.contains(section)) {
        section = document.querySelector('#listsContainer .list:not(.add-list):not(#addListEntry)');
    }
    if (!section) return;

    const wrap = section.querySelector('.card-composer');
    const form = wrap ? wrap.querySelector('.composer') : null;
    const textarea = wrap ? wrap.querySelector('textarea') : null;
    if (!wrap || !form || !form.hidden) return;

    e.preventDefault();
    try { e.stopPropagation(); e.stopImmediatePropagation && e.stopImmediatePropagation(); } catch(_){}
    // Open composer directly to avoid relying on onclick binding
    wrap.classList.add('is-open');
    form.hidden = false;
    setTimeout(()=>{ try{ textarea && textarea.focus(); }catch(_){ } }, 0);
}, true);
// Keyup fallback in case other keydown handlers consume Enter earlier
document.addEventListener('keyup', function(e){
    if (e.key !== 'Enter' || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!boardPage || boardPage.classList.contains('hidden')) return;
    try { if (enterComposerSuppressUntil && Date.now() < enterComposerSuppressUntil) { return; } else { enterComposerSuppressUntil = 0; } } catch(_){ }
    // if composer already open anywhere, skip
    if (document.querySelector('.card-composer.is-open')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    let section = (t && t.closest && t.closest('.list:not(.add-list):not(#addListEntry)')) || lastHoveredListSection || document.querySelector('#listsContainer .list:not(.add-list):not(#addListEntry)');
    if (!section) return;
    const wrap = section.querySelector('.card-composer');
    const form = wrap ? wrap.querySelector('.composer') : null;
    const textarea = wrap ? wrap.querySelector('textarea') : null;
    if (!wrap || !form || !form.hidden) return;
    try { e.preventDefault(); e.stopPropagation(); } catch(_){}
    wrap.classList.add('is-open');
    form.hidden = false;
    setTimeout(()=>{ try{ textarea && textarea.focus(); }catch(_){ } }, 0);
}, true);

// Keyup fallback for Esc to ensure single-press closes add-list input
document.addEventListener('keyup', function(e){
    if (e.key !== 'Escape') return;
    // If already handled by keydown very recently, skip fallback
    if (escAddListHandledAt && Date.now() - escAddListHandledAt < 500) return;
    // if add-list form is open, close it
    closeAddListEntry(e);
}, true);
// ... existing code ...

// 移动看板（项目看板页）
async function promptMoveBoard(boardName){
    try { hideBoardSwitcher(); } catch (e) {}
    const target = await openProjectChooser(currentProjectId);
    if (!target) return;
    await moveBoardRequest(currentProjectId, target.id, boardName);
}

// 移动看板（首页快捷看板）
async function promptMoveBoardFromHome(fromProjectId, boardName){
    const target = await openProjectChooser(fromProjectId);
    if (!target) return;
    await moveBoardRequest(fromProjectId, target.id, boardName, true);
}

// 打开项目选择器模态框，返回选中项目
async function openProjectChooser(excludeProjectId){
    try {
        const resp = await fetch(`/api/user-projects/${currentUser}`);
        if (!resp.ok) { uiToast('加载项目列表失败','error'); return null; }
        const all = await resp.json();
        const candidates = (Array.isArray(all) ? all : []).filter(p => String(p.id) !== String(excludeProjectId));
        if (!candidates.length) { uiToast('没有可移动到的项目','info'); return null; }

        const modal = document.getElementById('projectChooserModal');
        const listEl = document.getElementById('projectChooserList');
        const searchEl = document.getElementById('projectChooserSearch');
        const confirmBtn = document.getElementById('projectChooserConfirm');
        if (!modal || !listEl || !searchEl || !confirmBtn) { return null; }

        let selectedId = null;
        function renderList(items){
            listEl.innerHTML = '';
            items.forEach(p => {
                const item = document.createElement('div');
                item.className = 'board-switcher-item';
                item.innerHTML = `<span class="board-switcher-label" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`;
                item.onclick = () => {
                    selectedId = p.id;
                    confirmBtn.disabled = false;
                    // highlight selection
                    listEl.querySelectorAll('.board-switcher-item').forEach(el=>el.classList.remove('active'));
                    item.classList.add('active');
                };
                listEl.appendChild(item);
            });
        }
        renderList(candidates);
        searchEl.value = '';
        searchEl.oninput = () => {
            const q = searchEl.value.trim().toLowerCase();
            const filtered = q ? candidates.filter(p => (p.name||'').toLowerCase().includes(q)) : candidates;
            renderList(filtered);
            selectedId = null; confirmBtn.disabled = true;
        };

        return await new Promise(resolve => {
            function cleanup(){
                modal.classList.add('hidden');
                confirmBtn.onclick = null;
                closeBtn.onclick = null;
                document.removeEventListener('keydown', keyHandler, true);
            }
            const closeBtn = modal.querySelector('.close-btn');
            const keyHandler = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBtn && closeBtn.click(); }
                if (e.key === 'Enter' && !confirmBtn.disabled) { e.preventDefault(); confirmBtn.click(); }
            };
            document.addEventListener('keydown', keyHandler, true);
            closeBtn && (closeBtn.onclick = () => { cleanup(); resolve(null); });
            confirmBtn.onclick = () => {
                const picked = candidates.find(p => String(p.id) === String(selectedId));
                cleanup();
                resolve(picked || null);
            };
            modal.classList.remove('hidden');
            setTimeout(()=>{ try{ searchEl.focus(); }catch(_){} }, 0);
        });
    } catch (e) {
        uiToast('加载项目列表失败','error');
        return null;
    }
}

function closeProjectChooser(){
    const modal = document.getElementById('projectChooserModal');
    if (modal) modal.classList.add('hidden');
}

// 发送移动看板请求并进行轻量 UI 更新
async function moveBoardRequest(fromProjectId, toProjectId, boardName, isHome){
    if (String(fromProjectId) === String(toProjectId)) { uiToast('目标项目不能与源项目相同','error'); return; }
    try {
        const resp = await fetch('/api/move-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromProjectId, toProjectId, boardName, actor: currentUser })
        });
        const result = await resp.json().catch(() => ({}));
        if (!resp.ok) { uiToast(result.message || '移动失败','error'); return; }
        try {
            document.querySelectorAll('#quickAccessBoards .quick-board-card').forEach(card => {
                const starBtn = card.querySelector('.star-btn');
                const titleEl = card.querySelector('h4');
                if (!starBtn || !titleEl) return;
                const pid = starBtn.getAttribute('data-project-id');
                const bname = starBtn.getAttribute('data-board-name');
                if (String(pid) === String(fromProjectId) && bname === boardName) {
                    starBtn.setAttribute('data-project-id', String(toProjectId));
                    const projEl = card.querySelector('.board-project');
                    if (projEl && result && result.toProjectName) projEl.textContent = result.toProjectName;
                    card.onclick = () => {
                        currentProjectId = String(toProjectId);
                        currentProjectName = (result && result.toProjectName) || currentProjectName;
                        currentBoardName = boardName;
                        previousPage = 'project';
                        showBoard();
                    };
                    const renameBtn = card.querySelector('.rename-btn');
                    if (renameBtn) renameBtn.setAttribute('onclick', `event.stopPropagation(); promptRenameBoardFromHome('${toProjectId}', '${escapeJs(boardName)}')`);
                    const moveBtn = card.querySelector('.move-btn');
                    if (moveBtn) moveBtn.setAttribute('onclick', `event.stopPropagation(); promptMoveBoardFromHome('${toProjectId}', '${escapeJs(boardName)}')`);
                    const delBtn = card.querySelector('.delete-btn');
                    if (delBtn) delBtn.setAttribute('onclick', `event.stopPropagation(); deleteBoardFromHome('${escapeJs(boardName)}', '${toProjectId}')`);
                }
            });
        } catch(e) {}
        // 更新缓存：从源项目移除看板
        try {
            if (Array.isArray(projectBoardsCache[fromProjectId])) {
                projectBoardsCache[fromProjectId] = projectBoardsCache[fromProjectId].filter(b => b !== boardName);
            }
            // 清除目标项目的缓存，强制下次进入时重新加载
            delete projectBoardsCache[toProjectId];
        } catch(e) {}
        // 标记目标项目需要重新加载看板列表
        try {
            // 如果当前缓存的项目key是目标项目，重置它以强制刷新
            if (window.boardSelectProjectKey === String(toProjectId)) {
                window.boardSelectProjectKey = null;
            }
            // 标记看板列表为脏数据
            window.boardSelectDirty = true;
        } catch(e) {}

        // 如果在项目看板列表页，刷新看板列表
        try {
            if (!boardSelectPage.classList.contains('hidden') && String(currentProjectId) === String(fromProjectId)) {
                // 直接重新加载看板列表以确保完整刷新
                loadProjectBoards();
            }
        } catch(e) {}

        uiToast('移动成功','success');
        if (String(fromProjectId) === String(currentProjectId) && currentBoardName === boardName && socket && socket.readyState === WebSocket.OPEN) {
            // server will broadcast board-moved
        }
        // 刷新首页项目列表和星标看板
        // 标记首页需要刷新
        homeDirty = true;
        // 延迟执行刷新，确保模态框已完全关闭
        setTimeout(() => {
            try {
                if (!projectPage.classList.contains('hidden')) {
                    homeDirty = false;
                    loadUserProjects();
                }
            } catch(e) {}
            // 强制刷新星标看板区域
            try { renderStarredBoards(); } catch(e) {}
        }, 50);
    } catch (e) {
        console.error('Move board error:', e);
        uiToast('移动失败','error');
    }
}

// ... existing code ...
// 归档看板（项目内）
async function archiveBoard(boardName){
    const ok = await uiConfirm(`将看板 "${boardName}" 移至归档？`, '归档看板');
    if (!ok) return;
    try {
        const resp = await fetch('/api/archive-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: currentProjectId, boardName, actor: currentUser })
        });
        const result = await resp.json().catch(()=>({}));
        if (!resp.ok) { uiToast(result.message || '归档失败','error'); return; }
            uiToast('看板已归档','success');
        try { loadProjectBoards(); } catch(e){}
        try { renderStarredBoards(); } catch(e){}
    } catch (e) {
        console.error('Archive board error:', e);
        uiToast('归档失败','error');
    }
}

// 归档看板（首页快捷卡片）
async function archiveBoardFromHome(projectId, boardName){
    const ok = await uiConfirm(`将看板 "${boardName}" 移至归档？`, '归档看板');
    if (!ok) return;
    try {
        const resp = await fetch('/api/archive-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId, boardName, actor: currentUser })
        });
        const result = await resp.json().catch(()=>({}));
        if (!resp.ok) { uiToast(result.message || '归档失败','error'); return; }
            uiToast('看板已归档','success');
        try { renderStarredBoards(); } catch(e){}
        try { if (!projectPage.classList.contains('hidden')) loadUserProjects(); } catch(e) {}
    } catch (e) {
        console.error('Archive board (home) error:', e);
        uiToast('归档失败','error');
    }
}

// 还原归档看板
async function unarchiveBoard(boardName){
    const ok = await uiConfirm(`还原看板 "${boardName}" 到项目列表？`, '还原看板');
    if (!ok) return;
    try {
        // Preserve archived list UI state (expanded/search) before request
        try {
            const listEl = document.querySelector('.archived-boards-list');
            if (listEl) {
                window.boardArchivedExpanded = !listEl.classList.contains('hidden');
            }
            const qEl = document.getElementById('archivedBoardsSearch');
            if (qEl) window.boardArchivedSearch = qEl.value || '';
        } catch(_){ }
        const resp = await fetch('/api/unarchive-board', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ projectId: currentProjectId, boardName, actor: currentUser })
        });
        const result = await resp.json().catch(()=>({}));
        if (!resp.ok) { uiToast(result.message || '还原失败','error'); return; }
        uiToast('看板已还原','success');
        try { loadProjectBoards(); } catch(e){}
        try { renderStarredBoards(); } catch(e){}
    } catch (e) {
        console.error('Unarchive board error:', e);
        uiToast('还原失败','error');
    }
}

// =====================================================
// 全局粘贴创建卡片功能
// 支持 TaskPaper 格式智能识别和批量导入
// =====================================================
document.addEventListener('paste', async function(e) {
    // 仅在看板页面生效
    if (!boardPage || boardPage.classList.contains('hidden')) return;

    // 检查是否有输入框激活（如果是，让默认粘贴行为生效）
    if (isGlobalTextInputActive()) return;

    // 检查是否有弹窗打开（不拦截弹窗内的粘贴）
    if (hasOpenModal()) return;

    // 获取剪贴板内容
    let clipboardText = '';
    try {
        // 优先使用 clipboardData（同步方式）
        if (e.clipboardData && e.clipboardData.getData) {
            clipboardText = e.clipboardData.getData('text/plain');
        }
        // 备用：使用 navigator.clipboard API（异步方式）
        if (!clipboardText && navigator.clipboard && navigator.clipboard.readText) {
            clipboardText = await navigator.clipboard.readText();
        }
    } catch (err) {
        console.warn('无法读取剪贴板:', err);
        return;
    }

    clipboardText = (clipboardText || '').trim();
    if (!clipboardText) return;

    // 阻止默认粘贴行为
    e.preventDefault();

    // 获取看板列表信息（可能为空）
    let lists = ensureClientLists();
    if (!lists || !lists.listIds) {
        lists = { listIds: [], lists: {} };
    }

    // 解析粘贴内容并智能导入
    const result = parsePasteContent(clipboardText, lists);

    if (result.cards.length === 0) {
        uiToast('未识别到有效内容', 'warning');
        return;
    }

    // 先创建需要的新列表
    let newListsCreated = 0;
    const createdListMetas = [];
    if (result.newLists && result.newLists.length > 0) {
        ensureClientLists();
        for (const newList of result.newLists) {
            // 检查列表是否已存在
            const exists = Object.values(clientLists.lists).some(l => l.status === newList.status);
            if (!exists) {
                const id = newList.status; // 使用 status 作为 id
                const pos = clientLists.listIds.length;
                clientLists.lists[id] = { id, title: newList.title, pos, status: newList.status };
                clientLists.listIds.push(id);
                // 清空可能残留的旧数据（被删除的列表可能留有数据）
                boardData[newList.status] = [];
                newListsCreated++;
                createdListMetas.push({ id, title: newList.title, pos, status: newList.status });
            }
        }
        // 保存列表并同步到服务器
        if (newListsCreated > 0) {
            saveClientListsToStorage();
            queueListsSync();
        }
    }

    // 批量创建卡片
    let createdCount = 0;
    const affectedStatuses = new Set();
    const updatedLists = ensureClientLists(); // 获取更新后的列表

    // 收集新建列表的 status（这些列表的 boardData 已在上面清空）
    const newListStatuses = new Set((result.newLists || []).map(nl => nl.status));

    const createdCards = [];
    for (const { card, status } of result.cards) {
        // 更新本地数据
        if (!Array.isArray(boardData[status])) boardData[status] = [];
        // 新建的列表直接 push（因为已清空），现有列表插入顶部
        if (newListStatuses.has(status)) {
            boardData[status].push(card);
            createdCards.push({ card: cloneDeep(card), status, index: boardData[status].length - 1 });
        } else {
            boardData[status] = [card, ...boardData[status]];
            createdCards.push({ card: cloneDeep(card), status, index: 0 });
        }
        affectedStatuses.add(status);

        // 通过 WebSocket/HTTP 同步到服务器（始终落本地队列以防刷新丢失）
        queuePendingCardAdd(status, card, 'top');
        sendCardAdd(status, card, 'top');
        createdCount++;
    }

    // 更新 DOM
    renderBoard();

    // 提示用户
    if (result.isTaskPaperFormat) {
        const listNames = [...affectedStatuses].map(s => {
            const listInfo = Object.values(updatedLists.lists).find(l => l.status === s);
            return listInfo ? listInfo.title : s;
        }).join('、');
        let msg = `已导入 ${createdCount} 张卡片到「${listNames}」`;
        if (newListsCreated > 0) {
            msg += `（新建 ${newListsCreated} 个列表）`;
        }
        schedulePasteUndo(msg, { cards: createdCards, createdLists: createdListMetas });
    } else {
        const firstListId = updatedLists.listIds[0];
        const firstList = updatedLists.lists[firstListId];
        const listTitle = firstList?.title || firstList?.status || '列表';
        schedulePasteUndo(`已在「${listTitle}」创建 ${createdCount} 张卡片`, { cards: createdCards, createdLists: createdListMetas });
    }
});

function isGlobalTextInputActive(){
    const activeEl = document.activeElement;
    if (!activeEl) return false;
    return !!(
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable ||
        activeEl.contentEditable === 'true' ||
        activeEl.closest('[contenteditable="true"]') ||
        activeEl.closest('.card-composer') ||
        activeEl.closest('.add-list-form')
    );
}

function hasOpenModal(){
    return !!(
        document.querySelector('.modal:not(.hidden)') ||
        document.querySelector('#editModal:not(.hidden)') ||
        document.querySelector('.drawer.open')
    );
}

document.addEventListener('keydown', function(e){
    const boardVisible = boardPage && !boardPage.classList.contains('hidden');
    const archiveVisible = archivePage && !archivePage.classList.contains('hidden');
    if (!boardVisible && !archiveVisible) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (isGlobalTextInputActive()) return;
    if (hasOpenModal()) return;
    const key = (e.key || '').toLowerCase();
    const hasMod = e.ctrlKey || e.metaKey;
    if (!hasMod) return;
    const isUndo = key === 'z' && !e.shiftKey && !e.altKey;
    const isRedo = (key === 'z' && e.shiftKey && !e.altKey) || (key === 'y' && !e.shiftKey && !e.altKey);
    if (isUndo) {
        if (performUndo()) e.preventDefault();
        return;
    }
    if (isRedo) {
        if (performRedo()) e.preventDefault();
    }
}, true);

function schedulePasteUndo(message, payload){
    if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) {
        uiToast(message, 'success');
        return;
    }
    const action = {
        type: 'paste-import',
        label: '导入',
        createdAt: Date.now(),
        undo: () => undoPasteImport(payload),
        redo: () => redoPasteImport(payload)
    };
    pushUndoAction(action);
    uiToastAction(message, '撤销', () => {
        performUndo();
    }, 'success', 8000);
}

function undoPasteImport(payload){
    if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) return;
    const ids = new Set(payload.cards.map(item => item && item.card && item.card.id).filter(Boolean));
    if (!ids.size) return;

    getAllStatusKeys().forEach(status => {
        const arr = boardData[status];
        if (!Array.isArray(arr)) return;
        const next = arr.filter(card => !(card && ids.has(card.id)));
        boardData[status] = next;
    });

    dropPendingCardAddsByIds(ids);
    ids.forEach(id => sendDeleteCard(id));

    const createdLists = Array.isArray(payload.createdLists) ? payload.createdLists : [];
    if (createdLists.length) {
        ensureClientLists();
        createdLists.forEach(meta => {
            if (!meta || !meta.status) return;
            const listId = findListIdByStatus(meta.status);
            const hasCards = Array.isArray(boardData[meta.status]) && boardData[meta.status].length > 0;
            if (!hasCards) {
                if (listId) {
                    clientLists.listIds = clientLists.listIds.filter(id => id !== listId);
                    delete clientLists.lists[listId];
                }
                if (Array.isArray(boardData[meta.status]) && boardData[meta.status].length === 0) {
                    delete boardData[meta.status];
                }
            }
        });
        reindexClientLists();
        saveClientListsToStorage();
        queueListsSync();
    }

    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

function redoPasteImport(payload){
    if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) return;
    ensureClientLists();
    const createdLists = Array.isArray(payload.createdLists) ? payload.createdLists : [];
    if (createdLists.length) {
        createdLists.forEach(meta => {
            if (!meta || !meta.status) return;
            const existingId = findListIdByStatus(meta.status);
            if (existingId) return;
            const id = meta.id || meta.status;
            const pos = Math.max(0, Math.min(meta.pos || 0, clientLists.listIds.length));
            clientLists.listIds.splice(pos, 0, id);
            clientLists.lists[id] = { id, title: meta.title || meta.status, pos, status: meta.status };
        });
        reindexClientLists();
        saveClientListsToStorage();
        queueListsSync();
    }

    payload.cards.forEach(item => {
        if (!item || !item.card || !item.card.id) return;
        const card = cloneDeep(item.card);
        const status = item.status;
        if (!status) return;
        removeCardByIdFromBoardData(card.id);
        if (!Array.isArray(boardData[status])) boardData[status] = [];
        insertCardIntoStatus(card, status, item.index);
        const pos = item.index === 0 ? 'top' : 'bottom';
        queuePendingCardAdd(status, card, pos);
        sendCardAdd(status, card, pos);
    });

    renderBoard();
    if (!archivePage.classList.contains('hidden')) {
        renderArchive();
    }
}

/**
 * 解析粘贴内容，复用 parseMarkdownToBoard 进行 TaskPaper/Markdown 解析
 * @param {string} text 粘贴的文本
 * @param {object} existingLists 看板现有列表信息
 * @returns {{cards: Array<{card: object, status: string}>, isTaskPaperFormat: boolean, newLists: Array<{title: string, status: string}>}}
 */
function parsePasteContent(text, existingLists) {
    const lines = text.split('\n').map(l => l.replace(/\r$/, ''));
    const result = { cards: [], isTaskPaperFormat: false, newLists: [] };

    // 检测是否为 TaskPaper/Markdown 格式
    const hasTaskPaperHeaders = lines.some(l => isTaskPaperHeaderLine(l));
    const hasMarkdownHeaders = lines.some(l => /^##\s+/.test(l));
    const isStructuredFormat = hasTaskPaperHeaders || hasMarkdownHeaders;

    if (isStructuredFormat) {
        // 使用原有的 parseMarkdownToBoard 函数解析
        const parsedBoard = parseMarkdownToBoard(text);
        result.isTaskPaperFormat = true;

        // 构建现有列表的 status 集合和名称映射
        const existingStatusSet = new Set();
        const existingNameToStatus = {};
        const normalizeListTitleForMatch = (value) => {
            return (value || '').replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        };
        const stripLeadingEmoji = (value) => {
            return (value || '').replace(/^[\u{1F300}-\u{1F9FF}]\s*/u, '');
        };
        for (const listId of existingLists.listIds) {
            const list = existingLists.lists[listId];
            if (list) {
                existingStatusSet.add(list.status);
                const title = normalizeListTitleForMatch(list.title);
                if (title) existingNameToStatus[title] = list.status;
                // 支持去除 emoji 后的名称
                const titleNoEmoji = normalizeListTitleForMatch(stripLeadingEmoji(list.title || ''));
                if (titleNoEmoji && titleNoEmoji !== title) {
                    existingNameToStatus[titleNoEmoji] = list.status;
                }
            }
        }
        const usedStatuses = new Set(existingStatusSet);
        const makeUniqueStatus = () => {
            let key = '';
            for (let i = 0; i < 6; i++) {
                key = 'list_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
                if (!usedStatuses.has(key) && key !== 'archived') break;
            }
            while (usedStatuses.has(key) || key === 'archived') {
                key = 'list_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
            }
            usedStatuses.add(key);
            return key;
        };

        // 处理解析出的列表和卡片
        const parsedLists = parsedBoard.lists;
        const statusMapping = {}; // 解析出的 status -> 实际使用的 status

        if (parsedLists && parsedLists.listIds) {
            for (const listId of parsedLists.listIds) {
                const list = parsedLists.lists[listId];
                if (!list) continue;

                const listTitle = list.title || '';
                const listTitleLower = normalizeListTitleForMatch(listTitle);
                const parsedStatus = list.status;

                // 尝试匹配现有列表
                let targetStatus = null;

                // 1. 检查是否是标准列表（todo/doing/done）
                if (parsedStatus === 'todo' || parsedStatus === 'doing' || parsedStatus === 'done') {
                    // 查找现有列表中匹配的
                    const found = Object.values(existingLists.lists).find(l => l.status === parsedStatus);
                    if (found) {
                        targetStatus = found.status;
                    }
                }

                // 2. 按名称匹配
                if (!targetStatus && listTitleLower && existingNameToStatus[listTitleLower]) {
                    targetStatus = existingNameToStatus[listTitleLower];
                }

                // 3. 去除 emoji 后按名称匹配
                if (!targetStatus) {
                    const titleNoEmoji = normalizeListTitleForMatch(stripLeadingEmoji(listTitle));
                    if (titleNoEmoji && existingNameToStatus[titleNoEmoji]) {
                        targetStatus = existingNameToStatus[titleNoEmoji];
                    }
                }

                // 4. 如果都不匹配，创建新列表
                if (!targetStatus) {
                    if (parsedStatus && !usedStatuses.has(parsedStatus) && parsedStatus !== 'archived') {
                        targetStatus = parsedStatus;
                        usedStatuses.add(targetStatus);
                    } else {
                        targetStatus = makeUniqueStatus();
                    }
                    result.newLists.push({ title: listTitle, status: targetStatus });
                }

                statusMapping[parsedStatus] = targetStatus;
            }
        }

        // 提取所有卡片（避免重复处理同一个 status 的卡片）
        const processedStatuses = new Set();

        // 收集所有需要处理的 status 及其目标映射
        const statusesToProcess = new Map(); // parsedStatus -> targetStatus

        if (parsedLists && parsedLists.listIds) {
            for (const listId of parsedLists.listIds) {
                const list = parsedLists.lists[listId];
                if (!list) continue;
                const parsedStatus = list.status;
                if (!statusesToProcess.has(parsedStatus)) {
                    const targetStatus = statusMapping[parsedStatus] || parsedStatus;
                    statusesToProcess.set(parsedStatus, targetStatus);
                }
            }
        }

        // 处理解析出的列表中的卡片（每个 status 只处理一次）
        for (const [parsedStatus, targetStatus] of statusesToProcess) {
            if (processedStatuses.has(parsedStatus)) continue;

            const cards = parsedBoard[parsedStatus];
            if (Array.isArray(cards)) {
                for (const card of cards) {
                    const newCard = {
                        id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
                        title: card.title || '',
                        description: card.description || '',
                        author: currentUser,
                        assignee: card.assignee || null,
                        created: card.created || new Date().toISOString(),
                        deadline: card.deadline || null,
                        posts: card.posts || [],
                        commentsCount: card.commentsCount || 0,
                        starred: !!card.starred,
                        deferred: !!card.deferred
                    };
                    if (newCard.title && targetStatus !== 'archived') {
                        result.cards.push({ card: newCard, status: targetStatus });
                    }
                }
            }
            processedStatuses.add(parsedStatus);
        }

        // 处理标准列表（todo/doing/done）中的卡片（如果没有被处理过）
        const stdListTitles = { todo: '待办', doing: '进行中', done: '已完成' };
        for (const stdStatus of ['todo', 'doing', 'done']) {
            if (processedStatuses.has(stdStatus)) continue;

            const cards = parsedBoard[stdStatus];
            if (!Array.isArray(cards) || cards.length === 0) continue;

            // 查找对应的目标 status
            let targetStatus = statusMapping[stdStatus];
            if (!targetStatus) {
                const found = Object.values(existingLists.lists).find(l => l.status === stdStatus);
                if (found) {
                    targetStatus = found.status;
                } else {
                    // 没有现有列表匹配，创建新列表
                    targetStatus = stdStatus;
                    // 检查是否已在 newLists 中
                    if (!result.newLists.some(nl => nl.status === stdStatus)) {
                        result.newLists.push({ title: stdListTitles[stdStatus], status: stdStatus });
                    }
                }
            }

            for (const card of cards) {
                const newCard = {
                    id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
                    title: card.title || '',
                    description: card.description || '',
                    author: currentUser,
                    assignee: card.assignee || null,
                    created: card.created || new Date().toISOString(),
                    deadline: card.deadline || null,
                    posts: card.posts || [],
                    commentsCount: card.commentsCount || 0,
                    starred: !!card.starred,
                    deferred: !!card.deferred
                };
                if (newCard.title) {
                    result.cards.push({ card: newCard, status: targetStatus });
                }
            }
            processedStatuses.add(stdStatus);
        }

    } else {
        // 普通文本格式：每行一个任务
        let firstStatus = existingLists.lists[existingLists.listIds[0]]?.status;

        // 如果没有现有列表，创建一个默认的「待办」列表
        if (!firstStatus) {
            firstStatus = 'todo';
            result.newLists.push({ title: '待办', status: 'todo' });
        }

        // 解析 @标签 的辅助函数
        function parseTaskPaperItem(content) {
            let title = content;
            let assignee = null;
            let deadline = null;

            const dueMatch = title.match(/@due\(([^)]+)\)/);
            if (dueMatch) {
                deadline = dueMatch[1].trim();
                title = title.replace(/@due\([^)]+\)/, '').trim();
            }

            const assigneeMatch = title.match(/@(\S+)/);
            if (assigneeMatch && !assigneeMatch[1].includes('(')) {
                assignee = assigneeMatch[1];
                title = title.replace(/@\S+/, '').trim();
            }

            return { title: title.trim(), assignee, deadline };
        }

        for (const line of lines) {
            let trimmed = line.trim();
            if (!trimmed) continue;

            // 去除列表前缀
            if (trimmed.startsWith('- ')) trimmed = trimmed.substring(2).trim();
            if (trimmed.startsWith('* ')) trimmed = trimmed.substring(2).trim();
            trimmed = trimmed.replace(/^\d+[\.\)]\s*/, '').trim();

            if (trimmed) {
                const { title, assignee, deadline } = parseTaskPaperItem(trimmed);
                if (title) {
                    result.cards.push({
                        card: {
                            id: Date.now().toString() + Math.random().toString(36).slice(2, 8),
                            title: title,
                            description: '',
                            author: currentUser,
                            assignee: assignee,
                            created: new Date().toISOString(),
                            deadline: deadline,
                            posts: [],
                            commentsCount: 0,
                            starred: false,
                            deferred: false
                        },
                        status: firstStatus
                    });
                }
            }
        }
    }

    // 反转数组，使粘贴时第一条在最上面
    result.cards.reverse();

    return result;
}
// ... existing code ...
