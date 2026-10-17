// Modal da integração UTMify (19 §3.4, 11 §3.6; T113), aberto pelo hub (`modalKind: 'utmify'`).
import type { IntegrationModalProps } from '@/features/integrations/catalog'
import { TokenModal } from './token-modal'

export default function UtmifyModal(props: IntegrationModalProps) {
  return <TokenModal kind="utmify" {...props} />
}
