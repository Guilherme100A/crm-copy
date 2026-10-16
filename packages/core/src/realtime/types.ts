// Tipos do realtime (SPEC 3.7): streams por empresa/usuário no Redis + fan-out por pub/sub entre réplicas da API.
import type { MemberRole } from '@crm/db'
import type { redisConnection } from '@crm/node-kit'

/** Cliente ioredis (`redisConnection()` do @crm/node-kit). */
export type RealtimeRedis = ReturnType<typeof redisConnection>

/** Prefixo das chaves: `crm:rt:<companyId>`, `crm:rt:user:<userId>` e o canal de fan-out `crm:rt`. */
export const DEFAULT_REALTIME_PREFIX = 'crm:rt'
/** Retenção aproximada por stream (`XADD … MAXLEN ~ 10000`). */
export const DEFAULT_REALTIME_MAXLEN = 10_000
/** Heartbeat do SSE (`event: ping`), SPEC 3.7. */
export const DEFAULT_HEARTBEAT_MS = 20_000

/**
 * Escopo de chat do evento (SPEC 3.3 `chatScope`): conexão e departamento do chat.
 * Módulos podem acrescentar chaves; os `ScopeFilter`s registrados decidem quem recebe.
 */
export interface RealtimeScope {
  connection_id?: string | null
  department_id?: string | null
  [key: string]: unknown
}

export interface PublishOptions {
  scope?: RealtimeScope
  /** Evento só para este usuário (stream `crm:rt:user:<userId>`), ainda filtrado pela empresa. */
  userId?: string
}

/** Envelope no fio (igual ao `RealtimeEnvelope` de @crm/shared, sem exigir o tipo do catálogo). */
export interface WireEnvelope {
  id: string
  type: string
  company_id: string
  at: string
  data: unknown
}

/** Evento como circula entre as réplicas e no replay. */
export interface RealtimeEvent {
  stream: string
  envelope: WireEnvelope
  scope: RealtimeScope | null
  userId: string | null
}

/** Mensagens de controle no canal de fan-out (logout, remoção de acesso). */
export type RealtimeControl = { kind: 'end_session'; sessionId: string } | { kind: 'end_user'; userId: string }

/** Quem está conectado, para os filtros de escopo. */
export interface ScopeSubject {
  companyId: string
  userId: string
  role: MemberRole
  permissionKeys: string[] | null
}

export const realtimeKeys = (prefix = DEFAULT_REALTIME_PREFIX) => ({
  company: (companyId: string) => `${prefix}:${companyId}`,
  user: (userId: string) => `${prefix}:user:${userId}`,
  channel: prefix,
})
