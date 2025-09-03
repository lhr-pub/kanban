export type Json = Record<string, unknown> | Array<unknown> | string | number | boolean | null

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
    const res = await fetch(path, {
        headers: {
            'Content-Type': 'application/json',
            ...(options.headers || {})
        },
        ...options
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
        const msg = (data && (data.message || data.error)) || res.statusText;
        throw new Error(typeof msg === 'string' ? msg : 'Request failed');
    }
    return data as T;
}

export const AuthAPI = {
    register(input: { username: string; password: string; email: string }) {
        return api<{ message: string; username: string }>('/api/register', {
            method: 'POST',
            body: JSON.stringify(input)
        });
    },
    login(input: { username: string; password: string }) {
        return api<{ message: string; username: string }>('/api/login', {
            method: 'POST',
            body: JSON.stringify(input)
        });
    }
};

export const ProjectAPI = {
    getUserProjects(username: string) {
        return api(`/api/user-projects/${encodeURIComponent(username)}`);
    },
    createProject(input: { username: string; projectName: string }) {
        return api('/api/create-project', {
            method: 'POST',
            body: JSON.stringify(input)
        });
    },
    joinProject(input: { username: string; inviteCode: string }) {
        return api('/api/join-project', {
            method: 'POST',
            body: JSON.stringify(input)
        });
    },
    getProjectBoards(projectId: string) {
        return api(`/api/project-boards/${encodeURIComponent(projectId)}`);
    }
};

export const BoardAPI = {
    getBoard(projectId: string, boardName: string) {
        return api(`/api/board/${encodeURIComponent(projectId)}/${encodeURIComponent(boardName)}`);
    }
};