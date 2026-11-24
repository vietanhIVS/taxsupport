import { zodResolver } from '@hookform/resolvers/zod'
import {
  BadgeCheck, Check, ClipboardList, FileSearch, FileText, FlaskConical, IdCard, ListChecks, LockKeyhole,
  Mail, Phone, ReceiptText, ShieldCheck, UserRound, Wallet, CalendarDays,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useForm, useWatch, type FieldError } from 'react-hook-form'
import {
  ambiguousAge, calculatePricing, linePrice, personalSchema, registrationSchema, servicePrice, syntheticPerson, formatVnd,
  type Bootstrap, type PersonInput, type Registration, type RegistrationInput, type Service, type ServiceId,
} from '../../../shared/domain'
import { Alert, Button } from '../../components/ui'
import { ApiError, loadBootstrap, postRegistration } from '../../lib/api'
import { Completion } from '../payment/Completion'

const icons = { TAX_REFUND: ReceiptText, TAX_LOOKUP: FileSearch, OTHER: ClipboardList }
const steps = ['Thông tin cá nhân', 'Chọn dịch vụ', 'Hoàn tất']
const initialPerson: PersonInput = {
  full_name: '', birth_year: '', citizen_id: '', email: '', phone: '', consent_given: false, adult_confirmed: false,
}

function Hero() {
  return <section className="hero" aria-labelledby="page-title">
    <div className="hero-copy">
      <h1 id="page-title">Đăng ký dịch vụ<br />hỗ trợ thuế</h1>
      <p>Gửi yêu cầu hỗ trợ thuế cá nhân và xem chi phí dự kiến trước khi đăng ký.</p>
    </div>
    <div className="hero-art" aria-hidden="true">
      <div className="hero-grid" />
      <div className="art-card art-card-back" />
      <div className="art-card art-card-front">
        <FileText className="art-file" size={40} strokeWidth={1.45} />
        <i /><i /><i />
      </div>
      <div className="art-check"><Check size={26} strokeWidth={2.6} /></div>
      <span className="art-spark art-spark-one">+</span><span className="art-spark art-spark-two">+</span>
    </div>
  </section>
}

function Progress({ current }: { current: number }) {
  return <nav className="progress" aria-label="Tiến trình đăng ký">
    <ol>{steps.map((name, index) => <li key={name} aria-current={current === index + 1 ? 'step' : undefined}
      className={current === index + 1 ? 'step-current' : current > index + 1 ? 'step-done' : ''}>
      <span className="step-circle" aria-hidden="true">{current > index + 1 ? <Check size={16} /> : index + 1}</span>
      <span>{name}</span>
    </li>)}</ol>
  </nav>
}

function Sidebar({ services }: { services: Service[] }) {
  return <aside className="sidebar" aria-label="Thông tin dịch vụ">
    <section className="panel sidebar-panel">
      <div className="sidebar-title"><span className="section-icon"><Wallet size={20} aria-hidden="true" /></span><h2>Bảng phí dịch vụ</h2></div>
      {services.length ? <ul className="fee-list">{services.map(service => {
        const Icon = icons[service.id]
        return <li key={service.id}>
          <span className="fee-icon"><Icon size={19} aria-hidden="true" /></span>
          <div><p>{service.name}</p><strong className={service.pricing_type === 'FREE' ? 'free-text' : ''}>{servicePrice(service)}</strong></div>
        </li>
      })}</ul> : <p className="muted">Hiện chưa có dịch vụ mở đăng ký.</p>}
    </section>
    <section className="privacy-card">
      <ShieldCheck size={23} aria-hidden="true" />
      <div><h2>Bảo vệ thông tin cá nhân</h2><p>Thông tin chỉ dùng để tiếp nhận và xử lý yêu cầu hỗ trợ của bạn.</p></div>
    </section>
  </aside>
}

function Field({ title, name, error, icon, children }: { title: string; name: string; error?: FieldError; icon: ReactNode; children: ReactNode }) {
  return <div className="field">
    <label htmlFor={name}>{title} <span aria-hidden="true">*</span></label>
    <div className={`input-wrap ${error ? 'invalid' : ''}`}><span className="input-icon" aria-hidden="true">{icon}</span>{children}</div>
    {error && <p className="field-error" id={`${name}-error`}>{error.message}</p>}
  </div>
}

function PanelHeading({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return <div className="panel-heading"><span className="section-icon large">{icon}</span><div><h2 id="wizard-heading" tabIndex={-1}>{title}</h2><p>{children}</p></div></div>
}

export function Wizard({ bootstrap, openNotice }: { bootstrap: Bootstrap; openNotice: (name: 'privacy' | 'terms') => void }) {
  const [current, setCurrent] = useState(1)
  const [catalog, setCatalog] = useState(bootstrap.services)
  const [selected, setSelected] = useState<ServiceId[]>([])
  const [details, setDetails] = useState<Partial<Record<ServiceId, string>>>({})
  const [review, setReview] = useState(false)
  const [order, setOrder] = useState<Registration>()
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [detailError, setDetailError] = useState(false)
  const [fieldError, setFieldError] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef<{ identity: string; key: string } | null>(null)
  const submitting = useRef(false)
  const focusOnChange = useRef(false)
  const { register, handleSubmit, control, reset, getValues, formState: { errors } } = useForm<PersonInput>({
    resolver: zodResolver(personalSchema), defaultValues: initialPerson, mode: 'onBlur',
  })
  const year = useWatch({ control, name: 'birth_year' })
  const demo = bootstrap.demo
  const accepting = bootstrap.accepting && catalog.length > 0
  const selections = selected.map(service_id => ({
    service_id, additional_details: service_id === 'TAX_REFUND' || demo ? undefined : details[service_id]?.trim() || undefined,
  })).map(item => demo && item.service_id === 'OTHER' ? { ...item, additional_details: 'Yêu cầu hỗ trợ mẫu.' } : item)
  const pricing = selections.length ? calculatePricing(catalog, selections) : undefined

  useEffect(() => {
    if (focusOnChange.current) document.getElementById(order ? 'completion-title' : 'wizard-heading')?.focus()
    focusOnChange.current = true
  }, [current, review, order])

  function toServices() { setError(''); setCurrent(2) }
  function toggle(id: ServiceId) {
    setFieldError(false)
    if (selected.includes(id)) {
      setSelected(selected.filter(value => value !== id))
      setDetails(previous => { const next = { ...previous }; delete next[id]; return next })
      if (id === 'OTHER') setDetailError(false)
    } else setSelected([...selected, id])
  }
  function toReview() {
    setFieldError(!selected.length)
    const missingDetails = selected.includes('OTHER') && !demo && (details.OTHER?.trim().length ?? 0) < 5
    setDetailError(missingDetails)
    if (!selected.length) {
      document.querySelector<HTMLInputElement>('.service-option input')?.focus()
      return
    }
    if (missingDetails) { document.getElementById('details-OTHER')?.focus(); return }
    setError('')
    setReview(true)
  }

  async function submit() {
    if (submitting.current) return
    const body: RegistrationInput = {
      person: getValues(), selections, consent_version: bootstrap.legal.version,
      catalog_snapshot: (pricing?.lines ?? []).map(line => ({
        service_id: line.service_id, name: line.service_name_snapshot, description: line.service_description_snapshot,
        pricing_type: line.pricing_snapshot.type, fixed_fee: line.pricing_snapshot.fixed_fee,
      })),
    }
    if (!registrationSchema.safeParse(body).success) { setError('Kiểm tra lại thông tin và các dịch vụ đã chọn.'); return }
    const identity = JSON.stringify(body)
    if (!pending.current || pending.current.identity !== identity) pending.current = { identity, key: crypto.randomUUID() }
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      const result = await postRegistration(body, pending.current.key, demo)
      reset(initialPerson)
      pending.current = null
      setDetails({})
      setOrder(result)
      setCurrent(3)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CATALOG_CHANGED') {
        try {
          const data = await loadBootstrap()
          setSelected(previous => previous.filter(id => data.services.some(service => service.id === id)))
          setCatalog(data.services)
          setReview(false)
        } catch { /* Keep the existing selection available for retry. */ }
      }
      const mayHaveSaved = err instanceof ApiError && err.status >= 500 && err.code !== 'PAYMENT_UNAVAILABLE'
      setUncertain(mayHaveSaved)
      setError(mayHaveSaved ? (err as Error).message + ' Gửi lại cùng thông tin để tránh tạo đăng ký trùng.' : (err as Error).message)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  function restart() {
    reset(initialPerson); pending.current = null; setUncertain(false)
    setOrder(undefined); setCurrent(1); setSelected([]); setDetails({}); setReview(false); setError('')
    setDetailError(false); setFieldError(false)
  }

  const fieldProps = (name: 'full_name' | 'birth_year' | 'citizen_id' | 'email' | 'phone') => ({
    ...register(name), readOnly: demo, 'aria-invalid': Boolean(errors[name]),
    'aria-describedby': errors[name] ? `${name}-error` : undefined, id: name, required: true,
  })

  return <>
    <main id="main" className="shell main-shell">
      <Hero />
      <div className="wizard-layout">
        <div className="wizard-main">
          <Progress current={current} />
          {demo && <div className="demo-strip"><FlaskConical size={17} aria-hidden="true" /><span><strong>Bản trải nghiệm</strong> · Chỉ dùng dữ liệu mẫu.</span>
            {current === 1 && <button onClick={() => reset({ ...getValues(), ...syntheticPerson })}>Dùng thông tin mẫu</button>}
          </div>}
          {!accepting && <section className="panel wizard-panel"><PanelHeading title="Đăng ký trực tuyến" icon={<LockKeyhole size={24} />}>Dịch vụ hiện chưa mở đăng ký trực tuyến.</PanelHeading></section>}
          {accepting && current === 1 && <section className="panel wizard-panel" aria-labelledby="wizard-heading">
            <PanelHeading title="Thông tin cá nhân" icon={<IdCard size={24} aria-hidden="true" />}>Điền thông tin để TaxSupport tiếp nhận yêu cầu của bạn.</PanelHeading>
            <form noValidate onSubmit={handleSubmit(toServices)}>
              <div className="field-grid">
                <Field title="Họ và tên" name="full_name" icon={<UserRound size={18} />} error={errors.full_name}>
                  <input {...fieldProps('full_name')} placeholder="Nguyễn Văn A" autoComplete="name" maxLength={100} />
                </Field>
                <Field title="Năm sinh" name="birth_year" icon={<CalendarDays size={18} />} error={errors.birth_year}>
                  <input {...fieldProps('birth_year')} placeholder="Ví dụ 1995" autoComplete="bday-year" inputMode="numeric" maxLength={4} />
                </Field>
                <Field title="Số căn cước công dân" name="citizen_id" icon={<IdCard size={18} />} error={errors.citizen_id}>
                  <input {...fieldProps('citizen_id')} placeholder="Nhập 12 chữ số" autoComplete="off" inputMode="numeric" maxLength={12} />
                </Field>
                <Field title="Số điện thoại" name="phone" icon={<Phone size={18} />} error={errors.phone}>
                  <input {...fieldProps('phone')} placeholder="09xx xxx xxx" autoComplete="tel" inputMode="tel" maxLength={12} />
                </Field>
                <div className="field-wide"><Field title="Email" name="email" icon={<Mail size={18} />} error={errors.email}>
                  <input {...fieldProps('email')} placeholder="tenban@example.com" autoComplete="email" type="email" maxLength={254} />
                </Field></div>
              </div>
              {ambiguousAge(year) && <div className="check-block"><label className="check-row"><input type="checkbox" {...register('adult_confirmed')} aria-invalid={Boolean(errors.adult_confirmed)} aria-describedby={errors.adult_confirmed ? 'adult-error' : undefined} /> Tôi xác nhận đã đủ 18 tuổi.</label>
                {errors.adult_confirmed && <p className="field-error" id="adult-error">{errors.adult_confirmed.message}</p>}</div>}
              <div className="consent">
                <div className="check-row"><input id="consent" type="checkbox" {...register('consent_given')} aria-invalid={Boolean(errors.consent_given)} aria-describedby={errors.consent_given ? 'consent-error' : 'consent-notices'} required />
                  <label htmlFor="consent">Tôi đồng ý cho TaxSupport xử lý dữ liệu cá nhân để thực hiện yêu cầu.</label>
                </div>
                <p id="consent-notices">Xem <button type="button" onClick={() => openNotice('privacy')}>thông báo quyền riêng tư</button> và <button type="button" onClick={() => openNotice('terms')}>điều khoản dịch vụ</button>.</p>
                {errors.consent_given && <p id="consent-error" className="field-error">{errors.consent_given.message}</p>}
              </div>
              <div className="panel-actions end"><Button type="submit">Tiếp theo</Button></div>
            </form>
          </section>}
          {accepting && current === 2 && <section className="panel wizard-panel" aria-labelledby="wizard-heading">
            <PanelHeading title={review ? 'Kiểm tra đăng ký' : 'Lựa chọn dịch vụ'} icon={review ? <ListChecks size={24} /> : <ClipboardList size={24} />}>
              {review ? 'Xem lại thông tin và chi phí trước khi gửi yêu cầu.' : 'Chọn một hoặc nhiều dịch vụ phù hợp với nhu cầu của bạn.'}
            </PanelHeading>
            {!review && <fieldset className="service-options" aria-describedby={fieldError ? 'service-error' : undefined}>
              <legend className="sr-only">Dịch vụ</legend>
              {catalog.map(service => {
                const checked = selected.includes(service.id)
                const Icon = icons[service.id]
                return <div className="service-item" key={service.id}>
                  <label className={`service-option ${checked ? 'selected' : ''}`}>
                    <input type="checkbox" checked={checked} onChange={() => toggle(service.id)} />
                    <span className="fee-icon"><Icon size={20} aria-hidden="true" /></span>
                    <span className="service-copy"><strong>{service.name}</strong><span>{service.description}</span></span>
                    <span className={`service-price ${service.pricing_type === 'FREE' ? 'free-text' : ''}`}>{servicePrice(service)}</span>
                  </label>
                  {checked && service.id !== 'TAX_REFUND' && !demo && <div className="service-details">
                    <label htmlFor={`details-${service.id}`}>{service.id === 'OTHER' ? 'Mô tả nhu cầu *' : 'Thông tin bổ sung (không bắt buộc)'}</label>
                    <textarea id={`details-${service.id}`} rows={3} maxLength={500} value={details[service.id] ?? ''} aria-invalid={service.id === 'OTHER' && detailError}
                      aria-describedby={service.id === 'OTHER' && detailError ? 'details-error' : undefined}
                      onChange={event => { setDetails({ ...details, [service.id]: event.target.value }); setDetailError(false) }} />
                    {service.id === 'OTHER' && detailError && <p className="field-error" id="details-error">Mô tả nhu cầu từ 5 đến 500 ký tự.</p>}
                  </div>}
                  {checked && service.id === 'OTHER' && demo && <p className="sample-note">Mô tả mẫu: Yêu cầu hỗ trợ mẫu.</p>}
                </div>
              })}
              {fieldError && <p className="field-error" id="service-error" role="alert">Chọn ít nhất một dịch vụ.</p>}
            </fieldset>}
            {review && <div className="review-person"><span className="section-icon"><UserRound size={20} /></span><div><strong>{getValues('full_name')}</strong><p>CCCD ••••••••{getValues('citizen_id').slice(-4)} · Điện thoại ••••••{getValues('phone').slice(-4)}</p></div></div>}
            {pricing && <div className="receipt">
              <ul>{pricing.lines.map(line => <li key={line.service_id}><span>{line.service_name_snapshot}</span><strong>{linePrice(line.calculated_fee)}</strong></li>)}</ul>
              {pricing.total === null && <div className="receipt-total sub"><span>Tạm tính các mục đã có giá</span><strong>{formatVnd(pricing.subtotal)}</strong></div>}
              <div className="receipt-total"><span>Tổng phí</span><strong>{pricing.total === null ? 'Chờ báo giá' : formatVnd(pricing.total)}</strong></div>
            </div>}
            {review && pricing?.total === null && <Alert tone="info">Bạn sẽ nhận báo giá cho toàn bộ dịch vụ trước khi thanh toán.</Alert>}
            {error && <Alert>{error}</Alert>}
            <div className="panel-actions">{uncertain ? <Button variant="secondary" disabled={busy} onClick={restart}>Bắt đầu đăng ký mới</Button> : <Button variant="secondary" disabled={busy} onClick={() => review ? setReview(false) : setCurrent(1)}>Quay lại</Button>}
              {review ? <Button disabled={busy} onClick={submit}><BadgeCheck size={19} />{busy ? 'Đang gửi…' : 'Gửi đăng ký'}</Button> : <Button onClick={toReview}>Tiếp theo</Button>}
            </div>
          </section>}
          {order && current === 3 && <Completion order={order} restart={restart} />}
        </div>
        <Sidebar services={catalog} />
      </div>
    </main>
  </>
}
