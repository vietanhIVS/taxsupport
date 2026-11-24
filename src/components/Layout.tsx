import { FileText, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { unavailableLegal, type Legal } from '../../shared/domain'
import { Modal } from './ui'

export function Layout({ children, legal = unavailableLegal }: { children: ReactNode | ((openNotice: (name: 'privacy' | 'terms') => void) => ReactNode); legal?: Legal }) {
  const [notice, setNotice] = useState<'privacy' | 'terms' | null>(null)
  const openNotice = (name: 'privacy' | 'terms') => setNotice(name)
  return <>
    <a className="skip-link" href="#main">Chuyển đến nội dung chính</a>
    <header className="site-header">
      <div className="shell header-inner">
        <a className="brand" href="/" aria-label="TaxSupport, trang chủ"><span className="brand-icon"><FileText size={22} strokeWidth={2.2} aria-hidden="true" /></span><span>Tax<span className="brand-accent">Support</span></span></a>
        <span className="header-divider" aria-hidden="true" />
        <p>Dịch vụ hỗ trợ thuế độc lập</p>
      </div>
    </header>
    {typeof children === 'function' ? children(openNotice) : children}
    <footer className="site-footer">
      <div className="shell footer-inner">
        <div><strong>© {new Date().getFullYear()} TaxSupport</strong><p><ShieldCheck size={15} aria-hidden="true" /> Dịch vụ độc lập, không thuộc cơ quan thuế.</p></div>
        <div className="footer-links"><button onClick={() => openNotice('privacy')}>Quyền riêng tư</button><button onClick={() => openNotice('terms')}>Điều khoản dịch vụ</button></div>
      </div>
    </footer>
    {notice && <Modal title={notice === 'privacy' ? 'Thông báo quyền riêng tư' : 'Điều khoản dịch vụ'} onClose={() => setNotice(null)}>
      <p>{legal.identity}</p>
      <p>{legal[notice]}</p>
      {notice === 'privacy' && <><p>{legal.retention}</p><p>{legal.contact}</p></>}
      {legal.version && <p className="muted">Phiên bản {legal.version}</p>}
    </Modal>}
  </>
}
