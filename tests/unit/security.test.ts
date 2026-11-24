import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApi } from '../../server/api'
import { makeSecurity } from '../../server/security'

const key = (value: number) => Buffer.alloc(32, value).toString('base64url')
const env = { DATA_ENCRYPTION_KEY: key(3), DATA_ENCRYPTION_KEY_ID: 'v1', PAYMENT_TOKEN_SIGNING_KEY: key(7), REGISTRATION_HASH_KEY: key(8) }
const id = '7dc62dcb-5a4d-421e-ae52-5b99f6c47244'

afterEach(() => vi.restoreAllMocks())

describe('security', () => {
  it('encrypts CCCD with reference-bound authentication and supports key rotation', async () => {
    const s = makeSecurity(env)
    const result = await s.encrypt('000000000001', 'TAX8F2K9M3A')
    expect(result).not.toContain('000000000001')
    const rotated = makeSecurity({ ...env, DATA_ENCRYPTION_KEY: key(5), DATA_ENCRYPTION_KEY_ID: 'v2', DATA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ v1: key(3) }) })
    await expect(rotated.decrypt(result, 'TAX8F2K9M3A')).resolves.toBe('000000000001')
    await expect(rotated.decrypt(result, 'TAX8F2K9M3B')).rejects.toThrow()
  })
  it('preserves registration digests when signing keys are rotated', async () => {
    const previous = makeSecurity(env)
    const rotated = makeSecurity({ ...env, PAYMENT_TOKEN_SIGNING_KEY: key(9) })
    await expect(rotated.digest('registration', 'sample')).resolves.toBe(await previous.digest('registration', 'sample'))
    await expect(rotated.verify(await previous.issue(id, 'payment'), 'payment')).rejects.toMatchObject({ status: 401 })
  })
  it('rejects tampered, wrong-scope and expired tokens', async () => {
    const now = Date.now()
    const s = makeSecurity(env)
    const token = await s.issue(id, 'report')
    await expect(s.verify(token, 'report')).resolves.toBe(id)
    await expect(s.verify(token, 'payment')).rejects.toMatchObject({ status: 401 })
    await expect(s.verify('x' + token, 'report')).rejects.toMatchObject({ status: 401 })
    vi.spyOn(Date, 'now').mockReturnValue(now + 86_401_000)
    await expect(s.verify(token, 'report')).rejects.toMatchObject({ status: 401 })
  })
  it('fails closed without production config and serves only demo bootstrap data in demo mode', async () => {
    const website = 'https://site.example.test/api'
    const boot = await handleApi(new Request(website + '/bootstrap'), {})
    expect(await boot.json()).toMatchObject({ demo: false, accepting: false })
    const demo = await handleApi(new Request(website + '/bootstrap'), { DEMO_MODE: 'true' })
    expect(await demo.json()).toMatchObject({ demo: true, accepting: true })
    const action = new Request(website + '/registrations', { method: 'POST', body: '{}' })
    expect((await handleApi(action, { DEMO_MODE: 'true' })).status).toBe(503)
    expect((await handleApi(new Request(website + '/admin/login', { method: 'POST', headers: { Origin: 'https://other.example.test' } }), {})).status).toBe(403)
  })
})
