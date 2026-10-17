import { describe, expect, it } from 'vitest'
import { decisionBody, redirectHost } from './api'

describe('consentimento OAuth MCP (T115)', () => {
  const req = { request_id: 'r1', company: { id: 'c1', name: 'Empresa' } }

  it('aprovar confirma a empresa da credencial; negar não envia empresa', () => {
    expect(decisionBody(req, true)).toEqual({ request: 'r1', company_id: 'c1', approve: true })
    expect(decisionBody(req, false)).toEqual({ request: 'r1', approve: false })
  })

  it('mostra só o host do redirect_uri', () => {
    expect(redirectHost('https://claude.ai/api/mcp/auth_callback')).toBe('claude.ai')
    expect(redirectHost('não é url')).toBe('não é url')
  })
})
