import { useMemo } from 'react'
import { useParams } from 'react-router-dom'
import BoardView from '../components/BoardView'

export default function BoardPage() {
    const { projectId = '', boardName = '' } = useParams()
    const user = useMemo(() => localStorage.getItem('kanbanUser') || 'guest', [])
    return (
        <BoardView user={user} projectId={projectId} boardName={decodeURIComponent(boardName)} />
    )
}