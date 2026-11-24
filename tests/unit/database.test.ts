import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultServices, type ServiceId } from '../../shared/domain'

const db = new PGlite()
const owner = 'e5cf77d8-9070-483d-85dc-038a524020b6'
const operator = '3484d7b9-b14e-49c0-b94e-84c429c54bd3'
const unauthorized = 'fe51aa11-0a9a-4089-9364-b4284bce8245'
const synth = {
  full_name: 'Nguyễn Minh An', citizen_id_encrypted: 'test.encrypted.data', citizen_id_tail: '0000',
  email: 'sample@example.test', phone: '0900000000', birth_year: '1995', adult_confirmed: false,
}
interface Result { id: string; reference: string; total_fee: number | null; registration_status: string; payment_status: string; beneficiary: unknown; lines: Array<{ calculated_fee: number | null }> }

beforeAll(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${owner}'), ('${operator}'), ('${unauthorized}');
  `)
  await db.exec(await readFile(new URL('../../supabase/migrations/202611240001_taxsupport.sql', import.meta.url), 'utf8'))
  await db.exec(`
    insert into public.admins values ('${owner}', 'owner', true), ('${operator}', 'operator', true);
    insert into public.legal_config(version,identity,privacy,terms,contact,retention) values
    ('test-1','TaxSupport synthetic test only',repeat('Synthetic notice. ', 5),repeat('Synthetic terms. ', 5),'test@example.test','Synthetic test data');
  `)
})
afterAll(() => db.close())

const call = async <T = Result>(sql: string, values: unknown[] = []) =>
  (await db.query<{ result: T }>('select ' + sql + ' as result', values)).rows[0]!.result
const enablePayments = () => call('public.ts_update_beneficiary($1,$2)', [
  owner, { bank: 'Mẫu', bin: '000000', account: '0000000000', holder: 'TEST', description_limit: 20, verified: true },
])
const alpha = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
let counter = 0
function register(ids: ServiceId[], key = crypto.randomUUID(), hash = 'hashed', suppliedReference?: string, invalidPrice = false) {
  const index = ++counter
  const reference = suppliedReference ?? 'TAXTEST000' + alpha[index]
  const selections = ids.map(service_id => ({ service_id, additional_details: service_id === 'OTHER' ? 'Yêu cầu mẫu.' : null }))
  const snapshot = ids.map(id => {
    const { name, description, pricing_type, fixed_fee } = defaultServices.find(service => service.id === id)!
    return { service_id: id, name, description, pricing_type, fixed_fee: invalidPrice ? 1 : fixed_fee }
  })
  return call('public.ts_register($1,$2,$3,$4,$5,$6,$7)', [key, hash, reference, synth, JSON.stringify(selections), JSON.stringify(snapshot), 'test-1'])
}

describe('database migration and workflows', () => {
  it('denies direct reads, writes and RPCs to anonymous and authenticated roles', async () => {
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role)
      try {
        await expect(db.query('select * from public.registrations')).rejects.toMatchObject({ code: '42501' })
        await expect(db.query('insert into public.rate_buckets values (\'test\', now(), 1)')).rejects.toMatchObject({ code: '42501' })
        await expect(call('public.ts_registration_result($1)', [owner])).rejects.toMatchObject({ code: '42501' })
      } finally { await db.exec('reset role') }
    }
  })
  it('blocks paid registration until a beneficiary is verified and rolls back all rows', async () => {
    await expect(register(['TAX_REFUND'])).rejects.toMatchObject({ code: 'PT503' })
    const result = await db.query('select (select count(*) from public.registrations)::int, (select count(*) from public.registration_services)::int as lines')
    expect(result.rows[0]).toMatchObject({ count: 0, lines: 0 })
    await enablePayments()
  })
  it('applies server prices, rejects tampering, preserves retry reference and prevents collision duplicates', async () => {
    const key = crypto.randomUUID()
    const created = await register(['TAX_LOOKUP'], key)
    expect(created).toMatchObject({ registration_status: 'SUBMITTED', payment_status: 'NOT_REQUIRED', total_fee: 0, beneficiary: null })
    expect(await register(['TAX_LOOKUP'], key)).toMatchObject({ id: created.id, reference: created.reference })
    await expect(register(['TAX_LOOKUP'], key, 'different')).rejects.toMatchObject({ code: 'PT409' })
    await expect(register(['TAX_LOOKUP'], crypto.randomUUID(), 'hashed', created.reference)).rejects.toMatchObject({ code: '23505' })
    await expect(register(['TAX_REFUND'], crypto.randomUUID(), 'hashed', undefined, true)).rejects.toMatchObject({ message: 'CATALOG_CHANGED' })
  })
  it('supports complete quote, zero quote and guarded work transitions', async () => {
    const free = await register(['OTHER'])
    const paid = await register(['TAX_REFUND', 'OTHER'])
    expect(paid).toMatchObject({ registration_status: 'NEEDS_QUOTE', payment_status: 'AWAITING_QUOTE', total_fee: null, beneficiary: null })
    await expect(call('public.ts_confirm_quote($1,$2,$3)', [unauthorized, paid.id, { OTHER: 0, TAX_REFUND: 0 }])).rejects.toMatchObject({ code: '42501' })
    await expect(call('public.ts_confirm_quote($1,$2,$3)', [operator, paid.id, { OTHER: 0 }])).rejects.toMatchObject({ message: 'INVALID_QUOTE' })
    expect(await call('public.ts_confirm_quote($1,$2,$3)', [operator, free.id, { OTHER: 0 }])).toMatchObject({ total_fee: 0, payment_status: 'NOT_REQUIRED' })
    expect(await call('public.ts_transition($1,$2,$3)', [operator, free.id, 'PROCESSING'])).toMatchObject({ registration_status: 'PROCESSING' })
    expect(await call('public.ts_confirm_quote($1,$2,$3)', [operator, paid.id, { OTHER: 200000, TAX_REFUND: 300000 }])).toMatchObject({ total_fee: 500000, payment_status: 'PENDING' })
    await expect(call('public.ts_transition($1,$2,$3)', [operator, paid.id, 'PROCESSING'])).rejects.toMatchObject({ message: 'INVALID_STATE' })
    expect(await call('public.ts_report_payment($1)', [paid.id])).toMatchObject({ payment_status: 'CUSTOMER_REPORTED' })
    expect(await call('public.ts_report_payment($1)', [paid.id])).toMatchObject({ payment_status: 'CUSTOMER_REPORTED' })
    expect(await call('public.ts_verify_payment($1,$2,$3,$4)', [operator, paid.id, 450000, 'TX-TEST-1'])).toEqual({ discrepancy: true })
    expect(await call('public.ts_verify_payment($1,$2,$3,$4)', [operator, paid.id, 500000, 'TX-TEST-1'])).toMatchObject({ payment_status: 'VERIFIED' })
    expect(await call('public.ts_transition($1,$2,$3)', [operator, paid.id, 'PROCESSING'])).toMatchObject({ registration_status: 'PROCESSING' })
    expect(await call('public.ts_transition($1,$2,$3)', [operator, paid.id, 'COMPLETED'])).toMatchObject({ registration_status: 'COMPLETED' })
    const second = await register(['TAX_REFUND'])
    expect(await call('public.ts_verify_payment($1,$2,$3,$4)', [operator, second.id, 300000, 'TX-TEST-1'])).toEqual({ duplicate: true })
    await expect(call('public.ts_admin_audit($1,$2,$3)', [operator, second.id, 'UNMASK'])).rejects.toMatchObject({ code: '42501' })
    expect(await call('public.ts_transition($1,$2,$3)', [operator, second.id, 'CANCELLED'])).toMatchObject({ payment_status: 'CANCELLED' })
  })
  it('keeps pricing snapshots and audits catalog and beneficiary changes', async () => {
    const first = await register(['TAX_REFUND'])
    await call('public.ts_update_service($1,$2)', [owner, { ...defaultServices[0], fixed_fee: 320000 }])
    expect(await call('public.ts_registration_result($1)', [first.id])).toMatchObject({ total_fee: 300000, lines: [{ calculated_fee: 300000 }] })
    await expect(register(['TAX_REFUND'])).rejects.toMatchObject({ message: 'CATALOG_CHANGED' })
    const summary = await call('public.ts_metrics($1)', [owner])
    expect(summary).toMatchObject({ revenue: 500000, verified: 1 })
  })
})
