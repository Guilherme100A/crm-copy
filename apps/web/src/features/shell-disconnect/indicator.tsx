// Indicador no item "Conexões" do menu (AC-T107-01..04; 18 §5.5): ponto de alerta com o rótulo "Instância
// desconectada nas últimas 24h" quando alguma conexão da empresa ativa caiu nas últimas 24 h. Suporte e quem não tem
// `connections.view` não veem nem consultam.
import { useQuery } from '@tanstack/react-query'
import { useT } from '@/i18n'
import type { Session } from '@/lib/session'
import { cn } from '@/lib/utils'
import { canSeeDisconnectAlert, disconnectAlertQuery, isAlertActive } from './api'
import './realtime'

export function DisconnectIndicator({ session, collapsed = false }: { session: Session; collapsed?: boolean }) {
  const t = useT('shell-disconnect')
  const allowed = canSeeDisconnectAlert(session)
  const q = useQuery({ ...disconnectAlertQuery(session.company?.id), enabled: allowed })
  if (!allowed || !isAlertActive(q.data)) return null
  const label = t('indicator.label')
  return (
    <span
      data-testid="shell-disconnect-indicator"
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'size-2.5 shrink-0 rounded-full bg-destructive ring-2 ring-sidebar',
        collapsed ? 'absolute top-1.5 right-3' : 'ml-auto',
      )}
    />
  )
}
