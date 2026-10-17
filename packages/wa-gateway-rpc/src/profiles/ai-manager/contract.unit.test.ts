// A suíte de contrato da `@crm/wa-port` contra o servidor RPC simulado do ai-manager, com o gateway no perfil
// `ai-manager` (detecção no boot). AC-T98-01: só os alvos de hoje → roda a parte sessions/cancel/groups (o envio é
// capacidade ausente até A8; ver profile.unit.test.ts). AC-T98-02: com os aditivos (A1/A3/A7/A8) → a suíte inteira.
import { randomBytes } from 'node:crypto'
import { redisConnection } from '@crm/node-kit'
import { defineWaGatewayContract } from '@crm/wa-port/contract'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll } from 'vitest'
import { createWorkerContractHarness } from '../../testing'
import { createAiManagerGateway } from './detect'
import { startAiManagerSimulator, type AiManagerSimulator } from './testing/simulator'

const TOKEN = `t98-${randomBytes(6).toString('hex')}`
// Stream único por arquivo (docs/licoes.md): nunca o `wsm:events` compartilhado.
const STREAM = `test:t98:wsm:events:${randomBytes(4).toString('hex')}`

let redis: Redis
let today: AiManagerSimulator
let full: AiManagerSimulator

beforeAll(async () => {
  redis = redisConnection()
  today = await startAiManagerSimulator({ token: TOKEN })
  full = await startAiManagerSimulator({ token: TOKEN, additive: true, redis, stream: STREAM })
})

afterAll(async () => {
  await today?.close()
  await full?.close()
  await redis?.del(STREAM)
  await redis?.quit()
})

async function harnessFor(sim: AiManagerSimulator) {
  const gateway = await createAiManagerGateway({
    url: sim.url,
    token: TOKEN,
    redis,
    stream: STREAM,
    blockMs: 100,
    timeoutMs: 15_000,
  })
  const harness = createWorkerContractHarness({
    gateway,
    url: sim.url,
    token: TOKEN,
    blobStore: sim.blobStore,
    eventTimeoutMs: 5000,
  })
  return {
    ...harness,
    // O inbound nasce no "lado WhatsApp" do simulador e chega pelo outbox (A1), não por XADD do teste.
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

defineWaGatewayContract('AC-T98-01 ai-manager de hoje (sessions, cancel, groups)', () => harnessFor(today), {
  only: ['capabilities', 'sessions', 'cancel', 'groups'],
})

defineWaGatewayContract('AC-T98-02 ai-manager com A1/A3/A7/A8', () => harnessFor(full))
