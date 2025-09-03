import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { BoardAPI } from '../lib/api'
import { useWebSocket } from '../lib/ws'

export default function BoardPage() {
    const { projectId = '', boardName = '' } = useParams()
    const { ready, send } = useWebSocket()
    const [board, setBoard] = useState<any>(null)

    useEffect(() => {
        (async () => {
            if (projectId && boardName) {
                try {
                    const data = await BoardAPI.getBoard(projectId, decodeURIComponent(boardName))
                    setBoard(data)
                } catch (e) { /* ignore */ }
            }
        })()
    }, [projectId, boardName])

    useEffect(() => {
        if (!ready) return
        const user = localStorage.getItem('kanbanUser') || 'guest'
        send({ type: 'join', user, projectId, boardName: decodeURIComponent(boardName) })
    }, [ready, projectId, boardName, send])

    return (
        <div style={{ padding: 16 }}>
            <h2>看板：{decodeURIComponent(boardName)}（项目：{projectId}）</h2>
            <pre style={{ background: '#f6f8fa', padding: 12, overflow: 'auto' }}>{JSON.stringify(board, null, 2)}</pre>
            <button onClick={async () => {
                const data = await BoardAPI.getBoard(projectId!, decodeURIComponent(boardName!))
                setBoard(data)
            }}>刷新</button>
        </div>
    )
}