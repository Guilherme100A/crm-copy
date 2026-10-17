// Perfil `ai-manager` e detecção de capacidades ausentes (AC-T98-01/02) contra o servidor RPC simulado do ai-manager.
import { randomBytes } from 'node:crypto'
import { isContractTestEnabled, WA_GATEWAY_CONTRACT_TESTS } from '@crm/wa-port/contract'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AI_MANAGER_ADDITIVE_ROUTES,
  aiManagerProfile,
  CapabilityNotSupportedError,
  createAiManagerGateway,
  createRpcGateway,
  createWaGatewayFromEnv,
  detectAiManagerCapabilities,
  gatewayProfileNames,
  loadWaGatewayConfig,
  routeOf,
  WorkerUnavailableError,
} from '../../index'
import { startAiManagerSimulator, type AiManagerSimulator } from './testing/simulator'

const TOKEN = `t98-${randomBytes(6).toString('hex')}`
const phone = () => `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
const actor = 'crm:t98'

/** Métodos que o ai-manager de hoje não tem: A3/A7/A8 + os que nem têm proposta. */
const ABSENT_TODAY = [
  'send',
  'sendGroup',
  'downloadMedia',
  'presence',
  'react',
  'deleteForEveryone',
  'listContacts',
  'recordConsent',
  'optOut',
  'markRead',
  'profile.get',
  'profile.setName',
  'profile.setStatus',
  'profile.setPicture',
  'capabilities',
]
const ABSENT_WITH_ADDITIVES = [
  'react',
  'deleteForEveryone',
  'markRead',
  'profile.get',
  'profile.setName',
  'profile.setStatus',
  'profile.setPicture',
  'capabilities',
]

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
async function connect(
  sim: AiManagerSimulator,
  gateway: {
    sessions: { create(i: { name: string }): Promise<{ id: string }>; startQr(id: string): Promise<unknown> }
  },
) {
  const s = await gateway.sessions.create({ name: `t98-${randomBytes(2).toString('hex')}` })
  await gateway.sessions.startQr(s.id)
  const res = await fetch(`${sim.url}/internal/fake/sessions/${s.id}/open`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  expect(res.ok).toBe(true)
  return s.id
}

describe('perfil ai-manager: registro e mapa de métodos', () => {
  it('AC-T98-01: WA_RPC_PROFILE=ai-manager é aceito e monta o gateway RPC com o perfil', async () => {
    expect(gatewayProfileNames()).toContain('ai-manager')
    const env = { WA_GATEWAY: 'rpc', WA_RPC_PROFILE: 'ai-manager', WA_RPC_URL: today.url, INTERNAL_TOKEN: TOKEN }
    expect(loadWaGatewayConfig(env)).toMatchObject({ mode: 'rpc', profile: 'ai-manager', url: today.url })
    const built = createWaGatewayFromEnv(env)
    try {
      // Cópia mutável do perfil: a detecção preguiçosa remove as rotas ausentes dela.
      expect(built.rpc?.gatewayProfile).toEqual(aiManagerProfile)
      expect(built.rpc?.gatewayProfile).not.toBe(aiManagerProfile)
      expect((await built.gateway.sessions.list()).length).toBeGreaterThanOrEqual(0)
    } finally {
      await built.close()
    }
  })

  it('os alvos de hoje do perfil existem no worker simulado; o envio nunca usa a fila crua messages.enqueue', () => {
    const rpcs = Object.values(aiManagerProfile.methods).map((r) => {
      const route = routeOf(r!)
      return `${route.target}.${route.method}`
    })
    expect(rpcs).not.toContain('messages.enqueue')
    const additive = new Set<string>(Object.values(AI_MANAGER_ADDITIVE_ROUTES).map((r) => r.rpc))
    for (const rpc of rpcs.filter((r) => !additive.has(r))) expect(today.targets).toContain(rpc)
    for (const rpc of additive) expect(today.targets).not.toContain(rpc)
    expect(aiManagerProfile.methods.send).toBe('messages.send')
    expect(aiManagerProfile.methods.markRead).toBeUndefined()
    expect(aiManagerProfile.methods.capabilities).toBeUndefined()
  })

  it('AC-T98-01: sem detecção, o worker de hoje recusa o alvo aditivo e o gateway lança CapabilityNotSupportedError (remote)', async () => {
    const gateway = createRpcGateway({ url: today.url, token: TOKEN, profile: 'ai-manager' })
    const before = today.calls.length
    const err = await gateway
      .send({ sessionId: 's', phone: phone(), content: { text: 'x' }, actor })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CapabilityNotSupportedError)
    expect(err).toMatchObject({ code: 'CAPABILITY_NOT_SUPPORTED', status: 501, remote: true, method: 'messages.send' })
    expect(today.calls.slice(before).map((c) => `${c.target}.${c.method}`)).toEqual(['messages.send'])
    await gateway.close()
  })
})

describe('detecção de capacidades ausentes', () => {
  it('AC-T98-01: contra o ai-manager de hoje marca A3/A7/A8 como ausentes e o gateway recusa sem chamar a rede', async () => {
    const gateway = await createAiManagerGateway({ url: today.url, token: TOKEN })
    try {
      const report = gateway.capabilityReport
      expect([...report.missing].sort()).toEqual([...ABSENT_TODAY].sort())
      expect(report.missingChanges).toEqual(['A3', 'A7', 'A8'])
      expect(report.supported).toEqual(
        expect.arrayContaining(['sessions.create', 'sessions.remove', 'cancel', 'fetchGroups']),
      )
      expect(gateway.markRead).toBeUndefined()
      expect(gateway.profile).toBeUndefined()

      const before = today.calls.length
      const sid = 'sess'
      const attempts: Array<[string, () => Promise<unknown>]> = [
        ['send', () => gateway.send({ sessionId: sid, phone: phone(), content: { text: 'x' }, actor })],
        ['sendGroup', () => gateway.sendGroup({ sessionId: sid, groupId: '1@g.us', content: { text: 'x' }, actor })],
        [
          'downloadMedia',
          () =>
            gateway.downloadMedia(sid, {
              session_id: sid,
              message_id: 'm',
              mime: 'image/jpeg',
              size: null,
              sha256: null,
              key: null,
              status: 'pending',
            }),
        ],
        ['presence', () => gateway.presence(sid, phone(), 'composing')],
        ['listContacts', () => gateway.listContacts(sid)],
        ['recordConsent', () => gateway.recordConsent({ phone: phone(), source: 'manual', actor })],
        ['optOut', () => gateway.optOut({ phone: phone(), actor })],
        ['react', () => gateway.react({ sessionId: sid, phone: phone(), messageId: 'm', emoji: '👍', actor })],
        [
          'deleteForEveryone',
          () => gateway.deleteForEveryone({ sessionId: sid, phone: phone(), messageId: 'm', actor } as never),
        ],
      ]
      for (const [method, call] of attempts) {
        await expect(call(), method).rejects.toMatchObject({
          name: 'CapabilityNotSupportedError',
          method,
          profile: 'ai-manager',
          remote: false,
          status: 501,
        })
      }
      expect(today.calls.length).toBe(before)
      // As capacidades nativas ficam falsas (sem `meta.capabilities`) e a consulta não vai à rede.
      expect(await gateway.refreshCapabilities()).toEqual({
        nativeButtons: false,
        nativeCarousel: false,
        calls: false,
        labelsSync: false,
        businessProfile: false,
      })
      expect(today.calls.length).toBe(before)
    } finally {
      await gateway.close()
    }
  })

  it('AC-T98-02: com os alvos aditivos simulados só ficam ausentes os métodos sem proposta', async () => {
    const report = await detectAiManagerCapabilities({ url: full.url, token: TOKEN })
    expect([...report.missing].sort()).toEqual([...ABSENT_WITH_ADDITIVES].sort())
    expect(report.missingChanges).toEqual([])
    expect(report.profile.methods.send).toBe('messages.send')
  })

  it('cada alvo é sondado uma vez, com args vazios, e a sonda não cria nada no worker', async () => {
    const sim = await startAiManagerSimulator({ token: TOKEN, additive: { contacts: true } })
    try {
      const report = await detectAiManagerCapabilities({ url: sim.url, token: TOKEN })
      expect(report.missingChanges).toEqual(['A3', 'A8'])
      expect(report.supported).toEqual(expect.arrayContaining(['listContacts', 'recordConsent', 'optOut']))
      const probes = sim.calls.map((c) => `${c.target}.${c.method}`)
      expect(new Set(probes).size).toBe(probes.length)
      expect(sim.calls.every((c) => c.args.length === 0)).toBe(true)
      expect(probes.sort()).toEqual(
        Object.values(AI_MANAGER_ADDITIVE_ROUTES)
          .map((r) => r.rpc)
          .sort(),
      )
    } finally {
      await sim.close()
    }
  })

  it('token recusado na detecção vira WorkerUnavailableError (não "capacidade ausente")', async () => {
    const err = await detectAiManagerCapabilities({ url: today.url, token: 'errado' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WorkerUnavailableError)
    expect(err).toMatchObject({ reason: 'unauthorized' })
  })
})

describe('alvos aditivos simulados (A3/A7/A8)', () => {
  it('AC-T98-02: presence, contacts e envio pelo pipeline funcionam pelo gateway', async () => {
    const gateway = await createAiManagerGateway({ url: full.url, token: TOKEN })
    try {
      const sessionId = await connect(full, gateway)
      await gateway.presence(sessionId, '+5511988887777', 'composing')
      expect(full.presences).toContainEqual({ sessionId, to: '+5511988887777', kind: 'composing' })
      await expect(gateway.presence(sessionId, '+5511988887777', 'dancing' as never)).rejects.toThrow()
      expect(await gateway.listContacts(sessionId)).toEqual([
        expect.objectContaining({ jid: expect.any(String), phone: expect.any(String) }),
      ])

      const p = phone()
      // Sem consentimento o gate contactAllowed recusa (como o SendPipeline do ai-manager).
      await expect(gateway.send({ sessionId, phone: p, content: { text: 'oi' }, actor })).rejects.toMatchObject({
        code: 'CONTACT_NOT_ALLOWED',
        status: 403,
        gate: 'contactAllowed',
      })
      await gateway.recordConsent({ phone: p, source: 'inbound', actor })
      const sent = await gateway.send({ sessionId, phone: p, content: { text: 'oi' }, actor })
      expect(sent).toMatchObject({ sessionId, phone: p, status: 'queued' })
      const group = await gateway.sendGroup({
        sessionId,
        groupId: '120363000000000001@g.us',
        content: { text: 'grupo' },
        actor,
      })
      expect(group).toMatchObject({ phone: '120363000000000001@g.us', status: 'queued' })
    } finally {
      await gateway.close()
    }
  })
})

describe('only/skip da suíte de contrato', () => {
  it('todo teste da suíte tem grupo; only exige todos os grupos e skip recusa qualquer um', () => {
    expect(Object.keys(WA_GATEWAY_CONTRACT_TESTS).length).toBeGreaterThanOrEqual(19)
    expect(isContractTestEnabled(['sessions'])).toBe(true)
    expect(isContractTestEnabled(['cancel', 'send'], { only: ['cancel', 'sessions'] })).toBe(false)
    expect(isContractTestEnabled(['cancel'], { only: ['cancel', 'sessions'] })).toBe(true)
    expect(isContractTestEnabled(['send', 'contacts'], { skip: ['contacts'] })).toBe(false)
    expect(isContractTestEnabled(['groups'], { skip: ['contacts'] })).toBe(true)
  })
})
