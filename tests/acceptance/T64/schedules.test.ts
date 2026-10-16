// AC-T64-01..04 — agendamento de mensagem/fluxo: limites de data, execução pelo pipeline e criação de run,
// recorrência e cancelamento/listagem.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { addMember, DAY, type Env, fieldPaths, inFuture, localParts, MIN, newChat, newFlow, newOwner, schedule, startEnv } from './setup'

let env: Env

beforeAll(async () => {
  env = await startEnv()
})
afterAll(async () => {
  await env?.close()
})

const jobId = (s: { id: string; run_at: string }) => `schedule-${s.id}-${Date.parse(s.run_at)}`
const mentions = (job: unknown, s: { id: string; run_at: string }) => {
  const j = JSON.stringify(job)
  return j.includes(s.id) && (j.includes(jobId(s)) || j.includes(String(Date.parse(s.run_at))) || j.includes(s.run_at))
}

describe('T64 — limites de data', () => {
  it('AC-T64-01 agendar mensagem para daqui a 1 hora e até 31 dias → 201', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s1 = await schedule(o, chat.id, { kind: 'message', text: 'lembrete', run_at: inFuture(60 * MIN) })
    expect(s1).toMatchObject({ kind: 'message', status: 'pending', recurrence: 'one_off', chat_id: chat.id })
    const s31 = await schedule(o, chat.id, { kind: 'message', text: 'no limite', run_at: inFuture(31 * DAY - MIN) })
    expect(s31.status).toBe('pending')
    // a criação enfileira o job delayed
    expect(env.jobs.added.some((a) => mentions(a.job, s1))).toBe(true)
  })

  it('AC-T64-01 agendar fluxo ativo → 201; fluxo não publicado → 422', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const flowId = await newFlow(o, 'active')
    const s = await schedule(o, chat.id, { kind: 'flow', flow_id: flowId, run_at: inFuture(2 * DAY) })
    expect(s).toMatchObject({ kind: 'flow', flow_id: flowId, status: 'pending' })
    const draft = await newFlow(o, 'draft')
    const res = await o.c.post(`/api/chats/${chat.id}/schedules`, { kind: 'flow', flow_id: draft, run_at: inFuture(2 * DAY) })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('flow_id')
  })

  it.each([
    ['acima de 31 dias', () => inFuture(31 * DAY + 60 * MIN)],
    ['no passado', () => new Date(Date.now() - 60 * MIN).toISOString()],
    ['agora', () => new Date().toISOString()],
  ])('AC-T64-01 data %s → 422 em run_at', async (_label, when) => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    for (const body of [
      { kind: 'message', text: 'x', run_at: when() },
      { kind: 'flow', flow_id: await newFlow(o), run_at: when() },
    ]) {
      const res = await o.c.post(`/api/chats/${chat.id}/schedules`, body)
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(res)).toContain('run_at')
    }
    expect((await o.c.get(`/api/chats/${chat.id}/schedules`)).body.items).toHaveLength(0)
  })
})

describe('T64 — execução', () => {
  it('AC-T64-02 na hora, a mensagem sai pelo WaGateway e o agendamento fica sent', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s = await schedule(o, chat.id, { kind: 'message', text: 'Seu horário é amanhã às 10h', run_at: inFuture(30 * MIN) })
    const before = env.gateway.sent.length
    const r = await env.run(s.id, s.run_at)
    expect(r.executed, JSON.stringify(r)).toBe(true)
    expect(r.status).toBe('sent')
    const sends = env.gateway.sent.slice(before)
    expect(sends).toHaveLength(1)
    expect(JSON.stringify(sends[0].content)).toContain('Seu horário é amanhã às 10h')
    expect(String(sends[0].phone).replace(/\D/g, '')).toBe(chat.phone.replace(/\D/g, ''))
    const [msg] = await env.q(`SELECT direction, body FROM crm.messages WHERE id = $1`, [r.message_id])
    expect(msg).toMatchObject({ direction: 'outbound', body: 'Seu horário é amanhã às 10h' })
    const got = (await o.c.get(`/api/schedules/${s.id}`)).body.schedule
    expect(got.status).toBe('sent')
    expect(got.last_message_id).toBe(r.message_id)
  })

  it('AC-T64-02 executar de novo o mesmo agendamento não reenvia', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s = await schedule(o, chat.id, { kind: 'message', text: 'uma vez só', run_at: inFuture(30 * MIN) })
    await env.run(s.id, s.run_at)
    const before = env.gateway.sent.length
    const again = await env.run(s.id, s.run_at)
    expect(again.executed).toBe(false)
    expect(env.gateway.sent.length).toBe(before)
  })

  it('AC-T64-02 fluxo agendado cria o run', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const flowId = await newFlow(o)
    const s = await schedule(o, chat.id, { kind: 'flow', flow_id: flowId, run_at: inFuture(3 * 60 * MIN) })
    const r = await env.run(s.id, s.run_at)
    expect(r.executed, JSON.stringify(r)).toBe(true)
    expect(r.flow_run_id).toBeTruthy()
    const [run] = await env.q(`SELECT flow_id, chat_id, contact_id, trigger FROM crm.flow_runs WHERE id = $1`, [r.flow_run_id])
    expect(run).toMatchObject({ flow_id: flowId, chat_id: chat.id, contact_id: chat.contactId })
    expect(JSON.stringify(run.trigger)).toContain(s.id)
    const got = (await o.c.get(`/api/schedules/${s.id}`)).body.schedule
    expect(got.status).toBe('sent')
    expect(got.last_flow_run_id).toBe(r.flow_run_id)
  })
})

describe('T64 — recorrência', () => {
  function addMonth(iso: string) {
    const p = localParts(iso)
    const y = p.m === 12 ? p.y + 1 : p.y
    const m = p.m === 12 ? 1 : p.m + 1
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
    const d = Math.min(p.d, last)
    // America/Sao_Paulo sem horário de verão (UTC-3)
    return new Date(Date.UTC(y, m - 1, d, p.h + 3, p.min)).toISOString()
  }

  it.each([
    ['daily', (iso: string) => new Date(Date.parse(iso) + DAY).toISOString()],
    ['weekly', (iso: string) => new Date(Date.parse(iso) + 7 * DAY).toISOString()],
    ['monthly', addMonth],
  ] as const)('AC-T64-03 recorrência %s reagenda a próxima ocorrência após executar', async (recurrence, next) => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s = await schedule(o, chat.id, { kind: 'message', text: `recorrente ${recurrence}`, run_at: inFuture(2 * 60 * MIN), recurrence })
    const before = env.gateway.sent.length
    const enqBefore = env.enqueued.length
    const r = await env.run(s.id, s.run_at)
    expect(r.executed, JSON.stringify(r)).toBe(true)
    expect(env.gateway.sent.length).toBe(before + 1)

    const expected = next(s.run_at)
    const got = (await o.c.get(`/api/schedules/${s.id}`)).body.schedule
    expect(got.status).toBe('pending')
    expect(Date.parse(got.run_at)).toBe(Date.parse(expected))
    expect(got.run_count).toBe(1)
    expect(got.last_run_at).toBeTruthy()
    expect(Date.parse(r.next_run_at)).toBe(Date.parse(expected))
    // mesma hora local
    expect([localParts(got.run_at).h, localParts(got.run_at).min]).toEqual([localParts(s.run_at).h, localParts(s.run_at).min])

    // novo job enfileirado para a próxima ocorrência, com o atraso até ela
    const enq = env.enqueued.slice(enqBefore)
    expect(enq.length).toBe(1)
    expect(mentions(enq[0]!.job, { id: s.id, run_at: got.run_at })).toBe(true)
    expect(Math.abs(enq[0]!.delayMs - (Date.parse(got.run_at) - Date.parse(s.run_at)))).toBeLessThan(5_000)

    // a próxima ocorrência também executa e avança de novo
    const r2 = await env.run(s.id, got.run_at)
    expect(r2.executed).toBe(true)
    const got2 = (await o.c.get(`/api/schedules/${s.id}`)).body.schedule
    expect(got2.run_count).toBe(2)
    expect(Date.parse(got2.run_at)).toBe(Date.parse(next(got.run_at)))
  })

  it('AC-T64-03 execução atrasada de uma ocorrência antiga (job velho) não envia', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s = await schedule(o, chat.id, { kind: 'message', text: 'diário', run_at: inFuture(60 * MIN), recurrence: 'daily' })
    await env.run(s.id, s.run_at)
    const before = env.gateway.sent.length
    const stale = await env.run(s.id, s.run_at, new Date(Date.parse(s.run_at) + 60 * MIN))
    expect(stale.executed).toBe(false)
    expect(env.gateway.sent.length).toBe(before)
  })
})

describe('T64 — cancelar e listar', () => {
  it('AC-T64-04 cancelar remove o job e o agendamento não executa mais', async () => {
    const o = await newOwner(env)
    const chat = await newChat(env, o)
    const s = await schedule(o, chat.id, { kind: 'message', text: 'vou cancelar', run_at: inFuture(5 * 60 * MIN) })
    expect(env.jobs.added.some((a) => mentions(a.job, s))).toBe(true)
    const res = await o.c.delete(`/api/schedules/${s.id}`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.schedule.status).toBe('cancelled')
    expect(env.jobs.removed.some((j) => mentions(j, s)), JSON.stringify(env.jobs.removed.slice(-2))).toBe(true)

    const before = env.gateway.sent.length
    const r = await env.run(s.id, s.run_at)
    expect(r).toMatchObject({ executed: false, reason: 'not_pending' })
    expect(env.gateway.sent.length).toBe(before)
    expectApiError(await o.c.delete(`/api/schedules/${s.id}`), 'CONFLICT', 409)
  })

  it('AC-T64-04 GET /api/schedules filtra por chat e status', async () => {
    const o = await newOwner(env)
    const a = await newChat(env, o)
    const b = await newChat(env, o)
    const a1 = await schedule(o, a.id, { kind: 'message', text: 'a1', run_at: inFuture(60 * MIN) })
    const a2 = await schedule(o, a.id, { kind: 'message', text: 'a2', run_at: inFuture(2 * 60 * MIN) })
    const b1 = await schedule(o, b.id, { kind: 'message', text: 'b1', run_at: inFuture(3 * 60 * MIN) })
    await o.c.delete(`/api/schedules/${a2.id}`)
    await env.run(b1.id, b1.run_at)

    const ids = async (qs: string) => ((await o.c.get(`/api/schedules?${qs}`)).body.items ?? []).map((x: any) => x.id).sort()
    expect(await ids(`chat_id=${a.id}`)).toEqual([a1.id, a2.id].sort())
    expect(await ids(`chat_id=${b.id}`)).toEqual([b1.id])
    expect(await ids('status=cancelled')).toEqual([a2.id])
    expect(await ids('status=sent')).toEqual([b1.id])
    expect(await ids(`chat_id=${a.id}&status=pending`)).toEqual([a1.id])
    const byChat = (await o.c.get(`/api/chats/${a.id}/schedules?status=pending`)).body.items.map((x: any) => x.id)
    expect(byChat).toEqual([a1.id])
  })

  it('AC-T64-04 chat fora do escopo (ou de outra empresa) → 404 em criar, listar, detalhe e cancelar', async () => {
    const o = await newOwner(env)
    const dept = await o.c.post('/api/departments', { name: 'Vendas' })
    const other = await o.c.post('/api/departments', { name: 'Suporte' })
    const chat = await newChat(env, o)
    await env.q(`UPDATE crm.chats SET department_id = $2 WHERE id = $1`, [chat.id, other.body.department.id])
    const s = await schedule(o, chat.id, { kind: 'message', text: 'só do owner', run_at: inFuture(60 * MIN) })
    const m = await addMember(env, o)
    const scope = await o.c.put(`/api/departments/members/${m.memberId}/scope`, { department_ids: [dept.body.department.id], connection_ids: [] })
    expect(scope.status, scope.text).toBe(200)

    expectApiError(await m.c.post(`/api/chats/${chat.id}/schedules`, { kind: 'message', text: 'x', run_at: inFuture(60 * MIN) }), 'NOT_FOUND', 404)
    expectApiError(await m.c.get(`/api/schedules/${s.id}`), 'NOT_FOUND', 404)
    expectApiError(await m.c.delete(`/api/schedules/${s.id}`), 'NOT_FOUND', 404)
    expect((await m.c.get('/api/schedules')).body.items.map((x: any) => x.id)).not.toContain(s.id)

    const stranger = await newOwner(env)
    expectApiError(await stranger.c.get(`/api/schedules/${s.id}`), 'NOT_FOUND', 404)
    expect((await o.c.get(`/api/schedules/${s.id}`)).body.schedule.status).toBe('pending')
  })
})
