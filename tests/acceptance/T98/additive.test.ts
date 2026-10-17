// AC-T98-02: com os alvos aditivos simulados (send A8, media/presence A3, contacts A7, outbox de eventos A1), a suíte
// de contrato inteira da wa-port passa contra o simulador do ai-manager, com o gateway montado pelo caminho de
// produção (createWaGatewayFromEnv, WA_RPC_PROFILE=ai-manager). Stream de eventos único por arquivo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADDITIVE_METHODS, REDIS_URL, extensionEnv, rand, rpcMod, rpcTesting, simulatorMod } from './support'

const TOKEN = `t98-acc-${rand(6)}`
const STREAM = `test:t98acc:full:${rand()}`

let redis: any
let sim: any
const opened: Array<{ close(): Promise<void> }> = []

beforeAll(async () => {
  const { redisConnection }: any = await import('@crm/node-kit')
  redis = redisConnection({ url: REDIS_URL })
  const { startAiManagerSimulator } = await simulatorMod()
  sim = await startAiManagerSimulator({ token: TOKEN, additive: true, redis, stream: STREAM })
})

afterAll(async () => {
  for (const g of opened) await g.close().catch(() => {})
  await sim?.close()
  await redis?.del(STREAM).catch(() => {})
  await redis?.quit().catch(() => {})
})

async function fromEnv() {
  const { createWaGatewayFromEnv } = await rpcMod()
  const created = createWaGatewayFromEnv(extensionEnv(sim.url, TOKEN, STREAM), { redis: REDIS_URL })
  opened.push(created)
  return created.gateway
}

async function harness() {
  const { createWorkerContractHarness } = await rpcTesting()
  const gateway = await fromEnv()
  const h = createWorkerContractHarness({ gateway, url: sim.url, token: TOKEN, blobStore: sim.blobStore, eventTimeoutMs: 8000 })
  return {
    ...h,
    // O inbound nasce no "lado WhatsApp" do simulador e chega ao CRM pelo outbox (A1), não por XADD do teste.
    async injectInbound(sessionId: string, message: { id: string; from: string; text: string }) {
      const res = await fetch(`${sim.url}/internal/fake/sessions/${sessionId}/receive`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
      if (!res.ok) throw new Error(`simulador: receive → HTTP ${res.status}`)
    },
  }
}

const { defineWaGatewayContract, WA_GATEWAY_CONTRACT_TESTS } = await import('@crm/wa-port/contract')

// Sem `only`/`skip`: a suíte inteira (todos os testes registrados) roda e passa.
defineWaGatewayContract('AC-T98-02 suíte inteira contra o ai-manager com A1/A3/A7/A8', harness)

describe('AC-T98-02 aditivos fora da suíte', () => {
  it('AC-T98-02 a suíte rodou inteira: todo grupo da suíte, inclusive send, media e events, está no registro', () => {
    const groups = new Set(Object.values(WA_GATEWAY_CONTRACT_TESTS).flat())
    for (const g of ['sessions', 'send', 'contacts', 'sendGroup', 'cancel', 'groups', 'media', 'events']) expect(groups).toContain(g)
  })

  it('AC-T98-02 detecção: nenhum método aditivo ausente e nenhuma mudança pendente', async () => {
    const gateway: any = await fromEnv()
    const report = await gateway.capabilityReport()
    for (const m of ADDITIVE_METHODS) expect(report.supported).toContain(m)
    expect(report.missingChanges).toEqual([])
  })

  async function connected(gateway: any) {
    const h: any = await harness()
    const s = await gateway.sessions.create({ name: `Aditivo ${rand()}` })
    await h.connect(s.id)
    return s.id as string
  }

  it('AC-T98-02 presence vai a presence.update e chega ao worker', async () => {
    const gateway: any = await fromEnv()
    const sessionId = await connected(gateway)
    await gateway.presence(sessionId, '+5511999990002', 'composing')
    expect(sim.presences).toContainEqual({ sessionId, to: '+5511999990002', kind: 'composing' })
  })

  it('AC-T98-02 listContacts devolve a agenda da sessão (contacts.list)', async () => {
    const gateway: any = await fromEnv()
    const sessionId = await connected(gateway)
    const list = await gateway.listContacts(sessionId)
    expect(list.length).toBeGreaterThan(0)
    expect(list[0]).toEqual(expect.objectContaining({ jid: expect.any(String), phone: expect.any(String) }))
  })

  it('AC-T98-02 recordConsent libera o send e optOut volta a bloquear (contacts.*, A7 + A8)', async () => {
    const gateway: any = await fromEnv()
    const sessionId = await connected(gateway)
    const phone = `+55119${Math.floor(10_000_000 + Math.random() * 89_999_999)}`
    const req = { sessionId, phone, content: { type: 'text', text: 'oi' }, actor: 'crm:user-t98' }
    await expect(gateway.send(req)).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403 })
    await gateway.recordConsent({ phone, source: 'manual' })
    expect(await gateway.send(req)).toMatchObject({ sessionId, phone, status: 'queued' })
    await gateway.optOut({ phone })
    await expect(gateway.send(req)).rejects.toMatchObject({ code: 'CONTACT_NOT_ALLOWED', status: 403 })
    expect(sim.calls.some((c: any) => c.target === 'messages' && c.method === 'enqueue')).toBe(false)
  })

  it('AC-T98-02 sendGroup para um grupo da sessão enfileira pela messages.sendGroup', async () => {
    const gateway: any = await fromEnv()
    const sessionId = await connected(gateway)
    const [group] = await gateway.fetchGroups(sessionId)
    const m = await gateway.sendGroup({ sessionId, groupId: group.id, content: { type: 'text', text: 'oi grupo' }, actor: 'crm:user-t98' })
    expect(m).toMatchObject({ sessionId, status: 'queued' })
    expect(sim.calls.some((c: any) => c.target === 'messages' && c.method === 'sendGroup')).toBe(true)
  })
})
