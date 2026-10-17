import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectSaleSlots, saleActions, saleColumns } from '@/features/dashboard-history/slots'
import { translate } from '@/i18n/core'
import { api } from '@/lib/http'
import { dispatchRealtime, registeredTypes } from '@/lib/realtime'
import {
  createBatcher,
  reemitInvoice,
  SALE_INVOICE_KEY,
  SALE_UTMIFY_KEY,
  saleInvoiceQuery,
  type SaleInvoiceDto,
} from './api'
import { applySaleUpdated, canReemit, invoiceStatusKey, reemitTarget } from './logic'
import * as slot from './sale-history-slot'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const inv = (over: Partial<SaleInvoiceDto> = {}): SaleInvoiceDto => ({
  sale_id: 's1',
  invoice_emit_status: null,
  invoice_last_error: null,
  invoice_integration_id: null,
  attempts: 0,
  number: null,
  pdf_url: null,
  can_reemit: true,
  ...over,
})

describe('AC-T114-05 status da nota e "Reemitir nota" no histórico de vendas', () => {
  it('rótulos de 19 §4.2 nas 3 línguas (nulo = "Sem emissor")', () => {
    expect(invoiceStatusKey(inv())).toBe('none')
    expect(invoiceStatusKey(null)).toBe('none')
    expect(invoiceStatusKey(inv({ invoice_emit_status: 'failed' }))).toBe('failed')
    const pt = (k: string) => translate('pt-BR', `settings-payments:invoice.status.${k}`)
    expect([pt('pending'), pt('succeeded'), pt('failed'), pt('none')]).toEqual([
      'Enviando emissão…',
      'Enviada ao emissor',
      'Falha na emissão',
      'Sem emissor',
    ])
    for (const locale of ['en', 'es'] as const)
      for (const k of ['pending', 'succeeded', 'failed', 'none', 'reemit', 'reemitted'])
        expect(
          translate(locale, `settings-payments:invoice.${k === 'reemit' || k === 'reemitted' ? k : `status.${k}`}`),
        ).not.toMatch(/invoice\./)
    expect(translate('pt-BR', 'settings-payments:invoice.reemit')).toBe('Reemitir nota')
    expect(translate('pt-BR', 'settings-payments:invoice.reemitted')).toBe('Emissão reenfileirada')
  })

  it('reemissão só quando o status ≠ pending e ≠ succeeded (respeita `can_reemit` do servidor)', () => {
    expect(canReemit(inv())).toBe(true)
    expect(canReemit(inv({ invoice_emit_status: 'failed' }))).toBe(true)
    expect(canReemit(inv({ invoice_emit_status: 'pending', can_reemit: false }))).toBe(false)
    expect(canReemit({ invoice_emit_status: 'succeeded' })).toBe(false)
    expect(canReemit(null)).toBe(true)
  })

  it('emissor do "Reemitir": o da venda (servidor resolve), o único da conta, ou escolha entre vários', () => {
    const sale = { note_issuer_id: null }
    expect(reemitTarget(inv({ invoice_integration_id: 'i1' }), sale, [])).toEqual({ kind: 'server' })
    expect(reemitTarget(inv(), { note_issuer_id: 'i9' }, null)).toEqual({ kind: 'server' })
    expect(reemitTarget(inv(), sale, [{ id: 'i1' }])).toEqual({ kind: 'id', id: 'i1' })
    expect(reemitTarget(inv(), sale, [{ id: 'i1' }, { id: 'i2' }])).toEqual({ kind: 'choose' })
    expect(reemitTarget(inv(), sale, null)).toEqual({ kind: 'none' })
  })

  it('"Reemitir nota" chama a rota da T112 (202 + mensagem) com o emissor escolhido', async () => {
    const post = vi
      .spyOn(api, 'post')
      .mockResolvedValue({
        invoice: inv({ invoice_emit_status: 'pending', can_reemit: false }),
        message: 'Emissão reenfileirada. Aguarde alguns segundos e atualize a lista.',
      } as never)
    const res = await reemitInvoice('s1', 'i2')
    expect(post).toHaveBeenCalledWith('/api/sales/s1/reemit-invoice', { invoice_integration_id: 'i2' })
    expect(res.invoice.invoice_emit_status).toBe('pending')
    await reemitInvoice('s1')
    expect(post).toHaveBeenLastCalledWith('/api/sales/s1/reemit-invoice', {})
  })

  it('as células pedem o status em lote (`/api/sale-invoices?sale_ids=`), até 200 ids por chamada', async () => {
    const fetchMany = vi.fn(async (ids: string[]) => ids.filter((id) => id !== 'x').map((id) => ({ sale_id: id })))
    const b = createBatcher(fetchMany, (x) => x.sale_id, { max: 2, delayMs: 0 })
    const r = await Promise.all(['a', 'b', 'c', 'x', 'a'].map((id) => b.load(id)))
    expect(r).toEqual([{ sale_id: 'a' }, { sale_id: 'b' }, { sale_id: 'c' }, null, { sale_id: 'a' }])
    expect(fetchMany.mock.calls).toEqual([[['a', 'b']], [['c', 'x']]])

    const get = vi
      .spyOn(api, 'get')
      .mockResolvedValue({
        items: [inv({ sale_id: 's1' }), inv({ sale_id: 's2', invoice_emit_status: 'failed' })],
      } as never)
    const load = (id: string) => (saleInvoiceQuery(id).queryFn as () => Promise<SaleInvoiceDto | null>)()
    const [a, b2] = await Promise.all([load('s1'), load('s2')])
    expect(a?.invoice_emit_status).toBeNull()
    expect(b2?.invoice_emit_status).toBe('failed')
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith('/api/sale-invoices', { query: { sale_ids: 's1,s2' } })
  })

  it('`sale.updated` atualiza o status da nota e da UTMify no cache', () => {
    const qc = new QueryClient()
    qc.setQueryData([...SALE_INVOICE_KEY, 's1'], inv())
    applySaleUpdated(qc, { sale_id: 's1', invoice_emit_status: 'failed', invoice_last_error: 'Falha na Notasy: 500' })
    expect(qc.getQueryData([...SALE_INVOICE_KEY, 's1'])).toMatchObject({
      invoice_emit_status: 'failed',
      invoice_last_error: 'Falha na Notasy: 500',
      can_reemit: true,
    })
    applySaleUpdated(qc, {
      sale_id: 's1',
      invoice: inv({ invoice_emit_status: 'succeeded', can_reemit: false, number: '42' }),
    })
    expect(qc.getQueryData([...SALE_INVOICE_KEY, 's1'])).toMatchObject({
      invoice_emit_status: 'succeeded',
      number: '42',
    })
    qc.setQueryData([...SALE_UTMIFY_KEY, 's1'], {
      sale_id: 's1',
      utmify_integration_id: 'u1',
      utmify_status: 'pending',
      utmify_last_error: null,
    })
    applySaleUpdated(qc, { sale_id: 's1', utmify_status: 'succeeded' })
    expect(qc.getQueryData([...SALE_UTMIFY_KEY, 's1'])).toMatchObject({ utmify_status: 'succeeded' })
    applySaleUpdated(qc, null)
    applySaleUpdated(qc, { invoice_emit_status: 'failed' })
  })

  it('o slot entra no histórico (colunas "Nota fiscal"/"UTMify" e ação "Reemitir") e ouve `sale.updated`', () => {
    expect(collectSaleSlots({ '../sale-invoice/sale-history-slot.tsx': slot })).toBe(3)
    expect(saleColumns().map((c) => c.id)).toEqual(['nf', 'utmify'])
    expect(saleActions().map((a) => a.id)).toEqual(['reemit-invoice'])
    expect(registeredTypes()).toContain('sale.updated')
    const qc = new QueryClient()
    qc.setQueryData([...SALE_INVOICE_KEY, 's9'], inv({ sale_id: 's9' }))
    dispatchRealtime(
      {
        id: '1',
        type: 'sale.updated',
        company_id: 'c',
        at: '',
        data: { sale_id: 's9', invoice_emit_status: 'pending' },
      },
      qc,
    )
    expect(qc.getQueryData([...SALE_INVOICE_KEY, 's9'])).toMatchObject({
      invoice_emit_status: 'pending',
      can_reemit: false,
    })
    expect(translate('es', 'settings-payments:history.invoice')).toBe('Factura')
  })
})
