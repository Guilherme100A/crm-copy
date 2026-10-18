import { describe, expect, it } from 'vitest'
import type { FlowAction, FlowNode } from '@crm/shared'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { buildContext, type StepStore } from '../../engine/context'
import { dryRun } from '../../engine/dry-run'
import { createEmptyNodeRegistry, createNodeRegistry } from '../../engine/registry'
import { applyGlobals, delaySeconds, messagingHandlers, mimeOf, registerMessagingNodes, type MessagingDeps } from './index'
import { crc16ccitt, normalizePixKey, pixAmount, pixEmv, pixMessage } from './pix'

const SESSION = 'sess-1'
const PHONE = '+5511999990000'

const action = (id: string, type: string, config: Record<string, unknown>, order = 0): FlowAction => ({ id, type, order, config })
const node = (type: string, actions: FlowAction[]): FlowNode => ({ id: 'n1', type, name: type, position: { x: 0, y: 0 }, actions })

function memoryStore(): StepStore & { actions: Map<string, unknown> } {
  const actions = new Map<string, unknown>()
  return {
    actions,
    findAction: async (key) => (actions.has(key) ? { result: actions.get(key) } : null),
    saveAction: async (row) => void actions.set(row.key, row.result),
    saveStep: async () => undefined,
  }
}

function setup(n: FlowNode, deps: MessagingDeps = {}, store = memoryStore()) {
  const wa = new FakeWaGateway({ sessions: [{ id: SESSION, name: 'c1', state: 'STABLE' }] })
  const sleeps: number[] = []
  const ctx = () =>
    buildContext({
      runId: 'run-1',
      companyId: 'co-1',
      flowId: 'f1',
      contactId: 'ct-1',
      chatId: 'chat-1',
      seq: 1,
      node: n,
      definition: { schema: 'crm.flow/v1', entry: 'start', nodes: [n], edges: [], variables: [], refs: {} },
      contact: { full_name: 'Maria Silva', phone_number: '5511999990000' },
      vars: { pedido: '42' },
      wa,
      log: { debug() {}, info() {}, warn() {}, error() {} },
      repo: { companyId: 'co-1', db: null, dryRun: false },
      store,
    })
  const handlers = messagingHandlers({
    resolveTarget: async () => ({ sessionId: SESSION, phone: PHONE }),
    sleep: async (ms) => void sleeps.push(ms),
    rng: () => 0.5,
    ...deps,
  })
  return { wa, sleeps, ctx, handlers, store }
}

describe('Pix copia e cola', () => {
  it('CRC16-CCITT-FALSE de "123456789" é 29B1', () => {
    expect(crc16ccitt('123456789')).toBe('29B1')
  })

  it('reproduz o exemplo estático do manual do BR Code (CRC 1D3D)', () => {
    expect(pixEmv({ key: '123e4567-e12b-12d1-a456-426655440000', merchantName: 'Fulano de Tal', city: 'BRASILIA' })).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    )
  })

  it('com valor inclui o campo 54 e o CRC continua válido', () => {
    const emv = pixEmv({ key: 'pix@empresa.com', amount: '10,5', merchantName: 'Loja São João' })
    expect(emv).toContain('540510.50')
    expect(emv).toContain('5913Loja Sao Joao')
    expect(emv.slice(-8, -4)).toBe('6304')
    expect(emv.slice(-4)).toBe(crc16ccitt(emv.slice(0, -4)))
  })

  it('valores e chaves normalizados', () => {
    expect(pixAmount('1.234,56')).toBe('1234.56')
    expect(pixAmount('10.50')).toBe('10.50')
    expect(pixAmount(0)).toBeNull()
    expect(pixAmount('abc')).toBeNull()
    expect(normalizePixKey('123.456.789-09')).toBe('12345678909')
    expect(normalizePixKey('11999998888', 'PHONE')).toBe('+5511999998888')
    expect(normalizePixKey('+5511999998888')).toBe('+5511999998888')
    expect(normalizePixKey('Pix@Empresa.com')).toBe('pix@empresa.com')
  })

  it('mensagem traz chave, valor e o código na última linha', () => {
    const text = pixMessage({ key: 'pix@empresa.com', amount: 10 })
    expect(text).toContain('Chave Pix: pix@empresa.com')
    expect(text).toContain('Valor: R$ 10,00')
    expect(text.split('\n').at(-1)).toBe(pixEmv({ key: 'pix@empresa.com', amount: 10 }))
  })
})

describe('regras puras', () => {
  it('delay: fixo, aleatório inclusivo entre mín e máx e teto de 120 s', () => {
    expect(delaySeconds({ delay_seconds: 7 })).toBe(7)
    expect(delaySeconds({ delay_min_seconds: 2, delay_max_seconds: 5 }, () => 0)).toBe(2)
    expect(delaySeconds({ delay_min_seconds: 2, delay_max_seconds: 5 }, () => 0.9999999)).toBe(5)
    expect(delaySeconds({ delay_min_seconds: 2, delay_max_seconds: 5 }, () => 0.5)).toBe(4)
    expect(delaySeconds({ delay_seconds: 500 })).toBe(120)
    expect(delaySeconds({ delay_min_seconds: 100, delay_max_seconds: 900 }, () => 0.9999)).toBe(120)
  })

  it('globais g_* e {{global.x}} antes do render; desconhecidas ficam', () => {
    expect(applyGlobals('{g_loja} - {{global.cidade}} - {g_x} - {nome}', { g_loja: 'Centro', g_cidade: 'SP' })).toBe('Centro - SP - {g_x} - {nome}')
  })

  it('mime pela extensão', () => {
    expect(mimeOf('proposta.PDF')).toBe('application/pdf')
    expect(mimeOf('https://x.test/a.xlsx?sig=1')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(mimeOf('sem-extensao')).toBe('application/octet-stream')
  })
})

describe('nó message', () => {
  it('envia em ordem com variáveis renderizadas, presença antes e atrasos pelo sleep injetado', async () => {
    const n = node('message', [
      action('a2', 'send_multi_media', { media_type: 'audio', media_source: 'url', media_url: 'https://x.test/{pedido}.ogg', typing_delay_seconds: 3 }, 2),
      action('a1', 'send_message', { message_text: 'Oi {first_name}, pedido {pedido}' }, 0),
      action('d1', 'delay_between_messages', { delay_min_seconds: 2, delay_max_seconds: 6 }, 1),
    ])
    const { wa, sleeps, ctx, handlers } = setup(n)
    expect(await handlers.message.execute(ctx())).toEqual({ next: 'source' })
    expect(wa.sent.map((m) => m.content)).toEqual([{ text: 'Oi Maria, pedido 42' }, { audio: { url: 'https://x.test/42.ogg' }, ptt: true }])
    expect(wa.sent.every((m) => m.actor === 'flow:run-1' && m.phone === PHONE && m.sessionId === SESSION)).toBe(true)
    expect(wa.presences.map((p) => p.kind)).toEqual(['composing', 'recording'])
    expect(sleeps).toEqual([4000, 3000])
  })

  it('retry do mesmo passo não reenvia (idempotente por ação)', async () => {
    const n = node('message', [action('a1', 'send_message', { message_text: 'uma vez' })])
    const { wa, ctx, handlers } = setup(n)
    await handlers.message.execute(ctx())
    await handlers.message.execute(ctx())
    expect(wa.sent).toHaveLength(1)
  })

  it('arquivo, figurinha, contato e vídeo-nota', async () => {
    const n = node('message', [
      action('f', 'send_file', { file_name: 'proposta.pdf', file_url: 'https://x.test/p.pdf' }, 0),
      action('s', 'send_sticker', { sticker_name: 'oi', sticker_url: 'https://x.test/s.webp' }, 1),
      action('c', 'send_contact', { contact_name: 'Suporte', contact_phone: '+55 11 95555-4444' }, 2),
      action('v', 'send_multi_media', { media_type: 'video', media_source: 'url', media_url: 'https://x.test/n.mp4', uazapi_video_type: 'ptv', messages: [{ view_once: true }] }, 3),
    ])
    const { wa, ctx, handlers } = setup(n)
    await handlers.message.execute(ctx())
    const [f, s, c, v] = wa.sent
    expect(f!.content).toEqual({ document: { url: 'https://x.test/p.pdf' }, mimetype: 'application/pdf', fileName: 'proposta.pdf' })
    expect(s!.content).toEqual({ sticker: { url: 'https://x.test/s.webp' } })
    expect((c!.content as { contact: { vcard: string } }).contact.vcard).toContain('waid=5511955554444')
    expect(v!.content).toMatchObject({ video: { url: 'https://x.test/n.mp4' }, ptv: true })
    expect(v!.viewOnce).toBe(true)
  })

  it('modelo interno: cabeçalho de mídia antes, corpo com globais e botões como menu numerado', async () => {
    const n = node('message', [action('t', 'send_message', { message_text: 'fallback', message_template_id: 'tpl-1' })])
    const { wa, ctx, handlers } = setup(n, {
      loadTemplate: async (_c, id) =>
        id === 'tpl-1'
          ? {
              header: { type: 'image', media_id: 'm1' },
              body: 'Olá {first_name}, loja {g_loja}',
              footer: 'Rodapé',
              buttons: [
                { type: 'reply', text: 'Sim' },
                { type: 'reply', text: 'Não' },
                { type: 'url', text: 'Site', url: 'https://x.test' },
              ],
            }
          : null,
      globals: async () => ({ g_loja: 'Centro' }),
      mediaUrl: async () => ({ url: 'https://x.test/h.jpg', mime: 'image/jpeg' }),
    })
    await handlers.message.execute(ctx())
    expect(wa.sent.map((m) => m.content)).toEqual([
      { image: { url: 'https://x.test/h.jpg' }, mimetype: 'image/jpeg' },
      { text: 'Olá Maria, loja Centro\n\n1 - Sim\n2 - Não\n\nSite: https://x.test\n\nRodapé' },
    ])
  })

  it('modelo não encontrado usa o texto da ação; sem texto, falha sem enviar', async () => {
    const a = setup(node('message', [action('t', 'send_message', { message_text: 'fallback', message_template_id: 'x' })]), { loadTemplate: async () => null })
    await a.handlers.message.execute(a.ctx())
    expect(a.wa.sent.map((m) => m.content)).toEqual([{ text: 'fallback' }])
    const b = setup(node('message', [action('t', 'send_message', { message_text: '', message_template_id: 'x' })]), { loadTemplate: async () => null })
    await expect(b.handlers.message.execute(b.ctx())).rejects.toThrow('mensagem vazia')
    expect(b.wa.sent).toHaveLength(0)
  })

  it('ponto de extensão record recebe cada envio; falha nele não derruba o nó', async () => {
    const seen: string[] = []
    const n = node('message', [action('a1', 'send_message', { message_text: 'oi' })])
    const { ctx, handlers } = setup(n, {
      record: async (_c, sent) => {
        seen.push(`${sent.actionId}:${sent.view.id}`)
        throw new Error('boom')
      },
    })
    await expect(handlers.message.execute(ctx())).resolves.toEqual({ next: 'source' })
    expect(seen).toHaveLength(1)
  })
})

describe('nós notification e pix', () => {
  it('notificação vai para +<ddi><número> pela sessão do run', async () => {
    const n = node('notification', [action('n', 'send_notification', { name: 'Equipe', phone: '11988887777', message: 'Lead {first_name}' })])
    const { wa, ctx, handlers } = setup(n)
    await handlers.notification.execute(ctx())
    expect(wa.sent).toHaveLength(1)
    expect(wa.sent[0]).toMatchObject({ sessionId: SESSION, phone: '+5511988887777', content: { text: 'Lead Maria' } })
    // Número da equipe não é contato: consentimento manual antes do envio (senão o gate contactAllowed barra).
    expect(wa.consents).toEqual([{ phone: '+5511988887777', source: 'manual', name: 'Equipe', actor: 'crm:flow-notification' }])
    const m = setup(node('notification', [action('n', 'send_notification', { name: 'E', phone: '5512345678', country_code: '351', message: 'x' })]))
    await m.handlers.notification.execute(m.ctx())
    expect(m.wa.sent[0]!.phone).toBe('+3515512345678')
  })

  it('pix envia um texto com chave, valor e EMV válido', async () => {
    const n = node('pix', [action('p', 'send_pix_button', { pix_key: 'pix@empresa.com', pix_type: 'EMAIL', amount_reais: '{valor}', merchant_name: 'Loja' })])
    const { wa, ctx, handlers } = setup(n)
    const c = ctx()
    c.setVar('valor', '25,90')
    await handlers.pix.execute(c)
    const text = (wa.sent[0]!.content as { text: string }).text
    expect(text).toContain('Valor: R$ 25,90')
    const emv = text.split('\n').at(-1)!
    expect(emv).toContain('540525.90')
    expect(emv.slice(-4)).toBe(crc16ccitt(emv.slice(0, -4)))
  })
})

describe('registro', () => {
  it('registerMessagingNodes registra message, notification e pix; createNodeRegistry já vem com eles', async () => {
    const reg = registerMessagingNodes(createEmptyNodeRegistry())
    expect(reg.types().sort()).toEqual(['message', 'notification', 'pix'])
    const r = await dryRun({
      definition: {
        schema: 'crm.flow/v1',
        entry: 'start',
        nodes: [
          { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
          { ...node('message', [action('a', 'send_message', { message_text: 'Oi {first_name}' })]), id: 'm' },
        ],
        edges: [{ id: 'e', from: 'start', handle: 'source', to: 'm' }],
        variables: [],
        refs: {},
      },
      registry: createNodeRegistry(),
      contact: { full_name: 'Ana Souza', phone_number: '5511912345678' },
    })
    expect(r.status).toBe('completed')
    expect(r.sent.map((m) => [m.phone, m.content])).toEqual([['+5511912345678', { text: 'Oi Ana' }]])
  })
})
