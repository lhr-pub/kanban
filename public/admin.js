(function() {
    let token = localStorage.getItem('kanbanAdminToken') || '';
    let adminName = localStorage.getItem('kanbanAdminName') || '';

    const loginView = document.getElementById('adminLogin');
    const appView = document.getElementById('adminApp');
    const loginBtn = document.getElementById('adminLoginBtn');
    const logoutBtn = document.getElementById('adminLogoutBtn');
    const loginMsg = document.getElementById('loginMsg');

    function showLogin() {
        loginView.classList.remove('hidden');
        appView.classList.add('hidden');
    }
    function showApp() {
        loginView.classList.add('hidden');
        appView.classList.remove('hidden');
        document.getElementById('adminHello').textContent = `你好，${adminName}`;
        loadUsers();
    }

    async function adminLogin() {
        const username = document.getElementById('adminUsername').value.trim();
        const password = document.getElementById('adminPassword').value.trim();
        loginMsg.textContent = '';
        if (!username || !password) {
            loginMsg.textContent = '请输入用户名和密码';
            return;
        }
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();
            if (!res.ok) {
                loginMsg.textContent = data.message || '登录失败';
                return;
            }
            token = data.token;
            adminName = data.username;
            localStorage.setItem('kanbanAdminToken', token);
            localStorage.setItem('kanbanAdminName', adminName);
            showApp();
        } catch (e) {
            loginMsg.textContent = '网络错误，请稍后重试';
        }
    }

    async function adminLogout() {
        try {
            await fetch('/api/admin/logout', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
        } catch {}
        token = '';
        adminName = '';
        localStorage.removeItem('kanbanAdminToken');
        localStorage.removeItem('kanbanAdminName');
        showLogin();
    }

    async function loadUsers() {
        const tbody = document.getElementById('usersTable');
        tbody.innerHTML = '';
        try {
            const res = await fetch('/api/admin/users', { headers: { 'Authorization': `Bearer ${token}` } });
            if (res.status === 401 || res.status === 403) { return adminLogout(); }
            const users = await res.json();
            users.forEach(user => tbody.appendChild(renderUserRow(user)));
        } catch (e) {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td colspan="7">加载失败，请刷新重试</td>`;
            tbody.appendChild(tr);
        }
    }

    function renderUserRow(user) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td class="nowrap"><span class="badge${user.admin ? ' badge-danger' : ''}">${user.username}</span></td>
            <td>${user.email || ''}</td>
            <td>${user.verified ? '已验证' : '<span class="danger">未验证</span>'}</td>
            <td>${user.admin ? '是' : '否'}</td>
            <td>${user.projects}</td>
            <td><span class="muted">${user.created || ''}</span></td>
            <td class="right">
                <button data-act="toggle-verify">${user.verified ? '设为未验证' : '设为已验证'}</button>
                <button data-act="toggle-admin">${user.admin ? '取消管理员' : '设为管理员'}</button>
                <button data-act="reset-pass">重置密码</button>
                <button data-act="delete" class="danger">删除</button>
            </td>
        `;
        tr.querySelector('[data-act="toggle-verify"]').onclick = () => updateUser(user.username, { verified: !user.verified });
        tr.querySelector('[data-act="toggle-admin"]').onclick = () => updateUser(user.username, { admin: !user.admin });
        tr.querySelector('[data-act="reset-pass"]').onclick = async () => {
            const pwd = prompt(`输入新密码（用户: ${user.username}）`);
            if (!pwd) return;
            await updateUser(user.username, { password: pwd });
        };
        tr.querySelector('[data-act="delete"]').onclick = async () => {
            if (!confirm(`确认删除用户: ${user.username}？此操作不可撤销。`)) return;
            await deleteUser(user.username);
        };
        return tr;
    }

    async function updateUser(username, payload) {
        try {
            const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                alert(data.message || '更新失败');
            }
            await loadUsers();
        } catch {
            alert('网络错误');
        }
    }

    async function deleteUser(username) {
        try {
            const res = await fetch(`/api/admin/users/${encodeURIComponent(username)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                alert(data.message || '删除失败');
            }
            await loadUsers();
        } catch {
            alert('网络错误');
        }
    }

    loginBtn.addEventListener('click', adminLogin);
    logoutBtn.addEventListener('click', adminLogout);

    // 尝试自动登录
    if (token && adminName) {
        showApp();
    } else {
        showLogin();
    }
})();