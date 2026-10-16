// Massa de chats para E2E (Playwright) no harness da T17: conexão pela API (T40), mensagens recebidas injetadas em
// /__e2e/wa/emit (WaEvent v1) e consumidas pelo worker do harness, envio/ações pela API (T48/T49) e espera do SSE.
// Compartilhado entre suítes de UI de chat (T75 em diante).
import { expect, type Page } from '@playwright/test'

export const XRW = { 'x-requested-with': 'crm' }

export async function createConnection(page: Page, name = `Loja ${Date.now().toString(36)}`) {
  const res = await page.request.post('/api/connections', { data: { name }, headers: XRW })
  expect(res.status(), await res.text()).toBe(201)
  const { connection } = await res.json()
  return connection as { id: string; session_id: string; name: string }
}

let seq = 0
export const newPhone = () => `55119${String(Date.now() % 1e4).padStart(4, '0')}${String(++seq).padStart(4, '0')}`
export const waId = (p = 'E2E') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Emite um WaEvent no harness e espera o worker confirmar (ack). */
export async function emit(page: Page, event: Record<string, unknown>) {
  const res = await page.request.post('/__e2e/wa/emit', { headers: XRW, data: { event: { v: 1, at: new Date().toISOString(), ...event } } })
  expect(res.status(), await res.text()).toBe(202)
  const { stream_id } = await res.json()
  const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(stream_id)}&wait_ms=10000`)
  expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
}

/** message.inbound do telefone; `message` sobrescreve campos (type, text, media...). Devolve o id do WhatsApp. */
export async function inbound(page: Page, sessionId: string, phone: string, message: Record<string, unknown> = {}) {
  const id = waId('IN')
  await emit(page, {
    type: 'message.inbound',
    session_id: sessionId,
    message: { id, from: `${phone}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), push_name: `Cliente ${phone.slice(-4)}`, type: 'conversation', text: 'olá', ...message },
  })
  return id
}

/** Id do chat do telefone (espera o ingest criar). */
export async function chatIdOf(page: Page, phone: string): Promise<string> {
  let id: string | undefined
  await expect
    .poll(
      async () => {
        const body = await (await page.request.get(`/api/chats?search=${phone.slice(-8)}`)).json()
        id = body.items?.[0]?.id
        return id
      },
      { timeout: 15_000 },
    )
    .toBeTruthy()
  return id!
}

export async function newChat(page: Page, sessionId: string, text = 'olá, quero informações') {
  const phone = newPhone()
  await inbound(page, sessionId, phone, { text })
  return { id: await chatIdOf(page, phone), phone }
}

/** Mensagens do chat pela API (todas as páginas, ordem cronológica crescente). */
export async function messagesOf(page: Page, chatId: string): Promise<any[]> {
  const all: any[] = []
  let before: string | undefined
  for (let guard = 0; guard < 20; guard++) {
    const res = await page.request.get(`/api/chats/${chatId}/messages?limit=100${before ? `&before=${before}` : ''}`)
    expect(res.status(), await res.text()).toBe(200)
    const items: any[] = (await res.json()).items ?? []
    if (!items.length) break
    all.push(...items)
    if (items.length < 100) break
    before = items.reduce((a, b) => (Date.parse(a.created_at ?? a.wa_timestamp) <= Date.parse(b.created_at ?? b.wa_timestamp) ? a : b)).id
  }
  const time = (m: any) => Date.parse(m.wa_timestamp ?? m.created_at)
  return [...new Map(all.map((m) => [m.id, m])).values()].sort((a, b) => time(a) - time(b))
}

/** Mensagem do chat pelo id do WhatsApp (espera o ingest gravar). */
export async function messageByWaId(page: Page, chatId: string, wa: string) {
  let found: any
  await expect.poll(async () => (found = (await messagesOf(page, chatId)).find((m) => m.wa_message_id === wa)), { timeout: 15_000 }).toBeTruthy()
  return found
}

export async function sendText(page: Page, chatId: string, text: string) {
  const res = await page.request.post(`/api/chats/${chatId}/messages`, { data: { type: 'text', text }, headers: XRW })
  expect(res.status(), await res.text()).toBe(201)
  return (await res.json()).message
}

/**
 * Simula o engine confirmando o envio: message.status 'sent' com transport_message_id (id do WhatsApp).
 * No harness o FakeWaGateway não avança a mensagem sozinho; sem o id do WhatsApp não dá para apagar/reagir.
 */
export async function markSent(page: Page, sessionId: string, chatId: string, message: { id: string; pipeline_message_id: string }) {
  await emit(page, { type: 'message.status', session_id: sessionId, message_id: message.pipeline_message_id, transport_message_id: waId('OUT'), status: 'sent' })
  await waitSent(page, chatId, message.id)
}

/** Espera a mensagem enviada ter id do WhatsApp. */
export async function waitSent(page: Page, chatId: string, messageId: string) {
  await expect
    .poll(async () => (await messagesOf(page, chatId)).find((m) => m.id === messageId)?.wa_message_id ?? null, { timeout: 20_000 })
    .toBeTruthy()
}

/** Upload (POST /api/media, multipart 'file') de um PNG pequeno com cabeçalho real. */
export async function uploadPng(page: Page) {
  const buf = Buffer.alloc(2048, 0x20)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf)
  const res = await page.request.post('/api/media', { multipart: { file: { name: 'foto.png', mimeType: 'image/png', buffer: buf } }, headers: XRW })
  expect(res.status(), await res.text()).toBeLessThan(300)
  return (await res.json()).media.id as string
}

/** Antes de navegar: registra os EventSource da página. */
export async function trackSse(page: Page) {
  await page.addInitScript(() => {
    const w = window as any
    w.__sse = [] as EventSource[]
    const Orig = w.EventSource
    w.EventSource = class extends Orig {
      constructor(url: string, init?: any) {
        super(url, init)
        w.__sse.push(this)
      }
    }
  })
}

/** Espera um SSE de /api/events aberto (eventos emitidos antes disso não chegariam). */
export async function waitSseOpen(page: Page) {
  await expect
    .poll(() => page.evaluate(() => ((window as any).__sse ?? []).some((es: EventSource) => es.url.includes('/api/events') && es.readyState === 1)), { timeout: 20_000 })
    .toBe(true)
}
