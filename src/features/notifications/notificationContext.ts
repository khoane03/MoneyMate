import { createContext, useContext } from 'react'

export type PartnerNotification = {
  id: string
  connection_id: string | null
  event_type: string
  entity_type: 'shared_expense' | 'settlement' | 'admin_notice' | 'direct_debt' | 'payment_request' | 'planned_expense'
  entity_id: string
  title: string
  body: string
  created_at: string
  read_at: string | null
}
export type IncomingAlert = { id: string; title: string; body: string }

export type RealtimeState = 'connecting' | 'connected' | 'offline' | 'unavailable'
export type NotificationContextValue = {
  notifications: PartnerNotification[]
  unreadCount: number
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string
  realtime: RealtimeState
  announcement: string
  incomingAlert: IncomingAlert | null
  dismissIncomingAlert: () => void
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  markRead: (id: string) => Promise<boolean>
  markAllRead: () => Promise<boolean>
}

export const NotificationContext = createContext<NotificationContextValue | null>(null)

export function useNotifications() {
  const value = useContext(NotificationContext)
  if (!value) throw new Error('useNotifications must be used inside NotificationProvider')
  return value
}
