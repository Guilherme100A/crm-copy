// AC-T119-01..03 — escopo de chat nas rotas de mensagens e mídia: fora do escopo → 404 sem efeito colateral.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { addMember, chatIn, department, type Env, newOwner, type Owner, setScope, sideEffects, startEnv, upload } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

interface Scene {
  o: Owner
  x: string
  y: string
  chatX: Awaited<ReturnType<typeof chatIn>>
  chatY: Awaited<ReturnType<typeof chatIn>>
}

async function scene(): Promise<Scene> {
  const o = await newOwner(env)
  const x = await department(o)
  const y = await department(o)
  return { o, x, y, chatX: await chatIn(env, o, x), chatY: await chatIn(env, o, y) }
}

/** Todas as ações do AC-T119-01 contra um chat, devolvendo o status de cada uma. */
async function everyAction(actor: { c: any; cookie: string; companyId: string }, chat: Scene['chatY']) {
  const mediaId = await upload(env, actor as any)
  const out: Record<string, { status: number; text: string }> = {}
  const keep = (name: string, r: { status: number; text: string }) => (out[name] = { status: r.status, text: r.text })
  keep('listar', await actor.c.get(`/api/chats/${chat.id}/messages`))
  keep('enviar texto', await actor.c.post(`/api/chats/${chat.id}/messages`, { type: 'text', text: 'resposta' }))
  keep('enviar mídia', await actor.c.post(`/api/chats/${chat.id}/messages`, { type: 'image', media_id: mediaId, caption: 'foto' }))
  keep('marcar lido', await actor.c.post(`/api/chats/${chat.id}/read`, {}))
  keep('reagir', await actor.c.post(`/api/chats/${chat.id}/messages/${chat.inboundId}/react`, { emoji: '👍' }))
  keep('apagar', await actor.c.post(`/api/chats/${chat.id}/messages/${chat.outboundId}/delete`, {}))
  return out
}

describe('T119 — fora do escopo', () => {
  it('AC-T119-01 membro do departamento X recebe 404 em todas as ações num chat de Y, sem nada gravado nem enviado', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const before = await sideEffects(env, s.chatY.id)

    const results = await everyAction(m, s.chatY)
    for (const [action, r] of Object.entries(results)) {
      expect(r.status, `${action}: ${r.text}`).toBe(404)
      expect(JSON.parse(r.text).error.code, action).toBe('NOT_FOUND')
    }
    const after = await sideEffects(env, s.chatY.id)
    expect(after.sent, 'FakeWaGateway registrou envio').toBe(before.sent)
    expect(after.reads, 'FakeWaGateway registrou leitura').toBe(before.reads)
    expect(after.messages, 'mensagem gravada no chat fora do escopo').toBe(before.messages)
    expect(after.deleted).toBe(before.deleted)
    expect(after.unread).toBe(before.unread)
  })

  it('AC-T119-01 a resposta 404 não revela o conteúdo do chat', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const res = await m.c.get(`/api/chats/${s.chatY.id}/messages`)
    expectApiError(res, 'NOT_FOUND', 404)
    expect(res.text).not.toContain('mensagem para apagar')
    expect(res.text).not.toContain('olá')
  })

  it('AC-T119-01 no próprio departamento o mesmo membro consegue (sanidade do cenário)', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const r = await m.c.get(`/api/chats/${s.chatX.id}/messages`)
    expect(r.status, r.text).toBe(200)
    const send = await m.c.post(`/api/chats/${s.chatX.id}/messages`, { type: 'text', text: 'oi do escopo' })
    expect(send.status, send.text).toBe(201)
  })
})

describe('T119 — dentro do escopo', () => {
  async function expectAllOk(actor: any, chat: Scene['chatY']) {
    const sentBefore = env.gateway.sent.length
    const results = await everyAction(actor, chat)
    for (const [action, r] of Object.entries(results)) expect(r.status, `${action}: ${r.text}`).toBeLessThan(300)
    // texto, mídia, reação e apagar passam pelo gateway
    expect(env.gateway.sent.length - sentBefore).toBeGreaterThanOrEqual(4)
  }

  it('AC-T119-02 owner consegue todas as ações em qualquer departamento', async () => {
    const s = await scene()
    await expectAllOk(s.o, s.chatY)
  })

  it('AC-T119-02 admin consegue todas as ações mesmo com departamentos selecionados', async () => {
    const s = await scene()
    const admin = await addMember(env, s.o, 'admin', null)
    await setScope(s.o, admin.memberId, [s.x])
    await expectAllOk(admin, s.chatY)
  })

  it('AC-T119-02 membro sem restrição de departamento consegue todas as ações', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await expectAllOk(m, s.chatY)
  })

  it('AC-T119-02 membro passa a ver o chat assim que ganha o escopo', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    expectApiError(await m.c.get(`/api/chats/${s.chatY.id}/messages`), 'NOT_FOUND', 404)
    await setScope(s.o, m.memberId, [s.x, s.y])
    const r = await m.c.get(`/api/chats/${s.chatY.id}/messages`)
    expect(r.status, r.text).toBe(200)
    const send = await m.c.post(`/api/chats/${s.chatY.id}/messages`, { type: 'text', text: 'agora vejo' })
    expect(send.status, send.text).toBe(201)
  })
})

describe('T119 — encaminhar', () => {
  it('AC-T119-03 encaminhar mensagem de um chat fora do escopo → 404 e nada é enviado', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const before = await sideEffects(env, s.chatX.id)
    const res = await m.c.post(`/api/chats/${s.chatY.id}/messages/${s.chatY.inboundId}/forward`, { chat_id: s.chatX.id })
    expectApiError(res, 'NOT_FOUND', 404)
    const after = await sideEffects(env, s.chatX.id)
    expect(after.sent).toBe(before.sent)
    expect(after.messages).toBe(before.messages)
  })

  it('AC-T119-03 encaminhar para um chat DESTINO fora do escopo → 404 e nada é gravado nem enviado', async () => {
    const s = await scene()
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const before = await sideEffects(env, s.chatY.id)
    const res = await m.c.post(`/api/chats/${s.chatX.id}/messages/${s.chatX.inboundId}/forward`, { chat_id: s.chatY.id })
    expectApiError(res, 'NOT_FOUND', 404)
    const after = await sideEffects(env, s.chatY.id)
    expect(after.sent).toBe(before.sent)
    expect(after.messages).toBe(before.messages)
  })

  it('AC-T119-03 encaminhar dentro do escopo funciona (sanidade)', async () => {
    const s = await scene()
    const other = await chatIn(env, s.o, s.x)
    const m = await addMember(env, s.o, 'member')
    await setScope(s.o, m.memberId, [s.x])
    const res = await m.c.post(`/api/chats/${s.chatX.id}/messages/${s.chatX.inboundId}/forward`, { chat_id: other.id })
    expect(res.status, res.text).toBe(201)
  })
})
