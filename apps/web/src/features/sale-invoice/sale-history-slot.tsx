// Slot do histórico de vendas (T87 → T114; AC-T114-05): colunas "Nota fiscal" e "UTMify" e a ação "Reemitir nota".
// Descoberto pelo glob eager do histórico (`dashboard-history/history-panel.tsx`); só `import type` de lá.
import type { SaleHistorySlot } from '@/features/dashboard-history/slots'
import { useT } from '@/i18n'
import { InvoiceStatusCell, ReemitButton, UtmifyStatusCell } from './invoice-cells'
import { registerSaleInvoiceRealtime } from './realtime'

registerSaleInvoiceRealtime()

function Header({ k }: { k: 'invoice' | 'utmify' }) {
  const t = useT('settings-payments')
  return <>{t(`history.${k}`)}</>
}

export const saleHistorySlot: SaleHistorySlot = {
  columns: [
    { id: 'nf', header: () => <Header k="invoice" />, cell: (sale) => <InvoiceStatusCell sale={sale} />, order: 1 },
    { id: 'utmify', header: () => <Header k="utmify" />, cell: (sale) => <UtmifyStatusCell sale={sale} />, order: 2 },
  ],
  actions: [{ id: 'reemit-invoice', render: (sale) => <ReemitButton sale={sale} /> }],
}
