import { describe, expect, it } from 'vitest'
import { SETTINGS_TABS } from '../settings/tabs'
import { createBody, EXPIRATION_OPTIONS } from './api'

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
