import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleApi } from '../../server/api'
import { makeSecurity } from '../../server/security'
import { defaultServices, syntheticPerson } from '../../shared/domain'

const origin = 'https://taxsupport.example.test'
const actor = 'a927adc8-a33b-4855-8b7d-58928897b3a2'
const orderId = 'f9e13ffd-c30e-4347-8f1c-6a64ec469c25'
const otherOrderId = '16ce213a-624e-49c6-9835-9ef579309c03'
const key = (value: number) => Buffer.alloc(32, value).toString('base64url')
const env = {
  SUPABASE_URL: 'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service',
  SUPABASE_ANON_KEY: 'fixture-anon', DATA_ENCRYPTION_KEY: key(6), DATA_ENCRYPTION_KEY_ID: 'v1',
  PAYMENT_TOKEN_SIGNING_KEY: key(7), REGISTRATION_HASH_KEY: key(8), LEGAL_APPROVED: 'true',
}
const json = (body: unknown, status = 200, headers?: Record<string, string>) => Response.json(body, { status, headers })
const registerRequest = (body: unknown) => new Request(origin + '/api/registrations', {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
})
const cookie = { Cookie: '__Host-taxsupport-admin=fixture-jwt' }
type MockHandler = (url: URL, body: Record<string, unknown>, request: Request) => Response | Promise<Response>
function mockDatabase(handler: MockHandler) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const body = request.body ? await request.json() as Record<string, unknown> : {}
    if (url.pathname.endsWith('/ts_rate_limit')) return json(true)
    if (url.pathname === '/auth/v1/user') return json({ id: actor, aud: 'authenticated' })
    return handler(url, body, request)
  })
}
afterEach(() => vi.unstubAllGlobals())

describe('Pages API boundary', () => {
  it('rejects attempted price tampering and blocks collection until approved', async () => {
    mockDatabase(() => { throw new Error('Unexpected database call') })
    expect((await handleApi(registerRequest({ total_fee: 1 }), env)).status).toBe(400)
    expect((await handleApi(registerRequest({ total_fee: 1 }), { ...env, LEGAL_APPROVED: 'false' })).status).toBe(503)
  })

  it('encrypts personal identifiers before persistence and retries reference collisions', async () => {
    const attempted: string[] = []
    const s = makeSecurity(env)
    mockDatabase(async (url, body) => {
      expect(url.pathname).toBe('/rest/v1/rpc/ts_register')
      const reference = String(body.p_reference)
      attempted.push(reference)
      const person = body.p_person as Record<string, string>
      expect(person.citizen_id).toBeUndefined()
      await expect(s.decrypt(person.citizen_id_encrypted!, reference)).resolves.toBe(syntheticPerson.citizen_id)
      if (attempted.length === 1) return json({ code: '23505', message: 'duplicate registrations_reference_code_key' }, 409)
      return json({ id: orderId, reference, registration_status: 'SUBMITTED', payment_status: 'NOT_REQUIRED', total_fee: 0, lines: [] })
    })
    const catalog = defaultServices.find(item => item.id === 'TAX_LOOKUP')!
    const response = await handleApi(registerRequest({
      person: { ...syntheticPerson, consent_given: true, adult_confirmed: false },
      consent_version: 'test-1', selections: [{ service_id: catalog.id }],
      catalog_snapshot: [{ service_id: catalog.id, name: catalog.name, description: catalog.description, pricing_type: catalog.pricing_type, fixed_fee: catalog.fixed_fee }],
    }), env)
    expect(response.status).toBe(201)
    expect(attempted).toHaveLength(2)
    expect(attempted[0]).not.toBe(attempted[1])
    const result = await response.json()
    expect(result).toMatchObject({ reference: attempted[1], total_fee: 0 })
    expect(result).not.toHaveProperty('id')
    expect(result).not.toHaveProperty('report_token')
  })

  it('requires a matching scope and uses the signed order ID for payment access', async () => {
    const s = makeSecurity(env)
    const requested: unknown[] = []
    mockDatabase((url, body) => {
      expect(url.pathname).toBe('/rest/v1/rpc/ts_registration_result')
      requested.push(body.p_id)
      return json({
        id: orderId, reference: 'TAX4C8M2X9T', registration_status: 'AWAITING_PAYMENT', payment_status: 'PENDING', total_fee: 300000,
        beneficiary: { bank: 'Mẫu', bin: '000000', account: '0000000000', holder: 'TEST', description_limit: 20 },
        transfer_description: 'TAX4C8M2X9T HT', lines: [],
      })
    })
    const pay = (token: string) => handleApi(new Request(origin + '/api/payment?id=' + otherOrderId, {
      method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': 'application/json' },
    }), env)
    expect((await pay(await s.issue(orderId, 'report'))).status).toBe(401)
    const response = await pay(await s.issue(orderId, 'payment'))
    expect(response.status).toBe(200)
    expect(requested).toEqual([orderId])
    const data = await response.json() as { report_token: string; payment: { payload: string } }
    expect(data.payment.payload).toContain('TAX4C8M2X9T HT')
    await expect(s.verify(data.report_token, 'report')).resolves.toBe(orderId)
  })

  it('rejects authenticated non-admins and unauthenticated access', async () => {
    mockDatabase((url, body) => {
      expect(url.pathname).toBe('/rest/v1/rpc/ts_require_admin')
      expect(body.p_actor).toBe(actor)
      return json({ code: '42501', message: 'DENIED' }, 403)
    })
    expect((await handleApi(new Request(origin + '/api/admin/registrations'), env)).status).toBe(401)
    expect((await handleApi(new Request(origin + '/api/admin/registrations', { headers: cookie }), env)).status).toBe(403)
  })

  it('limits CSV export to owners and masks and neutralizes spreadsheet cells', async () => {
    let exportAudited = false
    mockDatabase((url, body) => {
      if (url.pathname.endsWith('/ts_require_admin')) {
        expect(body.p_owner).toBe(true)
        return json('owner')
      }
      if (url.pathname.endsWith('/ts_admin_audit')) {
        exportAudited = body.p_action === 'EXPORT'
        return json(null)
      }
      expect(url.pathname).toBe('/rest/v1/registrations')
      return json([{
        value: 'fixture', id: orderId, reference_code: 'TAX4C8M2X9T', full_name: 'Test Fixture', total_fee: 0, phone: '0900123456',
        citizen_id_tail: '0000', registration_status: 'SUBMITTED', payment_status: 'NOT_REQUIRED', created_at: '2026-11-24T08:00:00Z',
        registration_services: [{ service_id: 'TAX_LOOKUP', service_name_snapshot: '=1+1' }],
      }], 200, { 'Content-Range': '0-0/1' })
    })
    const response = await handleApi(new Request(origin + '/api/admin/export', { headers: cookie }), env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/csv')
    const csv = await response.text()
    expect(csv).toContain('"\'=1+1"')
    expect(csv).toContain('••••••3456')
    expect(csv).not.toContain('0900123456')
    expect(exportAudited).toBe(true)
  })
})
