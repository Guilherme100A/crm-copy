// Regras puras da tela de conexões: search params, limite (AC-T71-05), validação replicada do servidor (nome 2–100,
// telefone DDI+número `^[1-9]\d{6,14}$`, proxy), ações disponíveis por status/permissão (08 §4) e o patch do cache
// pelos eventos `connection.*` (AC-T71-02).
import { z } from 'zod'
import {
  CONNECTION_STATUSES,
  PROXY_PROTOCOLS,
  type ConnectionDto,
  type ConnectionLimits,
  type ConnectionsPage,
  type ConnectionStatus,
  type ProxyInput,
  type ProxyProtocol,
} from './api'

export const connectionsSearchSchema = z.object({
  search: z.string().max(200).optional().catch(undefined),
  filter: z.enum(CONNECTION_STATUSES).optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
})
export type ConnectionsSearch = z.infer<typeof connectionsSearchSchema>

/** Limite definido e atingido (sem limite, `connections: null`, nunca bloqueia). */
export function limitReached(limits: ConnectionLimits | undefined): boolean {
  return !!limits && limits.connections !== null && limits.used >= limits.connections
}

export const NAME_MIN = 2
export const NAME_MAX = 100
export const PAIRING_PHONE_RE = /^[1-9]\d{6,14}$/

export function nameIssue(name: string): 'required' | 'length' | null {
  const n = name.trim()
  if (!n) return 'required'
  return n.length < NAME_MIN || n.length > NAME_MAX ? 'length' : null
}

/** Só dígitos (tolera `+`, espaços, traços e parênteses digitados). */
export const phoneDigits = (v: string) => v.replace(/\D+/g, '')
export const phoneValid = (v: string) => PAIRING_PHONE_RE.test(phoneDigits(v))

export interface ProxyDraft {
  protocol: ProxyProtocol
  host: string
  port: string
  username: string
  /** Vazia mantém a senha salva no servidor. */
  password: string
  /** Apaga a senha salva (`remove_password: true`), só quando nenhuma senha nova foi digitada. */
  removePassword: boolean
}

export function proxyDraftOf(c: Pick<ConnectionDto, 'proxy'>): ProxyDraft {
  const p = c.proxy
  return {
    protocol: p?.protocol ?? 'http',
    host: p?.host ?? '',
    port: p ? String(p.port) : '',
    username: p?.username ?? '',
    password: '',
    removePassword: false,
  }
}

export type ProxyIssues = Partial<Record<'protocol' | 'host' | 'port', 'required' | 'invalid'>>

export function proxyIssues(d: ProxyDraft): ProxyIssues {
  const out: ProxyIssues = {}
  if (!(PROXY_PROTOCOLS as readonly string[]).includes(d.protocol)) out.protocol = 'invalid'
  const host = d.host.trim()
  if (!host) out.host = 'required'
  else if (host.length > 253 || /\s/.test(host)) out.host = 'invalid'
  const port = Number(d.port)
  if (!d.port.trim()) out.port = 'required'
  else if (!Number.isInteger(port) || port < 1 || port > 65535) out.port = 'invalid'
  return out
}

export function proxyInputOf(d: ProxyDraft): ProxyInput {
  return {
    protocol: d.protocol,
    host: d.host.trim(),
    port: Number(d.port),
    ...(d.username.trim() ? { username: d.username.trim() } : {}),
    ...(d.password ? { password: d.password } : d.removePassword ? { remove_password: true } : {}),
  }
}

export type ConnectionAction =
  | 'connect'
  | 'resume'
  | 'disconnect'
  | 'restart'
  | 'rename'
  | 'proxy'
  | 'instance'
  | 'paused-flows'
  | 'stop-flows'
  | 'delete'

export interface ConnectionPerms {
  canEdit: boolean
  canDelete: boolean
  canRunFlows: boolean
}

const CONNECTABLE: readonly ConnectionStatus[] = ['pending', 'connecting', 'disconnected', 'banned']

/** Ações do menu da linha, na ordem de exibição (08 §4 adaptado ao Baileys). */
export function actionsFor(c: ConnectionDto, perms: ConnectionPerms): ConnectionAction[] {
  const out: ConnectionAction[] = []
  const scheduled = !!c.scheduled_for_deletion_at
  if (perms.canEdit && !scheduled) {
    if (CONNECTABLE.includes(c.status)) out.push('connect')
    if (c.status === 'paused') out.push('resume')
    if (c.status === 'connected' || c.status === 'paused') out.push('disconnect')
    if (c.status === 'connected' || c.requires_restart) out.push('restart')
  }
  if (perms.canEdit) out.push('rename', 'proxy', 'instance')
  if (perms.canRunFlows) {
    if ((c.paused_flows_count ?? 0) > 0) out.push('paused-flows')
    out.push('stop-flows')
  }
  if (perms.canDelete && !scheduled) out.push('delete')
  return out
}

export type ConnectionPatch = Partial<ConnectionDto> & { id: string }

/** Aplica o patch na página em cache; `null` se a conexão não está nela. */
export function patchPage(page: ConnectionsPage, patch: ConnectionPatch): ConnectionsPage | null {
  const i = page.items.findIndex((c) => c.id === patch.id)
  if (i < 0) return null
  const prev = page.items[i]!
  const next: ConnectionDto = { ...prev, ...patch }
  const items = [...page.items]
  items[i] = next
  const status_counts = { ...page.status_counts }
  if (prev.status !== next.status) {
    status_counts[prev.status] = Math.max(0, (status_counts[prev.status] ?? 0) - 1)
    status_counts[next.status] = (status_counts[next.status] ?? 0) + 1
  }
  return { ...page, items, status_counts }
}

/** Patch a partir do payload de um evento `connection.*` (só os campos que o evento traz). */
export function patchFromEvent(type: string, data: Record<string, unknown>): ConnectionPatch | null {
  const id = typeof data.connection_id === 'string' ? data.connection_id : null
  if (!id) return null
  const patch: ConnectionPatch = { id }
  if (type === 'connection.status_changed') {
    if (typeof data.status === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(data.status))
      patch.status = data.status as ConnectionStatus
    if (data.session_state !== undefined) patch.session_state = (data.session_state as string | null) ?? null
    if (data.connection_state !== undefined)
      patch.connection_state = (data.connection_state as 'open' | 'close' | null) ?? null
    if (Array.isArray(data.badges)) patch.badges = data.badges as ConnectionDto['badges']
  } else if (type === 'connection.connected') {
    patch.status = 'connected'
    patch.connection_state = 'open'
    if (typeof data.connected_at === 'string') patch.connected_at = data.connected_at
    if (typeof data.phone_number === 'string') patch.phone_number = data.phone_number
  } else if (type === 'connection.disconnected') {
    patch.connection_state = 'close'
    if (typeof data.status === 'string' && (CONNECTION_STATUSES as readonly string[]).includes(data.status))
      patch.status = data.status as ConnectionStatus
    if (typeof data.disconnected_at === 'string') patch.disconnected_at = data.disconnected_at
    if (typeof data.reason === 'string') patch.last_disconnect_reason = data.reason
  } else return null
  return patch
}
