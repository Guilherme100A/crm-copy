// HealthMonitor (T20, fork do ai-manager apps/worker/src/health/monitor.ts): avalia warm-up e Health Score de cada sessão conectada e aplica
// as transições da SPEC 3.2 (WARMING→STABLE, →DEGRADED, recuperação, PAUSED automático).
// O sistema só PARA diante de sinais anormais; nunca aumenta atividade para compensar (SPEC 1.4 #4).
// O resume é sempre manual (SessionManager.resume → resumeState).
import { EventEmitter } from 'node:events'
import { healthEvents, type Database } from '../db'
import type { ConnectedContext, DisconnectedContext, SessionManagerLogger } from '../session/manager'
import { InvalidTransitionError, type SessionState } from '../session/states'
import type { SessionRow } from '../session/store'
import { isWarmupComplete, type WarmupSchedule } from '../warmup'
import { HEALTH_CRITICAL_THRESHOLD, HEALTH_WARNING_THRESHOLD } from './score'
import { HEALTH_EVENT_TYPES, HealthService, type HealthEvaluation, type SessionHealth } from './service'

/** Parte do SessionManager (wsm T05) usada pelo monitor. */
export interface MonitoredManager {
  pause(id: string): Promise<unknown>
  emit(event: 'state', payload: { sessionId: string; from: SessionState; to: SessionState }): boolean
}

/** Controle opcional da fila (wsm T08); o monitor não depende do código da fila. */
export interface HealthQueueControl {
  pause(sessionId: string): void | Promise<void>
}

export type HealthAlertType = 'forbidden_403' | 'health_degraded' | 'warmup_paused' | 'error_burst' | 'disconnected'

/** Evento observável consumido pelos alertas (wsm T11). */
export interface HealthAlert {
  type: HealthAlertType
  sessionId: string
  at: Date
  detail?: Record<string, unknown>
}

export interface HealthStateChange {
  sessionId: string
  from: SessionState
  to: SessionState
  reason: string
}

export interface HealthMonitorEvents {
  alert: [HealthAlert]
  state: [HealthStateChange]
  evaluated: [{ sessionId: string; health: SessionHealth }]
}

export interface HealthMonitorOptions {
  db: Database
  logger?: SessionManagerLogger
  /** Relógio (injetável). */
  now?: () => Date
  /** Cronograma de warm-up (default: DEFAULT_WARMUP_SCHEDULE). */
  schedule?: Partial<WarmupSchedule>
  /** Janela dos contadores do score (default 24h). */
  windowMs?: number
  /** Pausa da fila no PAUSED automático (além do evento `state` do manager). */
  queueControl?: HealthQueueControl
  /** Intervalo da avaliação periódica de cada sessão conectada (default 60s; 0 desliga). */
  intervalMs?: number
  /** Erros na metade recente da janela, com tendência de alta, que caracterizam `error_burst` (default 5). */
  burstThreshold?: number
  /** SessionManager (também pode ser ligado depois com `attach`). */
  manager?: MonitoredManager
}

export const DEFAULT_HEALTH_INTERVAL_MS = 60_000
export const DEFAULT_BURST_THRESHOLD = 5

const ACTIVE_STATES: readonly SessionState[] = ['WARMING', 'STABLE', 'DEGRADED']
const noopLogger: SessionManagerLogger = { debug() {}, info() {}, warn() {}, error() {} }

export class HealthMonitor extends EventEmitter<HealthMonitorEvents> {
  readonly service: HealthService
  private manager: MonitoredManager | undefined
  private readonly log: SessionManagerLogger
  private readonly now: () => Date
  private readonly intervalMs: number
  private readonly burstThreshold: number
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly chains = new Map<string, Promise<unknown>>()
  private readonly bursting = new Set<string>()

  constructor(private readonly opts: HealthMonitorOptions) {
    super()
    this.now = opts.now ?? (() => new Date())
    this.service = new HealthService(opts.db, {
      now: this.now,
      ...(opts.schedule ? { schedule: opts.schedule } : {}),
      ...(opts.windowMs !== undefined ? { windowMs: opts.windowMs } : {}),
    })
    this.log = opts.logger ?? noopLogger
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS
    this.burstThreshold = opts.burstThreshold ?? DEFAULT_BURST_THRESHOLD
    this.manager = opts.manager
  }

  /** Liga o SessionManager (usado no PAUSED automático: `manager.pause(id)`). */
  attach(manager: MonitoredManager): this {
    this.manager = manager
    return this
  }

  // ---- hooks do SessionManager (já bindados) -------------------------------------

  readonly onConnected = async (sessionId: string, _ctx?: ConnectedContext): Promise<void> => {
    this.startTimer(sessionId)
    await this.evaluate(sessionId)
  }

  readonly onDisconnected = async (sessionId: string, ctx: DisconnectedContext): Promise<void> => {
    this.stopTimer(sessionId)
    if (ctx.reason === 'local') return
    if (ctx.reason === 'forbidden') {
      // O SessionManager grava forbidden_403 e pausa a sessão logo após este hook.
      const row = await this.service.store.find(sessionId)
      const detail: Record<string, unknown> = { source: 'connection' }
      if (ctx.statusCode !== undefined) detail.statusCode = ctx.statusCode
      await this.pauseQueue(sessionId)
      await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.autoPaused, { reason: 'forbidden_403', ...detail })
      this.alert('forbidden_403', sessionId, detail)
      if (row?.status === 'WARMING') this.alert('warmup_paused', sessionId, { reason: 'forbidden_403' })
      return
    }
    this.alert('disconnected', sessionId, ctx.statusCode === undefined ? { reason: ctx.reason } : { reason: ctx.reason, statusCode: ctx.statusCode })
  }

  /** Destino do resume manual: STABLE se o warm-up terminou, senão WARMING. Sinais anteriores deixam de contar. */
  readonly resumeState = async (row: SessionRow): Promise<'WARMING' | 'STABLE'> => {
    const now = this.now()
    await this.recordEvent(row.id, HEALTH_EVENT_TYPES.resumed, { manual: true }, now)
    this.bursting.delete(row.id)
    return isWarmupComplete(row.warmupStartedAt, now, this.service.schedule) ? 'STABLE' : 'WARMING'
  }

  // ---- API pública ------------------------------------------------------------------

  /** Health da sessão (wsm AC-T10-04). SessionError SESSION_NOT_FOUND se não existir. */
  getHealth(sessionId: string): Promise<SessionHealth> {
    return this.service.getHealth(sessionId)
  }

  /** Avalia agora e aplica as transições; devolve a visão de health após as transições. */
  evaluate(sessionId: string): Promise<SessionHealth> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve()
    const run = prev.then(() => this.doEvaluate(sessionId))
    const tail = run.catch(() => undefined)
    this.chains.set(sessionId, tail)
    void tail.then(() => {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId)
    })
    return run
  }

  /**
   * Sinal externo (ex.: 403 num envio, T09): grava o health_event e reavalia na hora.
   * `forbidden_403` pausa a sessão.
   */
  async recordSignal(sessionId: string, type: 'forbidden_403' | 'disconnected', detail?: Record<string, unknown>): Promise<SessionHealth> {
    await this.recordEvent(sessionId, type, detail ?? {})
    return this.evaluate(sessionId)
  }

  /** Para os timers de avaliação periódica. */
  stop(): void {
    for (const t of this.timers.values()) clearInterval(t)
    this.timers.clear()
  }

  // ---- internos -----------------------------------------------------------------------

  private async doEvaluate(sessionId: string): Promise<SessionHealth> {
    const ev = await this.service.evaluate(sessionId)
    const state = ev.row.status
    if (ACTIVE_STATES.includes(state)) {
      await this.checkBurst(sessionId, ev)
      await this.apply(sessionId, state, ev)
    }
    const row = await this.service.store.get(sessionId)
    const health = { ...ev.health, state: row.status }
    this.emit('evaluated', { sessionId, health })
    return health
  }

  private async apply(sessionId: string, state: SessionState, ev: HealthEvaluation): Promise<void> {
    const { score, stats, warmup } = ev
    if (stats.forbidden403 > 0 || score < HEALTH_CRITICAL_THRESHOLD) {
      await this.autoPause(sessionId, state, stats.forbidden403 > 0 ? 'forbidden_403' : 'health_critical', ev)
      return
    }
    if (score < HEALTH_WARNING_THRESHOLD) {
      if (state === 'DEGRADED') return
      if (await this.transition(sessionId, 'DEGRADED', 'health_degraded')) {
        await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.degraded, { score, from: state })
        this.alert('health_degraded', sessionId, { level: 'warning', score, label: ev.label, from: state })
      }
      return
    }
    if (state === 'DEGRADED') {
      const to = warmup.complete ? 'STABLE' : 'WARMING'
      if (await this.transition(sessionId, to, 'health_recovered')) {
        await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.recovered, { score, to })
      }
      return
    }
    if (state === 'WARMING' && warmup.complete) {
      if (await this.transition(sessionId, 'STABLE', 'warmup_completed')) {
        await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.warmupCompleted, { warmupPercent: warmup.percent })
      }
    }
  }

  private async autoPause(sessionId: string, from: SessionState, reason: 'forbidden_403' | 'health_critical', ev: HealthEvaluation): Promise<void> {
    let paused = false
    try {
      if (this.manager) {
        await this.manager.pause(sessionId)
        paused = true
      } else {
        paused = await this.transition(sessionId, 'PAUSED', reason)
      }
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err
      this.log.warn({ session_id: sessionId, err: err.message }, 'auto pause skipped')
    }
    if (!paused) return
    await this.pauseQueue(sessionId)
    const detail = { reason, score: ev.score, label: ev.label, from, forbidden403: ev.stats.forbidden403 }
    await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.autoPaused, detail)
    this.log.warn({ session_id: sessionId, ...detail }, 'session paused automatically')
    if (reason === 'forbidden_403') this.alert('forbidden_403', sessionId, { source: 'health', score: ev.score, forbidden403: ev.stats.forbidden403 })
    else this.alert('health_degraded', sessionId, { level: 'critical', paused: true, score: ev.score, label: ev.label, from })
    if (from === 'WARMING') this.alert('warmup_paused', sessionId, { reason, score: ev.score })
  }

  private async checkBurst(sessionId: string, ev: HealthEvaluation): Promise<void> {
    const { recentErrors, errorTrend } = ev.stats
    const burst = recentErrors >= this.burstThreshold && errorTrend > 0
    if (!burst) {
      this.bursting.delete(sessionId)
      return
    }
    if (this.bursting.has(sessionId)) return
    this.bursting.add(sessionId)
    const detail = { recentErrors, previousErrors: ev.stats.previousErrors, errorTrend }
    await this.recordEvent(sessionId, HEALTH_EVENT_TYPES.errorBurst, detail)
    this.alert('error_burst', sessionId, detail)
  }

  /** Transição validada pela store (SPEC 3.2). Corrida/estado inválido → false (sem erro). */
  private async transition(sessionId: string, to: SessionState, reason: string): Promise<boolean> {
    try {
      const res = await this.service.store.transition(sessionId, to)
      if (!res.changed) return false
      this.log.info({ session_id: sessionId, from: res.from, to: res.to, reason }, 'session state changed by health monitor')
      this.manager?.emit('state', { sessionId, from: res.from, to: res.to })
      this.emit('state', { sessionId, from: res.from, to: res.to, reason })
      return true
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.log.warn({ session_id: sessionId, from: err.from, to, reason }, 'health transition skipped')
        return false
      }
      throw err
    }
  }

  private async pauseQueue(sessionId: string): Promise<void> {
    if (!this.opts.queueControl) return
    try {
      await this.opts.queueControl.pause(sessionId)
    } catch (err) {
      this.log.error({ session_id: sessionId, err }, 'queue pause failed')
    }
  }

  private async recordEvent(sessionId: string, type: string, detail: Record<string, unknown>, at = this.now()): Promise<void> {
    await this.opts.db.insert(healthEvents).values({ sessionId, type, detail, createdAt: at })
  }

  private alert(type: HealthAlertType, sessionId: string, detail?: Record<string, unknown>): void {
    const alert: HealthAlert = detail ? { type, sessionId, at: this.now(), detail } : { type, sessionId, at: this.now() }
    try {
      this.emit('alert', alert)
    } catch (err) {
      this.log.error({ session_id: sessionId, err, type }, 'alert listener failed')
    }
  }

  private startTimer(sessionId: string): void {
    this.stopTimer(sessionId)
    if (this.intervalMs <= 0) return
    const timer = setInterval(() => {
      this.evaluate(sessionId).catch((err) => this.log.error({ session_id: sessionId, err }, 'health evaluation failed'))
    }, this.intervalMs)
    timer.unref?.()
    this.timers.set(sessionId, timer)
  }

  private stopTimer(sessionId: string): void {
    const t = this.timers.get(sessionId)
    if (t) clearInterval(t)
    this.timers.delete(sessionId)
  }
}

