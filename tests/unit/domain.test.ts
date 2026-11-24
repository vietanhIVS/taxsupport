import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import QRCode from 'qrcode'
import { calculatePricing, currentYear, defaultServices, formatVnd, personalSchema, registrationSchema, syntheticPerson } from '../../shared/domain'
import { crc16, randomReference, transferDescription, vietQr } from '../../shared/vietqr'

const person = { ...syntheticPerson, full_name: '  Nguyễn Ánh   ', phone: '+84900000000', consent_given: true, adult_confirmed: false }

describe('registration validation', () => {
  it('preserves leading zeroes, trims Vietnamese names and normalizes phone numbers', () => {
    expect(personalSchema.parse(person)).toMatchObject({ full_name: 'Nguyễn Ánh', citizen_id: '000000000000', phone: '0900000000' })
  })
  it.each([
    { full_name: 'N' }, { full_name: 'Bad123' }, { citizen_id: '01000000000' }, { citizen_id: '01000000000X' },
    { phone: '0400000000' }, { email: 'example.test' }, { consent_given: false }, { birth_year: '1899' },
    { birth_year: String(currentYear() + 1) }, { birth_year: String(currentYear() - 17) },
    { birth_year: String(currentYear() - 18) },
  ])('rejects %o', (patch) => {
    expect(personalSchema.safeParse({ ...person, ...patch }).success).toBe(false)
  })
  it('accepts explicit confirmation when birth year alone is ambiguous', () => {
    expect(personalSchema.safeParse({ ...person, birth_year: String(currentYear() - 18), adult_confirmed: true }).success).toBe(true)
  })
  it('validates quote details and rejects client-supplied totals', () => {
    const order = {
      person, consent_version: 'test-1', selections: [{ service_id: 'OTHER', additional_details: ' 1234 ' }],
      catalog_snapshot: [{ service_id: 'OTHER', name: 'Test', description: 'Synthetic fixture', pricing_type: 'MANUAL_QUOTE', fixed_fee: null }],
    }
    expect(registrationSchema.safeParse(order).success).toBe(false)
    order.selections[0]!.additional_details += '5'
    expect(registrationSchema.safeParse(order).success).toBe(true)
    expect(registrationSchema.safeParse({ ...order, total_fee: 0 }).success).toBe(false)
  })
})

describe('pricing', () => {
  it.each([
    [true, false, false, 300000], [false, true, false, 0], [true, true, false, 300000],
    [false, false, true, null], [true, false, true, null], [false, true, true, null], [true, true, true, null],
  ])('applies HT=%s TC=%s KH=%s', (ht, tc, kh, expected) => {
    const selected = defaultServices.filter((_, index) => [ht, tc, kh][index]).map(item => ({ service_id: item.id }))
    const result = calculatePricing(defaultServices, selected)
    expect(result.total).toBe(expected)
    expect(result.subtotal).toBe(ht ? 300000 : 0)
  })
  it('rejects empty and inactive selections and formats VND', () => {
    expect(() => calculatePricing(defaultServices, [])).toThrow()
    expect(() => calculatePricing([], [{ service_id: 'TAX_REFUND' }])).toThrow()
    expect(formatVnd(300000)).toBe('300.000 ₫')
  })
})

function decodeTlv(value: string) {
  const result = new Map<string, string>()
  while (value) {
    const id = value.slice(0, 2)
    const length = Number(value.slice(2, 4))
    if (!Number.isInteger(length) || length < 1 || length > value.length - 4) throw new Error('Bad TLV')
    result.set(id, value.slice(4, 4 + length))
    value = value.slice(4 + length)
  }
  return result
}

describe('VietQR', () => {
  it('generates a server reference with the specified alphabet and stable service ordering', () => {
    for (let i = 0; i < 100; i++) expect(randomReference()).toMatch(/^TAX[A-Z0-9]{8}$/)
    expect(transferDescription('TAX8F2K9M3A', ['KH', 'TC', 'HT'])).toBe('TAX8F2K9M3A HT TC KH')
    expect(() => transferDescription('TAX8F2K9M3A', ['HT', 'HT'])).toThrow()
    expect(crc16('123456789')).toBe('29B1')
  })
  it('decodes the generated PNG and checks the recipient, amount, reference and checksum', async () => {
    const order = vietQr({ bank: 'Mẫu', holder: 'MẪU', bin: '000000', account: '0000000000', description_limit: 20 }, 300000, 'TAX8F2K9M3A HT TC')
    const png = PNG.sync.read(await QRCode.toBuffer(order.payload, { width: 640, margin: 4 }))
    const data = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data
    expect(data).toBe(order.payload)
    expect(png.width).toBe(640)
    const fields = decodeTlv(data!)
    const merchant = decodeTlv(fields.get('38')!)
    const beneficiary = decodeTlv(merchant.get('01')!)
    expect(merchant.get('00')).toBe('A000000727')
    expect(merchant.get('02')).toBe('QRIBFTTA')
    expect(beneficiary.get('00')).toBe('000000')
    expect(beneficiary.get('01')).toBe('0000000000')
    expect(fields.get('53')).toBe('704')
    expect(fields.get('54')).toBe('300000')
    expect(decodeTlv(fields.get('62')!).get('08')).toBe('TAX8F2K9M3A HT TC')
    expect(fields.get('63')).toBe(crc16(data!.slice(0, -4)))
    expect(data).not.toContain('@')
  })
})
