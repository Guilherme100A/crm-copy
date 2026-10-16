// Health Score (T20, fork do ai-manager). Função pura: indicador operacional de 0 a 100, sem nenhuma garantia
// sobre o comportamento do WhatsApp. Pesos inspirados no HealthMonitor do baileys-antiban.

export type HealthLabel = 'Good' | 'Warning' | 'Critical'

export interface HealthScoreInput {
  /** Mensagens enviadas com sucesso na janela. */
  sent: number
  /** Mensagens recebidas na janela (proxy da taxa de resposta). */
  received: number
  /** Envios que falharam na janela. */
  failed: number
  /** Quedas de conexão na janela. */
  disconnects: number
  /** Eventos 403 (forbidden) na janela. */
  forbidden403: number
  /** Erros da metade recente da janela menos os da metade anterior (> 0 = piorando). */
  errorTrend?: number
}

export interface HealthScore {
  score: number
  label: HealthLabel
}

/** Limiar de alerta (abaixo → DEGRADED) e crítico (abaixo → PAUSED), wsm AC-T10-03. */
export const HEALTH_WARNING_THRESHOLD = 70
export const HEALTH_CRITICAL_THRESHOLD = 40

/** Pesos do score. */
export const HEALTH_WEIGHTS = Object.freeze({
  /** Por falha de envio (teto `failedMax`). */
  failed: 3,
  failedMax: 30,
  /** Taxa de falha (failed / (sent + failed)) × `failureRate`, com amostra mínima. */
  failureRate: 20,
  failureRateMinSample: 5,
  /** Por desconexão (teto `disconnectsMax`). */
  disconnect: 5,
  disconnectsMax: 30,
  /** Por evento 403 (teto `forbiddenMax`). */
  forbidden: 40,
  forbiddenMax: 60,
  /** Taxa de resposta (received / sent) baixa, a partir de `replyMinSample` envios. */
  replyMinSample: 20,
  replyVeryLowRate: 0.02,
  replyVeryLowPenalty: 15,
  replyLowRate: 0.1,
  replyLowPenalty: 8,
  /** Por unidade de tendência positiva de erros (teto `trendMax`). */
  trend: 4,
  trendMax: 20,
})

export function healthLabel(score: number): HealthLabel {
  if (score >= HEALTH_WARNING_THRESHOLD) return 'Good'
  if (score >= HEALTH_CRITICAL_THRESHOLD) return 'Warning'
  return 'Critical'
}

const nn = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** Penalidades por componente (para explicar o score). */
export function healthPenalties(input: HealthScoreInput): Record<'failed' | 'disconnects' | 'forbidden403' | 'replyRate' | 'errorTrend', number> {
  const w = HEALTH_WEIGHTS
  const sent = nn(input.sent)
  const received = nn(input.received)
  const failed = nn(input.failed)
  const attempted = sent + failed

  let failedPenalty = Math.min(w.failedMax, failed * w.failed)
  if (attempted >= w.failureRateMinSample) failedPenalty += (failed / attempted) * w.failureRate

  let replyRate = 0
  if (sent >= w.replyMinSample) {
    const rate = received / sent
    if (rate < w.replyVeryLowRate) replyRate = w.replyVeryLowPenalty
    else if (rate < w.replyLowRate) replyRate = w.replyLowPenalty
  }

  return {
    failed: failedPenalty,
    disconnects: Math.min(w.disconnectsMax, nn(input.disconnects) * w.disconnect),
    forbidden403: Math.min(w.forbiddenMax, nn(input.forbidden403) * w.forbidden),
    replyRate,
    errorTrend: Math.min(w.trendMax, nn(input.errorTrend) * w.trend),
  }
}

export function computeHealthScore(input: HealthScoreInput): HealthScore {
  const p = healthPenalties(input)
  const total = p.failed + p.disconnects + p.forbidden403 + p.replyRate + p.errorTrend
  const score = Math.max(0, Math.min(100, Math.round(100 - total)))
  return { score, label: healthLabel(score) }
}
