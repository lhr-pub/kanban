import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AuthAPI } from '../lib/api'

export default function LoginPage() {
    const nav = useNavigate()
    const [username, setUsername] = useState('')
    const [password, setPassword] = useState('')
    const [email, setEmail] = useState('')
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function doLogin(e: React.FormEvent) {
        e.preventDefault()
        setError(null)
        setLoading(true)
        try {
            const res = await AuthAPI.login({ username, password })
            localStorage.setItem('kanbanUser', res.username)
            nav('/projects')
        } catch (err: any) {
            setError(err?.message || '登录失败')
        } finally {
            setLoading(false)
        }
    }

    async function doRegister(e: React.FormEvent) {
        e.preventDefault()
        setError(null)
        setLoading(true)
        try {
            await AuthAPI.register({ username, password, email })
            alert('注册成功，请前往邮箱验证后登录')
        } catch (err: any) {
            setError(err?.message || '注册失败')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div style={{ maxWidth: 360, margin: '40px auto' }}>
            <h2>登录</h2>
            <form onSubmit={doLogin}>
                <div>
                    <input placeholder="用户名或邮箱" value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div>
                    <input placeholder="密码" type="password" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
                <button disabled={loading} type="submit">登录</button>
            </form>

            <hr />
            <h3>注册</h3>
            <form onSubmit={doRegister}>
                <div>
                    <input placeholder="用户名" value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div>
                    <input placeholder="邮箱" value={email} onChange={e => setEmail(e.target.value)} />
                </div>
                <div>
                    <input placeholder="密码" type="password" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
                <button disabled={loading} type="submit">注册</button>
            </form>
            {error && <p style={{ color: 'red' }}>{error}</p>}
        </div>
    )
}