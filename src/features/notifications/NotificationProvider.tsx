import { Button as CommonButton } from '../../shared/ui/Controls'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RealtimeChannel } from '@supabase/supabase-js'
import { Bell, X } from 'lucide-react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { NotificationContext, type IncomingAlert, type PartnerNotification, type RealtimeState } from './notificationContext'

const NOTIFICATION_PAGE_SIZE = 50

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<PartnerNotification[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const [loading, setLoading] = useState(Boolean(supabase))
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState('')
  const [realtime, setRealtime] = useState<RealtimeState>(supabase ? 'connecting' : 'unavailable')
  const [announcement, setAnnouncement] = useState('')
  const [incomingAlert, setIncomingAlert] = useState<IncomingAlert | null>(null)
  const alertTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dismissIncomingAlert = useCallback(() => {
    setIncomingAlert(null)
    if (alertTimer.current) clearTimeout(alertTimer.current)
  }, [])

  const showIncomingAlert = useCallback((item: PartnerNotification) => {
    setIncomingAlert({ id: item.id, title: item.title, body: item.body })
    setAnnouncement(`Thông báo mới: ${item.title}. ${item.body}`)
    if (alertTimer.current) clearTimeout(alertTimer.current)
    alertTimer.current = setTimeout(() => setIncomingAlert(null), 5000)
  }, [])

  const refresh = useCallback(async () => {
    if (!supabase) {
      setNotifications([])
      setUnreadCount(0)
      setLoading(false)
      setRealtime('unavailable')
      setError('Thông báo cần được kết nối với Supabase.')
      return
    }

    const client = supabase
    const { data: authData, error: authError } = await client.auth.getUser()
    if (authError || !authData.user) {
      setNotifications([])
      setUnreadCount(0)
      setLoading(false)
      setError('Cần đăng nhập để xem thông báo.')
      return
    }

    const [listResult, countResult] = await Promise.all([
      client.from('notifications').select('id,connection_id,event_type,entity_type,entity_id,title,body,created_at,read_at')
        .eq('recipient_id', authData.user.id).order('created_at', { ascending: false }).order('id', { ascending: false }).range(0, NOTIFICATION_PAGE_SIZE - 1),
      client.from('notifications').select('id', { count: 'exact', head: true })
        .eq('recipient_id', authData.user.id).is('read_at', null),
    ])

    if (listResult.error || countResult.error) {
      setError('Không tải được thông báo. Kiểm tra migration và quyền truy cập rồi thử lại.')
    } else {
      setNotifications((listResult.data ?? []) as PartnerNotification[])
      setHasMore((listResult.data ?? []).length === NOTIFICATION_PAGE_SIZE)
      setUnreadCount(countResult.count ?? 0)
      setError('')
    }
    setLoading(false)
  }, [])

  const loadMore = useCallback(async () => {
    if (!supabase || loadingMore || !hasMore) return
    setLoadingMore(true)
    const from = notifications.length
    const { data: authData, error: authError } = await supabase.auth.getUser()
    if (authError || !authData.user) {
      setError('Cần đăng nhập để tải thêm thông báo.')
      setLoadingMore(false)
      return
    }
    const { data, error: listError } = await supabase.from('notifications')
      .select('id,connection_id,event_type,entity_type,entity_id,title,body,created_at,read_at')
      .eq('recipient_id', authData.user.id)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(from, from + NOTIFICATION_PAGE_SIZE - 1)
    if (listError) setError('Không tải thêm được thông báo. Hãy thử lại.')
    else {
      const page = (data ?? []) as PartnerNotification[]
      setNotifications(current => [...current, ...page])
      setHasMore(page.length === NOTIFICATION_PAGE_SIZE)
      setError('')
    }
    setLoadingMore(false)
  }, [hasMore, loadingMore, notifications.length])

  useEffect(() => {
    if (!supabase) {
      setRealtime('unavailable')
      setLoading(false)
      setError('Thông báo cần được kết nối với Supabase.')
      return
    }

    let disposed = false
    let channel: RealtimeChannel | null = null
    const client = supabase
    void client.auth.getUser().then(({ data, error: authError }) => {
      if (disposed) return
      if (authError || !data.user) {
        setRealtime('unavailable')
        setLoading(false)
        return
      }

      const userId = data.user.id
      const reconcileReminders = () => {
        void (async () => {
          try { await client.rpc('process_due_direct_debt_reminders') } catch { /* Older schemas may not have this optional RPC yet. */ }
          if (!disposed) void refresh()
        })()
      }
      reconcileReminders()
      channel = client.channel(`notifications:${userId}`)
        .on('postgres_changes', {
          event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}`,
        }, payload => {
          if (disposed) return
          if (payload.eventType === 'INSERT') {
            showIncomingAlert(payload.new as PartnerNotification)
          }
          void refresh()
        })
        .subscribe(status => {
          if (disposed) return
          if (status === 'SUBSCRIBED') {
            setRealtime('connected')
            // Reconcile from durable storage after every (re)connection.
            reconcileReminders()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setRealtime('offline')
          }
        })
    })

    return () => {
      disposed = true
      if (channel) void client.removeChannel(channel)
    }
  }, [refresh, showIncomingAlert])

  useEffect(() => () => { if (alertTimer.current) clearTimeout(alertTimer.current) }, [])

  const markRead = useCallback(async (id: string) => {
    if (!supabase) return false
    const { error: rpcError } = await supabase.rpc('mark_notification_read', { p_notification_id: id })
    if (rpcError) {
      setError('Không thể cập nhật trạng thái thông báo. Hãy thử lại khi có mạng.')
      return false
    }
    await refresh()
    return true
  }, [refresh])

  const markAllRead = useCallback(async () => {
    if (!supabase) return false
    const { error: rpcError } = await supabase.rpc('mark_all_notifications_read')
    if (rpcError) {
      setError('Không thể đánh dấu đã đọc. Hãy thử lại khi có mạng.')
      return false
    }
    await refresh()
    return true
  }, [refresh])

  const value = useMemo(() => ({ notifications, unreadCount, loading, loadingMore, hasMore, error, realtime, announcement, incomingAlert, dismissIncomingAlert, refresh, loadMore, markRead, markAllRead }),
    [notifications, unreadCount, loading, loadingMore, hasMore, error, realtime, announcement, incomingAlert, dismissIncomingAlert, refresh, loadMore, markRead, markAllRead])

  return <NotificationContext.Provider value={value}>{children}
    <span className="visually-hidden" aria-live="polite" aria-atomic="true">{announcement}</span>
    {incomingAlert && <aside className="realtime-notice-toast" role="alert" aria-live="assertive" aria-atomic="true">
      <span className="realtime-notice-toast-icon"><Bell size={19} aria-hidden="true" /></span>
      <div className="realtime-notice-toast-copy"><strong>{incomingAlert.title}</strong><p>{incomingAlert.body}</p><Link to="/notifications" onClick={dismissIncomingAlert}>Xem thông báo</Link></div>
      <CommonButton type="button" onClick={dismissIncomingAlert} aria-label="Đóng thông báo mới"><X size={18} aria-hidden="true" /></CommonButton>
    </aside>}
  </NotificationContext.Provider>
}
