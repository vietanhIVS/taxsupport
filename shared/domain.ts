import { z } from 'zod'

export const serviceIds = ['TAX_REFUND', 'TAX_LOOKUP', 'OTHER'] as const
export const pricingTypes = ['FIXED', 'FREE', 'MANUAL_QUOTE'] as const
export const registrationStatuses = ['SUBMITTED', 'NEEDS_QUOTE', 'AWAITING_PAYMENT', 'PROCESSING', 'COMPLETED', 'CANCELLED'] as const
export const paymentStatuses = ['NOT_REQUIRED', 'AWAITING_QUOTE', 'PENDING', 'CUSTOMER_REPORTED', 'VERIFIED', 'CANCELLED'] as const

export type ServiceId = (typeof serviceIds)[number]
export type RegistrationStatus = (typeof registrationStatuses)[number]
export type PaymentStatus = (typeof paymentStatuses)[number]

export interface Service {
  id: ServiceId
  name: string
  description: string
  short_code: string
  pricing_type: (typeof pricingTypes)[number]
  fixed_fee: number | null
  is_active: boolean
  display_order: number
}

export interface Line {
  service_id: ServiceId
  service_name_snapshot: string
  service_description_snapshot: string
  service_code_snapshot: string
  pricing_snapshot: { type: Service['pricing_type']; fixed_fee: number | null }
  calculated_fee: number | null
  additional_details?: string | null
}

export interface Payment {
  bank: string
  account: string
  holder: string
  description: string
  payload: string
}

export interface Registration {
  reference: string
  registration_status: RegistrationStatus
  payment_status: PaymentStatus
  total_fee: number | null
  lines: Line[]
  payment?: Payment
  report_token?: string
  demo?: boolean
}

export interface Legal {
  version: string
  identity: string
  privacy: string
  terms: string
  contact: string
  retention: string
}

export interface Bootstrap {
  services: Service[]
  demo: boolean
  accepting: boolean
  legal: Legal
}

export const defaultServices: Service[] = [
  { id: 'TAX_REFUND', name: 'Hỗ trợ thủ tục hoàn thuế', description: 'Hướng dẫn chuẩn bị hồ sơ và thực hiện các bước đề nghị hoàn thuế thu nhập cá nhân.', short_code: 'HT', pricing_type: 'FIXED', fixed_fee: 300000, is_active: true, display_order: 1 },
  { id: 'TAX_LOOKUP', name: 'Tra cứu thông tin thuế', description: 'Hỗ trợ tra cứu mã số thuế và thông tin nghĩa vụ thuế cá nhân.', short_code: 'TC', pricing_type: 'FREE', fixed_fee: 0, is_active: true, display_order: 2 },
  { id: 'OTHER', name: 'Dịch vụ khác', description: 'Mô tả nhu cầu của bạn để nhận báo giá phù hợp trước khi thanh toán.', short_code: 'KH', pricing_type: 'MANUAL_QUOTE', fixed_fee: null, is_active: true, display_order: 3 },
]

export const demoLegal: Legal = {
  version: 'demo-1',
  identity: 'TaxSupport · Dịch vụ hỗ trợ thuế độc lập',
  privacy: 'Bản trải nghiệm sử dụng thông tin giả lập. Vui lòng không nhập dữ liệu cá nhân thật. Dữ liệu mẫu trong trình duyệt được xóa khi tải lại trang.',
  terms: 'TaxSupport hỗ trợ thủ tục và tra cứu thông tin thuế. Đây là dịch vụ độc lập, không thuộc cơ quan thuế và không cam kết kết quả hoàn thuế.',
  contact: 'Kênh tiếp nhận yêu cầu về quyền riêng tư sẽ được công bố trước khi mở đăng ký chính thức.',
  retention: 'Dữ liệu mẫu chỉ tồn tại trong phiên trải nghiệm.',
}

export const unavailableLegal: Legal = {
  version: '',
  identity: 'TaxSupport · Dịch vụ hỗ trợ thuế độc lập',
  privacy: 'Thông báo quyền riêng tư sẽ được công bố trước khi mở đăng ký.',
  terms: demoLegal.terms,
  contact: demoLegal.contact,
  retention: 'Thông tin về thời hạn lưu trữ sẽ được công bố trước khi mở đăng ký.',
}

export const syntheticPerson = {
  full_name: 'Nguyễn Minh An',
  birth_year: '1995',
  citizen_id: '000000000000',
  email: 'minhan@example.test',
  phone: '0900000000',
}

const timeZone = 'Asia/Ho_Chi_Minh'
export function currentYear() {
  return Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone }).format())
}

export const normalizePhone = (phone: string) => phone.startsWith('+84') ? '0' + phone.slice(3) : phone
export const ambiguousAge = (year: string) => Number(year) === currentYear() - 18
const birthYear = z.string().trim().regex(/^\d{4}$/, 'Nhập năm sinh gồm 4 chữ số.')
const personalFields = z.object({
  full_name: z.string().trim().normalize().min(2, 'Nhập họ và tên từ 2 ký tự.').max(100, 'Họ và tên tối đa 100 ký tự.').regex(/^[\p{L}\p{M}][\p{L}\p{M} .’'-]*$/u, 'Họ và tên chỉ gồm chữ cái và dấu phân cách.'),
  birth_year: birthYear,
  citizen_id: z.string().trim().regex(/^\d{12}$/, 'Số CCCD phải gồm đúng 12 chữ số.'),
  email: z.string().trim().max(254).pipe(z.email('Nhập địa chỉ email hợp lệ.')),
  phone: z.string().trim().regex(/^(?:0|\+84)[35789]\d{8}$/, 'Nhập số di động Việt Nam hợp lệ.').transform(normalizePhone),
  consent_given: z.boolean().refine(Boolean, 'Bạn cần đồng ý để tiếp tục.'),
  adult_confirmed: z.boolean(),
})

export const personalSchema = personalFields.superRefine((data, context) => {
  const year = Number(data.birth_year)
  if (!/^\d{4}$/.test(data.birth_year)) return
  if (year < 1900 || year > currentYear()) {
    context.addIssue({ code: 'custom', path: ['birth_year'], message: 'Năm sinh nằm ngoài khoảng hợp lệ.' })
  } else if (year > currentYear() - 18) {
    context.addIssue({ code: 'custom', path: ['birth_year'], message: 'Dịch vụ dành cho người từ đủ 18 tuổi.' })
  } else if (ambiguousAge(data.birth_year) && !data.adult_confirmed) {
    context.addIssue({ code: 'custom', path: ['adult_confirmed'], message: 'Xác nhận bạn đã đủ 18 tuổi.' })
  }
})

const selections = z.array(z.strictObject({
  service_id: z.enum(serviceIds),
  additional_details: z.string().trim().max(500).optional(),
})).min(1, 'Chọn ít nhất một dịch vụ.').max(3).superRefine((items, context) => {
  if (new Set(items.map(item => item.service_id)).size !== items.length) {
    context.addIssue({ code: 'custom', message: 'Dịch vụ đã được chọn.' })
  }
  for (const [index, item] of items.entries()) {
    if (item.service_id === 'OTHER' && (item.additional_details?.length ?? 0) < 5) {
      context.addIssue({ code: 'custom', path: [index, 'additional_details'], message: 'Mô tả nhu cầu từ 5 đến 500 ký tự.' })
    }
    if (item.service_id === 'TAX_REFUND' && item.additional_details) {
      context.addIssue({ code: 'custom', path: [index, 'additional_details'], message: 'Dịch vụ này không yêu cầu mô tả.' })
    }
  }
})

export const registrationSchema = z.strictObject({
  person: personalSchema,
  selections,
  consent_version: z.string().trim().min(1).max(100),
  catalog_snapshot: z.array(z.strictObject({
    service_id: z.enum(serviceIds),
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(500),
    pricing_type: z.enum(pricingTypes),
    fixed_fee: z.number().int().nonnegative().nullable(),
  })).min(1).max(3),
})

export type PersonInput = z.input<typeof personalSchema>
export type RegistrationInput = z.input<typeof registrationSchema>

export function calculatePricing(catalog: Service[], selected: RegistrationInput['selections']) {
  if (!selected.length || new Set(selected.map(item => item.service_id)).size !== selected.length) {
    throw new Error('Chọn ít nhất một dịch vụ và tránh chọn trùng.')
  }
  const lines = selected.map(({ service_id, additional_details }): Line => {
    const service = catalog.find(item => item.id === service_id && item.is_active)
    if (!service) throw new Error('Dịch vụ đã thay đổi. Vui lòng chọn lại.')
    return {
      service_id,
      service_name_snapshot: service.name,
      service_description_snapshot: service.description,
      service_code_snapshot: service.short_code,
      pricing_snapshot: { type: service.pricing_type, fixed_fee: service.fixed_fee },
      calculated_fee: service.pricing_type === 'MANUAL_QUOTE' ? null : service.fixed_fee,
      additional_details,
    }
  }).sort((a, b) => serviceIds.indexOf(a.service_id) - serviceIds.indexOf(b.service_id))
  const subtotal = lines.reduce((sum, item) => sum + (item.calculated_fee ?? 0), 0)
  return { lines, subtotal, total: lines.some(item => item.calculated_fee === null) ? null : subtotal }
}

export const formatVnd = (amount: number) => new Intl.NumberFormat('vi-VN').format(amount) + ' ₫'
export const servicePrice = (service: Pick<Service, 'pricing_type' | 'fixed_fee'>) =>
  service.pricing_type === 'MANUAL_QUOTE' ? 'Liên hệ báo giá' : service.fixed_fee === 0 ? 'Miễn phí' : formatVnd(service.fixed_fee ?? 0)
export const linePrice = (value: number | null) => value === null ? 'Chờ báo giá' : value === 0 ? 'Miễn phí' : formatVnd(value)

export const registrationLabels: Record<RegistrationStatus, string> = {
  SUBMITTED: 'Đã tiếp nhận', NEEDS_QUOTE: 'Chờ báo giá', AWAITING_PAYMENT: 'Chờ thanh toán',
  PROCESSING: 'Đang xử lý', COMPLETED: 'Hoàn thành', CANCELLED: 'Đã hủy',
}
export const paymentLabels: Record<PaymentStatus, string> = {
  NOT_REQUIRED: 'Miễn phí', AWAITING_QUOTE: 'Chờ báo giá', PENDING: 'Chờ chuyển khoản',
  CUSTOMER_REPORTED: 'Khách báo đã chuyển', VERIFIED: 'Đã xác minh', CANCELLED: 'Đã hủy',
}

export const transitions: Partial<Record<RegistrationStatus, RegistrationStatus[]>> = {
  SUBMITTED: ['PROCESSING', 'CANCELLED'],
  NEEDS_QUOTE: ['CANCELLED'],
  AWAITING_PAYMENT: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['COMPLETED', 'CANCELLED'],
}
