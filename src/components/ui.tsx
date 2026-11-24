import { Slot } from '@radix-ui/react-slot'
import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { cva, type VariantProps } from 'class-variance-authority'
import { AlertCircle, Clipboard, Check, X } from 'lucide-react'
import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from 'react'

const button = cva('button', {
  variants: { variant: { primary: 'button-primary', secondary: 'button-secondary', ghost: 'button-ghost', danger: 'button-danger' } },
  defaultVariants: { variant: 'primary' },
})

export function Button({ variant, asChild, className, type, ...props }: ComponentProps<'button'> & VariantProps<typeof button> & { asChild?: boolean }) {
  const Tag = asChild ? Slot : 'button'
  return <Tag type={asChild ? undefined : type ?? 'button'} className={twMerge(clsx(button({ variant }), className))} {...props} />
}

export function Alert({ children, tone = 'error' }: { children: ReactNode; tone?: 'error' | 'info' | 'success' }) {
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><AlertCircle size={18} aria-hidden="true" /><div>{children}</div></div>
}

export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => { ref.current?.showModal() }, [])
  return <dialog className="modal" ref={ref} aria-labelledby={titleId} onCancel={onClose}>
    <div className="modal-heading"><h2 id={titleId}>{title}</h2><Button variant="ghost" aria-label="Đóng" onClick={onClose}><X size={20} /></Button></div>
    <div className="modal-body">{children}</div>
  </dialog>
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'initial' | 'copied' | 'error'>('initial')
  return <div className="copy-action">
    <Button variant="secondary" aria-label={label} onClick={async () => {
      try {
        await navigator.clipboard.writeText(text)
        setState('copied')
      } catch { setState('error') }
    }}>{state === 'copied' ? <Check size={16} /> : <Clipboard size={16} />}
      {state === 'copied' ? 'Đã sao chép' : 'Sao chép'}
    </Button>
    <span className={state === 'error' ? 'field-error' : 'sr-only'} role="status">{state === 'error' ? 'Không thể sao chép.' : state === 'copied' ? 'Đã sao chép.' : ''}</span>
  </div>
}
