// @crm/wa-gateway-rpc/testing — harness da suíte de contrato da `@crm/wa-port` contra o wa-worker real com
// `WA_TRANSPORT=fake` (AC-T46-01). O gateway testado é o RPC; o "lado WhatsApp" é dirigido pelo controle do
// FakeTransport: em processo (`fake`, o `FakeControl` do `startWaWorker`) ou, num processo filho, pelas rotas
// `/internal/fake/*` + stream/BlobStore compartilhados.
import { randomUUID } from 'node:crypto'
import { WA_EVENT_VERSION, WA_EVENTS_STREAM, type MediaHandle, type WaEvent } from '@crm/wa-port'
import type { WaGatewayContractHarness } from '@crm/wa-port/contract'
import type { Redis } from 'ioredis'
import type { RpcWaGateway } from '../gateway'
import { STREAM_EVENT_FIELD } from '../stream'

/** Formato mínimo do `FakeControl` do wa-worker (apps/wa-worker/src/boot/fake-control.ts). */
export interface InProcessFakeControl {
  require(sessionId: string): {
    receive(msg: { id?: string; from: string; text?: string }): unknown
    media: Map<string, Uint8Array>
  }
}

export interface WorkerContractHarnessOptions {
  gateway: RpcWaGateway
  /** Base do wa-worker (`/internal/fake/*`). */
  url: string
  token: string
  /** wa-worker em processo: injeta mensagens com o id pedido e mídia direto no FakeTransport. */
  fake?: InProcessFakeControl
  /** Sem `fake`: o inbound é publicado direto no stream (o `/internal/fake/.../receive` não aceita id). */
  redis?: Pick<Redis, 'xadd'>
  stream?: string
  /** Sem `fake`: mídia gravada no BlobStore compartilhado com o worker (`STORAGE_DIR`), lida por `handle.key`. */
  blobStore?: { put(data: Uint8Array, mime: string): Promise<{ key: string; size: number; sha256?: string | null }> }
  /**
   * Fila do wa-worker em processo (`MessageQueue`): depois de conectar, a fila da sessão fica pausada para os envios
   * do contrato continuarem `queued` (o teste de `cancel` não disputa corrida com a entrega). Sem ela, a entrega
   * imediata do worker pode levar a mensagem a `processing` antes do cancel.
   */
  queue?: { pause(sessionId: string): Promise<void> }
  actor?: string
  eventTimeoutMs?: number
  /** Tempo máximo para a sessão chegar a WARMING/STABLE. Default 10 s. */
  connectTimeoutMs?: number
  teardown?(): Promise<void> | void
}

const SENDABLE = ['WARMING', 'STABLE', 'DEGRADED']

export function createWorkerContractHarness(opts: WorkerContractHarnessOptions): WaGatewayContractHarness {
  const base = opts.url.replace(/\/+$/, '')
  const fakePost = (path: string, body: unknown = {}) =>
    fetch(`${base}/internal/fake/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const until = async (what: string, check: () => Promise<boolean>, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`harness: timeout esperando ${what}`)
      await new Promise((r) => setTimeout(r, 30))
    }
  }
  const timeout = opts.connectTimeoutMs ?? 10_000

  return {
    gateway: opts.gateway,
    ...(opts.actor ? { actor: opts.actor } : {}),
    ...(opts.eventTimeoutMs !== undefined ? { eventTimeoutMs: opts.eventTimeoutMs } : {}),
    async connect(sessionId) {
      await opts.gateway.sessions.startQr(sessionId)
      // O transporte do QR nasce de forma assíncrona no worker: espera ele existir para abrir.
      await until(`transporte de ${sessionId}`, async () => (await fakePost(`sessions/${sessionId}/qr`)).ok, timeout)
      const open = await fakePost(`sessions/${sessionId}/open`)
      if (!open.ok) throw new Error(`harness: open ${sessionId} → HTTP ${open.status}`)
      await until(`${sessionId} conectada`, async () => SENDABLE.includes((await opts.gateway.sessions.get(sessionId)).status), timeout)
      await opts.queue?.pause(sessionId)
    },
    async injectInbound(sessionId, message) {
      if (opts.fake) {
        opts.fake.require(sessionId).receive({ id: message.id, from: message.from, text: message.text })
        return
      }
      if (!opts.redis) throw new Error('harness: informe `fake` (worker em processo) ou `redis` para injetar mensagens')
      const event: WaEvent = {
        v: WA_EVENT_VERSION,
        type: 'message.inbound',
        session_id: sessionId,
        at: new Date().toISOString(),
        message: { id: message.id, from: message.from, from_me: false, timestamp: Date.now(), text: message.text, type: 'conversation' },
      }
      await opts.redis.xadd(opts.stream ?? WA_EVENTS_STREAM, '*', STREAM_EVENT_FIELD, JSON.stringify(event))
    },
    async media(sessionId) {
      const messageId = `contract-media-${randomUUID().slice(0, 12)}`
      const bytes = new TextEncoder().encode(`contract-bytes-${messageId}`)
      if (opts.fake) {
        // Download sob demanda: o worker pede os bytes ao transporte (handle `pending`, sem chave).
        opts.fake.require(sessionId).media.set(messageId, bytes)
        const handle: MediaHandle = { session_id: sessionId, message_id: messageId, mime: 'image/jpeg', size: null, sha256: null, key: null, status: 'pending' }
        return { handle, bytes }
      }
      if (!opts.blobStore) throw new Error('harness: informe `fake` ou `blobStore` (mesmo STORAGE_DIR do worker) para mídia')
      const info = await opts.blobStore.put(bytes, 'image/jpeg')
      const handle: MediaHandle = { session_id: sessionId, message_id: messageId, mime: 'image/jpeg', size: info.size, sha256: info.sha256 ?? null, key: info.key, status: 'ready' }
      return { handle, bytes }
    },
    async teardown() {
      await opts.gateway.close()
      await opts.teardown?.()
    },
  }
}
