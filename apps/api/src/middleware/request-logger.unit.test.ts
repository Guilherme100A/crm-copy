import { createLogger } from '@crm/node-kit'
import { Hono } from 'hono'
import { requestId } from 'hono/request-id'
import { describe, expect, it } from 'vitest'
import type { AppEnv } from '../lib/types'
import { logPath, requestLogger } from './request-logger'

describe('logPath', () => {
  it('mascara o token de /api/hooks/in/<token>; mantém o resto', () => {
    expect(logPath('/api/hooks/in/abcDEF123_secretTokenValue-0123456789xyz')).toBe('/api/hooks/in/***')
    expect(logPath('/api/hooks/in/x/y')).toBe('/api/hooks/in/***/***')
    expect(logPath('/api/hooks/payments/xpag/00000000-0000-4000-8000-000000000000')).toBe('/api/hooks/payments/xpag/00000000-0000-4000-8000-000000000000')
    expect(logPath('/api/hooks/sales/aVeryLongOpaqueTokenValue1234567890')).toBe('/api/hooks/sales/***')
    expect(logPath('/api/contacts/abc')).toBe('/api/contacts/abc')
  })

  it('o log de acesso de um POST em /api/hooks/in/<token> não contém o token', async () => {
    const lines: string[] = []
    const logger = createLogger({ level: 'info', destination: { write: (s: string) => void lines.push(s) } as never })
    const app = new Hono<AppEnv>()
    app.use('*', requestId(), requestLogger(logger))
    app.post('/api/hooks/in/:token', (c) => c.json({ ok: true }, 202))
    const token = 'tok_secretoMuitoLongo_1234567890abcdefghijklmnop'
    const res = await app.request(`/api/hooks/in/${token}?x=1`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    const log = lines.join('\n')
    expect(log).toContain('"path":"/api/hooks/in/***"')
    expect(log).not.toContain(token)
  })
})
