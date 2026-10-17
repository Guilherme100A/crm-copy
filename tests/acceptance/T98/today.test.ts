// AC-T98-01: contra um servidor RPC que simula SÓ os alvos que o ai-manager tem hoje, o gateway com perfil
// `ai-manager` (montado pelo caminho de produção, createWaGatewayFromEnv) passa a parte correspondente da suíte
// (sessions, cancel, groups) e marca o resto como capacidade ausente (CAPABILITY_NOT_SUPPORTED 501).
// Decisão do Orquestrador (spec/reports/T98-entrega.md): `send`/`sendGroup` dependem do alvo aditivo A8 — o
// `messages.enqueue` de hoje é a fila crua, sem os gates — então entram no "resto" e nunca podem usar `enqueue`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ADDITIVE_METHODS, REDIS_URL, TODAY_TARGETS, extensionEnv, rand, rejectionOf, rpcMod, rpcTesting, simulatorMod, startTodayServer, type TodayServer } from './support'

const TOKEN = `t98-acc-${rand(6)}`
const STREAM = `test:t98acc:today:${rand()}`

let server: TodayServer
let sim: any
const opened: Array<{ close(): Promise<void> }> = []

beforeAll(async () => {
  server = await startTodayServer(TOKEN)
  const { startAiManagerSimulator } = await simulatorMod()
  sim = await startAiManagerSimulator({ token: TOKEN })
})

afterAll(async () => {
  for (const g of opened) await g.close().catch(() => {})
  await server?.close()
  await sim?.close()
})

async function fromEnv(url: string) {
  const { createWaGatewayFromEnv } = await rpcMod()
  const created = createWaGatewayFromEnv(extensionEnv(url, TOKEN, STREAM), { redis: REDIS_URL })
  opened.push(created)
  return created
}

describe('AC-T98-01 ai-manager de hoje: sessions, cancel e groups funcionam pelo perfil', () => {
  it('AC-T98-01 WA_RPC_PROFILE=ai-manager é aceito e monta o gateway RPC sem chamar a rede', async () => {
    const { gatewayProfileNames } = await rpcMod()
    expect(gatewayProfileNames()).toContain('ai-manager')
    const before = server.calls.length
    const { mode, gateway } = await fromEnv(server.url)
    expect(mode).toBe('rpc')
    expect(gateway).toBeTruthy()
    expect(server.calls.length).toBe(before)
  })

  it('AC-T98-01 sessões: create, list, get, pause, resume, restart, logout e remove pelos alvos sessions.* de hoje', async () => {
    const { gateway } = await fromEnv(server.url)
    const s = await gateway.sessions.create({ name: 'Conexão T98' })
    expect(s).toMatchObject({ name: 'Conexão T98', status: 'NEW' })
    expect((await gateway.sessions.list()).map((x: any) => x.id)).toContain(s.id)
    expect((await gateway.sessions.get(s.id)).id).toBe(s.id)
    expect((await gateway.sessions.pause(s.id)).status).toBe('PAUSED')
    expect((await gateway.sessions.resume(s.id)).status).not.toBe('PAUSED')
    await gateway.sessions.startQr(s.id)
    await gateway.sessions.getQr(s.id)
    await gateway.sessions.restart(s.id)
    await gateway.sessions.logout(s.id)
    expect(await gateway.sessions.remove(s.id)).toEqual({ deletedProxyId: null })
    const err = await rejectionOf(gateway.sessions.get(s.id))
    expect(err.code ?? err.name).toMatch(/SESSION_NOT_FOUND|SessionError/)
    const used = server.calls.map((c) => `${c.target}.${c.method}`)
    for (const m of ['create', 'list', 'get', 'pause', 'resume', 'startQr', 'getQr', 'restart', 'logout', 'remove']) expect(used).toContain(`sessions.${m}`)
    expect(used.every((u) => TODAY_TARGETS.includes(u))).toBe(true)
  })

  it('AC-T98-01 groups: fetchGroups vai a sessions.fetchGroups e devolve os grupos da sessão', async () => {
    const { gateway } = await fromEnv(server.url)
    const s = await gateway.sessions.create({ name: 'Grupos T98' })
    const groups = await gateway.fetchGroups(s.id)
    expect(groups).toEqual([expect.objectContaining({ id: '120363000000000099@g.us', name: 'Grupo T98' })])
    expect(server.calls.at(-1)).toMatchObject({ target: 'sessions', method: 'fetchGroups', args: [s.id] })
  })

  it('AC-T98-01 cancel: mensagem na fila vira cancelled via messages.cancel; inexistente rejeita', async () => {
    const { gateway } = await fromEnv(server.url)
    const s = await gateway.sessions.create({ name: 'Cancel T98' })
    const id = server.seedQueued(s.id)
    const cancelled = await gateway.cancel(id)
    expect(cancelled).toMatchObject({ id, status: 'cancelled' })
    expect(server.calls.at(-1)).toMatchObject({ target: 'messages', method: 'cancel', args: [id] })
    await expect(gateway.cancel(id)).rejects.toBeTruthy() // já cancelada
    await expect(gateway.cancel('00000000-0000-4000-8000-000000000000')).rejects.toBeTruthy()
  })
})

describe('AC-T98-01 ai-manager de hoje: o resto é capacidade ausente', () => {
  it('AC-T98-01 send, sendGroup, downloadMedia, presence, listContacts, recordConsent e optOut → CAPABILITY_NOT_SUPPORTED 501', async () => {
    const { gateway } = await fromEnv(server.url)
    const s = await gateway.sessions.create({ name: 'Ausentes T98' })
    const calls: Record<string, () => Promise<unknown>> = {
      send: () => gateway.send({ sessionId: s.id, phone: '+5511999990001', content: { type: 'text', text: 'oi' }, actor: 'crm:user-t98' }),
      sendGroup: () => gateway.sendGroup({ sessionId: s.id, groupId: '120363000000000099@g.us', content: { type: 'text', text: 'oi' }, actor: 'crm:user-t98' }),
      downloadMedia: () => gateway.downloadMedia(s.id, { message_id: 'X', mime: 'image/png', key: 'k' }),
      presence: () => gateway.presence(s.id, '+5511999990001', 'composing'),
      listContacts: () => gateway.listContacts(s.id),
      recordConsent: () => gateway.recordConsent({ phone: '+5511999990001', source: 'manual' }),
      optOut: () => gateway.optOut({ phone: '+5511999990001' }),
    }
    expect(Object.keys(calls).sort()).toEqual([...ADDITIVE_METHODS].sort())
    for (const [method, call] of Object.entries(calls)) {
      const err = await rejectionOf(call())
      expect(err?.name, method).toBe('CapabilityNotSupportedError')
      expect(err?.code, method).toBe('CAPABILITY_NOT_SUPPORTED')
      expect(err?.status, method).toBe(501)
    }
  })

  it('AC-T98-01 depois da detecção, o método ausente falha sem tocar a rede e nunca usa messages.enqueue', async () => {
    const { gateway } = await fromEnv(server.url)
    const s = await gateway.sessions.create({ name: 'Sem rede T98' })
    await rejectionOf(gateway.presence(s.id, '+5511999990001', 'composing')) // dispara a sonda
    const before = server.calls.length
    for (let i = 0; i < 2; i++) {
      const err = await rejectionOf(gateway.send({ sessionId: s.id, phone: '+5511999990001', content: { type: 'text', text: 'oi' }, actor: 'crm:user-t98' }))
      expect(err.code).toBe('CAPABILITY_NOT_SUPPORTED')
      await rejectionOf(gateway.listContacts(s.id))
      await rejectionOf(gateway.optOut({ phone: '+5511999990001' }))
    }
    expect(server.calls.length).toBe(before)
    expect(server.calls.some((c) => c.target === 'messages' && c.method === 'enqueue')).toBe(false)
  })

  it('AC-T98-01 react/deleteForEveryone → 501 sem rede; markRead e profile ficam fora do gateway', async () => {
    const { gateway } = await fromEnv(server.url)
    const before = server.calls.length
    const target = { sessionId: 's', phone: '+5511999990001', messageId: 'm', actor: 'crm:user-t98' }
    for (const call of [() => gateway.react({ ...target, emoji: '👍' }), () => gateway.deleteForEveryone(target)]) {
      const err = await rejectionOf(call())
      expect(err.code).toBe('CAPABILITY_NOT_SUPPORTED')
      expect(err.status).toBe(501)
    }
    expect(server.calls.length).toBe(before)
    expect(gateway.markRead).toBeUndefined()
    expect(gateway.profile).toBeUndefined()
    const caps = await gateway.capabilities
    for (const v of Object.values(caps)) expect(typeof v).toBe('boolean')
  })

  it('AC-T98-01 relatório de detecção: aditivos em missing e mudanças A3, A7, A8 pendentes', async () => {
    const { gateway } = await fromEnv(server.url)
    const report = await gateway.capabilityReport()
    for (const m of ADDITIVE_METHODS) expect(report.missing).toContain(m)
    for (const m of ['sessions.create', 'sessions.list', 'cancel', 'fetchGroups']) expect(report.supported).toContain(m)
    expect(report.missingChanges).toEqual(['A3', 'A7', 'A8'])
  })

  it('AC-T98-01 o simulador entregue (modo hoje) expõe só alvos que o ai-manager tem', async () => {
    expect(sim.targets.length).toBeGreaterThan(0)
    for (const t of sim.targets) expect(TODAY_TARGETS, `alvo a mais no simulador: ${t}`).toContain(t)
    const { gateway } = await fromEnv(sim.url)
    const report = await gateway.capabilityReport()
    expect(report.missingChanges).toEqual(['A3', 'A7', 'A8'])
  })
})

// A parte da suíte de contrato da wa-port (T03) que o ai-manager de hoje cobre, contra o simulador entregue e o
// gateway de produção. Os testes fora do subconjunto ficam `skip` por desenho (opção `only`), por isso este bloco não
// leva o ID do AC no título; uma falha aqui reprova a execução vitest do verify.
const { defineWaGatewayContract } = await import('@crm/wa-port/contract')
defineWaGatewayContract(
  'T98 subconjunto da suíte contra o ai-manager de hoje',
  async () => {
    const { createWorkerContractHarness } = await rpcTesting()
    const { gateway } = await fromEnv(sim.url)
    return createWorkerContractHarness({ gateway, url: sim.url, token: TOKEN, blobStore: sim.blobStore, eventTimeoutMs: 5000 })
  },
  { only: ['capabilities', 'sessions', 'cancel', 'groups'] },
)
