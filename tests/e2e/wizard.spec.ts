import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { defaultServices, demoLegal, calculatePricing, syntheticPerson, registrationSchema, type Bootstrap, type Registration, type Service } from '../../shared/domain'
import { transferDescription, vietQr } from '../../shared/vietqr'

const origin = 'https://taxsupport.example.test'
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
}
const reference = 'TAXE2E00001'
const fixtureBank = { bank: 'Ngân hàng mẫu', bin: '000000', account: '0000000000', holder: 'TAI KHOAN MAU', description_limit: 20 }

async function serveBuild(page: Page, config: Partial<Bootstrap> = {}) {
  const bootstrap: Bootstrap = { services: defaultServices, demo: false, accepting: true, legal: demoLegal, ...config }
  const calls: string[] = []
  const state = { failFirst: false, invalidCatalogOnce: false, calls }
  const dist = resolve('dist')
  const csp = (await readFile(resolve(dist, '_headers'), 'utf8')).match(/Content-Security-Policy: ([^\n]*)/)?.[1] ?? ''
  await page.route(origin + '/**', async route => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status })
    if (pathname === '/api/bootstrap') return json(bootstrap)
    if (pathname === '/api/admin/session') return json({ error: 'Vui lòng đăng nhập.' }, 401)
    if (pathname === '/api/payment') return json({ error: 'Liên kết không hợp lệ hoặc đã hết hạn.' }, 401)
    if (pathname === '/api/registrations/report-payment') return json({ payment_status: 'CUSTOMER_REPORTED' })
    if (pathname === '/api/registrations') {
      calls.push(request.headers()['idempotency-key'] ?? '')
      if (state.failFirst && calls.length === 1) return json({ error: 'Chưa thể lưu yêu cầu. Vui lòng thử lại.' }, 503)
      if (state.invalidCatalogOnce && calls.length === 1) {
        bootstrap.services = defaultServices.map(item => item.id === 'TAX_REFUND' ? { ...item, fixed_fee: 320000 } : item) satisfies Service[]
        return json({ error: 'Danh mục hoặc giá đã thay đổi.', code: 'CATALOG_CHANGED' }, 409)
      }
      const parsed = registrationSchema.parse(request.postDataJSON())
      const { lines, total } = calculatePricing(bootstrap.services, parsed.selections)
      const row: Registration = {
        reference, lines, total_fee: total, registration_status: total === null ? 'NEEDS_QUOTE' : total === 0 ? 'SUBMITTED' : 'AWAITING_PAYMENT',
        payment_status: total === null ? 'AWAITING_QUOTE' : total === 0 ? 'NOT_REQUIRED' : 'PENDING',
      }
      if (total) {
        row.payment = vietQr(fixtureBank, total, transferDescription(reference, lines.map(line => line.service_code_snapshot)))
        row.report_token = 'fixture-test-token'
      }
      await new Promise(resolve => setTimeout(resolve, 60))
      return json(row, 201)
    }
    if (pathname.startsWith('/api')) return json({}, 404)
    const clamped = resolve(dist, '.' + (extname(pathname) ? pathname : '/index.html'))
    if (!clamped.startsWith(dist + '/')) return route.abort()
    const mime = types[extname(clamped)] ?? 'application/octet-stream'
    return route.fulfill({ body: await readFile(clamped), contentType: mime, headers: { 'Content-Security-Policy': csp } })
  })
  return state
}

const next = (page: Page) => page.getByRole('button', { name: 'Tiếp theo', exact: true })
async function completePersonal(page: Page) {
  await page.getByLabel('Họ và tên').fill(syntheticPerson.full_name)
  await page.getByLabel('Năm sinh').fill(syntheticPerson.birth_year)
  await page.getByLabel('Số căn cước công dân').fill(syntheticPerson.citizen_id)
  await page.getByLabel('Số điện thoại').fill(syntheticPerson.phone)
  await page.getByLabel('Email', { exact: false }).fill(syntheticPerson.email)
  await page.getByLabel('Tôi đồng ý').check()
  await next(page).click()
}

test('validates required fields, opens legal notices and preserves personal input on back', async ({ page }) => {
  await serveBuild(page)
  await page.goto(origin)
  await next(page).click()
  await expect(page.getByText('Số CCCD phải gồm đúng 12 chữ số.')).toBeVisible()
  await page.getByRole('button', { name: 'thông báo quyền riêng tư' }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await completePersonal(page)
  await expect(page.getByRole('heading', { name: 'Lựa chọn dịch vụ' })).toBeFocused()
  await next(page).click()
  await expect(page.getByText('Chọn ít nhất một dịch vụ.')).toBeVisible()
  await page.getByRole('button', { name: 'Quay lại' }).click()
  await expect(page.getByLabel('Số căn cước công dân')).toHaveValue('000000000000')
  await expect(page.getByLabel('Tôi đồng ý')).toBeChecked()
})

test('paid and free services together produce one registration, a downloadable QR, and a separate report status', async ({ page }) => {
  const state = await serveBuild(page)
  await page.goto(origin)
  await completePersonal(page)
  await page.getByRole('checkbox', { name: /Hỗ trợ thủ tục hoàn thuế/ }).check()
  await page.getByRole('checkbox', { name: /Tra cứu thông tin thuế/ }).check()
  await expect(page.locator('.receipt-total')).toContainText('300.000 ₫')
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).dblclick()
  await expect(page.getByRole('img', { name: 'Mã VietQR thanh toán' })).toBeVisible()
  expect(state.calls).toHaveLength(1)
  await expect(page.getByText(reference + ' HT TC')).toBeVisible()
  const download = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Tải mã QR' }).click()
  expect((await download).suggestedFilename()).toBe(reference + '-vietqr.png')
  await page.getByRole('button', { name: 'Tôi đã chuyển khoản' }).click()
  await expect(page.getByText(/Chúng tôi sẽ kiểm tra giao dịch/)).toBeVisible()
  await expect(page.getByText('Khoản thanh toán của bạn đã được xác minh.')).toHaveCount(0)
})

test('free flow skips QR and payment instructions', async ({ page }) => {
  await serveBuild(page)
  await page.goto(origin)
  await completePersonal(page)
  await page.getByRole('checkbox', { name: /Tra cứu thông tin thuế/ }).check()
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('heading', { name: 'Đăng ký thành công!' })).toBeVisible()
  await expect(page.getByText('0 ₫', { exact: true })).toBeVisible()
  await expect(page.getByRole('img', { name: /VietQR/ })).toHaveCount(0)
  await expect(page.getByText('Số tài khoản')).toHaveCount(0)
})

test('requires quote details, clears deselected data and prevents payment before a quote', async ({ page }) => {
  await serveBuild(page)
  await page.goto(origin)
  await completePersonal(page)
  const other = page.getByRole('checkbox', { name: /Dịch vụ khác/ })
  await page.getByRole('checkbox', { name: /Hỗ trợ thủ tục hoàn thuế/ }).check()
  await other.check()
  await expect(page.getByText('Tạm tính các mục đã có giá')).toBeVisible()
  await next(page).click()
  await expect(page.getByText('Mô tả nhu cầu từ 5 đến 500 ký tự.')).toBeVisible()
  const details = page.getByRole('textbox', { name: 'Mô tả nhu cầu *', exact: true })
  await details.fill('Nhu cầu kiểm thử.')
  await other.uncheck()
  await other.check()
  await expect(details).toHaveValue('')
  await details.fill('Nhu cầu kiểm thử.')
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('heading', { name: 'Đang chờ báo giá' })).toBeVisible()
  await expect(page.getByRole('img', { name: /VietQR/ })).toHaveCount(0)
})

test('reuses idempotency key after failed save and shows QR only after successful retry', async ({ page }) => {
  const state = await serveBuild(page)
  state.failFirst = true
  await page.goto(origin)
  await completePersonal(page)
  await page.getByRole('checkbox', { name: /Hỗ trợ thủ tục hoàn thuế/ }).check()
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('alert')).toContainText('Chưa thể lưu yêu cầu.')
  await expect(page.getByRole('img', { name: /VietQR/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('img', { name: /VietQR/ })).toBeVisible()
  expect(state.calls[0]).toBeTruthy()
  expect(state.calls).toEqual([state.calls[0], state.calls[0]])
})

test('requires review again after the catalog price changes', async ({ page }) => {
  const state = await serveBuild(page)
  state.invalidCatalogOnce = true
  await page.goto(origin)
  await completePersonal(page)
  await page.getByRole('checkbox', { name: /Hỗ trợ thủ tục hoàn thuế/ }).check()
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('heading', { name: 'Lựa chọn dịch vụ' })).toBeVisible()
  await expect(page.locator('.receipt-total')).toContainText('320.000 ₫')
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('img', { name: /VietQR/ })).toBeVisible()
  expect(state.calls[0]).not.toBe(state.calls[1])
})

test('demo fields use only synthetic inputs and layout fits at 320 pixels', async ({ page }) => {
  const state = await serveBuild(page, { demo: true })
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto(origin)
  await expect(page.locator('html')).toHaveAttribute('lang', 'vi')
  await expect(page.getByLabel('Họ và tên')).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: 'Dùng thông tin mẫu' }).click()
  await expect(page.getByLabel('Họ và tên')).toHaveValue(syntheticPerson.full_name)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
  await page.getByLabel('Tôi đồng ý').check()
  await next(page).click()
  await page.getByRole('checkbox', { name: /Hỗ trợ thủ tục hoàn thuế/ }).check()
  await next(page).click()
  await page.getByRole('button', { name: 'Gửi đăng ký' }).click()
  await expect(page.getByRole('img', { name: 'Mã VietQR giả lập' })).toBeVisible()
  await expect(page.getByText(/Vui lòng không chuyển tiền/)).toBeVisible()
  expect(state.calls).toHaveLength(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320)
})

test('closed production bootstrap exposes no form and a reference alone cannot open payment details', async ({ page }) => {
  const state = await serveBuild(page, { accepting: false })
  await page.goto(origin)
  await expect(page.getByText('Dịch vụ hiện chưa mở đăng ký trực tuyến.')).toBeVisible()
  await expect(page.getByLabel('Họ và tên')).toHaveCount(0)
  expect(state.calls).toHaveLength(0)
  await page.goto(origin + '/payment?reference=' + reference)
  await expect(page.getByRole('alert')).toContainText('Liên kết thanh toán không hợp lệ')
})

test('demo admin opens masked fixture details and filters by service', async ({ page }) => {
  await serveBuild(page, { demo: true })
  await page.goto(origin + '/admin')
  await page.getByRole('button', { name: 'Xem dữ liệu mẫu' }).click()
  await expect(page.getByRole('heading', { name: 'Quản lý đăng ký' })).toBeVisible()
  await page.getByLabel('Dịch vụ', { exact: true }).selectOption('OTHER')
  await page.getByRole('button', { name: 'Lọc', exact: true }).click()
  await expect(page.getByRole('row')).toHaveCount(2)
  await page.getByRole('button', { name: 'TAXDEMO0003' }).click()
  await expect(page.getByRole('dialog')).toContainText('••••••••0000')
  await expect(page.getByRole('button', { name: 'Hiện CCCD và thông tin liên hệ' })).toHaveCount(0)
})

test('admin reviews a quote, copies the scoped link and can only start after verification', async ({ page }) => {
  await serveBuild(page)
  const id = 'f9e13ffd-c30e-4347-8f1c-6a64ec469c25'
  const now = '2026-11-24T08:00:00Z'
  const { lines } = calculatePricing(defaultServices, [{ service_id: 'OTHER', additional_details: 'Nhu cầu giả lập.' }])
  const row = {
    id, reference_code: reference, full_name: syntheticPerson.full_name, citizen_id: '••••••••0000', phone: '••••••0000', total_fee: null as number | null,
    registration_status: 'NEEDS_QUOTE', payment_status: 'AWAITING_QUOTE', created_at: now, consent_at: now,
    birth_year: 1995, consent_version: 'test-1', registration_services: lines, audit_events: [], payment_records: null,
  }
  let signedIn = false
  await page.route(origin + '/api/admin/**', async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.slice('/api/admin'.length)
    const json = (value: unknown, status = 200) => route.fulfill({ json: value, status })
    if (path === '/login') {
      signedIn = true
      return json({ role: 'owner' })
    }
    if (!signedIn) return json({ error: 'Vui lòng đăng nhập.' }, 401)
    if (path === '/metrics') return json({ total: 1, today: 1, free: 0, paid: 0, quotes: 1, pending: 0, verified: 0, processing: 0, completed: 0, revenue: 0 })
    if (path === '/registrations') return json({ rows: [row], count: 1 })
    if (path.endsWith('/quote')) {
      row.total_fee = request.postDataJSON().prices.OTHER as number
      row.registration_services[0]!.calculated_fee = row.total_fee
      row.registration_status = 'AWAITING_PAYMENT'
      row.payment_status = 'PENDING'
    } else if (path.endsWith('/link')) {
      return json({ url: origin + '/payment#scoped-test-token' })
    } else if (path.endsWith('/verify')) {
      row.payment_status = 'VERIFIED'
    } else if (path.endsWith('/status')) {
      row.registration_status = 'PROCESSING'
    } else if (path === '/registrations/' + id) {
      return json(row)
    } else {
      return json({ error: 'Không tìm thấy yêu cầu.' }, 404)
    }
    return json({ ok: true })
  })

  await page.goto(origin + '/admin')
  await page.getByLabel('Email', { exact: true }).fill('owner@example.test')
  await page.getByLabel('Mật khẩu', { exact: true }).fill('synthetic-test-password')
  await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  await page.getByRole('button', { name: reference, exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Chờ báo giá')
  await expect(dialog.getByRole('button', { name: 'Tạo liên kết thanh toán' })).toHaveCount(0)
  await dialog.getByRole('spinbutton', { name: 'Dịch vụ khác (VND)' }).fill('150000')
  await dialog.getByRole('button', { name: 'Xác nhận báo giá' }).click()
  await expect(dialog).toContainText('150.000 ₫')
  await expect(dialog.getByRole('button', { name: 'Bắt đầu xử lý' })).toHaveCount(0)
  await dialog.getByRole('button', { name: 'Tạo liên kết thanh toán' }).click()
  await expect(dialog.getByRole('textbox', { name: /Liên kết thanh toán/ })).toHaveValue(origin + '/payment#scoped-test-token')
  await expect(dialog.getByRole('button', { name: 'Sao chép liên kết thanh toán' })).toBeVisible()
  await dialog.getByLabel('Số tiền thực nhận (VND)').fill('150000')
  await dialog.getByLabel('Mã giao dịch ngân hàng').fill('TRANSACTION-TEST-1')
  await dialog.getByRole('button', { name: 'Xác minh thanh toán' }).click()
  await expect(dialog).toContainText('Đã xác minh')
  await dialog.getByRole('button', { name: 'Bắt đầu xử lý' }).click()
  await expect(dialog).toContainText('Đang xử lý')
})
