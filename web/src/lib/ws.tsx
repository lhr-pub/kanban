import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'

export type WsMessage = any

interface WebSocketContextValue {
    socket: WebSocket | null
    ready: boolean
    send: (data: any) => void
}

const WebSocketContext = createContext<WebSocketContextValue>({ socket: null, ready: false, send: () => { } })

export function WebSocketProvider({ children }: { children: React.ReactNode }) {
    const [ready, setReady] = useState(false)
    const socketRef = useRef<WebSocket | null>(null)

    useEffect(() => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = `${protocol}//${window.location.host}/ws`
        const s = new WebSocket(url)
        socketRef.current = s
        function cleanup() {
            try { s.close() } catch { }
        }
        s.onopen = () => setReady(true)
        s.onclose = () => setReady(false)
        s.onerror = () => setReady(false)
        return cleanup
    }, [])

    const value = useMemo<WebSocketContextValue>(() => ({
        socket: socketRef.current,
        ready,
        send: (data: any) => {
            const s = socketRef.current
            if (s && s.readyState === WebSocket.OPEN) {
                s.send(typeof data === 'string' ? data : JSON.stringify(data))
            }
        }
    }), [ready])

    return (
        <WebSocketContext.Provider value={value}>
            {children}
        </WebSocketContext.Provider>
    )
}

export function useWebSocket() {
    return useContext(WebSocketContext)
}