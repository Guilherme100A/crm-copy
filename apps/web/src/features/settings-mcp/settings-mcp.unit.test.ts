import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '../settings/tabs'
import { createBody, EXPIRATION_OPTIONS, statusLabel } from './api'

describe('credenciais MCP (T94)', () => {
  it('corpo do POST: nome aparado, tipo static e expiração só quando escolhida', () => {
    expect(createBody('  Cursor ', 0)).toEqual({ mcp_credential: { name: 'Cursor', auth_type: 'static' } })
    expect(createBody('n8n', 90)).toEqual({ mcp_credential: { name: 'n8n', auth_type: 'static', expires_in_days: 90 } })
    expect(EXPIRATION_OPTIONS).toEqual([0, 30, 90, 365])
  })

  it('aba mcp_credentials registrada em integrações com settings.mcp.view', () => {
    expect(SETTINGS_TABS.find((x) => x.id === 'mcp_credentials')).toMatchObject({ group: 'integrations', labelKey: 'settings-mcp:tab', permissions: ['settings.mcp.view'] })
  })
})

describe('credenciais MCP OAuth (T115)', () => {
  it('corpo do POST do tipo oauth não leva expiração', () => {
    expect(createBody(' Claude ', 90, 'oauth')).toEqual({ mcp_credential: { name: 'Claude', auth_type: 'oauth' } })
  })

  it('status: "Conectada · <cliente>" quando há cliente OAuth; senão o rótulo do status', () => {
    const t = (key: string, vars?: Record<string, string>) => (vars ? `${key}:${vars.client}` : key)
    expect(statusLabel({ status: 'connected', connected_client_hint: 'Claude' }, t)).toBe('status.connectedWith:Claude')
    expect(statusLabel({ status: 'pending', connected_client_hint: null }, t)).toBe('status.pending')
    expect(statusLabel({ status: 'active' }, t)).toBe('status.active')
  })
})
