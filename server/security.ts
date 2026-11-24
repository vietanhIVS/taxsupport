import { z } from 'zod'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const base64url = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
const fromBase64url = (data: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(data)) throw new Error('Invalid encoding')
  return Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), value => value.charCodeAt(0))
}

export interface Env {
  DEMO_MODE?: string
  LEGAL_APPROVED?: string
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  DATA_ENCRYPTION_KEY?: string
  DATA_ENCRYPTION_KEY_ID?: string
  DATA_ENCRYPTION_PREVIOUS_KEYS?: string
  PAYMENT_TOKEN_SIGNING_KEY?: string
  REGISTRATION_HASH_KEY?: string
}

export class HttpError extends Error {
  status: number
  code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const tokenSchema = z.strictObject({
  id: z.uuid(),
  scope: z.enum(['payment', 'report']),
  exp: z.number().int(),
  nonce: z.uuid(),
})

const keyBytes = (encoded: string) => {
  const bytes = fromBase64url(encoded)
  if (bytes.byteLength !== 32) throw new Error('Invalid key length')
  return bytes
}

export function makeSecurity(env: Env) {
  const signing = keyBytes(env.PAYMENT_TOKEN_SIGNING_KEY ?? '')
  const registration = keyBytes(env.REGISTRATION_HASH_KEY ?? '')
  const encryption = keyBytes(env.DATA_ENCRYPTION_KEY ?? '')
  const kid = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).parse(env.DATA_ENCRYPTION_KEY_ID)
  if (new Set([env.PAYMENT_TOKEN_SIGNING_KEY, env.REGISTRATION_HASH_KEY, env.DATA_ENCRYPTION_KEY]).size !== 3) throw new Error('Separate keys required')
  const previous = z.record(z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), z.string()).parse(JSON.parse(env.DATA_ENCRYPTION_PREVIOUS_KEYS || '{}'))
  const importHmac = (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const hmac = importHmac(signing)
  const requestHmac = importHmac(registration)
  const aes = (bytes: Uint8Array<ArrayBuffer>) => crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  const activeKey = aes(encryption)
  const boundData = (reference: string, keyId: string) => encoder.encode(`taxsupport:citizen-id:${keyId}:${reference}`)

  return {
    async digest(purpose: 'registration' | 'ip-rate', value: string) {
      const key = purpose === 'registration' ? await requestHmac : await hmac
      return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(purpose + '\0' + value))))
    },
    async encrypt(value: string, reference: string) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: boundData(reference, kid) }, await activeKey, encoder.encode(value))
      return [kid, base64url(iv), base64url(new Uint8Array(data))].join('.')
    },
    async decrypt(value: string, reference: string) {
      const [storedId, iv, ciphertext] = value.split('.')
      if (!storedId || !iv || !ciphertext) throw new Error('Invalid encrypted value')
      const key = storedId === kid ? await activeKey : await aes(keyBytes(previous[storedId] ?? ''))
      return decoder.decode(await crypto.subtle.decrypt({
        name: 'AES-GCM', iv: fromBase64url(iv), additionalData: boundData(reference, storedId),
      }, key, fromBase64url(ciphertext)))
    },
    async issue(id: string, scope: 'payment' | 'report') {
      const duration = scope === 'payment' ? 7 * 86400 : 86400
      const encoded = base64url(encoder.encode(JSON.stringify({
        id, scope, exp: Math.floor(Date.now() / 1000) + duration, nonce: crypto.randomUUID(),
      })))
      const signature = await crypto.subtle.sign('HMAC', await hmac, encoder.encode('link\0' + encoded))
      return encoded + '.' + base64url(new Uint8Array(signature))
    },
    async verify(token: string, scope: 'payment' | 'report') {
      try {
        const [encoded, signature, extra] = token.split('.')
        if (!encoded || !signature || extra !== undefined ||
          !(await crypto.subtle.verify('HMAC', await hmac, fromBase64url(signature), encoder.encode('link\0' + encoded)))) throw new Error()
        const data = tokenSchema.parse(JSON.parse(decoder.decode(fromBase64url(encoded))))
        if (data.scope !== scope || data.exp <= Math.floor(Date.now() / 1000)) throw new Error()
        return data.id
      } catch {
        throw new HttpError(401, 'Liên kết không hợp lệ hoặc đã hết hạn.')
      }
    },
  }
}

export type Security = ReturnType<typeof makeSecurity>
