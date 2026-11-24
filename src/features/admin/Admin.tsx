import { ClipboardList, Download, LogOut, Search, Settings2, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  defaultServices, formatVnd, linePrice, paymentLabels, registrationLabels, transitions,
  type Line, type PaymentStatus, type RegistrationStatus, type Service, type ServiceId,
} from '../../../shared/domain'
import type { Beneficiary } from '../../../shared/vietqr'
import { Layout } from '../../components/Layout'
import { Alert, Button, CopyButton, Modal } from '../../components/ui'
import { api, ApiError, jsonPost, loadBootstrap } from '../../lib/api'

type Role = 'owner' | 'operator' | 'demo'

interface Row {
  id: string
  reference_code: string
  full_name: string
  citizen_id: string
  phone: string
  total_fee: number | null
  registration_status: RegistrationStatus
  payment_status: PaymentStatus
  created_at: string
  registration_services: Pick<Line, 'service_id' | 'service_name_snapshot'>[]
}

interface Detail extends Row {
  birth_year: number
  consent_version: string
  consent_at: string
  transfer_description: string | null
  registration_services: Line[]
  payment_records: { expected_amount: number; received_amount: number | null; transaction_reference: string | null; verified_at: string | null; customer_reported_at: string | null } | null
  audit_events: { action: string; created_at: string; metadata: { expected?: number; received?: number } }[]
}

interface Sensitive { citizen_id: string; phone: string; email: string }
interface List { rows: Row[]; count: number }
type Metrics = Record<keyof typeof metricLabels, number>
type BeneficiaryConfig = Beneficiary & { verified: boolean }

const metricLabels = {
  total: 'Tổng đăng ký', today: 'Đăng ký hôm nay', free: 'Miễn phí', paid: 'Có phí',
  quotes: 'Chờ báo giá', pending: 'Chờ thanh toán', verified: 'Đã xác minh',
  processing: 'Đang xử lý', completed: 'Hoàn thành', revenue: 'Doanh thu đã xác minh',
}
const auditLabels: Record<string, string> = {
  QUOTE_CONFIRMED: 'Xác nhận báo giá', PAYMENT_DISCREPANCY: 'Số tiền chuyển khoản không khớp',
  DUPLICATE_TRANSACTION: 'Mã giao dịch trùng', PAYMENT_VERIFIED: 'Xác minh thanh toán',
  STATUS_CHANGED: 'Cập nhật trạng thái', UNMASK: 'Xem thông tin nhạy cảm', LINK_ISSUED: 'Tạo liên kết thanh toán',
}
const statusActions: Partial<Record<RegistrationStatus, string>> = {
  PROCESSING: 'Bắt đầu xử lý', COMPLETED: 'Hoàn thành', CANCELLED: 'Hủy đăng ký',
}
const emptyFilters = { q: '', service: '', registration_status: '', payment_status: '', from: '', to: '', kind: '' }
const emptyBeneficiary = { bank: '', bin: '', account: '', holder: '', description_limit: 20, verified: false }
const dateFormat = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' })
const toDate = (value: string) => dateFormat.format(new Date(value))
const demoRows: Detail[] = defaultServices.map((service, index) => ({
  id: 'demo-' + service.id, reference_code: 'TAXDEMO000' + (index + 1), full_name: ['Nguyễn Minh An', 'Trần Bảo Vy', 'Lê Hải Nam'][index]!,
  citizen_id: '••••••••0000', phone: '••••••0000', total_fee: service.fixed_fee,
  registration_status: index === 0 ? 'AWAITING_PAYMENT' : index === 1 ? 'SUBMITTED' : 'NEEDS_QUOTE',
  payment_status: index === 0 ? 'CUSTOMER_REPORTED' : index === 1 ? 'NOT_REQUIRED' : 'AWAITING_QUOTE',
  created_at: new Date().toISOString(), birth_year: 1995, consent_version: 'demo-1', consent_at: new Date().toISOString(),
  transfer_description: null, payment_records: null, audit_events: [],
  registration_services: [{
    service_id: service.id, service_name_snapshot: service.name, service_description_snapshot: service.description, service_code_snapshot: service.short_code,
    calculated_fee: service.fixed_fee, pricing_snapshot: { type: service.pricing_type, fixed_fee: service.fixed_fee },
    additional_details: index === 2 ? 'Yêu cầu hỗ trợ mẫu.' : null,
  }],
}))
const demoMetrics: Metrics = { total: 3, today: 3, free: 1, paid: 1, quotes: 1, pending: 1, verified: 0, processing: 0, completed: 0, revenue: 0 }

function SelectFilter({ value, label, children, onChange }: { value: string; label: string; children: ReactNode; onChange: (value: string) => void }) {
  const id = useId()
  return <div className="admin-field"><label htmlFor={id}>{label}</label><select id={id} value={value} onChange={e => onChange(e.target.value)}>{children}</select></div>
}

function Login({ onLogin }: { onLogin: (role: Role) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [demo, setDemo] = useState<boolean>()
  useEffect(() => {
    let live = true
    void loadBootstrap().then(data => { if (live) setDemo(data.demo) }).catch(() => { if (live) setDemo(false) })
    return () => { live = false }
  }, [])
  return <main id="main" className="shell standalone">
    <section className="panel login-panel"><span className="section-icon large"><ShieldCheck size={25} /></span>
      <h1>Trang quản trị</h1>
      {demo && <><p className="muted">Xem danh sách đăng ký giả lập trong bản trải nghiệm.</p><Button onClick={() => onLogin('demo')}>Xem dữ liệu mẫu</Button></>}
      {demo === false && <form onSubmit={async (event: FormEvent) => {
        event.preventDefault()
        if (busy) return
        setBusy(true); setError('')
        try { onLogin((await api<{ role: Role }>('/admin/login', jsonPost({ email, password }))).role) }
        catch (err) { setError((err as Error).message) }
        finally { setPassword(''); setBusy(false) }
      }}>
        <label className="admin-field">Email<input type="email" required autoComplete="username" value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="admin-field">Mật khẩu<input type="password" required autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <Alert>{error}</Alert>}
        <Button type="submit" disabled={busy}>{busy ? 'Đang đăng nhập…' : 'Đăng nhập'}</Button>
      </form>}
      {demo === undefined && <p role="status" className="muted">Đang tải…</p>}
    </section>
  </main>
}

function RegistrationDetail({ detail, role, onRefresh, onFailure }: { detail: Detail; role: Role; onRefresh: () => Promise<void>; onFailure: (error: Error) => void }) {
  const [quote, setQuote] = useState<Partial<Record<ServiceId, string>>>(() =>
    Object.fromEntries(detail.registration_services.map(line => [line.service_id, line.calculated_fee ?? ''].map(String))))
  const [amount, setAmount] = useState('')
  const [transaction, setTransaction] = useState('')
  const [link, setLink] = useState('')
  const [sensitive, setSensitive] = useState<Sensitive>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [cancelConfirm, setCancelConfirm] = useState(false)
  const root = '/admin/registrations/' + detail.id
  const payable = detail.registration_status === 'AWAITING_PAYMENT' && ['PENDING', 'CUSTOMER_REPORTED'].includes(detail.payment_status)
  const act = async (action: string, payload: unknown, refresh: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const result = await api<{ url?: string } & Partial<Sensitive>>(root + '/' + action, jsonPost(payload))
      if (result.url) setLink(result.url)
      if (result.citizen_id && result.phone && result.email) setSensitive({ citizen_id: result.citizen_id, phone: result.phone, email: result.email })
      if (refresh) { setLink(''); await onRefresh() }
    } catch (err) {
      setError((err as Error).message)
      onFailure(err as Error)
      if (action === 'verify' && err instanceof ApiError && err.status === 409) await onRefresh().catch(() => {})
    } finally { setBusy(false) }
  }
  return <div className="admin-detail">
    <dl className="detail-pairs">
      <div><dt>Khách hàng</dt><dd>{detail.full_name}</dd></div>
      <div><dt>Năm sinh</dt><dd>{detail.birth_year}</dd></div>
      <div><dt>CCCD</dt><dd>{sensitive?.citizen_id ?? detail.citizen_id}</dd></div>
      <div><dt>Điện thoại</dt><dd>{sensitive?.phone ?? detail.phone}</dd></div>
      {sensitive && <div><dt>Email</dt><dd>{sensitive.email}</dd></div>}
      <div><dt>Đồng ý xử lý dữ liệu</dt><dd>{detail.consent_version} · {toDate(detail.consent_at)}</dd></div>
      <div><dt>Đăng ký</dt><dd>{registrationLabels[detail.registration_status]}</dd></div>
      <div><dt>Thanh toán</dt><dd>{paymentLabels[detail.payment_status]}</dd></div>
      {detail.transfer_description && <div><dt>Nội dung chuyển khoản</dt><dd>{detail.transfer_description}</dd></div>}
    </dl>
    {role === 'owner' && <Button disabled={busy} variant="secondary" onClick={() => sensitive ? setSensitive(undefined) : void act('unmask', {}, false)}>{sensitive ? 'Ẩn thông tin cá nhân' : 'Hiện CCCD và thông tin liên hệ'}</Button>}
    <div className="receipt"><h3>Dịch vụ đã chọn</h3>
      <ul>{detail.registration_services.map(line => <li key={line.service_id}><div>{line.service_name_snapshot}{line.additional_details && <p className="muted">{line.additional_details}</p>}</div><strong>{linePrice(line.calculated_fee)}</strong></li>)}</ul>
      <div className="receipt-total"><span>Tổng phí</span><strong>{linePrice(detail.total_fee)}</strong></div>
    </div>
    {detail.payment_records && <dl className="detail-pairs">
      <div><dt>Phí phải thu</dt><dd>{formatVnd(detail.payment_records.expected_amount)}</dd></div>
      {detail.payment_records.customer_reported_at && <div><dt>Khách báo chuyển khoản</dt><dd>{toDate(detail.payment_records.customer_reported_at)}</dd></div>}
      {detail.payment_records.verified_at && <><div><dt>Tiền đã nhận</dt><dd>{formatVnd(detail.payment_records.received_amount ?? 0)}</dd></div>
        <div><dt>Mã giao dịch</dt><dd>{detail.payment_records.transaction_reference}</dd></div>
        <div><dt>Đã xác minh</dt><dd>{toDate(detail.payment_records.verified_at)}</dd></div></>}
    </dl>}
    {role !== 'demo' && detail.registration_status === 'NEEDS_QUOTE' && <form className="admin-action-form" onSubmit={e => {
      e.preventDefault()
      void act('quote', { prices: Object.fromEntries(Object.entries(quote).map(([id, value]) => [id, Number(value)])) }, true)
    }}>
      <h3>Xác nhận báo giá</h3>
      {detail.registration_services.map(line => <label className="admin-field" key={line.service_id}>{line.service_name_snapshot} (VND)
        <input type="number" min={0} max={333_333_333_333} step={1} required value={quote[line.service_id] ?? ''} onChange={e => setQuote({ ...quote, [line.service_id]: e.target.value })} />
      </label>)}
      <Button type="submit" disabled={busy}>Xác nhận báo giá</Button>
    </form>}
    {role !== 'demo' && payable && <>
      <form className="admin-action-form" onSubmit={e => { e.preventDefault(); void act('verify', { amount: Number(amount), transaction }, true) }}>
        <h3>Xác minh tiền đã nhận</h3>
        <label className="admin-field">Số tiền thực nhận (VND)<input type="number" min={1} max={999_999_999_999} step={1} required value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label className="admin-field">Mã giao dịch ngân hàng<input required minLength={3} maxLength={80} value={transaction} onChange={e => setTransaction(e.target.value)} /></label>
        <Button type="submit" disabled={busy}>Xác minh thanh toán</Button>
      </form>
      <div className="admin-detail-actions"><Button variant="secondary" disabled={busy} onClick={() => void act('link', {}, false)}>Tạo liên kết thanh toán</Button>
        {link && <CopyButton text={link} label="Sao chép liên kết thanh toán" />}</div>
      {link && <label className="admin-field">Liên kết thanh toán · Hiệu lực 7 ngày<input readOnly value={link} onFocus={e => e.currentTarget.select()} /></label>}
    </>}
    {role !== 'demo' && <div className="admin-detail-actions">{(transitions[detail.registration_status] ?? [])
      .filter(status => status !== 'PROCESSING' || ['VERIFIED', 'NOT_REQUIRED'].includes(detail.payment_status)).map(status =>
        <Button key={status} variant={status === 'CANCELLED' ? 'danger' : 'secondary'} disabled={busy} onClick={() =>
          status === 'CANCELLED' ? setCancelConfirm(true) : void act('status', { status }, true)}>{statusActions[status]}</Button>)}</div>}
    {cancelConfirm && detail.registration_status !== 'CANCELLED' && <div className="admin-detail-actions">
      <p>Xác nhận hủy đăng ký {detail.reference_code}?</p><Button variant="danger" disabled={busy} onClick={() => { void act('status', { status: 'CANCELLED' }, true) }}>Xác nhận hủy</Button>
      <Button variant="secondary" disabled={busy} onClick={() => setCancelConfirm(false)}>Giữ đăng ký</Button>
    </div>}
    {detail.audit_events.length > 0 && <section className="audit"><h3>Lịch sử thao tác</h3>
      <ul>{detail.audit_events.map((event, index) => <li key={event.created_at + index}>
        <strong>{auditLabels[event.action] ?? event.action}</strong> · {toDate(event.created_at)}
        {event.action === 'PAYMENT_DISCREPANCY' && event.metadata.received !== undefined && <p>Đã nhận {formatVnd(event.metadata.received)} / {formatVnd(event.metadata.expected ?? 0)}</p>}
      </li>)}</ul></section>}
    {error && <Alert>{error}</Alert>}
  </div>
}

function ServiceSettings({ initial, save }: { initial: Service; save: (path: string, data: unknown) => Promise<void> }) {
  const [service, setService] = useState(initial)
  const [busy, setBusy] = useState(false)
  return <form className="admin-action-form" onSubmit={async e => {
    e.preventDefault()
    setBusy(true)
    try {
      await save('/admin/service', {
        id: service.id, name: service.name, description: service.description, fixed_fee: service.fixed_fee, is_active: service.is_active, display_order: service.display_order,
      })
    } finally { setBusy(false) }
  }}>
    <h3>{initial.short_code} · {initial.name}</h3>
    <label className="admin-field">Tên dịch vụ<input required maxLength={100} value={service.name} onChange={e => setService({ ...service, name: e.target.value })} /></label>
    <label className="admin-field">Mô tả<textarea required maxLength={500} rows={2} value={service.description} onChange={e => setService({ ...service, description: e.target.value })} /></label>
    {service.pricing_type === 'FIXED' && <label className="admin-field">Phí (VND)<input required type="number" min={1} max={333_333_333_333} step={1} value={service.fixed_fee ?? ''} onChange={e => setService({ ...service, fixed_fee: e.target.value === '' ? null : Number(e.target.value) })} /></label>}
    <label className="admin-field">Thứ tự hiển thị<input required type="number" min={1} max={999} step={1} value={service.display_order || ''} onChange={e => setService({ ...service, display_order: Number(e.target.value) })} /></label>
    <label className="check-row"><input type="checkbox" checked={service.is_active} onChange={e => setService({ ...service, is_active: e.target.checked })} /> Mở đăng ký</label>
    <Button variant="secondary" type="submit" disabled={busy}>Lưu dịch vụ</Button>
  </form>
}

function Settings({ onFailure }: { onFailure: (error: Error) => void }) {
  const [services, setServices] = useState<Service[]>()
  const [beneficiary, setBeneficiary] = useState<BeneficiaryConfig>(emptyBeneficiary)
  const [message, setMessage] = useState<{ text: string; error: boolean }>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    void api<{ services: Service[]; beneficiary: BeneficiaryConfig | null }>('/admin/settings').then(result => {
      if (live) { setServices(result.services); setBeneficiary(result.beneficiary ?? emptyBeneficiary) }
    }).catch((error: Error) => { if (live) { onFailure(error); setMessage({ text: error.message, error: true }) } })
    return () => { live = false }
  }, [onFailure])
  async function save(path: string, data: unknown) {
    setMessage(undefined)
    try { await api(path, jsonPost(data)); setMessage({ text: 'Đã lưu thay đổi.', error: false }) }
    catch (error) { onFailure(error as Error); setMessage({ text: (error as Error).message, error: true }) }
  }
  return <div className="admin-detail">
    {message && <Alert tone={message.error ? 'error' : 'success'}>{message.text}</Alert>}
    {services ? <>
      <form className="admin-action-form" onSubmit={async e => {
        e.preventDefault(); setBusy(true)
        try { await save('/admin/beneficiary', beneficiary) } finally { setBusy(false) }
      }}>
        <h3>Tài khoản nhận thanh toán</h3>
        {Object.entries({ bank: 'Tên ngân hàng', bin: 'Mã BIN đã xác minh', account: 'Số tài khoản', holder: 'Chủ tài khoản' }).map(([key, label]) => {
          const field = key as 'bank' | 'bin' | 'account' | 'holder'
          return <label className="admin-field" key={field}>{label}
            <input required value={beneficiary[field]} inputMode={['bin', 'account'].includes(field) ? 'numeric' : 'text'}
              onChange={e => setBeneficiary({ ...beneficiary, [field]: e.target.value, verified: false })} />
          </label>
        })}
        <label className="admin-field">Độ dài tối đa của nội dung chuyển khoản<input type="number" min={20} max={90} required value={beneficiary.description_limit || ''} onChange={e => setBeneficiary({ ...beneficiary, description_limit: Number(e.target.value), verified: false })} /></label>
        <label className="check-row"><input type="checkbox" checked={beneficiary.verified} onChange={e => setBeneficiary({ ...beneficiary, verified: e.target.checked })} /> Tôi đã xác minh tài khoản, mã BIN và khả năng quét VietQR.</label>
        <Button variant="secondary" type="submit" disabled={busy}>Lưu tài khoản nhận tiền</Button>
      </form>
      {services.map(service => <ServiceSettings key={service.id} initial={service} save={save} />)}
    </> : !message && <p role="status">Đang tải cấu hình…</p>}
  </div>
}

export default function Admin() {
  const [role, setRole] = useState<Role>()
  const [booting, setBooting] = useState(true)
  const [filters, setFilters] = useState(emptyFilters)
  const [applied, setApplied] = useState(emptyFilters)
  const [page, setPage] = useState(1)
  const [list, setList] = useState<List>()
  const [metrics, setMetrics] = useState<Metrics>()
  const [detail, setDetail] = useState<Detail>()
  const [settings, setSettings] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [refreshing, setRefreshing] = useState(0)
  const onFailure = useCallback((error: Error) => {
    if (error instanceof ApiError && error.status === 401) {
      setRole(undefined); setDetail(undefined); setSettings(false); setList(undefined); setMetrics(undefined)
    }
  }, [])
  useEffect(() => {
    let live = true
    void api<{ role: Role }>('/admin/session').then(result => { if (live) setRole(result.role) })
      .catch(() => {}).finally(() => { if (live) setBooting(false) })
    return () => { live = false }
  }, [])
  const query = new URLSearchParams({ ...applied, page: String(page) }).toString()
  useEffect(() => {
    let live = true
    if (!role) return
    if (role === 'demo') {
      const matches = demoRows.filter(row =>
        row.reference_code.startsWith(applied.q.trim().toUpperCase()) &&
        (!applied.service || row.registration_services.some(line => line.service_id === applied.service)) &&
        (!applied.registration_status || row.registration_status === applied.registration_status) &&
        (!applied.payment_status || row.payment_status === applied.payment_status) &&
        (!applied.kind || (applied.kind === 'free' ? row.total_fee === 0 : (row.total_fee ?? 0) > 0)) &&
        (!applied.from || Date.parse(row.created_at) >= Date.parse(applied.from + 'T00:00:00+07:00')) &&
        (!applied.to || Date.parse(row.created_at) <= Date.parse(applied.to + 'T23:59:59+07:00')))
      setList({ rows: matches, count: matches.length })
      setMetrics(demoMetrics)
      return
    }
    setLoading(true); setError('')
    void Promise.all([api<List>('/admin/registrations?' + query), api<Metrics>('/admin/metrics')])
      .then(([next, totals]) => { if (live) { setList(next); setMetrics(totals) } })
      .catch((err: Error) => { if (live) { setError(err.message); onFailure(err) } })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [role, query, applied, refreshing, onFailure])

  async function openDetail(id: string) {
    setError('')
    try {
      setDetail(role === 'demo' ? demoRows.find(row => row.id === id) : await api<Detail>('/admin/registrations/' + id))
    } catch (err) { setError((err as Error).message); onFailure(err as Error) }
  }
  async function logout() {
    setError('')
    try {
      if (role !== 'demo') await api('/admin/logout', jsonPost({}))
      setRole(undefined); setDetail(undefined); setSettings(false); setList(undefined); setMetrics(undefined)
    } catch (err) { setError((err as Error).message) }
  }
  async function exportCsv() {
    setError(''); setExporting(true)
    try {
      const response = await fetch('/api/admin/export?' + query, { cache: 'no-store' })
      if (!response.ok) {
        const message = await response.json().catch(() => ({})) as { error?: string }
        throw new ApiError(message.error ?? 'Không thể xuất dữ liệu.', response.status)
      }
      const url = URL.createObjectURL(await response.blob())
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'taxsupport.csv'; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) { setError((err as Error).message); onFailure(err as Error) }
    finally { setExporting(false) }
  }
  function filter(name: keyof typeof emptyFilters, value: string) { setFilters(previous => ({ ...previous, [name]: value })) }

  return <Layout>{booting ? <main id="main" className="shell standalone" role="status">Đang kiểm tra phiên đăng nhập…</main> : !role ? <Login onLogin={setRole} /> :
    <main id="main" className="shell standalone admin-shell">
      <div className="admin-header"><div><h1>Quản lý đăng ký</h1><p className="muted">Theo dõi yêu cầu, báo giá và thanh toán.</p></div>
        <div className="admin-detail-actions">{role === 'owner' && <Button variant="secondary" onClick={() => setSettings(true)}><Settings2 size={17} /> Cấu hình</Button>}
          <Button variant="ghost" onClick={logout}><LogOut size={17} /> {role === 'demo' ? 'Thoát bản mẫu' : 'Đăng xuất'}</Button></div></div>
      {role === 'demo' && <Alert tone="info">Bản trải nghiệm · Danh sách bên dưới gồm các đăng ký giả lập.</Alert>}
      {metrics && <div className="metric-grid">{Object.entries(metricLabels).map(([key, label]) => <div className="panel metric" key={key}><span>{label}</span>
        <strong>{key === 'revenue' ? formatVnd(metrics.revenue) : new Intl.NumberFormat('vi-VN').format(metrics[key as keyof Metrics])}</strong></div>)}</div>}
      <section className="panel admin-list">
        <div className="sidebar-title"><span className="section-icon"><ClipboardList size={20} /></span><h2>Danh sách đăng ký</h2></div>
        <form className="filters" onSubmit={e => { e.preventDefault(); setPage(1); setApplied({ ...filters }) }}>
          <label className="admin-field">Mã đăng ký<input type="search" maxLength={11} placeholder="TAX…" value={filters.q} onChange={e => filter('q', e.target.value)} /></label>
          <SelectFilter label="Dịch vụ" value={filters.service} onChange={value => filter('service', value)}><option value="">Tất cả</option>{defaultServices.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}</SelectFilter>
          <SelectFilter label="Trạng thái đăng ký" value={filters.registration_status} onChange={value => filter('registration_status', value)}><option value="">Tất cả</option>{Object.entries(registrationLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</SelectFilter>
          <SelectFilter label="Thanh toán" value={filters.payment_status} onChange={value => filter('payment_status', value)}><option value="">Tất cả</option>{Object.entries(paymentLabels).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</SelectFilter>
          <SelectFilter label="Loại phí" value={filters.kind} onChange={value => filter('kind', value)}><option value="">Tất cả</option><option value="free">Miễn phí</option><option value="paid">Có phí</option></SelectFilter>
          <label className="admin-field">Từ ngày<input type="date" value={filters.from} onChange={e => filter('from', e.target.value)} /></label>
          <label className="admin-field">Đến ngày<input type="date" min={filters.from || undefined} value={filters.to} onChange={e => filter('to', e.target.value)} /></label>
          <div className="filter-actions"><Button type="submit" disabled={loading}><Search size={16} /> Lọc</Button>
            <Button variant="secondary" onClick={() => { setFilters(emptyFilters); setApplied(emptyFilters); setPage(1) }}>Xóa bộ lọc</Button></div>
        </form>
        {error && <Alert>{error}</Alert>}
        {loading && <p className="muted" role="status">Đang tải đăng ký…</p>}
        {!loading && list?.count === 0 && <p className="empty-list">Không có đăng ký phù hợp.</p>}
        {!!list?.rows.length && <div className="table-wrap" tabIndex={0} role="region" aria-label="Bảng đăng ký">
          <table><thead><tr>{['Mã đăng ký', 'Khách hàng', 'Dịch vụ', 'Tổng phí', 'Đăng ký', 'Thanh toán', 'Ngày tạo'].map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
            <tbody>{list.rows.map(row => <tr key={row.id}>
              <td><button className="table-link" onClick={() => void openDetail(row.id)}>{row.reference_code}</button></td>
              <td><strong>{row.full_name}</strong><p className="muted">{row.citizen_id}<br />{row.phone}</p></td>
              <td>{row.registration_services.map(line => line.service_name_snapshot).join(', ')}</td><td>{linePrice(row.total_fee)}</td>
              <td><span className="table-status">{registrationLabels[row.registration_status]}</span></td><td>{paymentLabels[row.payment_status]}</td><td>{toDate(row.created_at)}</td>
            </tr>)}</tbody></table>
        </div>}
        <div className="admin-pagination">
          {role === 'owner' && <Button variant="secondary" disabled={exporting || !list?.rows.length} onClick={exportCsv}><Download size={16} />{exporting ? 'Đang xuất…' : 'Xuất CSV'}</Button>}
          {!!list?.count && <><span>Trang {page} / {Math.ceil(list.count / 25)}</span>
            <Button variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>Trang trước</Button>
            <Button variant="secondary" disabled={page * 25 >= list.count || loading} onClick={() => setPage(page + 1)}>Trang sau</Button></>}
        </div>
      </section>
      {detail && <Modal title={'Đăng ký ' + detail.reference_code} onClose={() => setDetail(undefined)}>
        <RegistrationDetail key={detail.id} detail={detail} role={role} onFailure={onFailure} onRefresh={async () => {
          const next = await api<Detail>('/admin/registrations/' + detail.id)
          setDetail(current => current?.id === detail.id ? next : current); setRefreshing(value => value + 1)
        }} />
      </Modal>}
      {settings && <Modal title="Cấu hình dịch vụ và thanh toán" onClose={() => setSettings(false)}><Settings onFailure={onFailure} /></Modal>}
    </main>}
  </Layout>
}
