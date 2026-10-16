// Auditoria das mutações (SPEC 3.6): `crm.audit_logs` sem segredos (SPEC 1.4 #8).
import { auditLogs, type Database } from '@crm/db'
import { isSensitiveLogKey } from '@crm/node-kit'

export interface AuditEntry {
  companyId: string | null
  actorUserId: string | null
  action: string
  targetType?: string | null
  targetId?: string | null
  detail?: Record<string, unknown> | null
  ip?: string | null
}

const MAX_DEPTH = 8

/** Cópia do valor SEM as chaves sensíveis (password, token, secret, apiKey, creds…), em qualquer profundidade. */
export function stripSecrets<T>(value: T): T {
  return strip(value, 0, new WeakSet()) as T
}

function strip(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return undefined
  if (seen.has(value) || depth >= MAX_DEPTH) return undefined
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((v) => strip(v, depth + 1, seen)).filter((v) => v !== undefined)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      if (isSensitiveLogKey(k)) continue
      const s = strip(v, depth + 1, seen)
      if (s !== undefined) out[k] = s
    }
    return out
  } finally {
    seen.delete(value)
  }
}

export class AuditService {
  constructor(private readonly db: Database) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLogs).values({
      companyId: entry.companyId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      detail: entry.detail ? stripSecrets(entry.detail) : null,
      ip: entry.ip ?? null,
    })
  }
}
