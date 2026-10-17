// Regras puras do status da NF/UTMify na venda (19 §4.2): rótulo por estado (nulo = "Sem emissor"), quando a reemissão
// é permitida, qual emissor usar ao clicar "Reemitir nota" e como um `sale.updated` (T112/T113) atualiza o cache.
import type { QueryClient } from '@tanstack/react-query'
import { SALE_INVOICE_KEY, SALE_UTMIFY_KEY, type SaleInvoiceDto, type SaleUtmifyDto } from './api'

export type InvoiceStatusKey = 'pending' | 'succeeded' | 'failed' | 'none'

export const invoiceStatusKey = (
  dto: Pick<SaleInvoiceDto, 'invoice_emit_status'> | null | undefined,
): InvoiceStatusKey => dto?.invoice_emit_status ?? 'none'
export const utmifyStatusKey = (dto: Pick<SaleUtmifyDto, 'utmify_status'> | null | undefined): InvoiceStatusKey =>
  dto?.utmify_status ?? 'none'

/** Reemissão permitida quando o status ≠ pending e ≠ succeeded (19 §4.2); usa `can_reemit` do servidor quando há. */
export function canReemit(
  dto: (Pick<SaleInvoiceDto, 'invoice_emit_status'> & { can_reemit?: boolean }) | null | undefined,
): boolean {
  if (!dto) return true
  if (typeof dto.can_reemit === 'boolean') return dto.can_reemit
  return dto.invoice_emit_status !== 'pending' && dto.invoice_emit_status !== 'succeeded'
}

/**
 * Emissor do "Reemitir nota":
 * - `{ kind: 'server' }` — a venda já tem emissor (da nota ou do bloco): o servidor resolve (corpo vazio);
 * - `{ kind: 'id', id }` — um único emissor na conta: vai direto;
 * - `{ kind: 'choose' }` — vários: o usuário escolhe;
 * - `{ kind: 'none' }` — a lista não veio (sem permissão) ou está vazia: o servidor responde (422 "nenhum emissor").
 */
export type ReemitTarget = { kind: 'server' } | { kind: 'id'; id: string } | { kind: 'choose' } | { kind: 'none' }

export function reemitTarget(
  invoice: Pick<SaleInvoiceDto, 'invoice_integration_id'> | null | undefined,
  sale: { note_issuer_id: string | null },
  issuers: readonly { id: string }[] | null,
): ReemitTarget {
  if (invoice?.invoice_integration_id || sale.note_issuer_id?.trim()) return { kind: 'server' }
  if (!issuers || issuers.length === 0) return { kind: 'none' }
  if (issuers.length === 1) return { kind: 'id', id: issuers[0]!.id }
  return { kind: 'choose' }
}

type Data = Record<string, unknown>
const has = (d: Data, k: string) => Object.prototype.hasOwnProperty.call(d, k)

/** Aplica um `sale.updated` (`{ sale_id, invoice?, invoice_emit_status?, utmify?, utmify_status?, … }`) no cache. */
export function applySaleUpdated(qc: Pick<QueryClient, 'setQueryData' | 'invalidateQueries'>, data: unknown): void {
  if (!data || typeof data !== 'object') return
  const d = data as Data
  const saleId = typeof d.sale_id === 'string' ? d.sale_id : null
  if (!saleId) return
  if (d.invoice && typeof d.invoice === 'object')
    qc.setQueryData([...SALE_INVOICE_KEY, saleId], d.invoice as SaleInvoiceDto)
  else if (has(d, 'invoice_emit_status')) {
    const status = (d.invoice_emit_status ?? null) as SaleInvoiceDto['invoice_emit_status']
    qc.setQueryData([...SALE_INVOICE_KEY, saleId], (old: SaleInvoiceDto | null | undefined) =>
      old
        ? {
            ...old,
            invoice_emit_status: status,
            invoice_last_error: (d.invoice_last_error ?? null) as string | null,
            can_reemit: status !== 'pending' && status !== 'succeeded',
          }
        : old,
    )
    void qc.invalidateQueries({ queryKey: [...SALE_INVOICE_KEY, saleId] })
  }
  if (d.utmify && typeof d.utmify === 'object') qc.setQueryData([...SALE_UTMIFY_KEY, saleId], d.utmify as SaleUtmifyDto)
  else if (has(d, 'utmify_status')) {
    qc.setQueryData([...SALE_UTMIFY_KEY, saleId], (old: SaleUtmifyDto | null | undefined) =>
      old
        ? {
            ...old,
            utmify_status: (d.utmify_status ?? null) as SaleUtmifyDto['utmify_status'],
            utmify_last_error: (d.utmify_last_error ?? null) as string | null,
          }
        : old,
    )
    void qc.invalidateQueries({ queryKey: [...SALE_UTMIFY_KEY, saleId] })
  }
}
