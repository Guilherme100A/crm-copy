// Suíte de contrato do WaGateway (SPEC T03): a mesma bateria roda contra o FakeWaGateway (T03) e contra o
// gateway RPC sobre o wa-worker real com transporte fake (T46). Erros são comparados por `code`/`status`
// (não por instanceof), porque atravessam o RPC.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MediaBody, WaGateway } from '../gateway'
import { parseWaEvent, WA_EVENT_VERSION, type MediaHandle, type WaEvent } from '../events'

export interface WaGatewayContractHarness {
  gateway: WaGateway
  /** Deixa a sessão pronta para enviar (WARMING/STABLE). Default: `connect(id)` do fake, se existir. */
  connect?(sessionId: string): Promise<void>
  /** Faz o lado WhatsApp produzir um `message.inbound`. Default: `emit(event)` do fake. */
  injectInbound?(sessionId: string, message: { id: string; from: string; text: string }): Promise<void>
  /** Mídia conhecida da sessão para `downloadMedia`. Default: `setMedia` do fake. */
  media?(sessionId: string): Promise<{ handle: MediaHandle; bytes: Uint8Array }>
  /** Actor usado nos envios. Default `crm:contract`. */
  actor?: string
  /** Tempo máximo de espera por eventos assíncronos (ms). Default 2000. */
  eventTimeoutMs?: number
  teardown?(): Promise<void> | void
}

export type WaGatewayContractFactory = () => WaGateway | WaGatewayContractHarness | Promise<WaGateway | WaGatewayContractHarness>

/**
 * Grupos da suíte (T98): cada teste declara os recursos do gateway que exercita além de criar/conectar sessão. Um
 * backend parcial (ex.: ai-manager sem os alvos aditivos) roda só a parte que tem e registra o resto como `skip`.
 */
export const WA_GATEWAY_CONTRACT_GROUPS = ['capabilities', 'sessions', 'send', 'contacts', 'sendGroup', 'markRead', 'cancel', 'groups', 'media', 'events'] as const
export type WaGatewayContractGroup = (typeof WA_GATEWAY_CONTRACT_GROUPS)[number]

export interface WaGatewayContractOptions {
  /** Roda só os testes cujos grupos estão TODOS nesta lista. */
  only?: readonly WaGatewayContractGroup[]
  /** Pula os testes que usam algum destes grupos. */
  skip?: readonly WaGatewayContractGroup[]
}

/** Título de cada teste da suíte → grupos que ele usa. Teste novo sem entrada aqui faz a suíte falhar ao registrar. */
export const WA_GATEWAY_CONTRACT_TESTS: Readonly<Record<string, readonly WaGatewayContractGroup[]>> = {
  'capabilities: expõe as cinco flags booleanas': ['capabilities'],
  'sessões: create devolve sessão NEW que aparece em list e get': ['sessions'],
  'sessões: get de sessão inexistente rejeita': ['sessions'],
  'sessões: pause leva a PAUSED e resume sai de PAUSED': ['sessions'],
  'sessões: remove apaga a sessão': ['sessions'],
  'send: devolve MessageView queued para a sessão e o telefone pedidos': ['send', 'contacts'],
  'send: sem actor rejeita com UNAUTHORIZED 401': ['send'],
  'send: sessão inexistente rejeita com SESSION_NOT_FOUND 404': ['send'],
  'send: sessão pausada rejeita com SESSION_NOT_CONNECTED 409': ['send', 'sessions'],
  'send: contato com opt-out rejeita com CONTACT_NOT_ALLOWED 403': ['send', 'contacts'],
  'send: o mesmo clientMessageId na sessão devolve a mesma mensagem (idempotência)': ['send', 'contacts'],
  'markRead (quando suportado): aceita os ids do chat sem erro': ['markRead'],
  'send: sendGroup com JID que não é de grupo rejeita com VALIDATION_ERROR 400': ['sendGroup'],
  'cancel: mensagem na fila vira cancelled': ['cancel', 'send', 'contacts'],
  'cancel: mensagem inexistente rejeita': ['cancel'],
  'fetchGroups: devolve a lista de grupos da sessão': ['groups'],
  'downloadMedia: devolve os bytes da mídia da mensagem': ['media'],
  'event: assinante recebe message.inbound válido (WaEvent v1)': ['events'],
  'event: depois do unsubscribe o assinante não recebe mais eventos': ['events'],
}

/** O teste que usa `groups` roda com estas opções? */
export function isContractTestEnabled(groups: readonly WaGatewayContractGroup[], options: WaGatewayContractOptions = {}): boolean {
  const { only, skip } = options
  if (only && !groups.every((g) => only.includes(g))) return false
  if (skip && groups.some((g) => skip.includes(g))) return false
  return true
}

/** `it` da suíte filtrado por `only`/`skip`: o teste fora do filtro é registrado como `skip` (aparece no relatório). */
function gatedIt(options: WaGatewayContractOptions) {
  return (title: string, fn: () => unknown) => {
    const groups = WA_GATEWAY_CONTRACT_TESTS[title]
    if (!groups) throw new Error(`WaGateway contract: o teste "${title}" não está em WA_GATEWAY_CONTRACT_TESTS`)
    const register = isContractTestEnabled(groups, options) ? it : it.skip
    register(title, fn)
  }
}

/** Controles opcionais do FakeWaGateway que a suíte usa quando a fábrica devolve só o gateway. */
interface FakeControls {
  connect?(sessionId: string, state?: 'WARMING' | 'STABLE'): Promise<unknown>
  emit?(event: WaEvent): Promise<void>
  setMedia?(messageId: string, bytes: Uint8Array): unknown
}

interface ResolvedHarness {
  gateway: WaGateway
  connect(sessionId: string): Promise<void>
  injectInbound(sessionId: string, message: { id: string; from: string; text: string }): Promise<void>
  media(sessionId: string): Promise<{ handle: MediaHandle; bytes: Uint8Array }>
  actor: string
  eventTimeoutMs: number
  teardown(): Promise<void>
}

function isHarness(value: WaGateway | WaGatewayContractHarness): value is WaGatewayContractHarness {
  return typeof (value as Partial<WaGateway>).send !== 'function' && typeof (value as WaGatewayContractHarness).gateway === 'object'
}

function missing(what: string): never {
  throw new Error(`WaGateway contract: the factory must provide ${what} (harness) or return a FakeWaGateway`)
}

function resolveHarness(value: WaGateway | WaGatewayContractHarness): ResolvedHarness {
  const harness: WaGatewayContractHarness = isHarness(value) ? value : { gateway: value }
  const gateway = harness.gateway
  const fake = gateway as unknown as FakeControls
  return {
    gateway,
    actor: harness.actor ?? 'crm:contract',
    eventTimeoutMs: harness.eventTimeoutMs ?? 2000,
    connect: async (sessionId) => {
      if (harness.connect) return harness.connect(sessionId)
      if (typeof fake.connect !== 'function') missing('connect(sessionId)')
      await fake.connect.call(gateway, sessionId, 'STABLE')
    },
    injectInbound: async (sessionId, message) => {
      if (harness.injectInbound) return harness.injectInbound(sessionId, message)
      if (typeof fake.emit !== 'function') missing('injectInbound(sessionId, message)')
      await fake.emit.call(gateway, {
        v: WA_EVENT_VERSION,
        type: 'message.inbound',
        session_id: sessionId,
        at: new Date().toISOString(),
        message: { id: message.id, from: message.from, from_me: false, timestamp: Date.now(), text: message.text, type: 'conversation' },
      })
    },
    media: async (sessionId) => {
      if (harness.media) return harness.media(sessionId)
      if (typeof fake.setMedia !== 'function') missing('media(sessionId)')
      const messageId = `contract-media-${uid()}`
      const bytes = new TextEncoder().encode(`contract-bytes-${messageId}`)
      fake.setMedia.call(gateway, messageId, bytes)
      const handle: MediaHandle = { session_id: sessionId, message_id: messageId, mime: 'image/jpeg', size: bytes.byteLength, sha256: null, key: null, status: 'ready' }
      return { handle, bytes }
    },
    teardown: async () => {
      await harness.teardown?.()
    },
  }
}

function uid(): string {
  return globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Telefone E.164 brasileiro aleatório (evita estado compartilhado entre testes). */
function randomPhone(): string {
  return `+55119${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`
}

async function toBytes(body: MediaBody): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body)
  const chunks: Uint8Array[] = []
  const reader = body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0))
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

async function waitFor<T>(find: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = find()
    if (found !== undefined || Date.now() >= deadline) return found
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * Registra a suíte de contrato do WaGateway no arquivo de teste Vitest que a chama.
 * A fábrica (síncrona ou async) roda antes de cada teste e devolve o gateway ou um harness com os controles do
 * lado WhatsApp. Uso: `defineWaGatewayContract(() => new FakeWaGateway())` ou
 * `defineWaGatewayContract('rpc', async () => ({ gateway, connect, injectInbound, media, teardown }))`.
 */
export function defineWaGatewayContract(factory: WaGatewayContractFactory): void
export function defineWaGatewayContract(name: string, factory: WaGatewayContractFactory): void
/** T98: `options.only`/`options.skip` por grupo (`WA_GATEWAY_CONTRACT_TESTS`) para backends parciais. */
export function defineWaGatewayContract(name: string, factory: WaGatewayContractFactory, options: WaGatewayContractOptions): void
export function defineWaGatewayContract(
  nameOrFactory: string | WaGatewayContractFactory,
  maybeFactory?: WaGatewayContractFactory,
  options: WaGatewayContractOptions = {},
): void {
  const name = typeof nameOrFactory === 'string' ? nameOrFactory : 'gateway'
  const factory = typeof nameOrFactory === 'string' ? maybeFactory : nameOrFactory
  if (typeof factory !== 'function') throw new TypeError('defineWaGatewayContract: factory is required')

  describe(`WaGateway contract (${name})`, () => {
    // T98: only/skip por grupo; sem opções todos os testes rodam, como antes.
    const it = gatedIt(options)
    let h: ResolvedHarness

    beforeEach(async () => {
      h = resolveHarness(await factory())
    })

    afterEach(async () => {
      await h?.teardown()
    })

    const connectedSession = async (): Promise<string> => {
      const session = await h.gateway.sessions.create({ name: `contract-${uid()}`, phone: randomPhone() })
      await h.connect(session.id)
      return session.id
    }

    const text = (body = 'contract') => ({ text: body })

    it('capabilities: expõe as cinco flags booleanas', () => {
      const caps = h.gateway.capabilities
      for (const key of ['nativeButtons', 'nativeCarousel', 'calls', 'labelsSync', 'businessProfile'] as const) {
        expect(typeof caps[key]).toBe('boolean')
      }
    })

    it('sessões: create devolve sessão NEW que aparece em list e get', async () => {
      const created = await h.gateway.sessions.create({ name: 'contract-new', phone: randomPhone() })
      expect(created).toMatchObject({ name: 'contract-new', status: 'NEW', state: 'NEW' })
      expect(typeof created.id).toBe('string')
      expect((await h.gateway.sessions.list()).map((s) => s.id)).toContain(created.id)
      expect(await h.gateway.sessions.get(created.id)).toMatchObject({ id: created.id, status: 'NEW' })
    })

    it('sessões: get de sessão inexistente rejeita', async () => {
      await expect(h.gateway.sessions.get(`missing-${uid()}`)).rejects.toBeInstanceOf(Error)
    })

    it('sessões: pause leva a PAUSED e resume sai de PAUSED', async () => {
      const id = await connectedSession()
      expect(await h.gateway.sessions.pause(id)).toMatchObject({ id, status: 'PAUSED' })
      const resumed = await h.gateway.sessions.resume(id)
      expect(resumed.status).not.toBe('PAUSED')
    })

    it('sessões: remove apaga a sessão', async () => {
      const created = await h.gateway.sessions.create({ name: 'contract-remove', phone: randomPhone() })
      const result = await h.gateway.sessions.remove(created.id)
      expect(result).toHaveProperty('deletedProxyId')
      expect((await h.gateway.sessions.list()).map((s) => s.id)).not.toContain(created.id)
    })

    it('send: devolve MessageView queued para a sessão e o telefone pedidos', async () => {
      const sessionId = await connectedSession()
      const phone = randomPhone()
      await h.gateway.recordConsent({ phone, source: 'manual', actor: h.actor })
      const message = await h.gateway.send({ sessionId, phone, content: text('olá'), actor: h.actor })
      expect(message).toMatchObject({ sessionId, phone, status: 'queued', attempts: 0, transportMessageId: null })
      expect(typeof message.id).toBe('string')
      expect(message.id.length).toBeGreaterThan(0)
    })

    it('send: sem actor rejeita com UNAUTHORIZED 401', async () => {
      const sessionId = await connectedSession()
      await expect(h.gateway.send({ sessionId, phone: randomPhone(), content: text() })).rejects.toMatchObject({
        name: 'SendRejectedError',
        code: 'UNAUTHORIZED',
        status: 401,
      })
    })

    it('send: sessão inexistente rejeita com SESSION_NOT_FOUND 404', async () => {
      await expect(h.gateway.send({ sessionId: `missing-${uid()}`, phone: randomPhone(), content: text(), actor: h.actor })).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
        status: 404,
      })
    })

    it('send: sessão pausada rejeita com SESSION_NOT_CONNECTED 409', async () => {
      const sessionId = await connectedSession()
      await h.gateway.sessions.pause(sessionId)
      await expect(h.gateway.send({ sessionId, phone: randomPhone(), content: text(), actor: h.actor })).rejects.toMatchObject({
        code: 'SESSION_NOT_CONNECTED',
        status: 409,
      })
    })

    it('send: contato com opt-out rejeita com CONTACT_NOT_ALLOWED 403', async () => {
      const sessionId = await connectedSession()
      const phone = randomPhone()
      await h.gateway.recordConsent({ phone, source: 'import', actor: h.actor })
      await h.gateway.optOut({ phone, reason: 'contract', actor: h.actor })
      await expect(h.gateway.send({ sessionId, phone, content: text(), actor: h.actor })).rejects.toMatchObject({
        code: 'CONTACT_NOT_ALLOWED',
        status: 403,
      })
    })

    it('send: o mesmo clientMessageId na sessão devolve a mesma mensagem (idempotência)', async () => {
      const sessionId = await connectedSession()
      const phone = randomPhone()
      await h.gateway.recordConsent({ phone, source: 'manual', actor: h.actor })
      const clientMessageId = `contract-${uid()}`
      const req = { sessionId, phone, content: text('uma vez'), actor: h.actor, clientMessageId, quoted: 'wamid-original', viewOnce: false }
      const first = await h.gateway.send(req)
      const second = await h.gateway.send(req)
      expect(second.id).toBe(first.id)
      const other = await h.gateway.send({ ...req, clientMessageId: `${clientMessageId}-2` })
      expect(other.id).not.toBe(first.id)
    })

    it('markRead (quando suportado): aceita os ids do chat sem erro', async () => {
      if (!h.gateway.markRead) return
      const sessionId = await connectedSession()
      await expect(h.gateway.markRead(sessionId, `${randomPhone().slice(1)}@s.whatsapp.net`, ['m1', 'm2'])).resolves.toBeUndefined()
    })

    it('send: sendGroup com JID que não é de grupo rejeita com VALIDATION_ERROR 400', async () => {
      const sessionId = await connectedSession()
      await expect(h.gateway.sendGroup({ sessionId, groupId: 'not-a-group', content: text(), actor: h.actor })).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
        status: 400,
      })
    })

    it('cancel: mensagem na fila vira cancelled', async () => {
      const sessionId = await connectedSession()
      const phone = randomPhone()
      await h.gateway.recordConsent({ phone, source: 'manual', actor: h.actor })
      const queued = await h.gateway.send({ sessionId, phone, content: text('cancelar'), actor: h.actor })
      const cancelled = await h.gateway.cancel(queued.id)
      expect(cancelled).toMatchObject({ id: queued.id, status: 'cancelled' })
    })

    it('cancel: mensagem inexistente rejeita', async () => {
      await expect(h.gateway.cancel(`missing-${uid()}`)).rejects.toBeInstanceOf(Error)
    })

    it('fetchGroups: devolve a lista de grupos da sessão', async () => {
      const sessionId = await connectedSession()
      const groups = await h.gateway.fetchGroups(sessionId)
      expect(Array.isArray(groups)).toBe(true)
      for (const g of groups) expect(g).toMatchObject({ id: expect.any(String), name: expect.any(String), participants: expect.any(Number) })
    })

    it('downloadMedia: devolve os bytes da mídia da mensagem', async () => {
      const sessionId = await connectedSession()
      const { handle, bytes } = await h.media(sessionId)
      const body = await h.gateway.downloadMedia(sessionId, handle)
      expect(Array.from(await toBytes(body))).toEqual(Array.from(bytes))
    })

    it('event: assinante recebe message.inbound válido (WaEvent v1)', async () => {
      const sessionId = await connectedSession()
      const received: WaEvent[] = []
      const unsubscribe = h.gateway.subscribe((e) => {
        received.push(e)
      })
      try {
        const id = `contract-in-${uid()}`
        await h.injectInbound(sessionId, { id, from: `${randomPhone().slice(1)}@s.whatsapp.net`, text: 'oi' })
        const event = await waitFor(
          () => received.find((e) => e.type === 'message.inbound' && e.session_id === sessionId && e.message.id === id),
          h.eventTimeoutMs,
        )
        expect(event).toBeDefined()
        expect(parseWaEvent(JSON.parse(JSON.stringify(event)))).toEqual(event)
        expect(event).toMatchObject({ v: 1, type: 'message.inbound', session_id: sessionId, message: { id, text: 'oi', from_me: false } })
      } finally {
        unsubscribe()
      }
    })

    it('event: depois do unsubscribe o assinante não recebe mais eventos', async () => {
      const sessionId = await connectedSession()
      const received: WaEvent[] = []
      const unsubscribe = h.gateway.subscribe((e) => {
        received.push(e)
      })
      unsubscribe()
      await h.injectInbound(sessionId, { id: `contract-off-${uid()}`, from: `${randomPhone().slice(1)}@s.whatsapp.net`, text: 'off' })
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, h.eventTimeoutMs)))
      expect(received.filter((e) => e.type === 'message.inbound')).toHaveLength(0)
    })
  })
}

/** Alias de `defineWaGatewayContract`. */
export const waGatewayContractSuite = defineWaGatewayContract
