// AC-T31-01/03/04 via HTTP: departamentos, vínculos de membros, FK de chats, horários por conexão, 409 de fluxo referenciado,
// chatScopeFor e filtro de escopo de departamento no SSE.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { connectSse, envelopeOf, sleep, summary, type SseConnection } from '../helpers/sse'
import { addMember, createDepartment, type Env, fieldPaths, insertChat, insertFlow, newConnection, newOwner, startEnv, uuid } from './setup'

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

describe('T31 — departamentos', () => {
  it('AC-T31-01 lista paginada com 20 por página', async () => {
    const o = await newOwner(env)
    for (let i = 0; i < 25; i++) await createDepartment(o.c, `Depto ${String(i).padStart(2, '0')}`)
    const p1 = await o.c.get('/api/departments?page=1')
    expect(p1.status, p1.text).toBe(200)
    expect(p1.body.items).toHaveLength(20)
    expect(p1.body.page).toMatchObject({ page: 1, limit: 20, total_count: 25, total_pages: 2, has_more: true })
    const p2 = await o.c.get('/api/departments?page=2')
    expect(p2.body.items).toHaveLength(5)
    expect(p2.body.page.has_more).toBe(false)
    const ids = new Set([...p1.body.items, ...p2.body.items].map((d: any) => d.id))
    expect(ids.size).toBe(25)
    expect((await o.c.get('/api/departments/all')).body.items).toHaveLength(25)
  })

  it('AC-T31-01 busca por nome ignora caixa e acento', async () => {
    const o = await newOwner(env)
    await createDepartment(o.c, 'Cobrança')
    await createDepartment(o.c, 'Vendas')
    await createDepartment(o.c, 'Suporte Técnico')
    const r1 = await o.c.get('/api/departments?search=cobranca')
    expect(r1.body.items.map((d: any) => d.name)).toEqual(['Cobrança'])
    const r2 = await o.c.get('/api/departments?search=TECNICO')
    expect(r2.body.items.map((d: any) => d.name)).toEqual(['Suporte Técnico'])
    expect(r2.body.page.total_count).toBe(1)
  })

  it('AC-T31-01 departamentos de outra empresa não aparecem nem são acessíveis', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const d = await createDepartment(a.c, 'Só da A')
    expect((await b.c.get('/api/departments/all')).body.items).toHaveLength(0)
    expectApiError(await b.c.get(`/api/departments/${d.id}`), 'NOT_FOUND', 404)
  })

  it('AC-T31-01 cor padrão #3B82F6 e hex válido normalizado', async () => {
    const o = await newOwner(env)
    expect((await createDepartment(o.c, 'Sem cor')).color).toBe('#3B82F6')
    expect((await createDepartment(o.c, 'Minúscula', '#ef4444')).color).toBe('#EF4444')
    expect((await createDepartment(o.c, 'Curta', '#abc')).color).toBe('#AABBCC')
  })

  it.each(['azul', '#12345', '#GGGGGG', '3B82F6', 'rgb(1,2,3)'])('AC-T31-01 cor fora de hex (%s) → 422 no campo color', async (color) => {
    const o = await newOwner(env)
    const res = await o.c.post('/api/departments', { name: 'Cor ruim', color })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('color')
    const d = await createDepartment(o.c, 'Ok')
    const patch = await o.c.patch(`/api/departments/${d.id}`, { color })
    expectApiError(patch, 'VALIDATION_ERROR', 422)
    expect((await o.c.get(`/api/departments/${d.id}`)).body.department.color).toBe('#3B82F6')
  })

  it('AC-T31-01 excluir o departamento remove os vínculos dos membros', async () => {
    const o = await newOwner(env)
    const m = await addMember(env, o, 'member')
    const d1 = await createDepartment(o.c, 'Some')
    const d2 = await createDepartment(o.c, 'Fica')
    const put = await o.c.put(`/api/departments/members/${m.memberId}/scope`, { department_ids: [d1.id, d2.id], connection_ids: [] })
    expect(put.status, put.text).toBe(200)
    expect([...put.body.scope.department_ids].sort()).toEqual([d1.id, d2.id].sort())

    const del = await o.c.delete(`/api/departments/${d1.id}`)
    expect(del.status, del.text).toBeLessThan(300)
    const scope = await o.c.get(`/api/departments/members/${m.memberId}/scope`)
    expect(scope.body.scope.department_ids).toEqual([d2.id])
    expect(await env.q(`SELECT 1 FROM crm.member_departments WHERE department_id = $1`, [d1.id])).toHaveLength(0)
    expectApiError(await o.c.get(`/api/departments/${d1.id}`), 'NOT_FOUND', 404)
  })

  it('AC-T31-01 FK chats.department_id: departamento inexistente é recusado; excluir o departamento zera o campo do chat', async () => {
    const o = await newOwner(env)
    const err = await insertChat(env, o.companyId, uuid()).then(
      () => null,
      (e: any) => e,
    )
    expect(err?.code, 'INSERT com department_id inexistente deveria violar a FK').toBe('23503')

    const d = await createDepartment(o.c, 'Com chat')
    const chatId = await insertChat(env, o.companyId, d.id)
    expect((await o.c.delete(`/api/departments/${d.id}`)).status).toBeLessThan(300)
    const [chat] = await env.q(`SELECT department_id FROM crm.chats WHERE id = $1`, [chatId])
    expect(chat, 'o chat não pode ser apagado junto').toBeTruthy()
    expect(chat.department_id).toBeNull()
  })
})

describe('T31 — horários de atendimento', () => {
  const hours = (list: Array<[number, string, string]>) => list.map(([day_of_week, start_time, end_time]) => ({ day_of_week, start_time, end_time, active: true }))

  it('AC-T31-03 config ativa com ação message sem texto → 422 message_text', async () => {
    const o = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    for (const message_text of [undefined, '', '   ']) {
      const res = await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'message', message_text, business_hours: hours([[1, '09:00', '18:00']]) })
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(res)).toContain('message_text')
    }
  })

  it('AC-T31-03 config ativa com ação flow sem fluxo (ou fluxo de outra empresa) → 422 flow_id', async () => {
    const o = await newOwner(env)
    const other = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    const none = await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'flow', business_hours: hours([[1, '09:00', '18:00']]) })
    expectApiError(none, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(none)).toContain('flow_id')
    const foreign = await insertFlow(env, other.companyId)
    const res = await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'flow', flow_id: foreign, business_hours: hours([[1, '09:00', '18:00']]) })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res)).toContain('flow_id')
  })

  it('AC-T31-03 PUT substitui config e intervalos', async () => {
    const o = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    const first = await o.c.put(`/api/business-hours/${conn}`, {
      active: true,
      action_type: 'message',
      message_text: 'Estamos fechados',
      business_hours: hours([
        [1, '08:00', '12:00'],
        [1, '13:00', '18:00'],
        [2, '09:00', '17:00'],
      ]),
    })
    expect(first.status, first.text).toBe(200)
    expect(first.body.config.business_hours).toHaveLength(3)

    const flowId = await insertFlow(env, o.companyId)
    const second = await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'flow', flow_id: flowId, business_hours: hours([[5, '10:00', '14:00']]) })
    expect(second.status, second.text).toBe(200)
    const got = (await o.c.get(`/api/business-hours/${conn}`)).body.config
    expect(got.action_type).toBe('flow')
    expect(got.flow_id).toBe(flowId)
    expect(got.business_hours.map((h: any) => [h.day_of_week, h.start_time, h.end_time])).toEqual([[5, '10:00', '14:00']])
  })

  it.each([
    ['start_time', { day_of_week: 1, start_time: '25:00', end_time: '26:00', active: true }],
    ['end_time', { day_of_week: 1, start_time: '18:00', end_time: '09:00', active: true }],
    ['day_of_week', { day_of_week: 7, start_time: '09:00', end_time: '10:00', active: true }],
  ])('AC-T31-03 PUT com intervalo inválido (%s) → 422 e a config anterior fica intacta (transação)', async (_field, bad) => {
    const o = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    const okBody = { active: true, action_type: 'message', message_text: 'Volte amanhã', business_hours: hours([[1, '09:00', '18:00']]) }
    expect((await o.c.put(`/api/business-hours/${conn}`, okBody)).status).toBe(200)
    const before = (await o.c.get(`/api/business-hours/${conn}`)).body.config

    const res = await o.c.put(`/api/business-hours/${conn}`, {
      active: true,
      action_type: 'message',
      message_text: 'Texto novo',
      business_hours: [{ day_of_week: 3, start_time: '08:00', end_time: '12:00', active: true }, bad],
    })
    expectApiError(res, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(res).some((p: string) => p.startsWith('business_hours.1')), fieldPaths(res).join(',')).toBe(true)
    const after = (await o.c.get(`/api/business-hours/${conn}`)).body.config
    expect(after.message_text).toBe('Volte amanhã')
    expect(after.business_hours.map((h: any) => [h.day_of_week, h.start_time, h.end_time])).toEqual(
      before.business_hours.map((h: any) => [h.day_of_week, h.start_time, h.end_time]),
    )
  })

  it('AC-T31-03 config de horário de outra empresa não vaza', async () => {
    const a = await newOwner(env)
    const b = await newOwner(env)
    const conn = await newConnection(env, a.companyId)
    await a.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'message', message_text: 'Fechado A', business_hours: hours([[1, '09:00', '18:00']]) })
    const got = await b.c.get(`/api/business-hours/${conn}`)
    expect(got.body?.config?.message_text ?? null).not.toBe('Fechado A')
  })

  it('AC-T31-03 DELETE de fluxo referenciado por horário de atendimento → 409 com a referência', async () => {
    const o = await newOwner(env)
    const conn = await newConnection(env, o.companyId)
    const flowId = await insertFlow(env, o.companyId)
    const put = await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'flow', flow_id: flowId, business_hours: hours([[1, '09:00', '18:00']]) })
    expect(put.status, put.text).toBe(200)

    const del = await o.c.delete(`/api/flows/${flowId}`)
    expectApiError(del, 'CONFLICT', 409)
    expect(JSON.stringify(del.body.error.details ?? {})).toContain('business_hour_config')
    expect(await env.q(`SELECT 1 FROM crm.flows WHERE id = $1`, [flowId])).toHaveLength(1)

    // inativa com o fluxo ainda conta como referência
    await o.c.put(`/api/business-hours/${conn}`, { active: false, action_type: 'flow', flow_id: flowId, business_hours: [] })
    expectApiError(await o.c.delete(`/api/flows/${flowId}`), 'CONFLICT', 409)

    // trocar a ação libera a exclusão
    await o.c.put(`/api/business-hours/${conn}`, { active: true, action_type: 'message', message_text: 'Fechado', business_hours: [] })
    expect((await o.c.delete(`/api/flows/${flowId}`)).status).toBeLessThan(300)
  })
})

describe('T31 — escopo de chat', () => {
  it('AC-T31-04 chatScopeFor: membro com departamentos/conexões devolve só esses', () => {
    const s = env.core.chatScopeFor({ role: 'member', department_ids: ['d1', 'd2'], connection_ids: ['c1'] })
    expect(s.departments).toEqual(['d1', 'd2'])
    expect(s.connections).toEqual(['c1'])
    const onlyDept = env.core.chatScopeFor({ role: 'member', department_ids: ['d9'], connection_ids: [] })
    expect(onlyDept).toEqual({ departments: ['d9'], connections: 'all' })
  })

  it('AC-T31-04 chatScopeFor: membro sem seleção devolve "todos"', () => {
    expect(env.core.chatScopeFor({ role: 'member', department_ids: [], connection_ids: [] })).toEqual({ departments: 'all', connections: 'all' })
    expect(env.core.chatScopeFor({ role: 'member' })).toEqual({ departments: 'all', connections: 'all' })
  })

  it('AC-T31-04 chatScopeFor: owner/admin sempre "todos", mesmo com seleção', () => {
    for (const role of ['owner', 'admin'])
      expect(env.core.chatScopeFor({ role, department_ids: ['d1'], connection_ids: ['c1'] })).toEqual({ departments: 'all', connections: 'all' })
  })

  it('AC-T31-04 SSE: evento com escopo de departamento só chega a quem tem o departamento (owner sempre)', async () => {
    const o = await newOwner(env)
    const inside = await addMember(env, o, 'member')
    const outside = await addMember(env, o, 'member')
    const free = await addMember(env, o, 'member')
    const dA = await createDepartment(o.c, 'Dentro')
    const dB = await createDepartment(o.c, 'Fora')
    expect((await o.c.put(`/api/departments/members/${inside.memberId}/scope`, { department_ids: [dA.id], connection_ids: [] })).status).toBe(200)
    expect((await o.c.put(`/api/departments/members/${outside.memberId}/scope`, { department_ids: [dB.id], connection_ids: [] })).status).toBe(200)

    const openFor = async (cookie: string) => {
      const s = await connectSse((p, init) => env.app.request(p, init), `/api/events?company_id=${o.companyId}`, { cookie })
      if (s.status !== 200) throw new Error(`SSE ${s.status}: ${s.text}`)
      open.push(s)
      await s.waitFor((m) => m.event === 'ping', 10_000)
      return s
    }
    const so = await openFor(o.cookie)
    const si = await openFor(inside.cookie)
    const sx = await openFor(outside.cookie)
    const sf = await openFor(free.cookie)

    const named = (n: string) => (m: any) => m.event === 'company.updated' && envelopeOf(m).data?.name === n
    await env.publisher.publish(o.companyId, 'company.updated', { name: 'escopo-A' }, { scope: { department_id: dA.id } })
    await env.publisher.publish(o.companyId, 'company.updated', { name: 'marcador' })

    await so.waitFor(named('escopo-A'))
    await si.waitFor(named('escopo-A'))
    await sf.waitFor(named('escopo-A'))
    await sx.waitFor(named('marcador'))
    await sleep(200)
    expect(sx.events().some(named('escopo-A')), summary(sx.messages)).toBe(false)
  })
})
