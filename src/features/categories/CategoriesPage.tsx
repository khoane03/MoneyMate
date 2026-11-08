import { Button as CommonButton } from '../../shared/ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, FolderOpen, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { z } from 'zod'
import { supabase } from '../../shared/lib/supabase'
import { fetchAllPages } from '../../shared/lib/pagination'
import { LoadingModal } from '../../shared/ui/LoadingModal'
import { useConfirm } from '../../shared/ui/useConfirm'
import { Button, Dropdown, Input } from '../../shared/ui/Controls'

type Category = { id: string; owner_id: string | null; name: string; kind: 'income' | 'expense' }
const categorySchema = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['income', 'expense']) })

export function CategoriesPage() {
  const confirm = useConfirm()
  const [userId, setUserId] = useState('')
  const [categories, setCategories] = useState<Category[]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'income' | 'expense'>('expense')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return }
    const client = supabase
    setLoading(true); setError('')
    const [{ data: user, error: authError }, result] = await Promise.all([
      client.auth.getUser(),
      fetchAllPages((from, to) => client.from('categories').select('id,owner_id,name,kind')
        .order('kind').order('created_at', { ascending: false }).order('id', { ascending: false })
        .range(from, to), 50)
    ])
    if (authError || result.error) setError('Không tải được danh mục. Hãy kiểm tra kết nối rồi thử lại.')
    else { setUserId(user.user?.id ?? ''); setCategories((result.data ?? []) as Category[]) }
    setLoading(false)
  }, [])
  useEffect(() => { void refresh() }, [refresh])

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(''); setMessage('')
    const parsed = categorySchema.safeParse({ name, kind })
    if (!parsed.success) { setError('Tên danh mục cần từ 1 đến 80 ký tự.'); return }
    if (!userId || !supabase) { setError('Bạn cần đăng nhập để tạo danh mục.'); return }
    setBusy(true)
    const { error: saveError } = await supabase.from('categories').insert({ owner_id: userId, name: parsed.data.name, kind: parsed.data.kind })
    if (saveError) setError(saveError.code === '23505' ? 'Danh mục cùng tên đã tồn tại trong nhóm này.' : 'Không thể tạo danh mục. Kiểm tra quyền truy cập rồi thử lại.')
    else { setName(''); setMessage('Đã thêm danh mục.'); await refresh() }
    setBusy(false)
  }

  async function remove(category: Category) {
    if (!supabase || category.owner_id !== userId) return
    const accepted = await confirm({ title: 'Xóa danh mục?', description: `Danh mục “${category.name}” sẽ bị xóa. Giao dịch cũ được giữ nguyên; nếu có tham chiếu đang hoạt động, máy chủ sẽ từ chối thao tác.`, confirmLabel: 'Xóa danh mục', tone: 'danger' })
    if (!accepted) return
    setError(''); setMessage('')
    const { error: deleteError } = await supabase.from('categories').delete().eq('id', category.id).eq('owner_id', userId)
    if (deleteError) setError('Danh mục đang được giao dịch hoặc ngân sách sử dụng, nên chưa thể xóa.')
    else { setMessage('Đã xóa danh mục.'); await refresh() }
  }

  const expenseCategories = categories.filter(category => category.kind === 'expense')
  const incomeCategories = categories.filter(category => category.kind === 'income')
  return <section className="categories-page" aria-labelledby="categories-title">
    <LoadingModal message="Đang tải danh mục thu chi…" show={loading} />
    <header className="content-heading"><div><p className="eyebrow">CÁCH PHÂN LOẠI DÒNG TIỀN</p><h1 id="categories-title">Danh mục</h1><p className="subheading">Danh mục cá nhân của bạn chỉ hiển thị với tài khoản này.</p></div></header>
    {error && <div className="form-error" role="alert">{error}<Button onClick={() => void refresh()}>Thử lại</Button></div>}{message && <p className="budget-success" role="status">{message}</p>}
    <form className="category-form" onSubmit={create}><div><h2>Thêm danh mục</h2><p>Tạo nhóm phù hợp với cách bạn theo dõi thu nhập và chi tiêu.</p></div><div className="category-field"><label htmlFor="category-kind">Loại</label><Dropdown id="category-kind" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="expense">Chi tiêu</option><option value="income">Thu nhập</option></Dropdown></div><div className="category-field"><label htmlFor="category-name">Tên danh mục</label><Input id="category-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required autoComplete="off"/></div><Button type="submit" variant="primary" className="mobile-plus-action" aria-label="Thêm danh mục" title="Thêm danh mục" disabled={busy}>{busy ? <LoaderCircle size={18} className="spin" aria-hidden="true"/> : <><Plus size={17} aria-hidden="true"/><span className="mobile-plus-label">Thêm danh mục</span></>}</Button></form>
    {loading ? null : <div className="category-groups"><CategoryGroup title="Chi tiêu" kind="expense" rows={expenseCategories} userId={userId} onRemove={remove}/><CategoryGroup title="Thu nhập" kind="income" rows={incomeCategories} userId={userId} onRemove={remove}/></div>}
  </section>
}

function CategoryGroup({ title, kind, rows, userId, onRemove }: { title: string; kind: 'income' | 'expense'; rows: Category[]; userId: string; onRemove: (category: Category) => void }) {
  const Icon = kind === 'income' ? ArrowDownLeft : ArrowUpRight
  return <section className="category-group"><header><span className={`category-group-icon ${kind}`}><Icon size={17}/></span><div><h2>{title}</h2><small>{rows.length} danh mục</small></div></header>{rows.length === 0 ? <div className={`category-empty ${kind}`} role="status"><span className="category-empty-icon" aria-hidden="true"><FolderOpen size={18}/></span><span><strong>Chưa có danh mục {kind === 'income' ? 'thu nhập' : 'chi tiêu'}</strong><small>{kind === 'income' ? 'Chọn “Thu nhập” ở biểu mẫu phía trên để thêm danh mục đầu tiên.' : 'Chọn “Chi tiêu” ở biểu mẫu phía trên để thêm danh mục đầu tiên.'}</small></span></div> : <ul>{rows.map(category => <li key={category.id}><span>{category.name}</span>{category.owner_id === null ? <small>Mặc định</small> : <CommonButton type="button" onClick={() => onRemove(category)} aria-label={`Xóa danh mục ${category.name}`} disabled={category.owner_id !== userId}><Trash2 size={16}/></CommonButton>}</li>)}</ul>}</section>
}
