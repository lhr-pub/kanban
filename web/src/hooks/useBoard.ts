import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardAPI } from '../lib/api'
import { useWebSocket } from '../lib/ws'
import type { BoardData, Card, CardId, StatusId } from '../types'

interface UseBoardOptions {
    user: string
    projectId: string
    boardName: string
}

export function useBoard(opts: UseBoardOptions) {
    const { socket, ready, send } = useWebSocket()
    const [board, setBoard] = useState<BoardData | null>(null)
    const [onlineUsers, setOnlineUsers] = useState<string[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const subsReady = useRef(false)

    // initial load
    useEffect(() => {
        let mounted = true
        setLoading(true)
        setError(null)
        BoardAPI.getBoard(opts.projectId, opts.boardName)
            .then((data) => { if (mounted) setBoard(data) })
            .catch((e) => { if (mounted) setError(e?.message || '加载看板失败') })
            .finally(() => { if (mounted) setLoading(false) })
        return () => { mounted = false }
    }, [opts.projectId, opts.boardName])

    // websocket join + handlers
    useEffect(() => {
        if (!ready || !socket) return
        send({ type: 'join', user: opts.user, projectId: opts.projectId, boardName: opts.boardName })

        const onMessage = (ev: MessageEvent) => {
            try {
                const data = JSON.parse(ev.data)
                if (!data) return
                switch (data.type) {
                    case 'board-update':
                        if (data.projectId === opts.projectId && data.boardName === opts.boardName) {
                            setBoard(data.board)
                        }
                        break
                    case 'user-list':
                        if (data.projectId === opts.projectId && data.boardName === opts.boardName) {
                            setOnlineUsers(data.users || [])
                        }
                        break
                }
            } catch { }
        }
        socket.addEventListener('message', onMessage)
        subsReady.current = true
        return () => {
            subsReady.current = false
            try { socket.removeEventListener('message', onMessage) } catch { }
        }
    }, [ready, socket, send, opts.user, opts.projectId, opts.boardName])

    const addCard = useCallback((status: StatusId, card: Card, position: 'top' | 'bottom' = 'top') => {
        send({ type: 'add-card', projectId: opts.projectId, boardName: opts.boardName, status, card, position })
    }, [send, opts.projectId, opts.boardName])

    const updateCard = useCallback((cardId: CardId, updates: Partial<Card>) => {
        send({ type: 'update-card', projectId: opts.projectId, boardName: opts.boardName, cardId, updates })
    }, [send, opts.projectId, opts.boardName])

    const moveCard = useCallback((cardId: CardId, fromStatus: StatusId, toStatus: StatusId) => {
        send({ type: 'move-card', projectId: opts.projectId, boardName: opts.boardName, cardId, fromStatus, toStatus })
    }, [send, opts.projectId, opts.boardName])

    const reorderCards = useCallback((status: StatusId, orderedIds: CardId[]) => {
        send({ type: 'reorder-cards', projectId: opts.projectId, boardName: opts.boardName, status, orderedIds })
    }, [send, opts.projectId, opts.boardName])

    const value = useMemo(() => ({
        board, onlineUsers, loading, error,
        addCard, updateCard, moveCard, reorderCards
    }), [board, onlineUsers, loading, error, addCard, updateCard, moveCard, reorderCards])

    return value
}