export type CardId = string
export type StatusId = string

export interface Card {
    id: CardId
    title: string
    description?: string
    author?: string
    assignee?: string
    created?: string
    deadline?: string
    labels?: string[]
    posts?: Array<{ id: string; author: string; text: string; created: string; updated?: string }>
    commentsCount?: number
    attachmentsCount?: number
    priority?: 'low' | 'med' | 'high'
}

export interface ListsConfig {
    listIds: StatusId[]
    lists: Record<StatusId, { id: StatusId; title: string; status: StatusId }>
}

export interface BoardData {
    todo?: Card[]
    doing?: Card[]
    done?: Card[]
    archived?: Card[]
    lists?: ListsConfig
}