import {
  calculatePricing, defaultServices, demoLegal, registrationSchema, syntheticPerson,
  type Bootstrap, type Registration, type RegistrationInput,
} from '../../shared/domain'
import { randomReference, transferDescription, vietQr } from '../../shared/vietqr'

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch('/api' + path, { ...options, cache: 'no-store', credentials: 'same-origin' })
  } catch {
    throw new ApiError('Không thể kết nối. Vui lòng thử lại.', 503)
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string; code?: string }
    throw new ApiError(payload.error || 'Chưa thể thực hiện yêu cầu. Vui lòng thử lại.', response.status, payload.code)
  }
  return response.json() as Promise<T>
}

export const jsonPost = (value: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
})

export const demoBootstrap: Bootstrap = { services: defaultServices, demo: true, accepting: true, legal: demoLegal }

export const loadBootstrap = () => import.meta.env.DEV && import.meta.env.VITE_API_MODE !== 'cloudflare'
  ? Promise.resolve(demoBootstrap)
  : api<Bootstrap>('/bootstrap')

const demoOrders = new Map<string, Registration>()

export async function postRegistration(data: RegistrationInput, key: string, demo: boolean): Promise<Registration> {
  if (!demo) return api('/registrations', { ...jsonPost(data), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key } })
  const { person, selections } = registrationSchema.parse(data)
  if (Object.entries(syntheticPerson).some(([field, sample]) => person[field as keyof typeof syntheticPerson] !== sample)) {
    throw new ApiError('Bản trải nghiệm chỉ nhận thông tin mẫu.', 400)
  }
  const previous = demoOrders.get(key)
  if (previous) return structuredClone(previous)
  const { lines, total } = calculatePricing(defaultServices, selections)
  const reference = randomReference()
  const result: Registration = {
    reference, lines: lines.map(({ additional_details: _, ...line }) => { void _; return line }), total_fee: total, demo: true,
    registration_status: total === null ? 'NEEDS_QUOTE' : total > 0 ? 'AWAITING_PAYMENT' : 'SUBMITTED',
    payment_status: total === null ? 'AWAITING_QUOTE' : total > 0 ? 'PENDING' : 'NOT_REQUIRED',
  }
  if (total !== null && total > 0) {
    result.payment = vietQr({ bank: 'Ngân hàng mẫu', bin: '000000', account: '0000000000', holder: 'TAI KHOAN MAU', description_limit: 30 },
      total, transferDescription(reference, lines.map(line => line.service_code_snapshot)))
    result.report_token = crypto.randomUUID()
  }
  demoOrders.set(key, result)
  return structuredClone(result)
}

export async function reportTransfer(token: string, demo: boolean) {
  if (!demo) return api<{ payment_status: Registration['payment_status'] }>('/registrations/report-payment', jsonPost({ token }))
  const entry = [...demoOrders.values()].find(item => item.report_token === token)
  if (!entry) throw new ApiError('Liên kết không hợp lệ hoặc đã hết hạn.', 401)
  entry.payment_status = 'CUSTOMER_REPORTED'
  return { payment_status: entry.payment_status }
}
