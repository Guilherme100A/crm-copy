// `webhook.sample_received` (T81): só chega para quem está escutando o webhook. O handler é registrado no carregamento
// da rota (antes de o shell abrir o SSE) e repassa a amostra a quem ouve aquele webhook.
import { onRealtime } from '@/lib/realtime'

export interface SampleReceived {
  webhook_id: string
  request_id: string
  request: { raw_body: string; raw_body_truncated: boolean }
}

type Listener = (ev: SampleReceived) => void
const listeners = new Map<string, Set<Listener>>()

export function onSample(webhookId: string, fn: Listener): () => void {
  let set = listeners.get(webhookId)
  if (!set) listeners.set(webhookId, (set = new Set()))
  set.add(fn)
  return () => {
    set.delete(fn)
    if (!set.size) listeners.delete(webhookId)
  }
}

export function dispatchSample(data: unknown): void {
  const ev = data as Partial<SampleReceived> | null
  if (!ev || typeof ev.webhook_id !== 'string' || !ev.request || typeof ev.request.raw_body !== 'string') return
  for (const fn of listeners.get(ev.webhook_id) ?? []) fn(ev as SampleReceived)
}

let registered = false
export function registerWebhookSamplesRealtime(): void {
  if (registered) return
  registered = true
  onRealtime('webhook.sample_received', (e) => dispatchSample(e.data))
}

/** Segundos restantes até `expiresAt` (≥ 0). */
export const secondsLeft = (expiresAt: string, now = Date.now()) => Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1000))
