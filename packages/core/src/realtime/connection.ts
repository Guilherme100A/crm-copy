// Uma conexão SSE (independente do Hono): assina os streams da empresa e do usuário, faz o replay do
// Last-Event-ID sem lacuna nem duplicata, filtra por empresa/permissão/escopo, manda `ping` a cada heartbeat
// (reconferindo o acesso) e fecha no logout.
import { isRealtimeEventType, realtimeEventPermission } from '@crm/shared'
import type { AuthInfo, CompanyMember } from '../platform/types'
import type { RealtimeHub } from './hub'
import { passesScope } from './scope-filter'
import { compareStreamIds, isStreamId } from './stream-id'
import { DEFAULT_HEARTBEAT_MS, type RealtimeControl, type RealtimeEvent, type ScopeSubject } from './types'

export interface SseMessage {
  event: string
  data: string
  id?: string
  retry?: number
}

/** Retry sugerido ao EventSource (ms), mandado no primeiro frame. */
export const SSE_RETRY_MS = 3000
/** Evento que manda o cliente recarregar tudo (histórico do Last-Event-ID já descartado). */
export const RESYNC_EVENT = 'resync'
export const PING_EVENT = 'ping'
/** Tipo do evento que, para o próprio usuário, recarrega permissões da conexão. */
const PERMISSIONS_CHANGED = 'member.permissions_changed'

export type AccessCheck = () => Promise<{ member: CompanyMember | null; perms: ReadonlySet<string> } | null>

export interface RealtimeConnectionOptions {
  hub: RealtimeHub
  companyId: string
  userId: string | null
  auth: AuthInfo
  /** `null` = token de API (empresa inteira, sem escopo). */
  member: CompanyMember | null
  perms: ReadonlySet<string>
  lastEventId?: string | null
  heartbeatMs?: number
  /** Reconfere sessão e vínculo a cada heartbeat; `null` fecha o stream. Também recarrega permissões. */
  checkAccess?: AccessCheck
  send: (message: SseMessage) => Promise<void>
  onError?: (err: unknown) => void
}

export class RealtimeConnection {
  private readonly opts: RealtimeConnectionOptions
  private member: CompanyMember | null
  private perms: ReadonlySet<string>
  private lastId: string | null
  private chain: Promise<void> = Promise.resolve()
  private closedFlag = false
  private wake: (() => void) | null = null
  private finish!: () => void
  readonly done: Promise<void>
  private readonly cleanup: Array<() => void> = []

  constructor(opts: RealtimeConnectionOptions) {
    this.opts = opts
    this.member = opts.member
    this.perms = opts.perms
    this.lastId = isStreamId(opts.lastEventId) ? opts.lastEventId : null
    this.done = new Promise((resolve) => (this.finish = resolve))
  }

  get closed(): boolean {
    return this.closedFlag
  }

  /** Abre a assinatura, faz replay (se houver Last-Event-ID) e roda o heartbeat até fechar. */
  async run(): Promise<void> {
    const { hub, companyId, userId } = this.opts
    const streams = [hub.keys.company(companyId), ...(userId ? [hub.keys.user(userId)] : [])]
    await hub.start()

    // Assina ANTES do replay e segura os eventos ao vivo até o replay terminar (sem lacuna).
    let buffer: RealtimeEvent[] | null = []
    this.cleanup.push(
      hub.subscribe(streams, (ev) => (buffer ? buffer.push(ev) : this.enqueue(() => this.deliver(ev)))),
      hub.onControl((c) => this.onControl(c)),
    )

    this.enqueue(() => this.write({ event: PING_EVENT, data: '', retry: SSE_RETRY_MS }))
    if (this.lastId) {
      const from = this.lastId
      try {
        const { events, truncated } = await hub.replay(streams, from)
        if (truncated) this.enqueue(() => this.write({ event: RESYNC_EVENT, data: '' }))
        for (const ev of events) this.enqueue(() => this.deliver(ev))
      } catch (err) {
        this.opts.onError?.(err)
        this.enqueue(() => this.write({ event: RESYNC_EVENT, data: '' }))
      }
    }
    const pending = buffer
    buffer = null
    for (const ev of pending) this.enqueue(() => this.deliver(ev))

    await this.heartbeat()
    await this.done
  }

  /** Fecha o stream (idempotente). */
  close(): void {
    if (this.closedFlag) return
    this.closedFlag = true
    for (const off of this.cleanup.splice(0)) off()
    this.wake?.()
    this.finish()
  }

  private async heartbeat() {
    const every = this.opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    // Prazo fixo a partir do início (sem acumular atraso); a ping sai ANTES da consulta ao banco,
    // para a latência da reconferência não empurrar o intervalo além do heartbeat.
    let next = Date.now() + every
    while (!this.closedFlag) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, next - Date.now()))
        this.wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      this.wake = null
      if (this.closedFlag) break
      next += every
      if (next < Date.now()) next = Date.now() + every
      this.enqueue(() => this.write({ event: PING_EVENT, data: '' }))
      if (this.opts.checkAccess) {
        try {
          const access = await this.opts.checkAccess()
          if (!access) {
            this.close()
            break
          }
          this.member = access.member
          this.perms = access.perms
        } catch (err) {
          // Falha transitória de banco: mantém o stream e tenta no próximo heartbeat.
          this.opts.onError?.(err)
        }
      }
    }
  }

  private onControl(c: RealtimeControl) {
    if (c.kind === 'end_session' && this.opts.auth.kind === 'session' && c.sessionId === this.opts.auth.sessionId) this.close()
    if (c.kind === 'end_user' && this.opts.userId && c.userId === this.opts.userId) this.close()
  }

  private enqueue(task: () => Promise<void>) {
    this.chain = this.chain.then(() => (this.closedFlag ? undefined : task())).catch((err: unknown) => this.opts.onError?.(err))
  }

  private async write(message: SseMessage) {
    if (!this.closedFlag) await this.opts.send(message)
  }

  private async deliver(ev: RealtimeEvent) {
    const env = ev.envelope
    if (this.lastId && compareStreamIds(env.id, this.lastId) <= 0) return
    if (!(await this.allowed(ev))) return
    if (env.type === PERMISSIONS_CHANGED && this.opts.userId && (env.data as { user_id?: string } | null)?.user_id === this.opts.userId) {
      await this.refreshAccess()
    }
    this.lastId = env.id
    await this.write({ event: env.type, id: env.id, data: JSON.stringify(env) })
  }

  /** Filtro no servidor (SPEC 3.7): empresa, destinatário, permissão do tipo e escopo de chat. */
  private async allowed(ev: RealtimeEvent): Promise<boolean> {
    const env = ev.envelope
    if (env.company_id !== this.opts.companyId) return false
    if (ev.userId && ev.userId !== this.opts.userId) return false
    const perm = isRealtimeEventType(env.type) ? realtimeEventPermission(env.type) : null
    if (perm && !this.perms.has(perm)) return false
    return passesScope(this.subject(), ev.scope, env)
  }

  private subject(): ScopeSubject | null {
    if (!this.member || !this.opts.userId) return null
    return { companyId: this.opts.companyId, userId: this.opts.userId, role: this.member.role, permissionKeys: this.member.permissionKeys }
  }

  private async refreshAccess() {
    if (!this.opts.checkAccess) return
    try {
      const access = await this.opts.checkAccess()
      if (!access) return this.close()
      this.member = access.member
      this.perms = access.perms
    } catch (err) {
      this.opts.onError?.(err)
    }
  }
}
