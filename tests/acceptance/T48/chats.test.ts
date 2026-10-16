// AC-T48-01..06 — lista de chats com escopo, filtros, ciclo de vida, transferência (espião + SSE), notas e contadores.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { connectSse, sleep, summary, type SseConnection } from '../helpers/sse'
import { addMember, clientOn, department, type Env, fieldPaths, listAll, newOwner, seedChat, setScope, startEnv } from './setup'

let env: Env
const open: SseConnection[] = []

beforeAll(async () => {
  env = await startEnv()
})
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})
afterAll(async () => {
  await env?.close()
})

describe('T48 — escopo', () => {
  it('AC-T48-01 membro com escopo do departamento X não vê chats de Y na lista nem nos contadores; owner vê todos', async () => {
    const o = await newOwner(env)
    const x = await department(o)
    const y = await department(o)
    const m = await addMember(env, o, 'member', ['chat.view'])
    await setScope(o, m.memberId, [x])
    const cx = await seedChat(env, o.companyId, { departmentId: x })
    const cy1 = await seedChat(env, o.companyId, { departmentId: y })
    const cy2 = await seedChat(env, o.companyId, { departmentId: y, status: 'attending' })

    const mine = await listAll(m.c)
    expect(mine.ids).toContain(cx)
    expect(mine.ids).not.toContain(cy1)
    expect(mine.ids).not.toContain(cy2)
    expect(mine.counts).toEqual({ waiting: 1, attending: 0, resolved: 0 })
    expect((await m.c.get('/api/chats/counts')).body.counts).toEqual({ waiting: 1, attending: 0, resolved: 0 })

    const all = await listAll(o.c)
    expect(all.ids).toEqual(expect.arrayContaining([cx, cy1, cy2]))
    expect(all.counts).toEqual({ waiting: 2, attending: 1, resolved: 0 })
  })

  it('AC-T48-01 detalhe e ações num chat de outro departamento → 404 para o membro', async () => {
    const o = await newOwner(env)
    const x = await department(o)
    const y = await department(o)
    const m = await addMember(env, o, 'member', ['chat.view', 'chat.assign_others', 'chat.block'])
    await setScope(o, m.memberId, [x])
    const cy = await seedChat(env, o.companyId, { departmentId: y })
    expectApiError(await m.c.get(`/api/chats/${cy}`), 'NOT_FOUND', 404)
    expectApiError(await m.c.patch(`/api/chats/${cy}/assign`, {}), 'NOT_FOUND', 404)
    expectApiError(await m.c.post(`/api/chats/${cy}/resolve`, {}), 'NOT_FOUND', 404)
    expectApiError(await m.c.post(`/api/chats/${cy}/notes`, { body: 'oi' }), 'NOT_FOUND', 404)
    expect((await o.c.get(`/api/chats/${cy}`)).status).toBe(200)
  })

  it('AC-T48-01 chat de outra empresa → 404 até para o owner', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const chat = await seedChat(env, b.companyId)
    expectApiError(await a.c.get(`/api/chats/${chat}`), 'NOT_FOUND', 404)
    expect((await listAll(a.c)).ids).not.toContain(chat)
  })
})

describe('T48 — filtros', () => {
  it('AC-T48-02 "não respondidas" traz só chats cuja última mensagem é do contato', async () => {
    const o = await newOwner(env)
    const lastIn = await seedChat(env, o.companyId, { messages: ['in'] })
    const lastInAfterOut = await seedChat(env, o.companyId, { messages: ['in', 'out', 'in'] })
    const lastOut = await seedChat(env, o.companyId, { messages: ['in', 'out'] })
    const noMsgs = await seedChat(env, o.companyId)

    const un = await listAll(o.c, 'response_status=unanswered')
    expect(un.ids.sort()).toEqual([lastIn, lastInAfterOut].sort())
    const ans = await listAll(o.c, 'response_status=answered')
    expect(ans.ids).toContain(lastOut)
    expect(ans.ids).not.toContain(lastIn)
    expect(un.ids).not.toContain(noMsgs)
  })

  it('AC-T48-02 nota interna não conta como resposta', async () => {
    const o = await newOwner(env)
    const chat = await seedChat(env, o.companyId, { messages: ['in'] })
    expect((await o.c.post(`/api/chats/${chat}/notes`, { body: 'vou ver isso' })).status).toBe(201)
    expect((await listAll(o.c, 'response_status=unanswered')).ids).toContain(chat)
  })

  it('AC-T48-02 período exige início e fim (senão 422)', async () => {
    const o = await newOwner(env)
    const onlyFrom = await o.c.get('/api/chats?created_from=2026-09-01T00:00:00Z')
    expectApiError(onlyFrom, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(onlyFrom)).toContain('created_to')
    const onlyTo = await o.c.get('/api/chats?created_to=2026-09-30T23:59:59Z')
    expectApiError(onlyTo, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(onlyTo)).toContain('created_from')
    expectApiError(await o.c.get('/api/chats/counts?created_from=2026-09-01T00:00:00Z'), 'VALIDATION_ERROR', 422)
  })

  it('AC-T48-02 período com início e fim filtra pela data de criação (inclusivo)', async () => {
    const o = await newOwner(env)
    const before = await seedChat(env, o.companyId, { createdAt: '2026-08-31T23:59:59Z' })
    const start = await seedChat(env, o.companyId, { createdAt: '2026-09-01T00:00:00Z' })
    const mid = await seedChat(env, o.companyId, { createdAt: '2026-09-15T10:00:00Z' })
    const end = await seedChat(env, o.companyId, { createdAt: '2026-09-30T23:59:59Z' })
    const after = await seedChat(env, o.companyId, { createdAt: '2026-10-01T00:00:00Z' })
    const r = await listAll(o.c, 'created_from=2026-09-01T00:00:00Z&created_to=2026-09-30T23:59:59Z')
    expect(r.ids.sort()).toEqual([start, mid, end].sort())
    expect(r.ids).not.toContain(before)
    expect(r.ids).not.toContain(after)
  })

  it('AC-T48-02 busca casa nome parcial (sem caixa/acento) e telefone parcial', async () => {
    const o = await newOwner(env)
    const joao = await seedChat(env, o.companyId, { name: 'João Pereira', phone: '+5511999887766' })
    const maria = await seedChat(env, o.companyId, { name: 'Maria Souza', phone: '+5521988776655' })
    expect((await listAll(o.c, 'search=joao')).ids).toEqual([joao])
    expect((await listAll(o.c, 'search=PEREI')).ids).toEqual([joao])
    expect((await listAll(o.c, 'search=99988')).ids).toEqual([joao])
    expect((await listAll(o.c, `search=${encodeURIComponent('(21) 98877')}`)).ids).toEqual([maria])
    expect((await listAll(o.c, 'search=ninguem-aqui')).ids).toEqual([])
  })
})

describe('T48 — ciclo de vida', () => {
  it('AC-T48-03 assumir chat de outro atendente exige chat.assign_others (senão 403)', async () => {
    const o = await newOwner(env)
    const a = await addMember(env, o, 'member', ['chat.view'])
    const b = await addMember(env, o, 'member', ['chat.view'])
    const boss = await addMember(env, o, 'member', ['chat.view', 'chat.assign_others'])
    const chat = await seedChat(env, o.companyId)

    const take = await a.c.patch(`/api/chats/${chat}/assign`, {})
    expect(take.status, take.text).toBe(200)
    expect(take.body.chat.assigned_user_id).toBe(a.userId)
    expect(take.body.chat.status).toBe('attending')

    expectApiError(await b.c.patch(`/api/chats/${chat}/assign`, {}), 'FORBIDDEN', 403)
    expectApiError(await b.c.patch(`/api/chats/${chat}/assign`, { user_id: b.userId }), 'FORBIDDEN', 403)
    expect((await o.c.get(`/api/chats/${chat}`)).body.chat.assigned_user_id).toBe(a.userId)

    const steal = await boss.c.patch(`/api/chats/${chat}/assign`, {})
    expect(steal.status, steal.text).toBe(200)
    expect(steal.body.chat.assigned_user_id).toBe(boss.userId)
  })

  it('AC-T48-03 atribuir chat livre a outra pessoa também exige chat.assign_others', async () => {
    const o = await newOwner(env)
    const a = await addMember(env, o, 'member', ['chat.view'])
    const b = await addMember(env, o, 'member', ['chat.view'])
    const chat = await seedChat(env, o.companyId)
    expectApiError(await a.c.patch(`/api/chats/${chat}/assign`, { user_id: b.userId }), 'FORBIDDEN', 403)
    const byOwner = await o.c.patch(`/api/chats/${chat}/assign`, { user_id: b.userId })
    expect(byOwner.status, byOwner.text).toBe(200)
    expect(byOwner.body.chat.assigned_user_id).toBe(b.userId)
  })

  it('AC-T48-03 resolve grava resolved_at; reopen volta a waiting', async () => {
    const o = await newOwner(env)
    const chat = await seedChat(env, o.companyId)
    await o.c.patch(`/api/chats/${chat}/assign`, {})
    const res = await o.c.post(`/api/chats/${chat}/resolve`, {})
    expect(res.status, res.text).toBe(200)
    expect(res.body.chat.status).toBe('resolved')
    expect(res.body.chat.resolved_at).toBeTruthy()
    const [row] = await env.q(`SELECT status, resolved_at FROM crm.chats WHERE id = $1`, [chat])
    expect(row.status).toBe('resolved')
    expect(row.resolved_at).toBeTruthy()

    const re = await o.c.post(`/api/chats/${chat}/reopen`, {})
    expect(re.status, re.text).toBe(200)
    expect(re.body.chat.status).toBe('waiting')
    expect(re.body.chat.resolved_at ?? null).toBeNull()
  })

  it('AC-T48-03 transições inválidas → 409', async () => {
    const o = await newOwner(env)
    const waiting = await seedChat(env, o.companyId)
    expectApiError(await o.c.post(`/api/chats/${waiting}/reopen`, {}), 'INVALID_TRANSITION', 409)
    expectApiError(await o.c.post(`/api/chats/${waiting}/unassign`, {}), 'INVALID_TRANSITION', 409)

    const resolved = await seedChat(env, o.companyId, { status: 'resolved' })
    expectApiError(await o.c.post(`/api/chats/${resolved}/resolve`, {}), 'INVALID_TRANSITION', 409)
    expectApiError(await o.c.patch(`/api/chats/${resolved}/assign`, {}), 'INVALID_TRANSITION', 409)

    const attending = await seedChat(env, o.companyId)
    await o.c.patch(`/api/chats/${attending}/assign`, {})
    expectApiError(await o.c.post(`/api/chats/${attending}/reopen`, {}), 'INVALID_TRANSITION', 409)
  })
})

describe('T48 — transferência de departamento', () => {
  it('AC-T48-04 transferir departamento publica chat.updated e o chat some da lista de quem perde o escopo', async () => {
    const o = await newOwner(env)
    const x = await department(o)
    const y = await department(o)
    const mx = await addMember(env, o, 'member', ['chat.view'])
    const my = await addMember(env, o, 'member', ['chat.view'])
    await setScope(o, mx.memberId, [x])
    await setScope(o, my.memberId, [y])
    const chat = await seedChat(env, o.companyId, { departmentId: x })
    expect((await listAll(mx.c)).ids).toContain(chat)
    expect((await listAll(my.c)).ids).not.toContain(chat)

    const before = env.published.length
    const res = await o.c.patch(`/api/chats/${chat}`, { department_id: y })
    expect(res.status, res.text).toBe(200)
    expect(res.body.chat.department_id).toBe(y)
    const ev = env.published.slice(before).find((p) => p.type === 'chat.updated')
    expect(ev, JSON.stringify(env.published.slice(before).map((p) => p.type))).toBeTruthy()
    expect(ev!.companyId).toBe(o.companyId)
    expect(JSON.stringify(ev!.data)).toContain(chat)
    expect(ev!.opts?.scope?.department_id).toBe(y)

    expect((await listAll(mx.c)).ids).not.toContain(chat)
    expectApiError(await mx.c.get(`/api/chats/${chat}`), 'NOT_FOUND', 404)
    expect((await listAll(my.c)).ids).toContain(chat)
  })

  it('AC-T48-04 no SSE, quem perde o escopo não recebe o chat.updated da transferência (quem ganha recebe)', async () => {
    const o = await newOwner(env)
    const x = await department(o)
    const y = await department(o)
    const mx = await addMember(env, o, 'member', ['chat.view'])
    const my = await addMember(env, o, 'member', ['chat.view'])
    await setScope(o, mx.memberId, [x])
    await setScope(o, my.memberId, [y])
    const chat = await seedChat(env, o.companyId, { departmentId: x })

    const openFor = async (cookie: string) => {
      const s = await connectSse((p, init) => env.sseApp.request(p, init), `/api/events?company_id=${o.companyId}`, { cookie })
      if (s.status !== 200) throw new Error(`SSE ${s.status}: ${s.text}`)
      open.push(s)
      await s.waitFor((m) => m.event === 'ping', 10_000)
      return s
    }
    const sx = await openFor(mx.cookie)
    const sy = await openFor(my.cookie)
    const so = await openFor(o.cookie)

    const ownerSse = clientOn(env.sseApp, o.cookie, o.companyId)
    const res = await ownerSse.patch(`/api/chats/${chat}`, { department_id: y })
    expect(res.status, res.text).toBe(200)
    const isUpdate = (m: any) => m.event === 'chat.updated' && m.data.includes(chat)
    await sy.waitFor(isUpdate)
    await so.waitFor(isUpdate)
    await sleep(300)
    expect(sx.events().some(isUpdate), summary(sx.messages)).toBe(false)

    // eventos seguintes do chat também não chegam a quem perdeu o escopo
    await ownerSse.patch(`/api/chats/${chat}/assign`, {})
    await sleep(300)
    expect(sx.events().some((m) => m.data.includes(chat)), summary(sx.messages)).toBe(false)
  })
})

describe('T48 — notas internas', () => {
  it('AC-T48-05 nota interna não chama o gateway e aparece no histórico com autor', async () => {
    const o = await newOwner(env)
    const m = await addMember(env, o, 'member', ['chat.view'])
    const chat = await seedChat(env, o.companyId, { messages: ['in'] })
    const sentBefore = env.gateway.sent.length

    const res = await m.c.post(`/api/chats/${chat}/notes`, { body: 'Cliente pediu desconto, verificar com gerente' })
    expect(res.status, res.text).toBe(201)
    expect(res.body.note.author.id).toBe(m.userId)
    expect(env.gateway.sent.length).toBe(sentBefore)

    const notes = await o.c.get(`/api/chats/${chat}/notes`)
    expect(notes.body.items.map((n: any) => n.body)).toContain('Cliente pediu desconto, verificar com gerente')

    const hist = await o.c.get(`/api/chats/${chat}/events`)
    expect(hist.status, hist.text).toBe(200)
    const ev = hist.body.items.find((e: any) => e.type === 'note_added')
    expect(ev, JSON.stringify(hist.body.items)).toBeTruthy()
    expect(ev.actor).toMatchObject({ id: m.userId, name: m.name })
    expect(JSON.stringify(ev.detail)).toContain('Cliente pediu desconto')
  })

  it('AC-T48-05 nota não vira mensagem do WhatsApp nem altera o chat como resposta', async () => {
    const o = await newOwner(env)
    const chat = await seedChat(env, o.companyId, { messages: ['in'] })
    const msgsBefore = await env.q(`SELECT count(*)::int AS n FROM crm.messages WHERE chat_id = $1`, [chat])
    const note = await o.c.post(`/api/chats/${chat}/notes`, { body: 'só interno' })
    expect(note.status, note.text).toBe(201)
    const msgsAfter = await env.q(`SELECT count(*)::int AS n FROM crm.messages WHERE chat_id = $1`, [chat])
    expect(msgsAfter[0].n).toBe(msgsBefore[0].n)
    expect(env.gateway.sent.some((s: any) => JSON.stringify(s).includes('só interno'))).toBe(false)
  })
})

describe('T48 — contadores por aba', () => {
  async function seedMix(companyId: string, deptA: string, deptB: string) {
    const plan: Array<[string, 'waiting' | 'attending' | 'resolved', Array<'in' | 'out'>]> = [
      [deptA, 'waiting', ['in']],
      [deptA, 'waiting', ['in', 'out']],
      [deptA, 'attending', ['in']],
      [deptA, 'attending', ['out']],
      [deptA, 'resolved', ['in', 'out']],
      [deptB, 'waiting', ['in']],
      [deptB, 'attending', ['in']],
      [deptB, 'resolved', ['in']],
    ]
    for (const [d, status, messages] of plan) await seedChat(env, companyId, { departmentId: d, status, messages })
    // volume para paginar (15 por página)
    for (let i = 0; i < 20; i++) await seedChat(env, companyId, { departmentId: deptA, status: 'waiting', messages: ['in'] })
  }

  it('AC-T48-06 contadores por aba batem com a lista sob os mesmos filtros (com paginação)', async () => {
    const o = await newOwner(env)
    const a = await department(o)
    const b = await department(o)
    await seedMix(o.companyId, a, b)
    for (const filter of ['', `department_ids=${a}`, 'response_status=unanswered', `department_ids=${b}&response_status=unanswered`]) {
      const sep = filter ? '&' : ''
      const counts = (await o.c.get(`/api/chats/counts?${filter}`)).body.counts
      for (const status of ['waiting', 'attending', 'resolved']) {
        const r = await listAll(o.c, `${filter}${sep}status=${status}`)
        expect(r.items.every((x: any) => x.status === status)).toBe(true)
        expect(r.items.length, `${status} com "${filter}"`).toBe(counts[status])
        expect(r.counts[status], `counts da lista ${status} com "${filter}"`).toBe(counts[status])
      }
    }
  })

  it('AC-T48-06 primeira página tem 15 itens e o cursor não repete nem pula chats', async () => {
    const o = await newOwner(env)
    const a = await department(o)
    const b = await department(o)
    await seedMix(o.companyId, a, b)
    const p1 = await o.c.get('/api/chats?status=waiting')
    expect(p1.body.items).toHaveLength(15)
    const all = await listAll(o.c, 'status=waiting')
    expect(new Set(all.ids).size).toBe(all.ids.length)
    expect(all.ids.length).toBe(p1.body.counts.waiting)
  })

  it('AC-T48-06 contadores do membro com escopo batem com a lista dele', async () => {
    const o = await newOwner(env)
    const a = await department(o)
    const b = await department(o)
    await seedMix(o.companyId, a, b)
    const m = await addMember(env, o, 'member', ['chat.view'])
    await setScope(o, m.memberId, [b])
    const counts = (await m.c.get('/api/chats/counts')).body.counts
    expect(counts).toEqual({ waiting: 1, attending: 1, resolved: 1 })
    for (const status of ['waiting', 'attending', 'resolved']) expect((await listAll(m.c, `status=${status}`)).items.length).toBe(counts[status])
  })
})
