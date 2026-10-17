// Realtime da empresa (T102; pendência da T53): `company.updated` recarrega a empresa, o perfil e a lista de contas.
// O shell importa este módulo de forma ESTÁTICA: o handler precisa estar registrado antes de o SSE abrir
// (o hub de Configurações é lazy e o seu import chegaria tarde demais).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { profileQueryKey } from '@/lib/session'
import { companyKey } from './api'

export function applyCompanyUpdated(e: RealtimeEnvelope, qc: QueryClient): void {
  const data = (e.data ?? {}) as { company_id?: string; id?: string }
  const id = data.company_id ?? data.id ?? e.company_id
  if (id) void qc.invalidateQueries({ queryKey: companyKey(id) })
  void qc.invalidateQueries({ queryKey: profileQueryKey })
  void qc.invalidateQueries({ queryKey: ['company-switcher'] })
}

onRealtime('company.updated', applyCompanyUpdated)
