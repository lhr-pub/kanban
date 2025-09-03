import { useMemo, useState } from 'react'
import type { BoardData, Card } from '../types'
import { useBoard } from '../hooks/useBoard'

export default function BoardView({ user, projectId, boardName }: { user: string; projectId: string; boardName: string }) {
    const { board, addCard, updateCard, moveCard, reorderCards, loading } = useBoard({ user, projectId, boardName })
    const lists = useMemo(() => board || { todo: [], doing: [], done: [] } as BoardData, [board])

    function AddRow({ status, position }: { status: 'todo' | 'doing' | 'done'; position: 'top' | 'bottom' }) {
        const [title, setTitle] = useState('')
        return (
            <div style={{ margin: '8px 0' }}>
                <input placeholder={`添加任务（${position === 'top' ? '顶部' : '底部'}）`} value={title} onChange={e => setTitle(e.target.value)} onKeyDown={(e) => {
                    if (e.key === 'Enter' && title.trim()) {
                        const card: Card = { id: String(Date.now()), title: title.trim(), author: user, created: new Date().toISOString(), posts: [], commentsCount: 0 }
                        addCard(status, card, position)
                        setTitle('')
                    }
                }} />
            </div>
        )
    }

    function List({ status, title }: { status: 'todo' | 'doing' | 'done'; title: string }) {
        const cards = (lists as any)[status] as Card[] || []
        return (
            <div style={{ background: '#ebecf0', padding: 8, borderRadius: 6, width: 272 }}>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>{title}</div>
                <AddRow status={status} position="top" />
                <div>
                    {cards.map((c) => (
                        <div key={c.id} style={{ background: '#fff', borderRadius: 4, padding: 8, marginBottom: 8 }}>
                            <div>{c.title}</div>
                        </div>
                    ))}
                </div>
                <AddRow status={status} position="bottom" />
            </div>
        )
    }

    if (loading && !board) return <div>加载中...</div>

    return (
        <div style={{ display: 'flex', gap: 12, padding: 12, overflowX: 'auto' }}>
            <List status="todo" title="待办" />
            <List status="doing" title="进行中" />
            <List status="done" title="已完成" />
        </div>
    )
}