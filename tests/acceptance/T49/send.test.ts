// AC-T49-01..06 — envio, mídia, atribuição, reação/apagar, falhas e conexão desconectada (caixa-preta via HTTP).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { download, type Env, fakeFile, inboundChat, LIMITS, OGG, owner, type Owner, rand, startEnv, upload } from './setup'

let env: Env
let a: Owner

beforeAll(async () => {
  env = await startEnv()
  a = await owner(env)
})
afterAll(async () => {
  await env?.close()
})

const sentTo = (sessionId: string) => env.gateway.sent.filter((s: any) => s.sessionId === sessionId)
const rows = (chatId: string) => env.q(`SELECT * FROM crm.messages WHERE chat_id = $1 ORDER BY created_at`, [chatId])

describe('T49 — envio de texto e idempotência', () => {
  it('AC-T49-01 texto chama WaGateway.send uma vez com o conteúdo e o client_message_id', async () => {
    const { chat, phone } = await inboundChat(env, a)
    const before = sentTo(a.sessionId).length
    const key = `idem-${rand()}`
    const res = await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'Olá! Como posso ajudar?' }, { 'idempotency-key': key })
    expect(res.status, res.text).toBe(201)
    expect(res.body.message.client_message_id).toBe(key)
    const sends = sentTo(a.sessionId).slice(before)
    expect(sends).toHaveLength(1)
    expect(sends[0].phone).toBe(phone)
    expect(JSON.stringify(sends[0].content)).toContain('Olá! Como posso ajudar?')
    expect(sends[0].actor).toBeTruthy()
  })

  it('AC-T49-01 reenviar a mesma requisição (mesmo Idempotency-Key) não duplica', async () => {
    const { chat } = await inboundChat(env, a)
    const before = sentTo(a.sessionId).length
    const key = `idem-${rand()}`
    const body = { type: 'text', text: `mensagem ${rand()}` }
    const first = await a.c.post(`/api/chats/${chat.id}/messages`, body, { 'idempotency-key': key })
    expect(first.status, first.text).toBe(201)
    const again = await a.c.post(`/api/chats/${chat.id}/messages`, body, { 'idempotency-key': key })
    expect([200, 201]).toContain(again.status)
    expect(again.body.message.id).toBe(first.body.message.id)
    expect(sentTo(a.sessionId).length - before).toBe(1)
    expect((await rows(chat.id)).filter((m: any) => m.direction === 'outbound')).toHaveLength(1)

    // chave diferente → novo envio
    const other = await a.c.post(`/api/chats/${chat.id}/messages`, body, { 'idempotency-key': `idem-${rand()}` })
    expect(other.status, other.text).toBe(201)
    expect(other.body.message.id).not.toBe(first.body.message.id)
    expect(sentTo(a.sessionId).length - before).toBe(2)
  })

  it('AC-T49-01 client_message_id no corpo também é idempotente', async () => {
    const { chat } = await inboundChat(env, a)
    const before = sentTo(a.sessionId).length
    const body = { type: 'text', text: 'via corpo', client_message_id: `cm-${rand()}` }
    const first = await a.c.post(`/api/chats/${chat.id}/messages`, body)
    const again = await a.c.post(`/api/chats/${chat.id}/messages`, body)
    expect(first.status, first.text).toBe(201)
    expect(again.body.message.id).toBe(first.body.message.id)
    expect(sentTo(a.sessionId).length - before).toBe(1)
  })

  it('AC-T49-01 GET /api/chats/:id/messages lista as mensagens do chat', async () => {
    const { chat } = await inboundChat(env, a)
    await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'resposta listada' })
    const res = await a.c.get(`/api/chats/${chat.id}/messages`)
    expect(res.status, res.text).toBe(200)
    expect(JSON.stringify(res.body)).toContain('resposta listada')
  })
})

describe('T49 — mídia', () => {
  it('AC-T49-02 arquivo acima do limite do tipo → 413', async () => {
    expectApiError(await upload(env, a, fakeFile('png', LIMITS.image + 1)), 'PAYLOAD_TOO_LARGE', 413)
    expectApiError(await upload(env, a, fakeFile('ogg', LIMITS.audio + 1)), 'PAYLOAD_TOO_LARGE', 413)
    expectApiError(await upload(env, a, fakeFile('pdf', LIMITS.document + 1)), 'PAYLOAD_TOO_LARGE', 413)
    // o limite é por tipo: um documento do tamanho que estoura imagem é aceito
    const doc = await upload(env, a, fakeFile('pdf', LIMITS.image + 1))
    expect(doc.status, doc.text).toBe(201)
  })

  it('AC-T49-02 mime não aceito → 415', async () => {
    expectApiError(await upload(env, a, fakeFile('exe', 1024)), 'UNSUPPORTED_MEDIA', 415)
  })

  it('AC-T49-02 áudio enviado como PTT é convertido para Ogg/Opus (conversor injetado) antes do gateway', async () => {
    const { chat } = await inboundChat(env, a)
    const up = await upload(env, a, fakeFile('mpeg', 4096))
    expect(up.status, up.text).toBe(201)
    const convBefore = env.converted.length
    const before = sentTo(a.sessionId).length

    const res = await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'audio', media_id: up.body.media.id, ptt: true })
    expect(res.status, res.text).toBe(201)
    expect(env.converted.length - convBefore).toBe(1)
    expect(env.converted.at(-1)!.mime).toBe('audio/mpeg')
    const sends = sentTo(a.sessionId).slice(before)
    expect(sends).toHaveLength(1)
    const content = JSON.stringify(sends[0].content)
    expect(content).toContain(OGG)
    expect(content).toMatch(/"ptt":\s*true/)
  })
})

describe('T49 — atribuição', () => {
  it('AC-T49-03 responder chat da fila sem responsável atribui ao remetente, muda para attending e registra first_human_reply_at', async () => {
    const { chat } = await inboundChat(env, a)
    expect(chat.status).toBe('waiting')
    expect(chat.assigned_user_id ?? null).toBeNull()
    expect(chat.first_human_reply_at ?? null).toBeNull()

    const r1 = await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'primeira resposta' })
    expect(r1.status, r1.text).toBe(201)
    const [after] = await env.q(`SELECT * FROM crm.chats WHERE id = $1`, [chat.id])
    expect(after.status).toBe('attending')
    expect(after.assigned_user_id).toBe(a.userId)
    expect(after.first_human_reply_at).not.toBeNull()
    expect(after.first_human_reply_by).toBe(a.userId)

    await new Promise((r) => setTimeout(r, 20))
    const r2 = await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'segunda resposta' })
    expect(r2.status, r2.text).toBe(201)
    const [later] = await env.q(`SELECT * FROM crm.chats WHERE id = $1`, [chat.id])
    expect(new Date(later.first_human_reply_at).getTime()).toBe(new Date(after.first_human_reply_at).getTime())
    expect(later.assigned_user_id).toBe(a.userId)
  })
})

describe('T49 — reação, apagar e falhas', () => {
  it('AC-T49-04 reação usa a chave (id do WhatsApp) da mensagem original', async () => {
    const { chat, msg, waId, phone } = await inboundChat(env, a)
    const before = sentTo(a.sessionId).length
    const res = await a.c.post(`/api/chats/${chat.id}/messages/${msg.id}/react`, { emoji: '👍' })
    expect(res.status, res.text).toBeLessThan(300)
    const sends = sentTo(a.sessionId).slice(before)
    expect(sends).toHaveLength(1)
    expect(sends[0].phone).toBe(phone)
    expect(sends[0].content).toEqual({ react: { messageId: waId, emoji: '👍' } })
  })

  it('AC-T49-04 apagar para todos chama deleteForEveryone', async () => {
    const { chat, phone } = await inboundChat(env, a)
    const waOut = `WAOUT-${rand(6)}`
    const [out] = await env.q(
      `INSERT INTO crm.messages (company_id, chat_id, direction, sender_type, type, body, status, wa_message_id)
       VALUES ($1, $2, 'outbound', 'user', 'text', 'vou apagar', 'sent', $3) RETURNING id`,
      [a.companyId, chat.id, waOut],
    )
    const before = sentTo(a.sessionId).length
    const res = await a.c.post(`/api/chats/${chat.id}/messages/${out.id}/delete`, {})
    expect(res.status, res.text).toBeLessThan(300)
    const sends = sentTo(a.sessionId).slice(before)
    expect(sends).toHaveLength(1)
    expect(sends[0].phone).toBe(phone)
    expect(sends[0].content).toEqual({ delete: { messageId: waOut } })
    const [row] = await env.q(`SELECT deleted_at FROM crm.messages WHERE id = $1`, [out.id])
    expect(row.deleted_at).not.toBeNull()
  })

  it('AC-T49-04 falha do gateway marca a mensagem failed e publica message.status', async () => {
    const { chat } = await inboundChat(env, a)
    const pubBefore = env.published.length
    env.gateway.failNext('RATE_LIMIT', 'rate limited')
    const res = await a.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'vai falhar' })
    const outs = (await rows(chat.id)).filter((m: any) => m.direction === 'outbound')
    expect(outs, `resposta ${res.status}: ${res.text}`).toHaveLength(1)
    expect(outs[0].status).toBe('failed')
    const pubs = env.published.slice(pubBefore).filter((p) => p.type === 'message.status')
    expect(pubs.length).toBeGreaterThan(0)
    expect(pubs.at(-1)!.companyId).toBe(a.companyId)
    expect(JSON.stringify(pubs.at(-1)!.data)).toContain('failed')
  })
})

describe('T49 — download de mídia', () => {
  it('AC-T49-05 GET /api/media/:id devolve o conteúdo com o mime correto', async () => {
    const file = fakeFile('png', 3000)
    const up = await upload(env, a, file)
    expect(up.status, up.text).toBe(201)
    const got = await download(env, a, `/api/media/${up.body.media.id}`)
    expect(got.status).toBe(200)
    expect(got.mime).toMatch(/^image\/png/)
    expect(got.bytes.equals(Buffer.from(await file.blob.arrayBuffer()))).toBe(true)
  })

  it('AC-T49-05 GET /api/media/:id de outra empresa → 404 (e id adulterado → 404)', async () => {
    const up = await upload(env, a, fakeFile('jpeg', 2000))
    expect(up.status, up.text).toBe(201)
    const b = await owner(env)
    expect((await download(env, b, `/api/media/${up.body.media.id}`)).status).toBe(404)
    const id: string = up.body.media.id
    const tampered = id.slice(0, -1) + (id.endsWith('a') ? 'b' : 'a')
    expect((await download(env, a, `/api/media/${tampered}`)).status).toBe(404)
  })
})

describe('T49 — conexão desconectada', () => {
  it('AC-T49-06 conexão desconectada → 409 SESSION_NOT_CONNECTED e a mensagem não é criada como enviada', async () => {
    const o = await owner(env)
    const { chat } = await inboundChat(env, o)
    await env.gateway.setSessionState(o.sessionId, 'DISCONNECTED')
    const before = sentTo(o.sessionId).length
    const res = await o.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'não vai' })
    expectApiError(res, 'SESSION_NOT_CONNECTED', 409)
    expect(sentTo(o.sessionId).length).toBe(before)
    const outs = (await rows(chat.id)).filter((m: any) => m.direction === 'outbound')
    expect(outs.filter((m: any) => ['queued', 'pending', 'processing', 'sent', 'delivered', 'read'].includes(m.status))).toEqual([])
  })

  it('AC-T49-06 conexão sem sessão resolvida → 409 SESSION_NOT_CONNECTED', async () => {
    const o = await owner(env)
    const { chat } = await inboundChat(env, o)
    env.sessions.delete(`${o.companyId}:${o.connectionId}`)
    expectApiError(await o.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'sem sessão' }), 'SESSION_NOT_CONNECTED', 409)
    const outs = (await rows(chat.id)).filter((m: any) => m.direction === 'outbound')
    expect(outs.filter((m: any) => m.status !== 'failed')).toEqual([])
  })
})
