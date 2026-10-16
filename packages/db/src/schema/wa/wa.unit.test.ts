import { getTableName, is } from 'drizzle-orm'
import { PgTable, getTableConfig } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as root from '../../index.js'
import * as tables from './tables/index.js'

const waTables = (Object.values(tables) as unknown[]).filter((v): v is PgTable => is(v, PgTable))

describe('schema wa', () => {
  it('tem as tabelas do ai-manager, todas em public', () => {
    expect(waTables.map((t) => getTableName(t)).sort()).toEqual(
      [
        'ai_settings',
        'audit_logs',
        'contacts',
        'health_events',
        'message_events',
        'messages',
        'proxies',
        'proxy_settings',
        'session_credentials',
        'session_limits',
        'session_links',
        'session_route_runs',
        'sessions',
        'suggestions',
        'webhooks',
      ].sort(),
    )
    for (const t of waTables) expect(getTableConfig(t).schema).toBeUndefined()
  })

  it('enums iguais aos do ai-manager', () => {
    expect(tables.SESSION_STATUSES).toEqual(['NEW', 'WARMING', 'STABLE', 'DEGRADED', 'PAUSED', 'DISCONNECTED'])
    expect(tables.MESSAGE_STATUSES).toEqual(['queued', 'processing', 'sent', 'delivered', 'read', 'failed', 'retrying', 'cancelled'])
  })

  it('a raiz de @crm/db expõe as tabelas wa só no objeto `wa` (sem colidir com o crm)', () => {
    expect(root.wa.sessions).toBe(tables.sessions)
    expect(root.wa.auditLogs).toBe(tables.auditLogs)
    expect(root.auditLogs).not.toBe(tables.auditLogs)
    expect(getTableConfig(root.auditLogs).schema).toBe('crm')
  })
})
