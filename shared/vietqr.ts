import type { Payment } from './domain'

export interface Beneficiary {
  bank: string
  bin: string
  account: string
  holder: string
  description_limit: number
}

function tlv(id: string, value: string) {
  if (!/^[\x20-\x7e]*$/.test(value) || value.length > 99) throw new Error('Trường VietQR không hợp lệ.')
  return id + String(value.length).padStart(2, '0') + value
}

export function crc16(value: string) {
  let crc = 0xffff
  for (const byte of new TextEncoder().encode(value)) {
    crc ^= byte << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}

export function transferDescription(reference: string, codes: string[]) {
  const order = ['HT', 'TC', 'KH']
  const sorted = order.filter(code => codes.includes(code))
  if (!/^TAX[A-Z0-9]{8}$/.test(reference) || sorted.length !== codes.length || !sorted.length) {
    throw new Error('Nội dung chuyển khoản không hợp lệ.')
  }
  return [reference, ...sorted].join(' ')
}

export function vietQr(beneficiary: Beneficiary, amount: number, description: string): Payment {
  const { bank, bin, account, holder, description_limit } = beneficiary
  if (!bank || !holder || !/^\d{6}$/.test(bin) || !/^\d{6,19}$/.test(account) ||
      !Number.isSafeInteger(amount) || amount <= 0 || amount > 999_999_999_999 ||
      !/^TAX[A-Z0-9]{8}(?: (?:HT|TC|KH)){1,3}$/.test(description) || description.length > description_limit) {
    throw new Error('Thông tin VietQR không hợp lệ.')
  }
  const consumer = tlv('00', bin) + tlv('01', account)
  const merchant = tlv('00', 'A000000727') + tlv('01', consumer) + tlv('02', 'QRIBFTTA')
  const body = tlv('00', '01') + tlv('01', '12') + tlv('38', merchant) + tlv('53', '704') +
    tlv('54', String(amount)) + tlv('58', 'VN') + tlv('62', tlv('08', description)) + '6304'
  return { bank, account, holder, description, payload: body + crc16(body) }
}

export function randomReference() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let result = ''
  while (result.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 252) result += alphabet[byte % 36]
      if (result.length === 8) return 'TAX' + result
    }
  }
  return 'TAX' + result
}
