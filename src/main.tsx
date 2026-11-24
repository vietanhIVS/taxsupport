import React, { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import '@fontsource/be-vietnam-pro/600.css'
import '@fontsource/be-vietnam-pro/700.css'
import '@fontsource/be-vietnam-pro/800.css'
import './styles.css'
import { Layout } from './components/Layout'
import { Alert, Button } from './components/ui'
import { api, jsonPost, loadBootstrap } from './lib/api'
import { Wizard } from './features/registration/Wizard'
import { Completion } from './features/payment/Completion'
import type { Bootstrap, Registration } from '../shared/domain'

const Admin = lazy(() => import('./features/admin/Admin'))
const path = window.location.pathname.replace(/\/$/, '')
const paymentToken = path === '/payment' ? window.location.hash.slice(1) : ''
if (path === '/payment' && window.location.hash) window.history.replaceState(null, '', '/payment')

function Home() {
  const [bootstrap, setBootstrap] = useState<Bootstrap>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let current = true
    void loadBootstrap().then(data => { if (current) setBootstrap(data) }).catch(() => {
      if (current) setError('Không thể tải thông tin đăng ký. Vui lòng thử lại.')
    })
    return () => { current = false }
  }, [attempt])

  return <Layout legal={bootstrap?.legal}>
    {openNotice => bootstrap ? <Wizard bootstrap={bootstrap} openNotice={openNotice} /> :
      <main id="main" className="shell standalone">
        {error ? <section className="panel standalone-panel"><Alert>{error}</Alert><Button onClick={() => { setError(''); setAttempt(attempt + 1) }}>Thử lại</Button></section>
          : <p role="status">Đang tải dịch vụ…</p>}
      </main>}
  </Layout>
}

function PaymentPage() {
  const [order, setOrder] = useState<Registration>()
  const [error, setError] = useState(paymentToken ? '' : 'Liên kết thanh toán không hợp lệ hoặc đã hết hạn.')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!paymentToken) return
    let current = true
    void api<Registration>('/payment', jsonPost({ token: paymentToken })).then(data => {
      if (current) setOrder(data)
    }).catch((err: Error) => { if (current) setError(err.message) })
    return () => { current = false }
  }, [attempt])
  return <Layout><main className="shell standalone payment-page" id="main">
    <h1>Thông tin thanh toán</h1>
    {order ? <Completion order={order} /> : error ? <section className="panel standalone-panel"><Alert>{error}</Alert>
      {paymentToken && <Button onClick={() => { setError(''); setAttempt(attempt + 1) }}>Thử lại</Button>}</section> : <p role="status">Đang tải thông tin…</p>}
  </main></Layout>
}

function App() {
  if (path === '/admin') return <Suspense fallback={<Layout><main id="main" className="shell standalone" role="status">Đang tải trang quản trị…</main></Layout>}><Admin /></Suspense>
  if (path === '/payment') return <PaymentPage />
  if (path) return <Layout><main id="main" className="shell standalone"><h1>Không tìm thấy trang</h1><Button asChild><a href="/">Về trang chủ</a></Button></main></Layout>
  return <Home />
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
