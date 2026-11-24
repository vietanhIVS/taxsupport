import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  defaultServices, demoLegal, unavailableLegal, registrationSchema, registrationStatuses, paymentStatuses, serviceIds,
  type Legal, type Registration, type Service, type Bootstrap,
} from '../shared/domain'
import { randomReference, vietQr, type Beneficiary } from '../shared/vietqr'
import { HttpError, makeSecurity, type Env, type Security } from './security'

const cookieName = '__Host-taxsupport-admin'
const noStore = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }
const maxBody = 8192
const tokenInput = z.strictObject({ token: z.string().min(1).max(1200) })
const quoteInput = z.strictObject({ prices: z.partialRecord(z.enum(serviceIds), z.number().int().min(0).max(333_333_333_333)) })
const verificationInput = z.strictObject({
  amount: z.number().int().min(1).max(999_999_999_999),
  transaction: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9 ._/-]{2,79}$/),
})
const transitionInput = z.strictObject({ status: z.enum(['PROCESSING', 'COMPLETED', 'CANCELLED']) })
const beneficiaryInput = z.strictObject({
  bank: z.string().trim().min(2).max(100), bin: z.string().regex(/^\d{6}$/), account: z.string().regex(/^\d{6,19}$/),
  holder: z.string().trim().min(2).max(100), description_limit: z.number().int().min(20).max(90), verified: z.boolean(),
})
const serviceInput = z.strictObject({
  id: z.enum(serviceIds), name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(500),
  fixed_fee: z.number().int().min(0).max(333_333_333_333).nullable(), is_active: z.boolean(),
  display_order: z.number().int().min(1).max(999),
}).refine(item => item.id === 'TAX_REFUND' ? (item.fixed_fee ?? 0) > 0 :
  item.id === 'TAX_LOOKUP' ? item.fixed_fee === 0 : item.fixed_fee === null)

const queryInput = z.object({
  q: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{0,11}$/).default(''),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  service: z.enum(serviceIds).or(z.literal('')).default(''),
  registration_status: z.enum(registrationStatuses).or(z.literal('')).default(''),
  payment_status: z.enum(paymentStatuses).or(z.literal('')).default(''),
  from: z.iso.date().or(z.literal('')).default(''),
  to: z.iso.date().or(z.literal('')).default(''),
  kind: z.enum(['', 'free', 'paid']).default(''),
}).refine(input => !input.from || !input.to || input.from <= input.to)

const messages: Record<string, string> = {
  CATALOG_CHANGED: 'Danh mục hoặc giá đã thay đổi. Vui lòng xem lại dịch vụ.',
  CONSENT_CHANGED: 'Thông báo quyền riêng tư đã thay đổi. Vui lòng tải lại trang và xem trước khi đồng ý.',
  IDEMPOTENCY_MISMATCH: 'Dữ liệu gửi lại khác với lần trước. Vui lòng bắt đầu đăng ký mới.',
  PAYMENT_UNAVAILABLE: 'Dịch vụ thu phí đang tạm ngưng. Vui lòng thử lại sau.',
  INVALID_STATE: 'Trạng thái hiện tại không cho phép thực hiện thao tác này.',
  NOT_FOUND: 'Không tìm thấy yêu cầu.',
  DENIED: 'Tài khoản không có quyền thực hiện thao tác này.',
  INVALID_QUOTE: 'Vui lòng nhập giá cho tất cả dịch vụ đã chọn.',
}

type DbError = { code?: string; message: string }
type DbResult = Registration & {
  id: string
  beneficiary: Beneficiary | null
  transfer_description: string | null
}

function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return Response.json(data, { status, headers: { ...noStore, ...headers } })
}

function unwrap<T>(result: { data: T; error: DbError | null }): T {
  if (!result.error) return result.data
  const { code, message } = result.error
  const status = code?.startsWith('PT') ? Number(code.slice(2)) : code === '42501' ? 403 : code === '23505' ? 409 : 503
  const known = Object.hasOwn(messages, message)
  throw new HttpError(status, known ? messages[message]! : 'Chưa thể thực hiện yêu cầu. Vui lòng thử lại.', known ? message : undefined)
}

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Yêu cầu phải sử dụng JSON.')
  }
  if (Number(request.headers.get('content-length')) > maxBody) throw new HttpError(413, 'Dữ liệu gửi lên quá dài.')
  const reader = request.body?.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  if (!reader) throw new HttpError(400, 'Dữ liệu gửi lên không hợp lệ.')
  let size = 0
  let body = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBody) {
        await reader.cancel()
        throw new HttpError(413, 'Dữ liệu gửi lên quá dài.')
      }
      body += decoder.decode(value, { stream: true })
    }
    return schema.parse(JSON.parse(body + decoder.decode()))
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, 'Dữ liệu gửi lên không hợp lệ.')
  } finally {
    reader.releaseLock()
  }
}

const readLegal = async (db: SupabaseClient): Promise<Legal | null> =>
  unwrap(await db.from('legal_config').select('version,identity,privacy,terms,contact,retention').maybeSingle()) as Legal | null
const readServices = async (db: SupabaseClient, active: boolean): Promise<Service[]> => {
  const query = db.from('services').select('id,name,description,short_code,pricing_type,fixed_fee,is_active,display_order').order('display_order').order('id')
  return unwrap(await (active ? query.eq('is_active', true) : query)) as Service[]
}

function configured(env: Env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_ANON_KEY &&
    env.DATA_ENCRYPTION_KEY && env.DATA_ENCRYPTION_KEY_ID && env.PAYMENT_TOKEN_SIGNING_KEY && env.REGISTRATION_HASH_KEY)
}

const authConfig = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }

async function customerResult(row: DbResult, security: Security): Promise<Registration> {
  const { id, reference, total_fee, registration_status, payment_status, lines, beneficiary, transfer_description } = row
  const result: Registration = { reference, total_fee, registration_status, payment_status, lines }
  if (total_fee && beneficiary && transfer_description && ['PENDING', 'CUSTOMER_REPORTED'].includes(payment_status)) {
    result.payment = vietQr(beneficiary, total_fee, transfer_description)
    result.report_token = await security.issue(id, 'report')
  }
  return result
}

async function register(request: Request, db: SupabaseClient, security: Security, env: Env) {
  if (env.LEGAL_APPROVED !== 'true') throw new HttpError(503, 'Đăng ký trực tuyến hiện chưa mở.')
  const key = z.uuid().safeParse(request.headers.get('Idempotency-Key'))
  if (!key.success) throw new HttpError(400, 'Mã gửi yêu cầu không hợp lệ.')
  const { person, selections, consent_version, catalog_snapshot } = await parseBody(request, registrationSchema)
  selections.sort((a, b) => a.service_id.localeCompare(b.service_id))
  catalog_snapshot.sort((a, b) => a.service_id.localeCompare(b.service_id))
  const hash = await security.digest('registration', JSON.stringify([person, selections, consent_version, catalog_snapshot]))
  const { citizen_id, ...remainingPerson } = person
  for (let attempt = 0; attempt < 5; attempt++) {
    const reference = randomReference()
    const result = await db.rpc('ts_register', {
      p_key: key.data, p_hash: hash, p_reference: reference,
      p_person: { ...remainingPerson, citizen_id_encrypted: await security.encrypt(citizen_id, reference), citizen_id_tail: citizen_id.slice(-4) },
      p_selections: selections, p_expected: catalog_snapshot, p_version: consent_version,
    })
    if (result.error?.code === '23505' && result.error.message.includes('registrations_reference_code_key')) continue
    return json(await customerResult(unwrap(result) as DbResult, security), 201)
  }
  throw new HttpError(503, 'Chưa tạo được mã đăng ký. Vui lòng thử lại.')
}

const baseProjection = 'id,reference_code,full_name,citizen_id_tail,phone,total_fee,registration_status,payment_status,created_at'
const listProjection = baseProjection + ',registration_services(service_id,service_name_snapshot)'
const detailProjection = baseProjection + ',updated_at,birth_year,consent_version,consent_at,transfer_description,registration_services(service_id,service_name_snapshot,service_description_snapshot,service_code_snapshot,pricing_snapshot,calculated_fee,additional_details),payment_records(expected_amount,received_amount,verified_at,verified_by,customer_reported_at,transaction_reference),audit_events(action,created_at,metadata)'

interface ListRow {
  id: string
  reference_code: string
  full_name: string
  citizen_id_tail: string
  phone: string
  total_fee: number | null
  registration_status: Registration['registration_status']
  payment_status: Registration['payment_status']
  created_at: string
  registration_services: { service_id: string; service_name_snapshot: string }[]
}
function maskRow<T extends ListRow>(row: T) {
  const { citizen_id_tail, phone, ...rest } = row
  return { ...rest, citizen_id: '••••••••' + citizen_id_tail, phone: '••••••' + phone.slice(-4) }
}

function csvCell(value: unknown) {
  const raw = String(value ?? '')
  const safe = /^[\s\uFEFF]*[=+@-]|^[\t\r\n]/u.test(raw) ? "'" + raw : raw
  return '"' + safe.replace(/"/g, '""') + '"'
}

function getList(db: SupabaseClient, url: URL, exportRows: boolean) {
  const parsed = queryInput.safeParse(Object.fromEntries(url.searchParams))
  if (!parsed.success) throw new HttpError(400, 'Bộ lọc không hợp lệ.')
  const f = parsed.data
  const pageSize = 25
  let result = db.from('registrations')
    .select(listProjection + (f.service ? ',match_service:registration_services!inner(service_id)' : ''), { count: 'exact' })
    .order('created_at', { ascending: false }).order('id', { ascending: false })
  if (f.service) result = result.eq('match_service.service_id', f.service)
  if (f.q) result = result.like('reference_code', f.q + '%')
  if (f.registration_status) result = result.eq('registration_status', f.registration_status)
  if (f.payment_status) result = result.eq('payment_status', f.payment_status)
  if (f.from) result = result.gte('created_at', f.from + 'T00:00:00+07:00')
  if (f.to) result = result.lte('created_at', f.to + 'T23:59:59.999999+07:00')
  if (f.kind === 'free') result = result.eq('total_fee', 0)
  if (f.kind === 'paid') result = result.gt('total_fee', 0)
  if (exportRows) return result.range(0, 999)
  const offset = (f.page - 1) * pageSize
  return result.range(offset, offset + pageSize - 1)
}

function sessionCookie(value = '', maxAge = 0) {
  return `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
}

async function handleAdmin(request: Request, url: URL, path: string, db: SupabaseClient, security: Security, env: Env) {
  const method = request.method
  if (method === 'POST' && path === '/admin/login') {
    const body = await parseBody(request, z.strictObject({ email: z.email().max(254), password: z.string().min(1).max(256) }))
    const auth = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, authConfig)
    const result = await auth.auth.signInWithPassword(body)
    if (result.error || !result.data.session) throw new HttpError(401, 'Thông tin đăng nhập không hợp lệ.')
    const role = unwrap(await db.rpc('ts_require_admin', { p_actor: result.data.user.id }))
    return json({ role }, 200, { 'Set-Cookie': sessionCookie(result.data.session.access_token, result.data.session.expires_in) })
  }

  const token = request.headers.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1)
  if (method === 'POST' && path === '/admin/logout') {
    if (token) await db.auth.admin.signOut(token, 'local')
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie() })
  }
  if (!token) throw new HttpError(401, 'Vui lòng đăng nhập.')
  const auth = createClient(env.SUPABASE_URL!, env.SUPABASE_ANON_KEY!, authConfig)
  const user = await auth.auth.getUser(token)
  if (user.error || !user.data.user) throw new HttpError(401, 'Phiên đăng nhập đã hết hạn.')
  const actor = user.data.user.id
  const ownerOnly = ['/admin/export', '/admin/settings'].includes(path) || /\/(unmask|beneficiary|service)$/.test(path)
  const role = unwrap(await db.rpc('ts_require_admin', { p_actor: actor, p_owner: ownerOnly }))

  if (method === 'GET' && path === '/admin/session') return json({ role })
  if (method === 'GET' && path === '/admin/metrics') return json(unwrap(await db.rpc('ts_metrics', { p_actor: actor })))
  if (method === 'GET' && (path === '/admin/registrations' || path === '/admin/export')) {
    const exporting = path === '/admin/export'
    const result = await getList(db, url, exporting)
    const rows = (unwrap(result) as unknown as ListRow[]).map(maskRow)
    if (!exporting) return json({ rows, count: result.count ?? 0 })
    if (result.count && result.count > 1000) throw new HttpError(400, 'Thu hẹp bộ lọc để xuất tối đa 1.000 đăng ký.')
    unwrap(await db.rpc('ts_admin_audit', { p_actor: actor, p_id: null, p_action: 'EXPORT' }))
    const fields = ['reference_code', 'full_name', 'citizen_id', 'phone', 'services', 'total_fee', 'registration_status', 'payment_status', 'created_at'] as const
    const data = rows.map(row => {
      const flat = { ...row, services: row.registration_services.map(line => line.service_name_snapshot).join(' / ') }
      return fields.map(field => csvCell(flat[field])).join(',')
    })
    return new Response('\uFEFF' + [fields.join(','), ...data].join('\r\n'), {
      headers: { ...noStore, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename=taxsupport.csv' },
    })
  }

  if (method === 'GET' && path === '/admin/settings') {
    const [services, beneficiary] = await Promise.all([
      readServices(db, false),
      db.from('payment_config').select('bank,bin,account,holder,description_limit,verified').maybeSingle().then(unwrap),
    ])
    return json({ services, beneficiary: beneficiary && { ...beneficiary, bin: beneficiary.bin ?? '', holder: beneficiary.holder ?? '', description_limit: beneficiary.description_limit ?? 20 } })
  }
  if (method === 'POST' && path === '/admin/service') {
    const service = await parseBody(request, serviceInput)
    return json(unwrap(await db.rpc('ts_update_service', { p_actor: actor, p_service: service })))
  }
  if (method === 'POST' && path === '/admin/beneficiary') {
    const config = await parseBody(request, beneficiaryInput)
    unwrap(await db.rpc('ts_update_beneficiary', { p_actor: actor, p_config: config }))
    return json({ ok: true })
  }

  const match = path.match(/^\/admin\/registrations\/([^/]+)(?:\/(quote|verify|status|unmask|link))?$/)
  if (match) {
    const id = z.uuid().safeParse(match[1])
    if (!id.success) throw new HttpError(404, 'Không tìm thấy yêu cầu.')
    const rpc = { p_actor: actor, p_id: id.data }
    if (method === 'GET' && !match[2]) {
      const result = unwrap(await db.from('registrations').select(detailProjection).eq('id', id.data)
        .order('created_at', { referencedTable: 'audit_events', ascending: false }).limit(15, { referencedTable: 'audit_events' }).maybeSingle())
      if (!result) throw new HttpError(404, 'Không tìm thấy yêu cầu.')
      return json(maskRow(result as unknown as ListRow))
    }
    if (method === 'POST' && match[2] === 'unmask') {
      const row = unwrap(await db.from('registrations').select('reference_code,citizen_id_encrypted,phone,email').eq('id', id.data).maybeSingle())
      if (!row) throw new HttpError(404, 'Không tìm thấy yêu cầu.')
      const citizenId = await security.decrypt(row.citizen_id_encrypted, row.reference_code)
      unwrap(await db.rpc('ts_admin_audit', { ...rpc, p_action: 'UNMASK' }))
      return json({ citizen_id: citizenId, phone: row.phone, email: row.email })
    }
    if (method === 'POST' && match[2] === 'quote') {
      const body = await parseBody(request, quoteInput)
      unwrap(await db.rpc('ts_confirm_quote', { ...rpc, p_prices: body.prices }))
      return json({ ok: true })
    }
    if (method === 'POST' && match[2] === 'verify') {
      const body = await parseBody(request, verificationInput)
      const result = unwrap(await db.rpc('ts_verify_payment', { ...rpc, p_amount: body.amount, p_transaction: body.transaction }))
      if (result.discrepancy) throw new HttpError(409, 'Số tiền không khớp. Chênh lệch đã được ghi nhận để xem xét.')
      if (result.duplicate) throw new HttpError(409, 'Mã giao dịch này đã được sử dụng.')
      return json({ ok: true })
    }
    if (method === 'POST' && match[2] === 'status') {
      const body = await parseBody(request, transitionInput)
      unwrap(await db.rpc('ts_transition', { ...rpc, p_status: body.status }))
      return json({ ok: true })
    }
    if (method === 'POST' && match[2] === 'link') {
      const row = unwrap(await db.rpc('ts_registration_result', { p_id: id.data })) as DbResult | null
      if (!row || row.registration_status !== 'AWAITING_PAYMENT' || !['PENDING', 'CUSTOMER_REPORTED'].includes(row.payment_status)) {
        throw new HttpError(409, 'Đăng ký này chưa có khoản phí chờ thanh toán.')
      }
      unwrap(await db.rpc('ts_admin_audit', { ...rpc, p_action: 'LINK_ISSUED' }))
      return json({ url: url.origin + '/payment#' + await security.issue(id.data, 'payment') })
    }
  }
  throw new HttpError(404, 'Không tìm thấy yêu cầu.')
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url)
    const path = url.pathname.replace(/^\/api/, '').replace(/\/$/, '')
    const method = request.method
    if (!['GET', 'POST'].includes(method)) return json({ error: 'Phương thức không được hỗ trợ.' }, 405, { Allow: 'GET, POST' })
    if (method === 'POST' && ((request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) ||
      request.headers.get('Sec-Fetch-Site') === 'cross-site')) throw new HttpError(403, 'Yêu cầu không hợp lệ.')

    const demo = env.DEMO_MODE === 'true'
    const bootstrap = method === 'GET' && path === '/bootstrap'
    const servicesEndpoint = method === 'GET' && path === '/services'
    if (demo || !configured(env)) {
      const data: Bootstrap = { demo, accepting: demo, services: defaultServices, legal: demo ? demoLegal : unavailableLegal }
      if (bootstrap) return json(data)
      if (servicesEndpoint) return json(data.services)
      throw new HttpError(503, demo ? 'Bản trải nghiệm chỉ sử dụng dữ liệu trong trình duyệt.' : 'Hệ thống hiện chưa mở.')
    }
    const db = createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, authConfig)
    const security = makeSecurity(env)
    if (bootstrap) {
      const [services, legal] = await Promise.all([readServices(db, true), readLegal(db)])
      return json({ demo: false, accepting: Boolean(legal && env.LEGAL_APPROVED === 'true'), services, legal: legal ?? unavailableLegal } satisfies Bootstrap)
    }
    if (servicesEndpoint) return json(await readServices(db, true))

    const category = path === '/admin/login' ? 'login' : path.startsWith('/admin/') ? 'admin' : path === '/registrations' ? 'register' : 'customer'
    const ip = request.headers.get('CF-Connecting-IP') ?? 'local'
    const bucket = await security.digest('ip-rate', category + ':' + ip)
    const allowed = unwrap(await db.rpc('ts_rate_limit', { p_bucket: bucket, p_limit: { login: 8, admin: 90, register: 15, customer: 40 }[category] }))
    if (!allowed) return json({ error: 'Quá nhiều yêu cầu. Vui lòng thử lại sau.' }, 429, { 'Retry-After': '60' })
    if (method === 'POST' && path === '/registrations') return await register(request, db, security, env)
    if (method === 'POST' && path === '/registrations/report-payment') {
      const body = await parseBody(request, tokenInput)
      const id = await security.verify(body.token, 'report')
      const row = unwrap(await db.rpc('ts_report_payment', { p_id: id })) as DbResult
      return json({ payment_status: row.payment_status })
    }
    if (method === 'POST' && path === '/payment') {
      const body = await parseBody(request, tokenInput)
      const id = await security.verify(body.token, 'payment')
      const row = unwrap(await db.rpc('ts_registration_result', { p_id: id })) as DbResult | null
      if (!row || row.registration_status === 'CANCELLED') throw new HttpError(404, 'Liên kết không còn hoạt động.')
      return json(await customerResult(row, security))
    }
    if (path.startsWith('/admin/')) return await handleAdmin(request, url, path, db, security, env)
    throw new HttpError(404, 'Không tìm thấy yêu cầu.')
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, code: error.code }, error.status)
    return json({ error: 'Chưa thể thực hiện yêu cầu. Vui lòng thử lại.' }, 503)
  }
}
