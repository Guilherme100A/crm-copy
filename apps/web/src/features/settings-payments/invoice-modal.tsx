// Modal do emissor de NF Notasy (19 §2.5, §3.2; T112), aberto pelo hub (`modalKind: 'invoice'`).
import type { IntegrationModalProps } from '@/features/integrations/catalog'
import { TokenModal } from './token-modal'

export default function InvoiceModal(props: IntegrationModalProps) {
  return <TokenModal kind="invoice" {...props} />
}
