import { Button as CommonButton, Input as CommonInput, Dropdown as CommonDropdown, Textarea as CommonTextarea } from '../../shared/ui/Controls'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Bell, Check, Clipboard, LoaderCircle, Megaphone, RotateCw, Save, ShieldCheck, Tags, Users, LockKeyhole, WifiOff, UnlockKeyhole, CircleCheck, UserRound, Activity, Network, Ban, UserRoundCheck, Plus } from 'lucide-react'
import { supabase } from '../../shared/lib/supabase'
import { parsePublicNoticeInput, parseSystemCategoryInput, type SystemCategoryInput } from '../../shared/lib/adminValidation'
import { formatDate, formatDateTime } from '../../shared/lib/dateFormat'
import { useConfirm } from '../../shared/ui/useConfirm'

type UserRecord = { id:string; email:string; created_at:string; last_sign_in_at:string|null; email_confirmed_at:string|null; banned_until:string|null; is_admin?:boolean }
type LockedUserRecord = Omit<UserRecord,'banned_until'> & { banned_until:string }
type CategoryRecord = { id:string; kind:'income'|'expense'; name:string; icon:string|null; color:string|null }
type PublicSettings = { notice_active:boolean; notice_title:string; notice_body:string; updated_at:string }
type UsageMetrics = { total_accounts:number; total_visits:number; visits_30d:number; total_requests:number; active_accounts_30d:number }
type AdminAction = 'status'|'list_users'|'list_accounts'|'list_locked_users'|'get_usage_metrics'|'ban_user'|'unban_user'|'list_categories'|'save_category'|'delete_category'|'get_public_settings'|'save_public_settings'
type AdminResponse<T> = T & { error?:string }
type AdminError = Error & { code?:string }
const emptyCategory:Omit<SystemCategoryInput,'id'>={kind:'expense',name:'',icon:'',color:'#5D7B6F'}
const emptySettings:PublicSettings={notice_active:false,notice_title:'',notice_body:'',updated_at:''}

async function callAdmin<T>(action:AdminAction,fields:Record<string,unknown>={}):Promise<AdminResponse<T>> {
  if(!supabase)throw Object.assign(new Error('Supabase chưa được cấu hình.'),{code:'not_configured'})
  const {data,error}=await supabase.functions.invoke('admin',{body:{action,...fields}})
  if(error){
    let payload:{error?:string;code?:string;message?:string}|null=null
    if('context' in error&&error.context&&typeof error.context==='object'&&'clone' in error.context){
      try{payload=await (error.context as Response).clone().json()}catch{payload=null}
    }
    const code=payload?.error??payload?.code??error.message
    throw Object.assign(new Error(code),{code}) as AdminError
  }
  if(!data)throw Object.assign(new Error('Máy chủ không trả dữ liệu.'),{code:'empty_response'})
  return data as AdminResponse<T>
}

function friendlyAdminError(error:unknown){
  const code=(error as AdminError)?.code??''
  if(code==='admin_access_required')return 'Tài khoản này chưa được cấp quyền quản trị.'
  if(code==='admin_schema_unavailable')return 'Chưa áp dụng migration 202611070005_admin_console trên Supabase.'
  if(code==='category_name_exists')return 'Đã có danh mục hệ thống cùng tên và loại.'
  if(code==='category_in_use_or_delete_failed')return 'Danh mục đang được giao dịch hoặc ngân sách sử dụng nên không thể xóa.'
  if(code==='cannot_ban_admin')return 'Không thể khóa một tài khoản quản trị.'
  if(code==='cannot_modify_admin_account')return 'Không thể khóa hoặc mở khóa tài khoản quản trị.'
  if(code==='accounts_unavailable')return 'Không tải được toàn bộ tài khoản. Hãy thử lại sau.'
  if(code==='usage_metrics_unavailable')return 'Chưa tải được số liệu truy cập và requests.'
  if(code==='admins_unavailable'||code==='admin_account_details_unavailable')return 'Không tải được danh sách tài khoản quản trị. Hãy thử lại sau.'
  if(code==='locked_users_unavailable')return 'Không tải được danh sách tài khoản đang bị khóa. Hãy thử tải lại.'
  if(code==='invalid_locked_user_cursor')return 'Danh sách tài khoản bị khóa đã thay đổi. Hãy tải lại để làm mới.'
  if(code==='function_not_found'||code.includes('not found')||code.includes('Failed to send a request'))return 'Edge Function admin chưa được triển khai hoặc chưa cấu hình đúng.'
  if(code==='invalid_public_notice')return 'Thông báo đang bật cần có tiêu đề và nội dung; tiêu đề tối đa 100 ký tự, nội dung tối đa 500 ký tự.'
  if(code==='admin_function_not_configured')return 'Thiếu cấu hình máy chủ cho Edge Function admin.'
  if(code==='NOT_FOUND')return 'Edge Function admin chưa được triển khai trên Supabase.'
  return 'Không hoàn tất được thao tác quản trị. Tải lại dữ liệu và thử lại.'
}

export function AdminPage(){
  const confirm=useConfirm()
  const [userId,setUserId]=useState('')
  const [access,setAccess]=useState<'checking'|'admin'|'denied'|'setup'|'error'>('checking')
  const [tab,setTab]=useState<'users'|'categories'|'settings'>('users')
  const [accountView,setAccountView]=useState<'all'|'admins'|'locked'>('all')
  const [error,setError]=useState('')
  const [notice,setNotice]=useState('')
  const [busy,setBusy]=useState(false)
  const [dataLoading,setDataLoading]=useState(false)
  const [copied,setCopied]=useState(false)
  const [users,setUsers]=useState<UserRecord[]>([])
  const [allAccounts,setAllAccounts]=useState<UserRecord[]>([])
  const [allAccountsPage,setAllAccountsPage]=useState(1)
  const [hasMoreAccounts,setHasMoreAccounts]=useState(false)
  const [userPage,setUserPage]=useState(1)
  const [hasMoreUsers,setHasMoreUsers]=useState(false)
  const [lockedUsers,setLockedUsers]=useState<LockedUserRecord[]>([])
  const [lockedCursor,setLockedCursor]=useState<number|null>(null)
  const [hasMoreLocked,setHasMoreLocked]=useState(false)
  const [categories,setCategories]=useState<CategoryRecord[]>([])
  const [categoryPage,setCategoryPage]=useState(1)
  const [hasMoreCategories,setHasMoreCategories]=useState(false)
  const [categoryForm,setCategoryForm]=useState<SystemCategoryInput>({id:null,...emptyCategory})
  const [settings,setSettings]=useState<PublicSettings>(emptySettings)
  const [metrics,setMetrics]=useState<UsageMetrics|null>(null)
  const [metricsLoading,setMetricsLoading]=useState(true)

  const refreshUsers=useCallback(async(page:number)=>{
    const result=await callAdmin<{users:UserRecord[];page:number;has_more:boolean}>('list_users',{page})
    setUsers(result.users??[]);setUserPage(page);setHasMoreUsers(Boolean(result.has_more))
  },[])
  const refreshAllAccounts=useCallback(async(page:number)=>{
    const result=await callAdmin<{users:UserRecord[];page:number;has_more:boolean}>('list_accounts',{page})
    setAllAccounts(result.users??[]);setAllAccountsPage(page);setHasMoreAccounts(Boolean(result.has_more))
  },[])
  const refreshMetrics=useCallback(async()=>{
    setMetricsLoading(true)
    try{
      const result=await callAdmin<{metrics:UsageMetrics}>('get_usage_metrics')
      setMetrics(result.metrics)
    }finally{setMetricsLoading(false)}
  },[])
  const refreshLockedUsers=useCallback(async(append=false)=>{
    const result=await callAdmin<{users:LockedUserRecord[];next_cursor:number|null;has_more:boolean}>('list_locked_users',append&&lockedCursor?{cursor:lockedCursor}:{})
    setLockedUsers(current=>append?[...current,...(result.users??[])]:result.users??[])
    setLockedCursor(result.next_cursor??null);setHasMoreLocked(Boolean(result.has_more))
  },[lockedCursor])
  const refreshCategories=useCallback(async(page=1,append=false)=>{
    const result=await callAdmin<{categories:CategoryRecord[];page:number;has_more:boolean}>('list_categories',{page})
    setCategories(current=>append?[...current,...(result.categories??[])]:result.categories??[])
    setCategoryPage(page);setHasMoreCategories(Boolean(result.has_more))
  },[])
  const refreshSettings=useCallback(async()=>{
    const result=await callAdmin<{settings:PublicSettings}>('get_public_settings')
    setSettings(result.settings??emptySettings)
  },[])

  useEffect(()=>{
    let mounted=true
    void(async()=>{
      const {data}=await supabase?.auth.getUser()??{data:{user:null}}
      if(!mounted)return
      if(data.user)setUserId(data.user.id)
      try{
        await callAdmin<{is_admin:boolean}>('status')
        if(!mounted)return
        setAccess('admin')
      }catch(cause){
        if(!mounted)return
        const code=(cause as AdminError)?.code
        if(code==='admin_access_required'){setAccess('denied');return}
        if(code==='admin_schema_unavailable'){setAccess('setup');setError(friendlyAdminError(cause));return}
        setAccess('error');setError(friendlyAdminError(cause))
      }
    })()
    return()=>{mounted=false}
  },[])

  useEffect(()=>{
    if(access!=='admin')return
    setError('');setDataLoading(true)
    void(tab==='users'?(accountView==='all'?refreshAllAccounts(1):accountView==='admins'?refreshUsers(1):refreshLockedUsers()):tab==='categories'?refreshCategories():refreshSettings()).catch(cause=>setError(friendlyAdminError(cause))).finally(()=>setDataLoading(false))
  },[access,tab,accountView,refreshAllAccounts,refreshUsers,refreshLockedUsers,refreshCategories,refreshSettings])

  useEffect(()=>{
    if(access!=='admin')return
    void refreshMetrics().catch(cause=>setError(friendlyAdminError(cause)))
  },[access,refreshMetrics])

  async function reload(){
    setBusy(true);setError('')
    try{if(tab==='users'){if(accountView==='all')await refreshAllAccounts(allAccountsPage);else if(accountView==='admins')await refreshUsers(userPage);else await refreshLockedUsers()}else if(tab==='categories')await refreshCategories();else await refreshSettings();if(access==='admin')await refreshMetrics();setNotice('Đã tải dữ liệu mới.')}
    catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  async function loadAdminPage(page:number){
    setDataLoading(true);setError('')
    try{await refreshUsers(page)}catch(cause){setError(friendlyAdminError(cause))}finally{setDataLoading(false)}
  }

  async function loadMoreLockedUsers(){
    setDataLoading(true);setError('')
    try{await refreshLockedUsers(true)}catch(cause){setError(friendlyAdminError(cause))}finally{setDataLoading(false)}
  }

  async function unlockUser(user:UserRecord){
    const accepted=await confirm({title:'Mở khóa tài khoản?',description:`${user.email||user.id} sẽ có thể đăng nhập lại.`,confirmLabel:'Mở khóa',tone:'warning'})
    if(!accepted)return
    setBusy(true);setError('');setNotice('')
    try{await callAdmin('unban_user',{user_id:user.id});await refreshLockedUsers();setNotice('Đã mở khóa tài khoản.')}
    catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  async function changeAccountAccess(user:UserRecord){
    if(user.is_admin)return
    const banned=Boolean(user.banned_until&&Date.parse(user.banned_until)>Date.now())
    const accepted=await confirm({
      title:banned?'Mở khóa tài khoản?':'Khóa tài khoản trong 30 ngày?',
      description:banned?`${user.email||user.id} sẽ có thể đăng nhập lại.`:`${user.email||user.id} sẽ không thể đăng nhập trong 30 ngày. Thao tác được ghi vào nhật ký quản trị.`,
      confirmLabel:banned?'Mở khóa':'Khóa tài khoản',tone:banned?'warning':'danger',
    })
    if(!accepted)return
    setBusy(true);setError('');setNotice('')
    try{
      await callAdmin(banned?'unban_user':'ban_user',{user_id:user.id})
      await refreshAllAccounts(allAccountsPage)
      setNotice(banned?'Đã mở khóa tài khoản.':'Đã khóa tài khoản trong 30 ngày.')
    }catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  async function copyBootstrap(){
    if(!userId)return
    const sql=`insert into public.admin_users(user_id,granted_by) values ('${userId}','${userId}') on conflict (user_id) do nothing;`
    try{await navigator.clipboard.writeText(sql);setCopied(true);setNotice('Đã sao chép câu lệnh cấp admin. Chỉ chạy trong SQL Editor của Supabase nếu đây là tài khoản quản trị bạn chọn.')}
    catch{setNotice(sql)}
  }

  async function saveCategory(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setNotice('')
    const input=parseSystemCategoryInput(categoryForm)
    if(!input){setError('Kiểm tra tên danh mục, loại và mã màu dạng #RRGGBB.');return}
    setBusy(true)
    try{await callAdmin('save_category',{category:input});setCategoryForm({id:null,...emptyCategory});await refreshCategories();setNotice(input.id?'Đã cập nhật danh mục hệ thống.':'Đã thêm danh mục hệ thống.')}
    catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  async function deleteCategory(category:CategoryRecord){
    const accepted=await confirm({title:'Xóa danh mục hệ thống?',description:`Danh mục “${category.name}” sẽ bị xóa. Nếu đang được giao dịch hoặc ngân sách sử dụng, máy chủ sẽ từ chối thao tác.`,confirmLabel:'Xóa danh mục',tone:'danger'})
    if(!accepted)return
    setBusy(true);setError('');setNotice('')
    try{await callAdmin('delete_category',{category_id:category.id});await refreshCategories();setNotice('Đã xóa danh mục hệ thống.')}
    catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  async function saveSettings(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();setError('');setNotice('')
    const input=parsePublicNoticeInput({active:settings.notice_active,title:settings.notice_title,body:settings.notice_body})
    if(!input){setError(friendlyAdminError({code:'invalid_public_notice'}));return}
    setBusy(true)
    try{const result=await callAdmin<{settings:PublicSettings}>('save_public_settings',{settings:input});setSettings(result.settings);setNotice('Đã cập nhật thông báo ứng dụng.')}
    catch(cause){setError(friendlyAdminError(cause))}finally{setBusy(false)}
  }

  if(access==='checking')return <section className="admin-page"><div className="admin-state-card" role="status"><span className="admin-state-icon"><LoaderCircle className="spin" size={25}/></span><p className="eyebrow">KHU VỰC QUẢN TRỊ</p><h1>Đang kiểm tra quyền truy cập</h1><p>Đang xác thực tài khoản với máy chủ bảo mật.</p></div></section>
  if(access==='denied'||access==='setup')return <section className="admin-page" aria-labelledby="admin-title"><div className="admin-state-card" role="alert"><span className="admin-state-icon"><LockKeyhole size={25}/></span><p className="eyebrow">KHU VỰC GIỚI HẠN</p><h1 id="admin-title">{access==='denied'?'Tài khoản chưa có quyền quản trị':'Chưa sẵn sàng'}</h1><p>{access==='denied'?'Tài khoản hiện tại không thể xem hoặc thay đổi dữ liệu quản trị.':'Máy chủ quản trị chưa được cấu hình đầy đủ. Hãy kiểm tra migration và Edge Function.'}</p>{access==='denied'&&userId&&<details className="admin-bootstrap"><summary>Hướng dẫn cấp quyền ban đầu</summary><label htmlFor="admin-user-id">ID tài khoản hiện tại</label><code id="admin-user-id">{userId}</code><p>Chỉ người có quyền quản trị Supabase mới được thực hiện câu lệnh này:</p><pre>{`insert into public.admin_users(user_id,granted_by) values ('${userId}','${userId}') on conflict (user_id) do nothing;`}</pre><CommonButton type="button" className="secondary-button" onClick={()=>void copyBootstrap()}><Clipboard size={16}/>{copied?'Đã sao chép':'Sao chép câu lệnh'}</CommonButton><small>Tài khoản thường không thể tự cấp quyền cho mình.</small></details>}</div></section>
  if(access==='error')return <section className="admin-page"><div className="admin-state-card" role="alert"><span className="admin-state-icon"><WifiOff size={25}/></span><p className="eyebrow">KHÔNG KẾT NỐI ĐƯỢC</p><h1>Chưa thể mở khu vực quản trị</h1><p>{error}</p><CommonButton type="button" className="primary-button" onClick={()=>window.location.reload()}><RotateCw size={16}/>Thử kết nối lại</CommonButton></div></section>

  return <section className="admin-page" aria-labelledby="admin-title">
    <header className="admin-hero"><div className="admin-hero-copy"><p className="eyebrow">MONEYMATE · QUẢN TRỊ HỆ THỐNG</p><h1 id="admin-title">Trung tâm quản trị</h1><p className="subheading">Quản lý quyền admin, danh mục dùng chung và thông báo trong ứng dụng.</p></div><CommonButton type="button" className="secondary-button" onClick={()=>void reload()} disabled={busy}><RotateCw size={16} className={busy?'spin':''}/>Tải lại</CommonButton></header>
    <div className="admin-security-note"><ShieldCheck size={17}/><span>Quyền được kiểm tra ở máy chủ. Ví, giao dịch và hóa đơn riêng tư không hiển thị tại đây.</span></div>
    <section className="admin-metrics" aria-label="Số liệu sử dụng">
      <header><div><p className="eyebrow">TỔNG QUAN SỬ DỤNG</p><h2>Hoạt động hệ thống</h2></div><span>Đã xác thực</span></header>
      <div className="admin-metric-grid">
        <article><span className="admin-metric-icon"><UserRound size={18}/></span><div><small>Tài khoản</small><strong>{metricsLoading?'…':metrics?.total_accounts.toLocaleString('vi-VN')??'—'}</strong><span>đã đăng ký</span></div></article>
        <article><span className="admin-metric-icon visits"><Activity size={18}/></span><div><small>Lượt truy cập</small><strong>{metricsLoading?'…':metrics?.total_visits.toLocaleString('vi-VN')??'—'}</strong><span>{metrics?`${metrics.visits_30d.toLocaleString('vi-VN')} trong 30 ngày`:'phiên đăng nhập đã ghi nhận'}</span></div></article>
        <article><span className="admin-metric-icon requests"><Network size={18}/></span><div><small>Requests</small><strong>{metricsLoading?'…':metrics?.total_requests.toLocaleString('vi-VN')??'—'}</strong><span>yêu cầu từ Supabase client</span></div></article>
        <article><span className="admin-metric-icon active"><Users size={18}/></span><div><small>Tài khoản hoạt động</small><strong>{metricsLoading?'…':metrics?.active_accounts_30d.toLocaleString('vi-VN')??'—'}</strong><span>có hoạt động trong 30 ngày</span></div></article>
      </div>
      <p className="admin-metrics-note">Lượt truy cập là phiên app đã đăng nhập. Requests chỉ đếm yêu cầu gửi qua Supabase client từ khi bật ghi nhận; không bao gồm Cloudinary/CDN hoặc hoạt động trước đó.</p>
    </section>
    {error&&<div className="admin-inline-error" role="alert"><AlertTriangle size={17}/><span>{error}</span><CommonButton type="button" className="text-button" onClick={()=>void reload()}>Thử lại</CommonButton></div>}{notice&&<p className="admin-notice" role="status">{notice}</p>}
    <nav className="admin-tabs" aria-label="Các mục quản trị"><CommonButton type="button" aria-pressed={tab==='users'} onClick={()=>setTab('users')}><Users size={17}/>Tài khoản</CommonButton><CommonButton type="button" aria-pressed={tab==='categories'} onClick={()=>setTab('categories')}><Tags size={17}/>Danh mục</CommonButton><CommonButton type="button" aria-pressed={tab==='settings'} onClick={()=>setTab('settings')}><Megaphone size={17}/>Thông báo</CommonButton></nav>
    {tab==='users'&&<section className="admin-panel"><header className="admin-panel-heading"><div className="admin-panel-heading-icon"><ShieldCheck size={20}/></div><div><h2>Tài khoản</h2><p>Danh sách quản trị viên và tài khoản đang bị khóa.</p></div></header>
      <nav className="admin-account-tabs" aria-label="Loại tài khoản"><CommonButton type="button" aria-pressed={accountView==='all'} onClick={()=>setAccountView('all')}><Users size={16}/>Tất cả</CommonButton><CommonButton type="button" aria-pressed={accountView==='admins'} onClick={()=>setAccountView('admins')}><ShieldCheck size={16}/>Quản trị viên</CommonButton><CommonButton type="button" aria-pressed={accountView==='locked'} onClick={()=>setAccountView('locked')}><LockKeyhole size={16}/>Đang bị khóa</CommonButton></nav>
      {accountView==='all'&&<>
        <div className="admin-section-caption"><h3>Tất cả tài khoản</h3><p>Danh sách toàn bộ tài khoản Auth, mới nhất trước. Thông tin ví và giao dịch không được truy vấn.</p></div>
        {dataLoading?<p className="data-status" role="status">Đang tải tài khoản…</p>:allAccounts.length===0?<div className="admin-empty"><Users size={22}/><strong>Chưa có tài khoản</strong><span>Không tìm thấy tài khoản trong hệ thống.</span></div>:<div className="admin-table-wrap"><table className="admin-table admin-account-table"><thead><tr><th>Tài khoản</th><th>Quyền</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th><th>Thao tác</th></tr></thead><tbody>{allAccounts.map(user=>{const banned=Boolean(user.banned_until&&Date.parse(user.banned_until)>Date.now());return <tr key={user.id}><td><strong>{user.email||'Không có email'}</strong><small>{user.id}</small><small>Tham gia {formatDate(user.created_at)}</small></td><td>{user.is_admin?<span className="admin-role-badge"><ShieldCheck size={14}/>Quản trị viên</span>:<span className="admin-user-badge">Người dùng</span>}</td><td><span className={`admin-status ${banned?'banned':user.email_confirmed_at?'active':'pending'}`}>{banned?'Đang khóa':user.email_confirmed_at?'Đang hoạt động':'Chưa xác nhận email'}</span></td><td>{user.last_sign_in_at?formatDateTime(user.last_sign_in_at):'Chưa đăng nhập'}</td><td>{user.is_admin?<span className="admin-protected-label"><ShieldCheck size={14}/>Được bảo vệ</span>:<CommonButton type="button" className={banned?'secondary-button':'admin-danger-button'} disabled={busy} onClick={()=>void changeAccountAccess(user)}>{banned?<><UserRoundCheck size={15}/>Mở khóa</>:<><Ban size={15}/>Khóa 30 ngày</>}</CommonButton>}</td></tr>})}</tbody></table></div>}
        <footer className="admin-pagination"><span>Trang {allAccountsPage} · tối đa 50 tài khoản mỗi trang</span><div><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading||allAccountsPage<=1} onClick={()=>{setDataLoading(true);void refreshAllAccounts(allAccountsPage-1).catch(cause=>setError(friendlyAdminError(cause))).finally(()=>setDataLoading(false))}}>Trước</CommonButton><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading||!hasMoreAccounts} onClick={()=>{setDataLoading(true);void refreshAllAccounts(allAccountsPage+1).catch(cause=>setError(friendlyAdminError(cause))).finally(()=>setDataLoading(false))}}>Tiếp</CommonButton></div></footer>
      </>}
      {accountView==='admins'&&<>
      <div className="admin-section-caption"><h3>Tài khoản quản trị</h3><p>Chỉ hiển thị tài khoản được cấp quyền admin trong hệ thống.</p></div>
      {dataLoading?<p className="data-status" role="status">Đang tải danh sách quản trị viên…</p>:users.length===0?<div className="admin-empty"><Users size={22}/><strong>Chưa có tài khoản quản trị khác</strong><span>Tài khoản đang dùng vẫn giữ quyền truy cập; danh sách sẽ cập nhật khi có admin được cấp quyền.</span></div>:<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Tài khoản</th><th>Quyền</th><th>Trạng thái</th><th>Đăng nhập gần nhất</th></tr></thead><tbody>{users.map(user=><tr key={user.id}><td><strong>{user.email||'Không có email'}</strong><small>{user.id}</small><small>Tham gia {formatDate(user.created_at)}</small></td><td><span className="admin-role-badge"><ShieldCheck size={14}/>Quản trị viên</span></td><td><span className={`admin-status ${user.banned_until&&new Date(user.banned_until).getTime()>Date.now()?'banned':user.email_confirmed_at?'active':'pending'}`}>{user.banned_until&&new Date(user.banned_until).getTime()>Date.now()?'Đang khóa':user.email_confirmed_at?'Đang hoạt động':'Chưa xác nhận email'}</span></td><td>{user.last_sign_in_at?formatDateTime(user.last_sign_in_at):'Chưa đăng nhập'}</td></tr>)}</tbody></table></div>}
      <footer className="admin-pagination"><span>Trang {userPage} · tối đa 50 quản trị viên mỗi trang</span><div><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading||userPage<=1} onClick={()=>void loadAdminPage(userPage-1)}>Trước</CommonButton><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading||!hasMoreUsers} onClick={()=>void loadAdminPage(userPage+1)}>Tiếp</CommonButton></div></footer>
      </>}
      {accountView==='locked'&&<>
        <div className="admin-section-caption"><h3>Tài khoản đang bị khóa</h3><p>Chỉ liệt kê tài khoản thường có trạng thái khóa còn hiệu lực. Quản trị viên được bảo vệ và không xuất hiện ở đây.</p></div>
        {dataLoading&&lockedUsers.length===0?<p className="data-status" role="status">Đang tìm tài khoản bị khóa…</p>:lockedUsers.length===0?<div className="admin-empty"><CircleCheck size={22}/><strong>Không có tài khoản đang bị khóa</strong><span>Nếu tài khoản bị khóa, danh sách sẽ xuất hiện tại đây để quản trị viên có thể mở khóa.</span></div>:<div className="admin-locked-list">{lockedUsers.map(user=><article key={user.id} className="admin-locked-card"><span className="admin-locked-icon"><LockKeyhole size={18}/></span><div className="admin-locked-main"><strong>{user.email||'Không có email'}</strong><small>{user.id}</small><span>Khóa đến {formatDateTime(user.banned_until)}</span></div><CommonButton type="button" className="secondary-button" disabled={busy} onClick={()=>void unlockUser(user)}><UnlockKeyhole size={16}/>Mở khóa</CommonButton></article>)}</div>}
        {hasMoreLocked&&<div className="admin-load-more"><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading} onClick={()=>void loadMoreLockedUsers()}>{dataLoading?<LoaderCircle size={16} className="spin"/>:<RotateCw size={16}/>}Tải thêm tài khoản</CommonButton></div>}
      </>}
    </section>}
    {tab==='categories'&&<section className="admin-panel admin-content-panel"><header className="admin-panel-heading"><span className="admin-panel-heading-icon"><Tags size={20}/></span><div><h2>Danh mục hệ thống</h2><p>Danh mục dùng chung cho mọi tài khoản. Danh mục cá nhân không xuất hiện ở đây.</p></div></header>
      <form className="admin-category-form" onSubmit={saveCategory}><div className="admin-form-title"><div><h3>{categoryForm.id?'Chỉnh sửa danh mục':'Thêm danh mục'}</h3><p>{categoryForm.id?'Cập nhật thông tin danh mục dùng chung.':'Tạo một danh mục mặc định mới.'}</p></div>{categoryForm.id&&<CommonButton type="button" className="text-button" onClick={()=>setCategoryForm({id:null,...emptyCategory})}>Hủy chỉnh sửa</CommonButton>}</div><div className="admin-form-grid"><div><label htmlFor="admin-category-name">Tên danh mục</label><CommonInput id="admin-category-name" value={categoryForm.name} maxLength={80} onChange={event=>setCategoryForm(current=>({...current,name:event.target.value}))} required/></div><div><label htmlFor="admin-category-kind">Loại giao dịch</label><CommonDropdown id="admin-category-kind" value={categoryForm.kind} disabled={Boolean(categoryForm.id)} onChange={event=>setCategoryForm(current=>({...current,kind:event.target.value as 'income'|'expense'}))}><option value="expense">Chi tiêu</option><option value="income">Thu nhập</option></CommonDropdown></div><div><label htmlFor="admin-category-icon">Tên biểu tượng (tùy chọn)</label><CommonInput id="admin-category-icon" value={categoryForm.icon??''} maxLength={48} onChange={event=>setCategoryForm(current=>({...current,icon:event.target.value}))}/></div><div><label htmlFor="admin-category-color">Màu nhận diện</label><div className="admin-color-control"><CommonInput id="admin-category-color" type="color" value={categoryForm.color??'#5D7B6F'} onChange={event=>setCategoryForm(current=>({...current,color:event.target.value}))}/><code>{(categoryForm.color??'#5D7B6F').toUpperCase()}</code><span aria-label="Xem trước màu" style={{backgroundColor:categoryForm.color??'#5D7B6F'}}/></div></div></div><CommonButton className={`primary-button ${categoryForm.id?'':'mobile-plus-action'}`} type="submit" aria-label={categoryForm.id?'Lưu danh mục':'Thêm danh mục'} title={categoryForm.id?'Lưu danh mục':'Thêm danh mục'} disabled={busy}>{categoryForm.id?<><Save size={16}/><span>Lưu danh mục</span></>:<><Plus size={16} aria-hidden="true"/><span className="mobile-plus-label">Thêm danh mục</span></>}</CommonButton></form>
      {dataLoading?<p className="data-status" role="status">Đang tải danh mục…</p>:categories.length===0?<div className="admin-empty"><Tags size={22}/><strong>Chưa có danh mục hệ thống</strong><span>Thêm danh mục mặc định từ biểu mẫu phía trên.</span></div>:<ul className="admin-category-list">{categories.map(category=><li key={category.id}><span className="admin-color-dot" style={{backgroundColor:category.color??'var(--accent)'}}/><div><strong>{category.name}</strong><small>{category.icon?`Biểu tượng ${category.icon}`:'Chưa đặt biểu tượng'}</small></div><span className="admin-category-kind">{category.kind==='income'?'Thu nhập':'Chi tiêu'}</span><div className="admin-category-actions"><CommonButton type="button" className="secondary-button" onClick={()=>setCategoryForm({id:category.id,kind:category.kind,name:category.name,icon:category.icon,color:category.color})}>Sửa</CommonButton><CommonButton type="button" className="admin-danger-button" disabled={busy} onClick={()=>void deleteCategory(category)}>Xóa</CommonButton></div></li>)}</ul>}
    </section>}
    {tab==='categories'&&hasMoreCategories&&<div className="list-pagination"><CommonButton type="button" className="secondary-button" disabled={busy||dataLoading} onClick={()=>void refreshCategories(categoryPage+1,true)}>Tải thêm danh mục</CommonButton></div>}
    {tab==='settings'&&<section className="admin-panel admin-content-panel"><header className="admin-panel-heading"><span className="admin-panel-heading-icon"><Megaphone size={20}/></span><div><h2>Thông báo ứng dụng</h2><p>Nội dung được gửi vào hộp thông báo của người dùng MoneyMate.</p></div></header>{dataLoading?<p className="data-status" role="status">Đang tải cấu hình…</p>:<div className="admin-notice-layout"><form className="admin-settings-form" onSubmit={saveSettings}><label className={`admin-toggle ${settings.notice_active?'is-active':''}`}><CommonInput type="checkbox" checked={settings.notice_active} onChange={event=>setSettings(current=>({...current,notice_active:event.target.checked}))}/><span className="admin-toggle-copy"><strong>{settings.notice_active?'Thông báo đang bật':'Thông báo đang tắt'}</strong><small>{settings.notice_active?'Nội dung sẽ được gửi đến người dùng khi lưu.':'Bật lên để gửi thông báo trong ứng dụng.'}</small></span></label><div className="admin-field"><label htmlFor="admin-notice-title">Tiêu đề thông báo</label><CommonInput id="admin-notice-title" value={settings.notice_title} maxLength={100} onChange={event=>setSettings(current=>({...current,notice_title:event.target.value}))} required={settings.notice_active}/><small>{settings.notice_title.length}/100 ký tự</small></div><div className="admin-field"><label htmlFor="admin-notice-body">Nội dung</label><CommonTextarea id="admin-notice-body" value={settings.notice_body} maxLength={500} rows={5} onChange={event=>setSettings(current=>({...current,notice_body:event.target.value}))} required={settings.notice_active}/><small>{settings.notice_body.length}/500 ký tự</small></div><CommonButton type="submit" className="primary-button" disabled={busy}><Check size={16}/>{settings.notice_active?'Lưu và gửi thông báo':'Lưu cài đặt thông báo'}</CommonButton>{settings.updated_at&&<small className="admin-updated-at">Cập nhật gần nhất: {formatDateTime(settings.updated_at)}</small>}</form><aside className="admin-notice-preview" aria-label="Bản xem trước thông báo"><div className="admin-preview-heading"><span><Bell size={16}/></span><div><strong>Bản xem trước</strong><small>Hộp thông báo người dùng</small></div></div><article className="admin-preview-card"><span className="admin-preview-icon"><Megaphone size={17}/></span><div><strong>{settings.notice_title||'Tiêu đề thông báo'}</strong><p>{settings.notice_body||'Nội dung thông báo sẽ hiển thị tại đây.'}</p><small>{settings.notice_active?'Sẵn sàng gửi khi lưu':'Bản nháp · chưa phát hành'}</small></div></article></aside></div>}</section>}
  </section>
}
