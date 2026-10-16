// SessionManager (fork de ai-manager apps/worker/src/sessions/manager.ts): cria, autentica, persiste, reconecta e
// controla sessões. Toda conexão passa por connectSession: proxy configurado é obrigatório, sem fallback direto.
// Duas filas por sessão: `ops` serializa as ações públicas (restart, logout, pause…) e `chain` serializa o
// tratamento dos eventos do transporte (open/close na ordem em que chegaram).
import { EventEmitter } from 'node:events'
import type { CredentialCipher } from '@crm/node-kit'
import { usePostgresAuthState, type PostgresAuthState } from '../auth-state'
import type { Database } from '../db'
import { connectSession, ProxyError } from '../proxy'
import type { DisconnectKind, WaTransport } from '../transport'
import { toQrDataUrl } from './qr'
import { assertAction, canTransition, type SessionState } from './states'
import { SessionError, SessionStore, toSessionView, type CreateSessionInput, type SessionRow, type SessionView, type TransitionOptions } from './store'

export interface SessionManagerLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type TransportFactory = (sessionId: string) => WaTransport

export interface ConnectedContext {
  sessionId: string
  transport: WaTransport
  state: SessionState
}

export interface DisconnectedContext {
  sessionId: string
  reason: DisconnectKind | 'local'
  statusCode?: number
}

export interface SessionManagerOptions {
  db: Database
  /** Cria o transporte de uma sessão (FakeTransport nos testes, BaileysTransport em produção). */
  transportFactory: TransportFactory
  logger?: SessionManagerLogger
  /** Espera entre reconexões (injetável). Padrão: setTimeout. */
  sleep?: (ms: number) => Promise<void>
  /** Atraso da tentativa `attempt` (1-based). Padrão: 1000·2^(attempt-1) → 1s, 2s, 4s, 8s, 16s. */
  backoff?: (attempt: number) => number
  /** Máximo de reconexões após queda transitória. Padrão 5. */
  maxReconnectAttempts?: number
  /** Chamado a cada conexão aberta (o HealthMonitor pluga aqui). */
  onConnected?: (sessionId: string, ctx: ConnectedContext) => void | Promise<void>
  /** Chamado quando a conexão cai ou é encerrada. */
  onDisconnected?: (sessionId: string, ctx: DisconnectedContext) => void | Promise<void>
  /** Destino do resume manual (PAUSED → WARMING|STABLE). Padrão: WARMING (o warm-up promove a STABLE). */
  resumeState?: (row: SessionRow) => 'WARMING' | 'STABLE' | Promise<'WARMING' | 'STABLE'>
  /** Prazo para o transporte emitir o código de pareamento. Padrão 30 s. */
  pairingTimeoutMs?: number
  /** Conta já pareada que não abre a conexão neste prazo vira queda transitória. Padrão 60 s. */
  connectTimeoutMs?: number
  now?: () => Date
  /** Auth state persistido. Padrão: usePostgresAuthState (cifrado com `cipher`). */
  authStateFactory?: (db: Database, sessionId: string) => Promise<PostgresAuthState>
  /** Cifrador das credenciais e da senha do proxy. Padrão: o de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: CredentialCipher
}

export interface QrInfo {
  /** Data URL (image/png) do QR mais recente, ou null se ainda não houver. */
  qr: string | null
  generatedAt: string | null
}

export interface SessionRuntimeInfo {
  sessionId: string
  connected: boolean
  monitoring: boolean
  reconnectAttempts: number
  pairingPhone?: string
}

export type SessionManagerErrorCode = 'PAIRING_TIMEOUT' | 'CONNECTION_CLOSED'

export class SessionManagerError extends Error {
  constructor(
    readonly code: SessionManagerErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SessionManagerError'
  }
}

interface Waiter {
  resolve: (code: string) => void
  reject: (err: Error) => void
}

interface Runtime {
  sessionId: string
  transport: WaTransport
  auth: PostgresAuthState
  pairingPhone?: string
  connected: boolean
  monitoring: boolean
  failures: number
  /** Encerramento local (logout/restart/stop): eventos de close são ignorados. */
  closing: boolean
  disposed: boolean
  qr?: { raw: string; at: Date; dataUrl: Promise<string> }
  pairingCode?: string
  pairingWaiters: Waiter[]
  chain: Promise<unknown>
  started: boolean
  /** Conta as tentativas de conexão: o vigia só age sobre a tentativa que o armou. */
  attempt: number
  /** A conexão foi recusada porque o proxy configurado está indisponível (sem tentativa direta). */
  proxyError?: Error
}

export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5
export const DEFAULT_CONNECT_TIMEOUT_MS = 60_000
export const DEFAULT_PAIRING_TIMEOUT_MS = 30_000
export const defaultBackoff = (attempt: number) => 1000 * 2 ** (attempt - 1)

const noopLogger: SessionManagerLogger = { debug() {}, info() {}, warn() {}, error() {} }

export interface SessionManagerEvents {
  connected: [ConnectedContext]
  disconnected: [DisconnectedContext]
  state: [{ sessionId: string; from: SessionState; to: SessionState }]
  qr: [{ sessionId: string; qr: string }]
  'pairing-code': [{ sessionId: string; code: string }]
  reconnect: [{ sessionId: string; attempt: number; delayMs: number }]
}

export class SessionManager extends EventEmitter<SessionManagerEvents> {
  readonly store: SessionStore
  private readonly runtimes = new Map<string, Runtime>()
  /** Fila de ações públicas por sessão. */
  private readonly ops = new Map<string, Promise<unknown>>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly timers = new Map<NodeJS.Timeout, () => void>()
  private readonly log: SessionManagerLogger
  private readonly maxAttempts: number
  private readonly connectTimeoutMs: number
  private readonly backoff: (attempt: number) => number
  private readonly now: () => Date
  private stopped = false

  constructor(private readonly opts: SessionManagerOptions) {
    super()
    this.store = new SessionStore(opts.db)
    this.log = opts.logger ?? noopLogger
    this.maxAttempts = opts.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.backoff = opts.backoff ?? defaultBackoff
    this.now = opts.now ?? (() => new Date())
  }

  // ---- ciclo de vida ---------------------------------------------------------------

  /** Boot: reconecta sessões com credenciais e estado ≠ DISCONNECTED (PAUSED reconecta e continua PAUSED). */
  async start(): Promise<void> {
    this.stopped = false
    const rows = await this.store.listResumable()
    const results = await Promise.allSettled(
      rows.filter((r) => !this.runtimes.has(r.id)).map((r) => this.serial(r.id, () => this.openRuntime(r.id))),
    )
    for (const r of results) if (r.status === 'rejected') this.log.error({ err: r.reason }, 'falha ao retomar sessão')
    this.log.info({ sessions: rows.length }, 'session manager iniciado')
  }

  /** Fecha todos os transportes sem alterar o estado no banco (shutdown / restart do processo). */
  async stop(): Promise<void> {
    this.stopped = true
    for (const [timer, wake] of this.timers) {
      clearTimeout(timer)
      wake()
    }
    this.timers.clear()
    await Promise.allSettled([...this.runtimes.values()].map((rt) => this.dispose(rt, 'local')))
    await this.whenIdle()
  }

  /** Resolve quando não há tarefas pendentes (eventos de conexão, reconexões, ações). Útil em testes. */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  // ---- consultas ---------------------------------------------------------------------

  async create(input: CreateSessionInput): Promise<SessionView> {
    return toSessionView(await this.store.create(input))
  }

  async list(): Promise<SessionView[]> {
    return (await this.store.list()).map(toSessionView)
  }

  async get(id: string): Promise<SessionView> {
    return toSessionView(await this.store.get(id))
  }

  /** Transporte vivo da sessão (fila de envio, grupos), se houver. */
  getTransport(sessionId: string): WaTransport | undefined {
    return this.runtimes.get(sessionId)?.transport
  }

  isConnected(sessionId: string): boolean {
    return this.runtimes.get(sessionId)?.connected ?? false
  }

  runtimeInfo(sessionId: string): SessionRuntimeInfo | undefined {
    const rt = this.runtimes.get(sessionId)
    if (!rt) return undefined
    const info: SessionRuntimeInfo = { sessionId, connected: rt.connected, monitoring: rt.monitoring, reconnectAttempts: rt.failures }
    if (rt.pairingPhone) info.pairingPhone = rt.pairingPhone
    return info
  }

  // ---- autenticação ----------------------------------------------------------------

  /** Inicia a conexão por QR. Válido em NEW ou DISCONNECTED (DISCONNECTED → NEW). */
  startQr(id: string): Promise<SessionView> {
    return this.serial(id, () => this.doStartQr(id))
  }

  async getQr(id: string): Promise<QrInfo> {
    await this.store.get(id)
    const qr = this.runtimes.get(id)?.qr
    if (!qr) return { qr: null, generatedAt: null }
    return { qr: await qr.dataUrl, generatedAt: qr.at.toISOString() }
  }

  /**
   * Conecta pedindo código de pareamento para `phone` (padrão: telefone da sessão). O transporte só pede o código
   * depois do primeiro QR e uma vez por socket; aqui só se espera o código (até `pairingTimeoutMs`).
   */
  async requestPairingCode(id: string, phone?: string): Promise<{ code: string }> {
    // Devolve a espera embrulhada num objeto: uma função async que devolve a promise a adotaria, e a fila de
    // ações da sessão ficaria presa até o código chegar.
    const { waiting } = await this.serial(id, async (): Promise<{ waiting: Promise<string> }> => {
      // O código é gerado para um número: sem número na sessão nem no pedido, use o QR.
      if (!phone && !(await this.store.get(id)).phone) {
        throw new SessionError('VALIDATION_ERROR', 'informe o número para gerar o código de pareamento (ou conecte por QR)', 'phone')
      }
      const row = await this.prepareAuth(id)
      const pairingPhone = (phone ?? row.phone!).trim()
      let rt = this.runtimes.get(id)
      if (rt && rt.pairingPhone === pairingPhone && rt.pairingCode) return { waiting: Promise.resolve(rt.pairingCode) }
      if (rt && rt.pairingPhone !== pairingPhone) {
        await this.dispose(rt, 'local')
        rt = undefined
      }
      if (!rt) rt = await this.openRuntime(id, { pairingPhone, deferConnect: true })
      const pending = this.waitPairingCode(rt)
      // Sem handler, uma rejeição (timeout/close) antes do await abaixo viraria unhandled rejection.
      pending.catch(() => undefined)
      if (!rt.started) void this.startConnect(rt).catch(() => {})
      return { waiting: pending }
    })
    // A espera do código fica fora da fila de ações: um restart/logout não aguarda o prazo do pareamento.
    return { code: await waiting }
  }

  // ---- ações manuais ------------------------------------------------------------------

  pause(id: string): Promise<SessionView> {
    return this.serial(id, async () => {
      assertAction('pause', (await this.store.get(id)).status)
      return this.applyTransition(id, 'PAUSED')
    })
  }

  /** Resume é sempre manual: PAUSED → WARMING|STABLE. Reabre a conexão se não houver uma. */
  resume(id: string): Promise<SessionView> {
    return this.serial(id, async () => {
      const row = await this.store.get(id)
      assertAction('resume', row.status)
      const target = this.opts.resumeState ? await this.opts.resumeState(row) : 'WARMING'
      const view = await this.applyTransition(id, target)
      if (!this.runtimes.has(id)) await this.openForAction(id)
      return view
    })
  }

  /** Fecha e reabre a conexão sem mudar o estado; aplica a troca de proxy (limpa requires_restart). */
  restart(id: string): Promise<SessionView> {
    return this.serial(id, async () => {
      assertAction('restart', (await this.store.get(id)).status)
      const rt = this.runtimes.get(id)
      if (rt) await this.dispose(rt, 'local')
      await this.openForAction(id)
      return this.get(id)
    })
  }

  /** Desloga o dispositivo, apaga as credenciais e vai para DISCONNECTED. */
  logout(id: string): Promise<SessionView> {
    return this.serial(id, async () => {
      assertAction('logout', (await this.store.get(id)).status)
      const rt = this.runtimes.get(id)
      if (rt) {
        rt.closing = true
        if (rt.connected) {
          try {
            await rt.transport.logout()
          } catch (err) {
            this.log.warn({ session_id: id, err }, 'falha no logout do transporte')
          }
        }
        await this.dispose(rt, 'local')
      }
      const auth = rt?.auth ?? (await this.authState(id))
      await auth.clear()
      await this.store.recordHealthEvent(id, 'logged_out', { manual: true })
      return this.applyTransition(id, 'DISCONNECTED')
    })
  }

  /** Exclui a sessão: desvincula o aparelho (se conectado), fecha a conexão e apaga a sessão (cascata). */
  remove(id: string): Promise<{ deletedProxyId: string | null }> {
    return this.serial(id, async () => {
      await this.store.get(id)
      const rt = this.runtimes.get(id)
      if (rt) {
        rt.closing = true
        if (rt.connected) {
          try {
            await rt.transport.logout()
          } catch (err) {
            this.log.warn({ session_id: id, err }, 'falha no logout do transporte')
          }
        }
        await this.dispose(rt, 'local')
      }
      const result = await this.store.delete(id)
      this.log.info({ session_id: id }, 'sessão removida')
      return result
    })
  }

  /**
   * Sessão que caiu só porque o proxy ficou indisponível (último evento `proxy_unavailable`, credenciais intactas):
   * com o proxy de volta, reconecta sem QR e mantendo o aquecimento.
   */
  recoverAfterProxy(id: string): Promise<boolean> {
    return this.serial(id, async () => {
      if (this.stopped || this.runtimes.has(id)) return false
      const row = await this.store.find(id)
      if (!row || row.status !== 'DISCONNECTED' || !row.proxyId) return false
      if ((await this.store.lastHealthEventType(id)) !== 'proxy_unavailable') return false
      if (!(await this.store.hasCredentials(id))) return false
      this.log.info({ session_id: id }, 'proxy disponível de novo: reconectando sessão')
      try {
        await this.doStartQr(id)
      } catch (err) {
        if (err instanceof ProxyError && err.code === 'PROXY_UNAVAILABLE') return false
        throw err
      }
      return true
    })
  }

  // ---- internos -------------------------------------------------------------------------

  /** Executa `fn` depois das ações anteriores da mesma sessão (nunca em paralelo com elas). */
  private serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(id) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const settled = run.then(
      () => undefined,
      () => undefined,
    )
    this.ops.set(id, settled)
    this.track(settled)
    void settled.then(() => {
      if (this.ops.get(id) === settled) this.ops.delete(id)
    })
    return run
  }

  private async doStartQr(id: string): Promise<SessionView> {
    const row = await this.prepareAuth(id)
    const rt = this.runtimes.get(id)
    if (rt && !rt.pairingPhone) return toSessionView(row)
    if (rt) await this.dispose(rt, 'local')
    await this.openForAction(id)
    return this.get(id)
  }

  /**
   * Abre a conexão para uma ação manual. Proxy configurado e indisponível: a sessão já ficou DISCONNECTED sem
   * tentativa direta, e a ação rejeita com `ProxyUnavailableError` (o boot só registra, ver `start`).
   */
  private async openForAction(id: string): Promise<Runtime> {
    const rt = await this.openRuntime(id)
    if (rt.proxyError) throw rt.proxyError
    return rt
  }

  private async prepareAuth(id: string): Promise<SessionRow> {
    const row = await this.store.get(id)
    assertAction('connect', row.status)
    if (row.status !== 'DISCONNECTED') return row
    const res = await this.store.transition(id, 'NEW')
    this.emit('state', { sessionId: id, from: res.from, to: res.to })
    return res.row
  }

  private async applyTransition(id: string, to: SessionState, set?: TransitionOptions['set']): Promise<SessionView> {
    const res = await this.store.transition(id, to, set ? { set } : {})
    if (res.changed) {
      this.log.info({ session_id: id, from: res.from, to: res.to }, 'estado da sessão mudou')
      this.emit('state', { sessionId: id, from: res.from, to: res.to })
    }
    return toSessionView(res.row)
  }

  private async applyTransitionSafe(id: string, to: SessionState): Promise<void> {
    const row = await this.store.find(id)
    if (!row || row.status === to) return
    if (!canTransition(row.status, to)) {
      this.log.warn({ session_id: id, from: row.status, to }, 'transição inválida ignorada')
      return
    }
    await this.applyTransition(id, to)
  }

  private authState(id: string): Promise<PostgresAuthState> {
    if (this.opts.authStateFactory) return this.opts.authStateFactory(this.opts.db, id)
    return usePostgresAuthState(this.opts.db, id, this.opts.cipher ? { cipher: this.opts.cipher } : {})
  }

  private async openRuntime(id: string, o: { pairingPhone?: string; deferConnect?: boolean } = {}): Promise<Runtime> {
    const auth = await this.authState(id)
    const transport = this.opts.transportFactory(id)
    const rt: Runtime = {
      sessionId: id,
      transport,
      auth,
      connected: false,
      monitoring: false,
      failures: 0,
      closing: false,
      disposed: false,
      pairingWaiters: [],
      chain: Promise.resolve(),
      started: false,
      attempt: 0,
    }
    if (o.pairingPhone) rt.pairingPhone = o.pairingPhone
    this.runtimes.set(id, rt)
    this.wire(rt)
    if (!o.deferConnect) await this.startConnect(rt)
    return rt
  }

  private startConnect(rt: Runtime): Promise<void> {
    rt.started = true
    return this.enqueue(rt, () => this.connect(rt))
  }

  private isCurrent(rt: Runtime): boolean {
    return !rt.disposed && this.runtimes.get(rt.sessionId) === rt
  }

  private wire(rt: Runtime): void {
    const { transport, sessionId } = rt
    transport.on('qr', (raw) => {
      if (!this.isCurrent(rt)) return
      const dataUrl = toQrDataUrl(raw)
      dataUrl.catch((err) => this.log.error({ session_id: sessionId, err }, 'falha ao gerar o QR'))
      this.track(dataUrl)
      rt.qr = { raw, at: this.now(), dataUrl }
      this.emit('qr', { sessionId, qr: raw })
    })
    transport.on('pairing-code', (code) => {
      if (!this.isCurrent(rt)) return
      rt.pairingCode = code
      for (const w of rt.pairingWaiters.splice(0)) w.resolve(code)
      this.emit('pairing-code', { sessionId, code })
    })
    transport.on('connection', (u) => {
      if (!this.isCurrent(rt) || rt.closing) return
      if (u.state === 'open') void this.enqueue(rt, () => this.onOpen(rt)).catch(() => {})
      else void this.enqueue(rt, () => this.onClose(rt, u.reason ?? 'transient', u.statusCode)).catch(() => {})
    })
  }

  /** Serializa o tratamento de eventos da sessão (ordem open/close preservada). */
  private enqueue<T>(rt: Runtime, fn: () => Promise<T>): Promise<T> {
    const run = rt.chain.then(() => (this.isCurrent(rt) ? fn() : (undefined as T)))
    rt.chain = run.catch((err) => this.log.error({ session_id: rt.sessionId, err }, 'tarefa da sessão falhou'))
    this.track(rt.chain)
    return run
  }

  private track(p: Promise<unknown>): void {
    const tracked = p.then(
      () => undefined,
      () => undefined,
    )
    this.pending.add(tracked)
    void tracked.finally(() => this.pending.delete(tracked))
  }

  private async connect(rt: Runtime): Promise<void> {
    const { sessionId, transport, auth } = rt
    const before = await this.store.find(sessionId)
    try {
      await connectSession({
        db: this.opts.db,
        transport,
        sessionId,
        auth: auth.state,
        saveCreds: auth.saveCreds,
        ...(this.opts.cipher ? { cipher: this.opts.cipher } : {}),
        ...(rt.pairingPhone ? { pairingPhone: rt.pairingPhone } : {}),
      })
    } catch (err) {
      if (err instanceof ProxyError && err.code === 'PROXY_UNAVAILABLE') {
        // connectSession já marcou DISCONNECTED e NÃO chamou transport.connect (sem fallback direto).
        this.log.warn({ session_id: sessionId, err: err.message }, 'proxy indisponível: sessão desconectada')
        rt.proxyError = err
        await this.store.recordHealthEvent(sessionId, 'proxy_unavailable', { message: err.message })
        if (before && before.status !== 'DISCONNECTED') this.emit('state', { sessionId, from: before.status, to: 'DISCONNECTED' })
        await this.dispose(rt, 'local')
        return
      }
      if (err instanceof ProxyError && err.code === 'SESSION_NOT_FOUND') {
        await this.dispose(rt, 'local')
        throw err
      }
      this.log.warn({ session_id: sessionId, err }, 'falha ao conectar o transporte')
      await this.onClose(rt, 'transient', undefined, err)
      return
    }
    // A conexão usou o proxy atual do banco: a troca pendente foi aplicada.
    if (before?.requiresRestart && this.isCurrent(rt)) await this.store.update(sessionId, { requiresRestart: false })
    // Conta já vinculada: vigia a abertura. QR/pairing não são vigiados.
    if (auth.state.creds.registered || auth.state.creds.me?.id) this.watchConnect(rt)
  }

  /** Conta pareada cuja conexão não abre nem falha no prazo: a tentativa vira queda transitória (backoff normal). */
  private watchConnect(rt: Runtime): void {
    const attempt = ++rt.attempt
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.stopped || !this.isCurrent(rt) || rt.connected || rt.closing || rt.attempt !== attempt) return
      this.log.warn({ session_id: rt.sessionId, timeout_ms: this.connectTimeoutMs }, 'a conexão não abriu no prazo')
      void this.enqueue(rt, async () => {
        if (!this.isCurrent(rt) || rt.connected || rt.attempt !== attempt) return
        await this.onClose(rt, 'transient', undefined, new Error(`a conexão não abriu em ${this.connectTimeoutMs}ms`))
      }).catch(() => undefined)
    }, this.connectTimeoutMs)
    timer.unref?.()
    this.timers.set(timer, () => undefined)
  }

  private async onOpen(rt: Runtime): Promise<void> {
    const { sessionId } = rt
    rt.connected = true
    rt.failures = 0
    rt.qr = undefined
    // Persiste as credenciais (cifradas) assim que a conexão abre.
    await rt.auth.saveCreds()
    const now = this.now()
    const row = await this.store.get(sessionId)
    let state = row.status
    if (row.status === 'NEW') {
      const view = await this.applyTransition(sessionId, 'WARMING', { warmupStartedAt: row.warmupStartedAt ?? now, lastConnectedAt: now })
      state = view.status
    } else {
      await this.store.update(sessionId, { lastConnectedAt: now })
    }
    await this.store.recordHealthEvent(sessionId, 'connected', { state })
    // Cadastro por QR sem número (ou número errado): vale o número da conta que de fato conectou.
    const ownPhone = rt.transport.ownPhone()
    if (ownPhone && ownPhone !== row.phone) {
      await this.store.update(sessionId, { phone: ownPhone })
      if (row.phone) this.log.warn({ session_id: sessionId }, 'telefone da sessão trocado pelo da conta conectada')
    }
    this.log.info({ session_id: sessionId, state }, 'sessão conectada')
    const ctx: ConnectedContext = { sessionId, transport: rt.transport, state }
    rt.monitoring = true
    this.emit('connected', ctx)
    if (this.opts.onConnected) {
      try {
        await this.opts.onConnected(sessionId, ctx)
      } catch (err) {
        this.log.error({ session_id: sessionId, err }, 'hook onConnected falhou')
      }
    }
  }

  private async onClose(rt: Runtime, reason: DisconnectKind, statusCode?: number, error?: unknown): Promise<void> {
    const { sessionId } = rt
    const wasConnected = rt.connected
    rt.connected = false
    rt.attempt++ // a queda já foi tratada: o vigia da tentativa anterior não age mais
    await this.stopMonitoring(rt, reason, statusCode)
    const detail: Record<string, unknown> = { reason }
    if (statusCode !== undefined) detail.statusCode = statusCode
    if (error) detail.error = error instanceof Error ? error.message : String(error)

    if (reason === 'loggedOut') {
      await this.store.recordHealthEvent(sessionId, 'disconnected', detail)
      await this.dispose(rt, 'local')
      // Credenciais deslogadas não servem mais: nova autenticação exige QR/pareamento.
      await rt.auth.clear()
      await this.applyTransitionSafe(sessionId, 'DISCONNECTED')
      return
    }

    if (reason === 'forbidden') {
      // Sinal anormal (403): para a sessão; nunca reconecta sozinho (SPEC 1.4 nº 4).
      await this.store.recordHealthEvent(sessionId, 'forbidden_403', statusCode === undefined ? {} : { statusCode })
      await this.dispose(rt, 'local')
      const row = await this.store.find(sessionId)
      if (row && row.status !== 'PAUSED') await this.applyTransitionSafe(sessionId, canTransition(row.status, 'PAUSED') ? 'PAUSED' : 'DISCONNECTED')
      return
    }

    await this.store.recordHealthEvent(sessionId, 'disconnected', { ...detail, wasConnected })
    rt.failures += 1
    if (rt.failures > this.maxAttempts) {
      this.log.warn({ session_id: sessionId, attempts: rt.failures - 1 }, 'reconexões esgotadas')
      await this.store.recordHealthEvent(sessionId, 'reconnect_failed', { attempts: rt.failures - 1 })
      await this.dispose(rt, 'local')
      await this.applyTransitionSafe(sessionId, 'DISCONNECTED')
      return
    }
    const attempt = rt.failures
    const delayMs = this.backoff(attempt)
    this.log.info({ session_id: sessionId, attempt, delay_ms: delayMs }, 'reconexão agendada')
    this.emit('reconnect', { sessionId, attempt, delayMs })
    // A espera fica fora da fila da sessão; ao acordar, a reconexão só roda se o runtime ainda for o atual.
    this.track(
      this.sleep(delayMs).then(() => {
        if (this.isCurrent(rt) && !this.stopped) return this.enqueue(rt, () => this.connect(rt))
      }),
    )
  }

  private sleep(ms: number): Promise<void> {
    if (this.opts.sleep) return this.opts.sleep(ms)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.set(timer, resolve)
    })
  }

  private waitPairingCode(rt: Runtime): Promise<string> {
    const timeoutMs = this.opts.pairingTimeoutMs ?? DEFAULT_PAIRING_TIMEOUT_MS
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        rt.pairingWaiters = rt.pairingWaiters.filter((w) => w !== waiter)
        reject(new SessionManagerError('PAIRING_TIMEOUT', `código de pareamento não recebido em ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      const waiter: Waiter = {
        resolve: (code) => {
          clearTimeout(timer)
          resolve(code)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      }
      rt.pairingWaiters.push(waiter)
    })
  }

  private async stopMonitoring(rt: Runtime, reason: DisconnectedContext['reason'], statusCode?: number): Promise<void> {
    if (!rt.monitoring) return
    rt.monitoring = false
    const ctx: DisconnectedContext = statusCode === undefined ? { sessionId: rt.sessionId, reason } : { sessionId: rt.sessionId, reason, statusCode }
    this.emit('disconnected', ctx)
    if (this.opts.onDisconnected) {
      try {
        await this.opts.onDisconnected(rt.sessionId, ctx)
      } catch (err) {
        this.log.error({ session_id: rt.sessionId, err }, 'hook onDisconnected falhou')
      }
    }
  }

  private async dispose(rt: Runtime, reason: DisconnectedContext['reason']): Promise<void> {
    if (rt.disposed) return
    rt.closing = true
    await this.stopMonitoring(rt, reason)
    rt.disposed = true
    rt.connected = false
    if (this.runtimes.get(rt.sessionId) === rt) this.runtimes.delete(rt.sessionId)
    const closed = rt.proxyError ?? new SessionManagerError('CONNECTION_CLOSED', 'conexão encerrada antes do código de pareamento')
    for (const w of rt.pairingWaiters.splice(0)) w.reject(closed)
    try {
      await rt.transport.close()
    } catch (err) {
      this.log.warn({ session_id: rt.sessionId, err }, 'falha ao fechar o transporte')
    }
  }
}
