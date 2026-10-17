// Células do histórico de vendas (AC-T114-05; 19 §4.2, §5.4): status da nota ("Enviando emissão…", "Enviada ao
// emissor", "Falha na emissão", "Sem emissor") com o último erro, status do envio à UTMify e o botão "Reemitir nota"
// (`sales.edit`), que reenfileira e mostra "Emissão reenfileirada" (toast `sale-invoice-reemitted`). Com vários emissores
// e nenhum definido na venda, um diálogo pede o emissor.
import { Dialog } from '@base-ui/react/dialog'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { SaleDto } from '@/features/dashboard-history/api'
import { issuersQuery } from '@/features/settings-payments/api'
import { inputClass, serverMessage } from '@/features/settings-quick-replies/kit'
import { useT } from '@/i18n'
import { hasAny, profileQuery, sessionFrom } from '@/lib/session'
import { notify } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { reemitInvoice, SALE_INVOICE_KEY, saleInvoiceQuery, saleUtmifyQuery } from './api'
import { canReemit, invoiceStatusKey, reemitTarget, utmifyStatusKey, type InvoiceStatusKey } from './logic'

const NS = 'settings-payments'

const TONE: Record<InvoiceStatusKey, string> = {
  pending: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  succeeded: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  failed: 'bg-destructive/10 text-destructive',
  none: 'bg-muted text-muted-foreground',
}

function Badge({
  testid,
  status,
  label,
  title,
}: {
  testid: string
  status: InvoiceStatusKey
  label: string
  title?: string | undefined
}) {
  return (
    <span
      data-testid={testid}
      data-status={status}
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        TONE[status],
      )}
    >
      {status === 'pending' ? <Loader2 className="size-3 animate-spin" aria-hidden /> : null}
      {label}
    </span>
  )
}

export function InvoiceStatusCell({ sale }: { sale: SaleDto }) {
  const t = useT(NS)
  const q = useQuery(saleInvoiceQuery(sale.id))
  if (q.isPending) return <span className="text-xs text-muted-foreground">…</span>
  if (q.isError) return <span className="text-xs text-muted-foreground">—</span>
  const dto = q.data
  const status = invoiceStatusKey(dto)
  return (
    <div className="flex max-w-56 flex-col gap-0.5">
      <Badge
        testid={`sale-invoice-status-${sale.id}`}
        status={status}
        label={t(`invoice.status.${status}`)}
        title={t('invoice.note')}
      />
      {status === 'failed' && dto?.invoice_last_error ? (
        <span
          data-testid={`sale-invoice-error-${sale.id}`}
          className="truncate text-[11px] text-destructive"
          title={dto.invoice_last_error}
        >
          {dto.invoice_last_error}
        </span>
      ) : null}
      {dto?.number || dto?.pdf_url ? (
        <span className="text-[11px] text-muted-foreground">
          {dto.number ? (
            <span data-testid={`sale-invoice-number-${sale.id}`}>{t('invoice.number', { number: dto.number })}</span>
          ) : null}
          {dto.pdf_url ? (
            <a
              data-testid={`sale-invoice-pdf-${sale.id}`}
              href={dto.pdf_url}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-1 text-primary hover:underline"
            >
              PDF
            </a>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}

export function UtmifyStatusCell({ sale }: { sale: SaleDto }) {
  const t = useT(NS)
  const q = useQuery(saleUtmifyQuery(sale.id))
  if (q.isPending) return <span className="text-xs text-muted-foreground">…</span>
  if (q.isError) return <span className="text-xs text-muted-foreground">—</span>
  const status = utmifyStatusKey(q.data)
  return (
    <Badge
      testid={`sale-utmify-status-${sale.id}`}
      status={status}
      label={t(`utmifyStatus.${status}`)}
      title={q.data?.utmify_last_error ?? undefined}
    />
  )
}

export function ReemitButton({ sale }: { sale: SaleDto }) {
  const t = useT(NS)
  const qc = useQueryClient()
  const profile = useQuery(profileQuery()).data
  const session = profile ? sessionFrom(profile) : null
  const allowed = !!session && hasAny(session, ['sales.edit'])
  const invoice = useQuery(saleInvoiceQuery(sale.id))
  const canListIssuers = !!session && hasAny(session, ['settings.integrations.view'])
  const issuers = useQuery({ ...issuersQuery(), enabled: allowed && canListIssuers })
  const [pending, setPending] = useState(false)
  const [choosing, setChoosing] = useState(false)
  if (!allowed || invoice.isPending || !canReemit(invoice.data)) return null

  const send = async (integrationId?: string) => {
    setPending(true)
    try {
      const res = await reemitInvoice(sale.id, integrationId)
      qc.setQueryData([...SALE_INVOICE_KEY, sale.id], res.invoice)
      notify('sale-invoice-reemitted', t('invoice.reemitted'), t('invoice.reemittedHint'))
      setChoosing(false)
    } catch (err) {
      notify('sale-invoice-reemit-error', serverMessage(err) ?? t('common.error'))
    } finally {
      setPending(false)
    }
  }

  const click = () => {
    const list = issuers.data && !issuers.data.denied ? issuers.data.items : null
    const target = reemitTarget(invoice.data, sale, list)
    if (target.kind === 'choose') setChoosing(true)
    else void send(target.kind === 'id' ? target.id : undefined)
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid={`sale-invoice-reemit-${sale.id}`}
        disabled={pending || (canListIssuers && issuers.isPending)}
        onClick={click}
        className="whitespace-nowrap"
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden /> : <RotateCw aria-hidden />}
        {t(invoice.data?.invoice_emit_status === 'failed' ? 'invoice.retry' : 'invoice.reemit')}
      </Button>
      {choosing ? (
        <IssuerDialog
          saleId={sale.id}
          issuers={issuers.data?.items ?? []}
          pending={pending}
          onCancel={() => setChoosing(false)}
          onConfirm={(id) => void send(id)}
        />
      ) : null}
    </>
  )
}

function IssuerDialog({
  saleId,
  issuers,
  pending,
  onCancel,
  onConfirm,
}: {
  saleId: string
  issuers: { id: string; company_name: string; token_configured: boolean }[]
  pending: boolean
  onCancel: () => void
  onConfirm: (id: string) => void
}) {
  const t = useT(NS)
  const [id, setId] = useState(issuers.find((i) => i.token_configured)?.id ?? issuers[0]?.id ?? '')
  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[70] bg-black/40" />
        <Dialog.Popup
          data-testid="sale-invoice-reemit-dialog"
          data-sale={saleId}
          className="fixed top-1/2 left-1/2 z-[70] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-xl border bg-background p-5 shadow-xl outline-none"
        >
          <Dialog.Title className="text-lg font-semibold">{t('invoice.chooseTitle')}</Dialog.Title>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">{t('invoice.issuer')}</span>
            <select
              data-testid="sale-invoice-reemit-issuer"
              value={id}
              onChange={(e) => setId(e.target.value)}
              className={inputClass}
            >
              {issuers.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.token_configured ? i.company_name : `${i.company_name} (${t('block.common.inactive')})`}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="outline" data-testid="sale-invoice-reemit-cancel" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
            <Button data-testid="sale-invoice-reemit-confirm" disabled={pending || !id} onClick={() => onConfirm(id)}>
              {t('invoice.reemit')}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
