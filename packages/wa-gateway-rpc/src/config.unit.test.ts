// Montagem a partir do ambiente (WA_GATEWAY=rpc|fake).
import { FakeWaGateway } from '@crm/wa-port/testing'
import { describe, expect, it } from 'vitest'
import { createWaGatewayFromEnv, loadWaGatewayConfig, WaGatewayConfigError } from './config'
import type { FetchLike } from './rpc-client'

describe('loadWaGatewayConfig', () => {
  it('padrão fake; rpc exige WA_RPC_URL e INTERNAL_TOKEN; perfil e stream com padrões', () => {
    expect(loadWaGatewayConfig({}).mode).toBe('fake')
    expect(() => loadWaGatewayConfig({ WA_GATEWAY: 'rpc' })).toThrow(/WA_RPC_URL e INTERNAL_TOKEN/)
    expect(() => loadWaGatewayConfig({ WA_GATEWAY: 'rpc', WA_RPC_URL: 'http://w:3100' })).toThrow(/INTERNAL_TOKEN/)
    expect(loadWaGatewayConfig({ WA_GATEWAY: 'RPC', WA_RPC_URL: 'http://w:3100', INTERNAL_TOKEN: 't' })).toMatchObject({
      mode: 'rpc',
      url: 'http://w:3100',
      token: 't',
      profile: 'crm',
      stream: 'wsm:events',
    })
  })

  it('valores inválidos falham com WaGatewayConfigError', () => {
    const rpc = { WA_GATEWAY: 'rpc', WA_RPC_URL: 'http://w:3100', INTERNAL_TOKEN: 't' }
    expect(() => loadWaGatewayConfig({ WA_GATEWAY: 'local' })).toThrow(WaGatewayConfigError)
    expect(() => loadWaGatewayConfig({ ...rpc, WA_RPC_URL: 'não-url' })).toThrow(/WA_RPC_URL/)
    expect(() => loadWaGatewayConfig({ ...rpc, WA_RPC_PROFILE: 'outro' })).toThrow(/WA_RPC_PROFILE desconhecido: outro/)
    expect(() => loadWaGatewayConfig({ ...rpc, WA_RPC_TIMEOUT_MS: '0' })).toThrow(/WA_RPC_TIMEOUT_MS/)
    expect(loadWaGatewayConfig({ ...rpc, WA_RPC_TIMEOUT_MS: '1500' }).timeoutMs).toBe(1500)
  })
})

describe('createWaGatewayFromEnv', () => {
  it('fake → FakeWaGateway', async () => {
    const r = createWaGatewayFromEnv({ WA_GATEWAY: 'fake' })
    expect(r.mode).toBe('fake')
    expect(r.gateway).toBeInstanceOf(FakeWaGateway)
    expect(r.rpc).toBeUndefined()
    await r.close()
  })

  it('rpc → gateway RPC com perfil crm apontando para WA_RPC_URL', async () => {
    const urls: string[] = []
    const fetch: FetchLike = async (url) => {
      urls.push(url)
      return { status: 200, json: async () => ({ result: [] }) }
    }
    const r = createWaGatewayFromEnv({ WA_GATEWAY: 'rpc', WA_RPC_URL: 'http://worker:3100', INTERNAL_TOKEN: 't', REDIS_URL: 'redis://127.0.0.1:6379/1' }, { fetch })
    expect(r.mode).toBe('rpc')
    expect(r.rpc?.gatewayProfile.name).toBe('crm')
    expect(await r.gateway.sessions.list()).toEqual([])
    expect(urls).toEqual(['http://worker:3100/internal/rpc'])
    await r.close()
  })
})
