import { Check, CircleCheck, Clock3, Download, QrCode } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatVnd, linePrice, type Registration } from '../../../shared/domain'
import { Alert, Button, CopyButton } from '../../components/ui'
import { reportTransfer } from '../../lib/api'

export function Completion({ order, restart }: { order: Registration; restart?: () => void }) {
  const [qrImage, setQrImage] = useState('')
  const [qrError, setQrError] = useState(false)
  const [status, setStatus] = useState(order.payment_status)
  const [reportError, setReportError] = useState('')
  const [busy, setBusy] = useState(false)
  const payment = order.payment
  const payload = payment?.payload
  useEffect(() => {
    if (!payload) return
    let current = true
    void import('qrcode').then(qr => qr.toDataURL(payload, { width: 640, margin: 4, errorCorrectionLevel: 'M' }))
      .then(value => { if (current) setQrImage(value) })
      .catch(() => { if (current) setQrError(true) })
    return () => { current = false }
  }, [payload])

  const awaitingQuote = status === 'AWAITING_QUOTE'
  const Icon = awaitingQuote ? Clock3 : payment ? QrCode : CircleCheck
  const title = awaitingQuote ? 'Đang chờ báo giá' : payment ? 'Thanh toán dịch vụ' : status === 'VERIFIED' ? 'Đã xác minh thanh toán' : 'Đăng ký thành công!'
  const intro = awaitingQuote ? 'Yêu cầu của bạn đã được ghi nhận và đang chờ xác nhận báo giá.' :
    payment ? 'Quét mã VietQR hoặc sử dụng thông tin chuyển khoản bên dưới.' :
    status === 'VERIFIED' ? 'Khoản thanh toán của bạn đã được xác minh.' : 'Yêu cầu hỗ trợ của bạn đã được ghi nhận.'

  async function report() {
    if (!order.report_token || busy) return
    setBusy(true)
    setReportError('')
    try { setStatus((await reportTransfer(order.report_token, Boolean(order.demo))).payment_status) }
    catch (error) { setReportError((error as Error).message) }
    finally { setBusy(false) }
  }

  return <section className="panel completion" aria-labelledby="completion-title">
    <div className="completion-heading">
      <span className={`section-icon large ${awaitingQuote ? 'warm' : payment ? '' : 'green'}`}><Icon size={29} aria-hidden="true" /></span>
      <h2 id="completion-title" tabIndex={-1}>{title}</h2><p>{intro}</p>
    </div>
    <div className="reference-band"><div><span>Mã đăng ký</span><strong>{order.reference}</strong></div><CopyButton label="Sao chép mã đăng ký" text={order.reference} /></div>
    <div className="receipt">
      <h3>Dịch vụ đã chọn</h3>
      <ul>{order.lines.map(line => <li key={line.service_id}><span>{line.service_name_snapshot}</span><strong>{linePrice(line.calculated_fee)}</strong></li>)}</ul>
      <div className="receipt-total"><span>Tổng phí</span><strong>{order.total_fee === null ? 'Chờ báo giá' : formatVnd(order.total_fee)}</strong></div>
    </div>
    {payment && <>
      {order.demo && <Alert tone="info">Mã và tài khoản dưới đây là dữ liệu mẫu. Vui lòng không chuyển tiền.</Alert>}
      <div className="payment-area">
        <div className="qr-side">
          {qrImage && <img src={qrImage} alt={order.demo ? 'Mã VietQR giả lập' : 'Mã VietQR thanh toán'} width="192" height="192" />}
          {qrError && <Alert>Không thể hiển thị mã QR.</Alert>}
          {!qrImage && !qrError && <div className="qr-placeholder" role="status">Đang tạo mã QR…</div>}
          {qrImage && <Button variant="secondary" asChild><a href={qrImage} download={`${order.reference}-vietqr.png`}><Download size={17} />Tải mã QR</a></Button>}
        </div>
        <dl className="bank-details">
          <div><dt>Ngân hàng</dt><dd>{payment.bank}</dd></div>
          <div><dt>Chủ tài khoản</dt><dd>{payment.holder}</dd></div>
          <div><dt>Số tài khoản</dt><dd>{payment.account}</dd><CopyButton label="Sao chép số tài khoản" text={payment.account} /></div>
          <div><dt>Số tiền</dt><dd>{formatVnd(order.total_fee ?? 0)}</dd><CopyButton label="Sao chép số tiền" text={String(order.total_fee)} /></div>
          <div><dt>Nội dung chuyển khoản</dt><dd>{payment.description}</dd><CopyButton label="Sao chép nội dung chuyển khoản" text={payment.description} /></div>
        </dl>
      </div>
      {reportError && <Alert>{reportError}</Alert>}
      {status === 'CUSTOMER_REPORTED' ? <Alert tone="success">Yêu cầu của bạn đã được ghi nhận. Chúng tôi sẽ kiểm tra giao dịch trong thời gian sớm nhất.</Alert> : status === 'VERIFIED' ? <Alert tone="success">Khoản thanh toán của bạn đã được xác minh.</Alert> :
        <Button onClick={report} disabled={busy || !order.report_token}><Check size={19} />{busy ? 'Đang gửi…' : 'Tôi đã chuyển khoản'}</Button>}
    </>}
    {restart && <div className="completion-actions"><Button variant="secondary" onClick={restart}>Đăng ký mới</Button></div>}
  </section>
}
