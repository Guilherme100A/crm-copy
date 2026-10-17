// Realtime da criação assistida: `ai_agent.run.updated` (T79) atualiza o run em cache (estágios, avisos, fim) sem
// esperar o polling. Registrado no carregamento das rotas de `/agentes`, junto do `registerAgentsRealtime()` (um
// handler registrado em módulo lazy não entra no SSE já aberto).
import type { QueryClient } from '@tanstack/react-query'
import { onRealtime, type RealtimeEnvelope } from '@/lib/realtime'
import { runKey, type PublicRun } from './api'
import { mergeRun } from './lab'

export function applyRunEvent(qc: QueryClient, data: unknown): void {
  const run = (data as { run?: PublicRun } | null)?.run
  if (!run?.id || !run.status) return
  qc.setQueryData<PublicRun>(runKey(run.id), (old) => mergeRun(old, run))
}

let registered = false

export function registerAgentLabRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('ai_agent.run.updated', (e: RealtimeEnvelope, qc) => applyRunEvent(qc, e.data))
}
