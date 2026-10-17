// `createWaGatewayFromEnv` com os dois perfis (T98): `crm` continua o gateway RPC de sempre (sem sonda);
// `ai-manager` monta o gateway síncrono com detecção preguiçosa na primeira chamada de um método aditivo.
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createWaGatewayFromEnv } from '../../config'
import { crmProfile } from '../../profiles'
import type { FetchLike } from '../../rpc-client'
import type { LazyAiManagerGateway } from './detect'
import { startAiManagerSimulator, type AiManagerSimulator } from './testing/simulator'

const TOKEN = `t98-${randomBytes(6).toString('hex')}`
const actor = 'crm:t98'
const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
const envFor = (profile: string, url: string) => ({
  WA_GATEWAY: 'rpc',
  WA_RPC_PROFILE: profile,
  WA_RPC_URL: url,
  INTERNAL_TOKEN: TOKEN,
})
const rpcs = (sim: AiManagerSimulator, from = 0) => sim.calls.slice(from).map((c) => `${c.target}.${c.method}`)

let today: AiManagerSimulator
let full: AiManagerSimulator

beforeAll(async () => {
  today = await startAiManagerSimulator({ token: TOKEN })
  full = await startAiManagerSimulator({ token: TOKEN, additive: true })
})

afterAll(async () => {
  await today?.close()
  await full?.close()
})

/** Sessão conectada no simulador (startQr → controle fake `open`). */
async function connected(sim: AiManagerSimulator, gateway: LazyAiManagerGateway): Promise<string> {
  const s = await gateway.sessions.create({ name: `t98-${randomBytes(2).toString('hex')}` })
  await gateway.sessions.startQr(s.id)
  await fetch(`${sim.url}/internal/fake/sessions/${s.id}/open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  return s.id
}

describe('createWaGatewayFromEnv por perfil', () => {
  it('perfil crm: mesmo gateway de antes — send vai direto a messages.enqueue, sem sonda', async () => {
    const seen: string[] = []
    const fetchSpy: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body) as { target: string; method: string }
      seen.push(`${body.target}.${body.method}`)
      return { status: 200, json: async () => ({ result: { id: 'm1', status: 'queued' } }) }
    }
    const built = createWaGatewayFromEnv(envFor('crm', 'http://127.0.0.1:1'), { fetch: fetchSpy })
    try {
      expect(built.rpc?.gatewayProfile).toBe(crmProfile)
      expect('capabilityReport' in built.rpc!).toBe(false)
      await built.gateway.send({ sessionId: 's', phone: phone(), content: { text: 'x' }, actor })
      expect(seen).toEqual(['messages.enqueue'])
    } finally {
      await built.close()
    }
  })

  it('perfil ai-manager: síncrono, sem rede ao montar; sessões não esperam a sonda', async () => {
    const before = today.calls.length
    const built = createWaGatewayFromEnv(envFor('ai-manager', today.url))
    try {
      expect(built.rpc?.gatewayProfile.name).toBe('ai-manager')
      expect(today.calls.length).toBe(before)
      await built.gateway.sessions.list()
      expect(rpcs(today, before)).toEqual(['sessions.list'])
    } finally {
      await built.close()
    }
  })

  it('perfil ai-manager: a 1ª chamada aditiva dispara a sonda uma vez; depois o ausente falha sem rede', async () => {
    const built = createWaGatewayFromEnv(envFor('ai-manager', today.url))
    const gateway = built.rpc as LazyAiManagerGateway
    try {
      const before = today.calls.length
      const req = { sessionId: 's', phone: phone(), content: { text: 'x' }, actor }
      await expect(gateway.send(req)).rejects.toMatchObject({
        name: 'CapabilityNotSupportedError',
        method: 'send',
        remote: false,
        status: 501,
      })
      const probes = rpcs(today, before)
      expect(probes).toHaveLength(7)
      expect(probes).not.toContain('messages.enqueue')
      const afterProbe = today.calls.length
      await expect(gateway.send(req)).rejects.toMatchObject({ name: 'CapabilityNotSupportedError', remote: false })
      await expect(gateway.presence('s', phone(), 'composing')).rejects.toMatchObject({
        name: 'CapabilityNotSupportedError',
        method: 'presence',
      })
      expect(today.calls.length).toBe(afterProbe)
      expect((await gateway.capabilityReport()).missingChanges).toEqual(['A3', 'A7', 'A8'])
      expect(today.calls.length).toBe(afterProbe)
    } finally {
      await built.close()
    }
  })

  it('perfil ai-manager com os alvos aditivos: envio pelo pipeline funciona depois da sonda', async () => {
    const built = createWaGatewayFromEnv(envFor('ai-manager', full.url))
    const gateway = built.rpc as LazyAiManagerGateway
    try {
      const sessionId = await connected(full, gateway)
      const p = phone()
      await gateway.recordConsent({ phone: p, source: 'manual', actor })
      expect(await gateway.send({ sessionId, phone: p, content: { text: 'oi' }, actor })).toMatchObject({
        sessionId,
        phone: p,
        status: 'queued',
      })
      expect((await gateway.capabilityReport()).missingChanges).toEqual([])
    } finally {
      await built.close()
    }
  })

  it('perfil ai-manager: sonda que falha (token recusado) propaga e é refeita na próxima chamada', async () => {
    let attempts = 0
    const counting: FetchLike = (url, init) => {
      attempts++
      return fetch(url, init)
    }
    const built = createWaGatewayFromEnv(
      { ...envFor('ai-manager', today.url), INTERNAL_TOKEN: 'errado' },
      { fetch: counting },
    )
    const gateway = built.rpc as LazyAiManagerGateway
    try {
      const before = today.calls.length
      await expect(gateway.listContacts('s')).rejects.toMatchObject({
        name: 'WorkerUnavailableError',
        reason: 'unauthorized',
      })
      const first = attempts
      expect(first).toBeGreaterThan(0)
      await expect(gateway.listContacts('s')).rejects.toMatchObject({ name: 'WorkerUnavailableError' })
      expect(attempts).toBeGreaterThan(first)
      // 401 não chega ao RPC do simulador: nada registrado como chamada.
      expect(today.calls.length).toBe(before)
    } finally {
      await built.close()
    }
  })
})
