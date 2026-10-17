// Modal "Nova venda" (02 §3.7, "Observado no app"): instância, números, cliente (nome exibido na NF), valor (padrão 0),
// moeda (padrão BRL), produto opcional, Source ID e data da venda (padrão agora, no fuso da empresa).
import { Dialog } from '@base-ui/react/dialog'
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { Bootstrap } from '@/features/dashboard/api'
import { useT } from '@/i18n'
import { HttpError } from '@/lib/http'
import { cn } from '@/lib/utils'
import { createSale, type SaleDto } from './api'
import { CURRENCIES, nowLocalIn, optional, parseAmount, zonedToIso } from './logic'

const NS = 'dashboard-history'
const field = 'h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'

interface Form {
  instance_name: string
  instance_number: string
  lead_number: string
  customer_name: string
  amount: string
  currency: string
  product_id: string
  source_id: string
  sold_at: string
}

const emptyForm = (tz: string): Form => ({
  instance_name: '',
  instance_number: '',
  lead_number: '',
  customer_name: '',
  amount: '0',
  currency: 'BRL',
  product_id: '',
  source_id: '',
  sold_at: nowLocalIn(tz),
})

export function SaleModal({ open, onClose, onCreated, timeZone, products }: { open: boolean; onClose: () => void; onCreated: (sale: SaleDto) => void; timeZone: string; products: Bootstrap['products'] }) {
  const t = useT(NS)
  const [form, setForm] = useState<Form>(() => emptyForm(timeZone))
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(emptyForm(timeZone))
    setError(null)
  }, [open, timeZone])

  const set = (k: keyof Form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const currencies = [...new Set<string>([...CURRENCIES, ...products.map((p) => p.currency), form.currency])]

  const submit = async () => {
    const amount = parseAmount(form.amount)
    if (amount === null) return setError(t('form.amountInvalid'))
    const soldAt = zonedToIso(form.sold_at, timeZone)
    if (!soldAt) return setError(t('form.dateInvalid'))
    setPending(true)
    setError(null)
    try {
      const { sale } = await createSale({
        amount_cents: amount,
        currency: form.currency,
        sold_at: soldAt,
        product_id: form.product_id || null,
        source_id: optional(form.source_id),
        instance_name: optional(form.instance_name),
        instance_number: optional(form.instance_number),
        lead_number: optional(form.lead_number),
        customer_name: optional(form.customer_name),
      })
      onCreated(sale)
    } catch (err) {
      const fields = err instanceof HttpError ? (err.details as { fields?: { message?: string }[] } | undefined)?.fields : undefined
      setError(fields?.length ? fields.map((f) => f.message).filter(Boolean).join(' · ') : t('form.error'))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="dashboard-history-modal"
          className="fixed top-1/2 left-1/2 z-[70] flex max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('form.title')}</Dialog.Title>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void submit()
            }}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('form.instanceName')}>
                <input data-testid="dashboard-history-form-instance-name" className={field} maxLength={255} value={form.instance_name} onChange={set('instance_name')} autoFocus />
              </Field>
              <Field label={t('form.instanceNumber')}>
                <input data-testid="dashboard-history-form-instance-number" className={field} inputMode="numeric" maxLength={64} placeholder="5500900000000" value={form.instance_number} onChange={set('instance_number')} />
              </Field>
              <Field label={t('form.leadNumber')}>
                <input data-testid="dashboard-history-form-lead-number" className={field} inputMode="numeric" maxLength={64} value={form.lead_number} onChange={set('lead_number')} />
              </Field>
              <Field label={t('form.customerName')} hint={t('form.customerNameHint')}>
                <input data-testid="dashboard-history-form-customer-name" className={field} maxLength={255} value={form.customer_name} onChange={set('customer_name')} />
              </Field>
              <Field label={t('form.amount')}>
                <input data-testid="dashboard-history-form-amount" className={field} type="number" min={0} step="0.01" inputMode="decimal" value={form.amount} onChange={set('amount')} />
              </Field>
              <Field label={t('form.currency')}>
                <select data-testid="dashboard-history-form-currency" className={field} value={form.currency} onChange={set('currency')}>
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('form.product')}>
                <select
                  data-testid="dashboard-history-form-product"
                  className={field}
                  value={form.product_id}
                  onChange={(e) => {
                    const product = products.find((p) => p.id === e.target.value)
                    setForm((f) => ({ ...f, product_id: e.target.value, currency: product?.currency || f.currency }))
                  }}
                >
                  <option value="">{t('form.noProduct')}</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('form.sourceId')}>
                <input data-testid="dashboard-history-form-source-id" className={field} maxLength={200} value={form.source_id} onChange={set('source_id')} />
              </Field>
              <Field label={t('form.soldAt')}>
                <input data-testid="dashboard-history-form-sold-at" className={field} type="datetime-local" value={form.sold_at} onChange={set('sold_at')} />
              </Field>
            </div>
            {error ? (
              <p data-testid="dashboard-history-form-error" role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="outline" data-testid="dashboard-history-form-cancel" onClick={onClose}>
                {t('form.cancel')}
              </Button>
              <Button type="submit" data-testid="dashboard-history-form-save" disabled={pending}>
                {t('form.save')}
              </Button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className={cn('flex min-w-0 flex-col gap-1 text-sm font-medium')}>
      {label}
      {children}
      {hint ? <span className="text-xs font-normal text-muted-foreground">{hint}</span> : null}
    </label>
  )
}
