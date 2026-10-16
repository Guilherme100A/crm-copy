// AC-T43-01 (disparo manual, runs, cancelamento), AC-T43-04 (cancel-all por conexão) e a pausa/retomada da T30 pela API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { envelopeOf } from '../helpers/sse'
import { MIN, flowWith, msgDef, newChat, newConnection, newMember, newOwner, openEvents, runRow, sleep, startEnv, waitDef, type Env, type User } from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

const ACTIVE = ['running', 'waiting', 'paused']
const runsOfContact = async (contactId: string) => env.q(`SELECT id, status, flow_id FROM crm.flow_runs WHERE contact_id = $1 ORDER BY started_at`, [contactId])

describe('AC-T43-01 disparo manual', () => {
  it('AC-T43-01 trigger no fluxo ativo cria o run do chat, enfileira o flow-step e aparece nas listas', async () => {
    const flow = await flowWith(owner, msgDef())
    const chat = await newChat(env, owner.companyId)
    const res = await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId })
    expect(res.status, res.text).toBe(201)
    const run = res.body.run
    expect(run).toMatchObject({ flow_id: flow.id, contact_id: chat.contactId, chat_id: chat.chatId, status: 'running' })
    expect(res.body.cancelled_run_ids).toEqual([])
    expect(env.jobs).toContainEqual({ runId: run.id, expectedSeq: 0 })

    const db = await runRow(env, run.id)
    expect(db).toMatchObject({ status: 'running', chat_id: chat.chatId, contact_id: chat.contactId, flow_id: flow.id })

    const detail = await owner.c.get(`/api/flow-runs/${run.id}`)
    expect(detail.status, detail.text).toBe(200)
    expect(detail.body.run).toMatchObject({ id: run.id, flow_id: flow.id, flow_name: flow.name, chat_id: chat.chatId, status: 'running' })
    expect(Array.isArray(detail.body.steps)).toBe(true)

    const list = await owner.c.get(`/api/flows/${flow.id}/runs`)
    expect(list.status, list.text).toBe(200)
    expect(list.body.items.map((r: any) => r.id)).toContain(run.id)
    expect(list.body.page).toBeTruthy()

    const ofChat = await owner.c.get(`/api/chats/${chat.chatId}/flow-runs?active=1`)
    expect(ofChat.status, ofChat.text).toBe(200)
    expect(ofChat.body.items.map((r: any) => r.id)).toEqual([run.id])
  })

  it('AC-T43-01 novo disparo cancela o run ativo anterior do contato e publica flow_run.created/cancelled', async () => {
    const f1 = await flowWith(owner, msgDef())
    const f2 = await flowWith(owner, msgDef())
    const chat = await newChat(env, owner.companyId)
    const first = await owner.c.post(`/api/flows/${f1.id}/trigger`, { chat_id: chat.chatId })
    expect(first.status, first.text).toBe(201)
    const firstId = first.body.run.id

    const stream = await openEvents(env, owner, owner.companyId)
    try {
      const second = await owner.c.post(`/api/flows/${f2.id}/trigger`, { chat_id: chat.chatId })
      expect(second.status, second.text).toBe(201)
      const secondId = second.body.run.id
      expect(second.body.cancelled_run_ids).toEqual([firstId])
      expect((await runRow(env, firstId)).status).toBe('cancelled')
      expect((await runRow(env, secondId)).status).toBe('running')
      const active = (await runsOfContact(chat.contactId)).filter((r: any) => ACTIVE.includes(r.status))
      expect(active.map((r: any) => r.id)).toEqual([secondId])

      const cancelled = await stream.waitFor((m) => m.event === 'flow_run.cancelled' && envelopeOf(m).data?.run_id === firstId, 10_000)
      expect(envelopeOf(cancelled).data).toMatchObject({ run_id: firstId, flow_id: f1.id, chat_id: chat.chatId, contact_id: chat.contactId })
      const created = await stream.waitFor((m) => m.event === 'flow_run.created' && envelopeOf(m).data?.run_id === secondId, 10_000)
      expect(envelopeOf(created).data).toMatchObject({ run_id: secondId, flow_id: f2.id, chat_id: chat.chatId, contact_id: chat.contactId, status: 'running' })
    } finally {
      await stream.close()
    }
  })

  it('AC-T43-01 fluxo inativo (rascunho ou pausado) → 409 e nenhum run é criado nem cancelado', async () => {
    const chat = await newChat(env, owner.companyId)
    const ok = await flowWith(owner, msgDef())
    const prev = await owner.c.post(`/api/flows/${ok.id}/trigger`, { chat_id: chat.chatId })
    expect(prev.status, prev.text).toBe(201)

    const draft = await flowWith(owner, msgDef(), false)
    expectApiError(await owner.c.post(`/api/flows/${draft.id}/trigger`, { chat_id: chat.chatId }), 'CONFLICT', 409)

    const paused = await flowWith(owner, msgDef())
    expect((await owner.c.post(`/api/flows/${paused.id}/pause`)).status).toBe(200)
    expectApiError(await owner.c.post(`/api/flows/${paused.id}/trigger`, { chat_id: chat.chatId }), 'CONFLICT', 409)

    const runs = await runsOfContact(chat.contactId)
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('running')
  })

  it('AC-T43-01 chat de outra empresa → 404; sem flows.run → 403; com flows.run → 201', async () => {
    const flow = await flowWith(owner, msgDef())
    const other = await newOwner(env)
    const foreign = await newChat(env, other.companyId)
    expectApiError(await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: foreign.chatId }), 'NOT_FOUND', 404)
    expect(await runsOfContact(foreign.contactId)).toHaveLength(0)

    const chat = await newChat(env, owner.companyId)
    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    expectApiError(await viewer.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId }), 'FORBIDDEN', 403)
    const runner = await newMember(env, owner.companyId, ['flows.view', 'flows.run'])
    const res = await runner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId })
    expect(res.status, res.text).toBe(201)
    expectApiError(await viewer.c.post(`/api/flow-runs/${res.body.run.id}/cancel`), 'FORBIDDEN', 403)
    // run de outra empresa não vaza
    expectApiError(await other.c.get(`/api/flow-runs/${res.body.run.id}`), 'NOT_FOUND', 404)
    // matriz padrão: member (sem lista explícita) tem flows.run — dispara e cancela
    const attendant = await newMember(env, owner.companyId, null)
    const chat2 = await newChat(env, owner.companyId)
    const byMember = await attendant.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat2.chatId })
    expect(byMember.status, byMember.text).toBe(201)
    expect((await attendant.c.post(`/api/flow-runs/${byMember.body.run.id}/cancel`)).status).toBe(200)
  })

  it('AC-T43-01 cancelar o run pela API: status cancelled, timer removido; cancelar de novo → 409', async () => {
    const flow = await flowWith(owner, waitDef())
    const chat = await newChat(env, owner.companyId)
    const res = await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId })
    expect(res.status, res.text).toBe(201)
    const runId = res.body.run.id
    await env.engine.step(runId, 0)
    expect((await runRow(env, runId)).status).toBe('waiting')
    expect(env.timers.scheduled.some((s) => s.data.runId === runId)).toBe(true)

    const cancel = await owner.c.post(`/api/flow-runs/${runId}/cancel`)
    expect(cancel.status, cancel.text).toBe(200)
    expect(cancel.body.run).toMatchObject({ id: runId, status: 'cancelled' })
    expect((await runRow(env, runId)).status).toBe('cancelled')
    expect(env.timers.cancelled.some((d) => d.runId === runId)).toBe(true)
    expectApiError(await owner.c.post(`/api/flow-runs/${runId}/cancel`), 'CONFLICT', 409)
    const ofChat = await owner.c.get(`/api/chats/${chat.chatId}/flow-runs?active=1`)
    expect(ofChat.body.items).toHaveLength(0)
  })
})

describe('AC-T43-01 pausa e retomada pela API (T30)', () => {
  it('AC-T43-01 pausar o fluxo pela API congela o run em espera (timer não avança) e ativar reagenda com o restante', async () => {
    const flow = await flowWith(owner, waitDef())
    const chat = await newChat(env, owner.companyId)
    const res = await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId })
    expect(res.status, res.text).toBe(201)
    const runId = res.body.run.id
    await env.engine.step(runId, 0)
    const waiting = await runRow(env, runId)
    expect(waiting).toMatchObject({ status: 'waiting', current_node_key: 'W' })
    const gen0 = { runId, seq: waiting.seq, gen: 0 }

    // simula 40 min já decorridos: restam 20 min do prazo de 1 h
    const remaining = 20 * MIN
    await env.q(`UPDATE crm.flow_runs SET wait = jsonb_set(wait, '{deadline_at}', to_jsonb($2::text)) WHERE id = $1`, [runId, new Date(Date.now() + remaining).toISOString()])

    const paused = await owner.c.post(`/api/flows/${flow.id}/pause`)
    expect(paused.status, paused.text).toBe(200)
    expect(paused.body.flow.status).toBe('paused')
    expect((await runRow(env, runId)).status).toBe('paused')
    expect(env.timers.cancelled.some((d) => d.runId === runId)).toBe(true)
    const detail = await owner.c.get(`/api/flow-runs/${runId}`)
    expect(detail.body.run.status).toBe('paused')

    // o timer antigo dispara com o fluxo pausado: nada avança
    expect((await env.control.fireTimer(gen0)).advanced).toBe(false)
    expect(await runRow(env, runId)).toMatchObject({ status: 'paused', current_node_key: 'W' })

    await sleep(1_500)
    const scheduledBefore = env.timers.scheduled.length
    const before = Date.now()
    const resumed = await owner.c.post(`/api/flows/${flow.id}/activate`)
    expect(resumed.status, resumed.text).toBe(200)
    expect(resumed.body.flow.status).toBe('active')
    const back = await runRow(env, runId)
    expect(back.status).toBe('waiting')
    const newDeadline = Date.parse(back.wait.deadline_at)
    // prazo novo = agora + restante (não o prazo cheio de 1 h, nem o prazo antigo)
    expect(newDeadline - before).toBeGreaterThan(remaining - 5_000)
    expect(newDeadline - Date.now()).toBeLessThan(remaining + 5_000)

    const fresh = env.timers.scheduled.slice(scheduledBefore).filter((s) => s.data.runId === runId)
    expect(fresh).toHaveLength(1)
    expect(Math.abs(fresh[0]!.delayMs - remaining)).toBeLessThan(5_000)
    expect(fresh[0]!.data.gen).toBeGreaterThan(0)

    // timer da geração antiga continua no-op; o novo segue o timeout
    expect((await env.control.fireTimer(gen0)).advanced).toBe(false)
    expect(await env.control.fireTimer(fresh[0]!.data)).toMatchObject({ advanced: true, handle: 'timeout' })
    expect((await runRow(env, runId)).current_node_key).toBe('T')
  })
})

describe('AC-T43-04 cancelar todos os runs de uma conexão', () => {
  it('AC-T43-04 nome errado ou com outra caixa → 422 sem cancelar; conexão desconhecida → 404', async () => {
    const flow = await flowWith(owner, msgDef())
    const conn = newConnection(env, owner.companyId, 'Loja Centro')
    const chat = await newChat(env, owner.companyId, conn.id)
    const run = await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: chat.chatId })
    expect(run.status, run.text).toBe(201)

    for (const wrong of ['Loja', 'loja centro', '', 'Loja Centro!']) {
      const res = await owner.c.post(`/api/connections/${conn.id}/cancel-all-flow-runs`, { confirmation_name: wrong })
      expectApiError(res, 'VALIDATION_ERROR', 422)
    }
    expectApiError(await owner.c.post(`/api/connections/${conn.id}/cancel-all-flow-runs`, {}), 'VALIDATION_ERROR', 422)
    expect((await runRow(env, run.body.run.id)).status).toBe('running')

    expectApiError(await owner.c.post(`/api/connections/${uuid()}/cancel-all-flow-runs`, { confirmation_name: 'Loja Centro' }), 'NOT_FOUND', 404)
    // conexão de outra empresa → 404
    const other = await newOwner(env)
    const foreign = newConnection(env, other.companyId, 'Loja Centro')
    expectApiError(await owner.c.post(`/api/connections/${foreign.id}/cancel-all-flow-runs`, { confirmation_name: 'Loja Centro' }), 'NOT_FOUND', 404)
  })

  it('AC-T43-04 com o nome exato cancela só os runs ativos daquela conexão', async () => {
    const flow = await flowWith(owner, msgDef())
    const waitFlow = await flowWith(owner, waitDef())
    const target = newConnection(env, owner.companyId, 'Atendimento Sul')
    const keep = newConnection(env, owner.companyId, 'Atendimento Norte')
    const a = await newChat(env, owner.companyId, target.id)
    const b = await newChat(env, owner.companyId, target.id)
    const c = await newChat(env, owner.companyId, keep.id)
    const ra = (await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: a.chatId })).body.run.id
    const rb = (await owner.c.post(`/api/flows/${waitFlow.id}/trigger`, { chat_id: b.chatId })).body.run.id
    await env.engine.step(rb, 0)
    expect((await runRow(env, rb)).status).toBe('waiting')
    const rc = (await owner.c.post(`/api/flows/${flow.id}/trigger`, { chat_id: c.chatId })).body.run.id

    const viewer = await newMember(env, owner.companyId, ['flows.view'])
    expectApiError(await viewer.c.post(`/api/connections/${target.id}/cancel-all-flow-runs`, { confirmation_name: target.name }), 'FORBIDDEN', 403)

    const res = await owner.c.post(`/api/connections/${target.id}/cancel-all-flow-runs`, { confirmation_name: 'Atendimento Sul' })
    expect(res.status, res.text).toBe(200)
    expect(res.body.cancelled).toBe(2)
    expect((await runRow(env, ra)).status).toBe('cancelled')
    expect((await runRow(env, rb)).status).toBe('cancelled')
    expect(env.timers.cancelled.some((d) => d.runId === rb)).toBe(true)
    expect((await runRow(env, rc)).status).toBe('running')

    // repetir não cancela mais nada
    const again = await owner.c.post(`/api/connections/${target.id}/cancel-all-flow-runs`, { confirmation_name: 'Atendimento Sul' })
    expect(again.status, again.text).toBe(200)
    expect(again.body.cancelled).toBe(0)
  })
})
