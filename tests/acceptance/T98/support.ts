// Apoio da suíte T98 (não é arquivo de teste). Contratos usados:
// '@crm/wa-gateway-rpc': createWaGatewayFromEnv (WA_GATEWAY=rpc + WA_RPC_PROFILE=ai-manager), gatewayProfileNames;
// '@crm/wa-gateway-rpc/testing': createWorkerContractHarness; '@crm/wa-port/contract': defineWaGatewayContract;
// o simulador entregue (packages/wa-gateway-rpc/src/profiles/ai-manager/testing/simulator.ts).
// Além do simulador entregue, `startTodayServer` é um servidor RPC INDEPENDENTE, escrito aqui a partir da lista
// fechada `bridgeHandlers` do ai-manager de hoje (spec/briefs/T98.md): o AC-T98-01 não depende só do simulador do operário.
import { randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export const rand = (n = 4) => randomBytes(n).toString('hex')
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1'

export const rpcMod = (): Promise<any> => import('@crm/wa-gateway-rpc')
export const rpcTesting = (): Promise<any> => import('@crm/wa-gateway-rpc/testing')
export const simulatorMod = (): Promise<any> => import('@crm/wa-gateway-rpc/profiles/ai-manager/testing/simulator')

/** Alvos que o ai-manager expõe hoje no POST /internal/rpc (brief T98, `bridgeHandlers`). */
export const TODAY_TARGETS = [
  'sessions.create',
  'sessions.list',
  'sessions.get',
  'sessions.startQr',
  'sessions.getQr',
  'sessions.requestPairingCode',
  'sessions.pause',
  'sessions.resume',
  'sessions.restart',
  'sessions.logout',
  'sessions.remove',
  'sessions.fetchGroups',
  'sessions.addGroupParticipant',
  'sessions.runGroupInvite',
  'sessions.getConversation',
  'sessions.configureConversation',
  'sessions.tickConversation',
  'sessions.getGroupAutomation',
  'sessions.configureGroupAutomation',
  'sessions.tickGroupAutomation',
  'messages.get',
  'messages.list',
  'messages.events',
  'messages.cancel',
  'messages.enqueue',
  'health.getHealth',
]

/** Métodos da porta que dependem de mudança aditiva (A3/A7/A8) e ficam ausentes no ai-manager de hoje. */
export const ADDITIVE_METHODS = ['send', 'sendGroup', 'downloadMedia', 'presence', 'listContacts', 'recordConsent', 'optOut']

export interface Call {
  target: string
  method: string
  args: unknown[]
}

export interface TodayServer {
  url: string
  calls: Call[]
  /** Mensagem já na fila (como se a API do ai-manager tivesse enfileirado). */
  seedQueued(sessionId: string): string
  close(): Promise<void>
}

/** Servidor RPC mínimo e independente com SÓ os alvos de hoje; o resto responde UNKNOWN_METHOD (HTTP 400). */
export async function startTodayServer(token: string): Promise<TodayServer> {
  const calls: Call[] = []
  const sessions = new Map<string, any>()
  const messages = new Map<string, any>()
  const now = () => new Date().toISOString()
  const fail = (name: string, message: string, extra: Record<string, unknown> = {}) => {
    throw Object.assign(new Error(message), { name, extra })
  }
  const getSession = (id: unknown) => sessions.get(String(id)) ?? fail('SessionError', `session ${id} not found`, { code: 'SESSION_NOT_FOUND' })
  const notImplemented = () => fail('Error', 'not simulated')
  const handlers: Record<string, (args: any[]) => unknown> = {
    'sessions.create': ([input]) => {
      const at = now()
      const s = { id: randomUUID(), name: input?.name, phone: input?.phone ?? null, status: 'NEW', state: 'NEW', proxyId: null, note: null, requiresRestart: false, warmupStartedAt: null, lastConnectedAt: null, createdAt: at, updatedAt: at }
      sessions.set(s.id, s)
      return s
    },
    'sessions.list': () => [...sessions.values()],
    'sessions.get': ([id]) => getSession(id),
    'sessions.startQr': ([id]) => getSession(id),
    'sessions.getQr': ([id]) => (getSession(id), { qr: null, generatedAt: null }),
    'sessions.requestPairingCode': ([id]) => (getSession(id), { code: 'ABCD-EFGH' }),
    'sessions.pause': ([id]) => Object.assign(getSession(id), { status: 'PAUSED', state: 'PAUSED' }),
    'sessions.resume': ([id]) => Object.assign(getSession(id), { status: 'STABLE', state: 'STABLE' }),
    'sessions.restart': ([id]) => getSession(id),
    'sessions.logout': ([id]) => Object.assign(getSession(id), { status: 'DISCONNECTED', state: 'DISCONNECTED' }),
    'sessions.remove': ([id]) => (getSession(id), sessions.delete(String(id)), { deletedProxyId: null }),
    'sessions.fetchGroups': ([id]) => (getSession(id), [{ id: '120363000000000099@g.us', name: 'Grupo T98', participants: 2, announce: false, isAdmin: true }]),
    'messages.get': ([id]) => messages.get(String(id)) ?? fail('MessageNotFoundError', 'not found', { code: 'MESSAGE_NOT_FOUND' }),
    'messages.list': () => [...messages.values()],
    'messages.events': () => [],
    'messages.cancel': ([id]) => {
      const m = messages.get(String(id)) ?? fail('MessageNotFoundError', `message ${id} not found`, { code: 'MESSAGE_NOT_FOUND', messageId: String(id) })
      if (m.status !== 'queued') fail('MessageTransitionError', `cannot cancel from ${m.status}`, { from: m.status, to: 'cancelled' })
      m.status = 'cancelled'
      return m
    },
    'messages.enqueue': () => notImplemented(),
    'health.getHealth': ([id]) => ({ sessionId: String(id), score: 100 }),
  }
  for (const t of TODAY_TARGETS) handlers[t] ??= notImplemented

  const server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: { code: 'UNAUTHORIZED', message: 'invalid internal token' } })
      if (req.url !== '/internal/rpc' || req.method !== 'POST') return reply(404, { error: { code: 'NOT_FOUND', message: 'not found' } })
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const call = { target: String(body.target), method: String(body.method), args: Array.isArray(body.args) ? body.args : [] }
      calls.push(call)
      const fn = Object.hasOwn(handlers, `${call.target}.${call.method}`) ? handlers[`${call.target}.${call.method}`] : undefined
      if (!fn) return reply(400, { error: { name: 'RpcError', code: 'UNKNOWN_METHOD', message: `unknown method ${call.target}.${call.method}` } })
      try {
        reply(200, { result: (await fn(call.args)) ?? null })
      } catch (err: any) {
        reply(200, { error: { name: err.name, message: err.message, ...(err.extra ?? {}) } })
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    seedQueued(sessionId) {
      const at = now()
      const m = { id: randomUUID(), sessionId, contactId: null, phone: '+5511999990000', content: { type: 'text', text: 'oi' }, status: 'queued', attempts: 0, lastError: null, transportMessageId: null, sentAt: null, deliveredAt: null, readAt: null, createdAt: at, updatedAt: at }
      messages.set(m.id, m)
      return m.id
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** Ambiente do modo extensão (docs/extension/ai-manager.md §2), com stream isolado. */
export function extensionEnv(url: string, token: string, stream: string): Record<string, string> {
  return { WA_GATEWAY: 'rpc', WA_RPC_PROFILE: 'ai-manager', WA_RPC_URL: url, INTERNAL_TOKEN: token, REDIS_URL, WA_EVENTS_STREAM: stream, WA_RPC_TIMEOUT_MS: '15000' }
}

/** Erro capturado de uma promessa (falha o teste se ela resolver). */
export async function rejectionOf(p: Promise<unknown>): Promise<any> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('esperava rejeição, mas resolveu')
}
