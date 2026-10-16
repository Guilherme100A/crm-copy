// Massa de dados da suíte T69 (contrato combinado com o Torno): conexão pela API da T40, chats criados pelo ingest
// a partir de message.inbound injetado no harness (/__e2e/wa/emit), status trocado pela API da T48.
import { expect, type Page } from '@playwright/test'

const H = { 'x-requested-with': 'crm' }

export async function createConnection(page: Page, name = `Loja ${Date.now().toString(36)}`) {
  const res = await page.request.post('/api/connections', { data: { name }, headers: H })
  expect(res.status(), await res.text()).toBe(201)
  const { connection } = await res.json()
  expect(connection.session_id).toBeTruthy()
  return connection as { id: string; session_id: string; name: string }
}

let seq = 0
export const newPhone = () => `55119${String(Date.now() % 1e4).padStart(4, '0')}${String(++seq).padStart(4, '0')}`

/** Injeta um message.inbound (WaEvent v1) e espera o worker do harness consumir. */
export async function emitInbound(page: Page, sessionId: string, phone: string, text: string, pushName = `Cliente ${phone.slice(-4)}`) {
  const id = `T69-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const res = await page.request.post('/__e2e/wa/emit', {
    headers: H,
    data: {
      event: {
        v: 1,
        type: 'message.inbound',
        session_id: sessionId,
        at: new Date().toISOString(),
        message: { id, from: `${phone}@s.whatsapp.net`, from_me: false, timestamp: Date.now(), type: 'conversation', text, push_name: pushName },
      },
    },
  })
  expect(res.status(), await res.text()).toBe(202)
  const { stream_id } = await res.json()
  const d = await page.request.get(`/__e2e/wa/deliveries?stream_id=${encodeURIComponent(stream_id)}&wait_ms=10000`)
  expect((await d.json()).acked, 'worker do harness não consumiu o evento').toBe(true)
}

/** Id do chat do telefone (espera o ingest criar). */
export async function chatIdOf(page: Page, phone: string): Promise<string> {
  let id: string | undefined
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/chats?search=${phone.slice(-8)}`)
        const body = await res.json()
        id = body.items?.[0]?.id
        return id
      },
      { timeout: 15_000 },
    )
    .toBeTruthy()
  return id!
}

/** Cria um chat (waiting, 1 não lida) e devolve seu id. */
export async function newChat(page: Page, sessionId: string, text = 'olá, quero informações') {
  const phone = newPhone()
  await emitInbound(page, sessionId, phone, text)
  return { id: await chatIdOf(page, phone), phone }
}

export async function assign(page: Page, chatId: string, userId: string) {
  const res = await page.request.post(`/api/chats/${chatId}/assign`, { data: { user_id: userId }, headers: H })
  if (res.status() === 404 || res.status() === 405) {
    const r2 = await page.request.patch(`/api/chats/${chatId}/assign`, { data: { user_id: userId }, headers: H })
    expect(r2.status(), await r2.text()).toBe(200)
    return
  }
  expect(res.status(), await res.text()).toBe(200)
}

export async function resolve(page: Page, chatId: string) {
  const res = await page.request.post(`/api/chats/${chatId}/resolve`, { data: {}, headers: H })
  expect(res.status(), await res.text()).toBe(200)
}

export async function markRead(page: Page, chatId: string) {
  const res = await page.request.post(`/api/chats/${chatId}/read`, { data: {}, headers: H })
  expect(res.status(), await res.text()).toBeLessThan(300)
}

/** Ids dos itens da lista, na ordem do DOM. */
export async function listIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="chat-list-item-"]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('data-testid')!).filter((t) => /^chat-list-item-[0-9a-f-]{36}$/.test(t)).map((t) => t.replace('chat-list-item-', '')),
    )
}
