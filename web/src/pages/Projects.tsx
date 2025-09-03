import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ProjectAPI } from '../lib/api'

export default function ProjectsPage() {
    const nav = useNavigate()
    const [username] = useState(() => localStorage.getItem('kanbanUser') || '')
    const [projects, setProjects] = useState<any[]>([])
    const [projectName, setProjectName] = useState('')
    const [inviteCode, setInviteCode] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        if (!username) {
            nav('/login')
            return
        }
        (async () => {
            try {
                const res = await ProjectAPI.getUserProjects(username)
                setProjects(res?.projects || res || [])
            } catch (e: any) {
                setError(e?.message || '加载项目失败')
            }
        })()
    }, [username, nav])

    async function createProject(e: React.FormEvent) {
        e.preventDefault()
        setLoading(true)
        setError(null)
        try {
            await ProjectAPI.createProject({ username, projectName })
            const res = await ProjectAPI.getUserProjects(username)
            setProjects(res?.projects || res || [])
            setProjectName('')
        } catch (e: any) {
            setError(e?.message || '创建项目失败')
        } finally { setLoading(false) }
    }

    async function joinProject(e: React.FormEvent) {
        e.preventDefault()
        setLoading(true)
        setError(null)
        try {
            await ProjectAPI.joinProject({ username, inviteCode })
            const res = await ProjectAPI.getUserProjects(username)
            setProjects(res?.projects || res || [])
            setInviteCode('')
        } catch (e: any) {
            setError(e?.message || '加入项目失败')
        } finally { setLoading(false) }
    }

    return (
        <div style={{ maxWidth: 720, margin: '40px auto' }}>
            <h2>我的项目</h2>
            {error && <p style={{ color: 'red' }}>{error}</p>}
            <ul>
                {projects.map((p: any) => (
                    <li key={p.projectId || p.id}>
                        <button onClick={() => nav(`/board/${p.projectId || p.id}/${encodeURIComponent(p.boards?.[0] || '默认看板')}`)}>
                            进入 {p.name || p.projectName}（{(p.boards && p.boards.length) || 0} 个看板）
                        </button>
                    </li>
                ))}
            </ul>

            <h3>创建项目</h3>
            <form onSubmit={createProject}>
                <input placeholder="项目名称" value={projectName} onChange={e => setProjectName(e.target.value)} />
                <button disabled={loading} type="submit">创建</button>
            </form>

            <h3>加入项目</h3>
            <form onSubmit={joinProject}>
                <input placeholder="邀请码" value={inviteCode} onChange={e => setInviteCode(e.target.value)} />
                <button disabled={loading} type="submit">加入</button>
            </form>
        </div>
    )
}