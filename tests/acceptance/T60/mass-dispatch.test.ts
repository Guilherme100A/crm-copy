// AC-T60-01..05: cota (429 e only_first_n), validações e aviso de warm-up, público do manifesto, cancelamento e alvos.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import {
  body,
  byIds,
  fieldPaths,
  labelContact,
  newConnection,
  newContact,
  newFlow,
  newLabel,
  newMember,
  newOwner,
  postMultipart,
  quota,
  recipients,
  startEnv,
  type Env,
  type User,
} from './setup'

/** Limite por conexão desta suíte (banco descartável): cota de 1 conexão = 5. */
const PER = 5

let env: Env
beforeAll(async () => {
  env = await startEnv()
  for (const n of ['addMassDispatchBonus', 'setMassDispatchPerConnectionLimit']) if (typeof env.core[n] !== 'function') throw new Error(`@crm/core não exporta ${n}`)
  await env.core.setMassDispatchPerConnectionLimit(env.db, PER)
})
afterAll(async () => {
  await env?.close()
})

/** Empresa com 1 conexão conectada e 1 fluxo ativo. */
async function company() {
  const o = await newOwner(env)
  const conn = await newConnection(env, o.companyId)
  const flow = await newFlow(o)
  return { o, conn, flow, target: [{ connection_id: conn.id, flow_id: flow.id }] }
}

const create = (u: User, b: unknown) => u.c.post('/api/mass-dispatches', b)
async function contacts(o: User, n: number) {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await newContact(env, o.companyId, { name: `C${i}` }))
  return ids
}

describe('AC-T60-01 cota', () => {
  it('AC-T60-01 cota = conexões × limite por conexão + bônus', async () => {
    const { o } = await company()
    expect(await quota(o)).toMatchObject({ limit: PER, used: 0, remaining: PER, billable_slots: 1, per_instance_limit: PER, bonus: 0 })
    await newConnection(env, o.companyId, 'DISCONNECTED') // toda conexão conta
    await env.core.addMassDispatchBonus(env.db, o.companyId, 3)
    const q = await quota(o)
    expect(q).toMatchObject({ limit: 2 * PER + 3, used: 0, remaining: 2 * PER + 3, billable_slots: 2, bonus: 3 })
    expect(q.period).toMatch(/^\d{4}-\d{2}$/)
    const other = await newOwner(env)
    expect(await quota(other)).toMatchObject({ limit: 0, remaining: 0, billable_slots: 0 })
  })

  it('AC-T60-01 público maior que a cota restante → aviso only_first_n e só N destinatários (os primeiros)', async () => {
    const { o, target } = await company()
    const ids = await contacts(o, 8)
    const res = await create(o, body(target, byIds(ids), { name: 'Black Friday' }))
    expect(res.status, res.text).toBe(201)
    const md = res.body.mass_dispatch
    expect(md).toMatchObject({ name: 'Black Friday', status: 'preparing', total_count: PER, pending_count: PER })
    expect(res.body.warnings).toContainEqual(expect.objectContaining({ code: 'only_first_n', n: PER, total: 8 }))
    const rs = await recipients(o, md.id)
    const pending = rs.filter((r) => r.status === 'pending').map((r) => r.contact_id)
    expect(pending.sort()).toEqual(ids.slice(0, PER).sort())
    expect(env.jobs.prepared).toContain(md.id)
    expect(await quota(o)).toMatchObject({ used: PER, remaining: 0 })
  })

  it('AC-T60-01 sem cota restante → 429 QUOTA_EXCEEDED e nada é criado', async () => {
    const { o, target } = await company()
    const ids = await contacts(o, PER)
    expect((await create(o, body(target, byIds(ids)))).status).toBe(201)
    const before = (await o.c.get('/api/mass-dispatches')).body.items.length
    const more = await contacts(o, 2)
    expectApiError(await create(o, body(target, byIds(more))), 'QUOTA_EXCEEDED', 429)
    expect((await o.c.get('/api/mass-dispatches')).body.items.length).toBe(before)
    // empresa sem conexão: cota 0 → 429 só depois de validar os alvos; com alvo válido de bônus
    const fresh = await newOwner(env)
    const flow = await newFlow(fresh)
    const conn = await newConnection(env, fresh.companyId)
    await env.core.addMassDispatchBonus(env.db, fresh.companyId, -PER)
    const c1 = await newContact(env, fresh.companyId)
    expectApiError(await create(fresh, body([{ connection_id: conn.id, flow_id: flow.id }], byIds([c1]))), 'QUOTA_EXCEEDED', 429)
  })
})

describe('AC-T60-02 validações e warm-up', () => {
  it('AC-T60-02 interval_max < interval_min, janela vazia, sem dias da semana ou valores fora do intervalo → 422', async () => {
    const { o, target } = await company()
    const ids = await contacts(o, 2)
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ interval_min_seconds: 30, interval_max_seconds: 10 }, 'interval_max_seconds'],
      [{ interval_min_seconds: 0, interval_max_seconds: 121 }, 'interval_max_seconds'],
      [{ window_start: '10:00', window_end: '10:00' }, 'window'],
      [{ window_start: '18:00', window_end: '08:00' }, 'window'],
      [{ weekdays: [] }, 'weekdays'],
      [{ weekdays: [7] }, 'weekdays'],
      [{ daily_limit: 0 }, 'daily_limit'],
    ]
    for (const [extra, field] of cases) {
      const res = await create(o, body(target, byIds(ids), extra))
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(res).join(' '), JSON.stringify(extra)).toContain(field)
    }
    const noDays = body(target, byIds(ids)) as any
    delete noDays.weekdays
    expectApiError(await create(o, noDays), 'VALIDATION_ERROR', 422)
    expect((await o.c.get('/api/mass-dispatches')).body.items).toHaveLength(0)
    expect(await quota(o)).toMatchObject({ used: 0 })
    // intervalo fixo (min = max) é aceito
    expect((await create(o, body(target, byIds(ids), { interval_min_seconds: 10, interval_max_seconds: 10 }))).status).toBe(201)
  })

  it('AC-T60-02 limite diário acima da capacidade de warm-up das conexões gera aviso (soma das conexões-alvo)', async () => {
    const { o, conn, flow } = await company()
    await env.core.addMassDispatchBonus(env.db, o.companyId, 50)
    const conn2 = await newConnection(env, o.companyId)
    const ids = await contacts(o, 4)
    const one = [{ connection_id: conn.id, flow_id: flow.id }]
    const over = await create(o, body(one, byIds(ids.slice(0, 1)), { daily_limit: 21 }))
    expect(over.status, over.text).toBe(201)
    expect(over.body.warnings).toContainEqual(expect.objectContaining({ code: 'daily_limit_exceeds_warmup', daily_limit: 21, capacity: 20 }))
    const ok = await create(o, body(one, byIds(ids.slice(1, 2)), { daily_limit: 20 }))
    expect(ok.body.warnings.some((w: any) => w.code === 'daily_limit_exceeds_warmup')).toBe(false)

    const two = [...one, { connection_id: conn2.id, flow_id: flow.id }]
    const sum = await create(o, body(two, byIds(ids.slice(2, 3)), { daily_limit: 41 }))
    expect(sum.body.warnings).toContainEqual(expect.objectContaining({ code: 'daily_limit_exceeds_warmup', capacity: 40 }))
    const fits = await create(o, body(two, byIds(ids.slice(3, 4)), { daily_limit: 40 }))
    expect(fits.status, fits.text).toBe(201)
    expect(fits.body.warnings.some((w: any) => w.code === 'daily_limit_exceeds_warmup')).toBe(false)
    expect(fits.body.mass_dispatch.targets).toHaveLength(2)
  })
})

describe('AC-T60-03 público do manifesto', () => {
  it('AC-T60-03 all_except com filtros exclui os ids; opt-out entra como skipped; importado sem conversa é aceito', async () => {
    const { o, target } = await company()
    const L = await newLabel(env, o.companyId)
    const a = await newContact(env, o.companyId, { name: 'A' })
    const b = await newContact(env, o.companyId, { name: 'B' })
    const excluded = await newContact(env, o.companyId, { name: 'Excluído' })
    const opted = await newContact(env, o.companyId, { name: 'Opt-out', optOut: true })
    const imported = await newContact(env, o.companyId, { name: 'Importado', origin: 'import', consent: true })
    const lidOnly = await newContact(env, o.companyId, { name: 'Só LID', phone: null, lid: `${Date.now()}@lid` })
    const outside = await newContact(env, o.companyId, { name: 'Sem etiqueta' })
    for (const id of [a, b, excluded, opted, imported, lidOnly]) await labelContact(env, o.companyId, id, L)

    const res = await create(o, body(target, { version: 1, mode: 'all_except', filters: { label_ids: [L] }, except_ids: [excluded] }))
    expect(res.status, res.text).toBe(201)
    const md = res.body.mass_dispatch
    const rs = await recipients(o, md.id)
    const byContact = Object.fromEntries(rs.map((r) => [r.contact_id, r]))
    expect(Object.keys(byContact).sort()).toEqual([a, b, opted, imported, lidOnly].sort())
    expect(byContact[outside]).toBeUndefined()
    expect(byContact[excluded]).toBeUndefined()
    for (const id of [a, b, imported]) expect(byContact[id]).toMatchObject({ status: 'pending', variant: 'a' })
    expect(byContact[opted]).toMatchObject({ status: 'skipped', skip_reason: 'opt_out' })
    expect(byContact[lidOnly]).toMatchObject({ status: 'skipped', skip_reason: 'no_phone' })
    expect(md).toMatchObject({ total_count: 3, pending_count: 3, skipped_count: 2 })
    // skipped não consome cota
    expect(await quota(o)).toMatchObject({ used: 3, remaining: PER - 3 })
    expect((await recipients(o, md.id, 'skipped')).map((r) => r.contact_id).sort()).toEqual([opted, lidOnly].sort())
  })

  it('AC-T60-03 manifesto por ids (multipart) ignora contatos de outra empresa; público vazio → 422; A/B divide por variante', async () => {
    const { o, conn, flow, target } = await company()
    await env.core.addMassDispatchBonus(env.db, o.companyId, 40)
    const other = await newOwner(env)
    const foreign = await newContact(env, other.companyId)
    const mine = await newContact(env, o.companyId)
    const res = await postMultipart(env, o, body(target, byIds([mine, foreign]), { name: 'Multipart' }))
    expect(res.status, res.text).toBe(201)
    expect((await recipients(o, res.body.mass_dispatch.id)).map((r) => r.contact_id)).toEqual([mine])

    expectApiError(await create(o, body(target, byIds([foreign]))), 'VALIDATION_ERROR', 422)

    const flowB = await newFlow(o)
    const many = await contacts(o, 30)
    const ab = await create(o, body([{ connection_id: conn.id, flow_id: flow.id }], byIds(many), { flow_b_id: flowB.id }))
    expect(ab.status, ab.text).toBe(201)
    const variants = (await recipients(o, ab.body.mass_dispatch.id)).map((r) => r.variant)
    expect(new Set(variants)).toEqual(new Set(['a', 'b']))
    expect(ab.body.mass_dispatch.flow_b_id).toBe(flowB.id)
  })
})

describe('AC-T60-04 cancelamento', () => {
  it('AC-T60-04 cancelar devolve a cota dos não iniciados (released_count) e cancela os jobs pendentes', async () => {
    const { o, target } = await company()
    const ids = await contacts(o, PER)
    const md = (await create(o, body(target, byIds(ids)))).body.mass_dispatch
    expect(await quota(o)).toMatchObject({ used: PER, remaining: 0 })
    // a T74 já iniciou 2 destinatários
    const started = ids.slice(0, 2)
    await env.q(`UPDATE crm.mass_dispatch_recipients SET status = 'started', started_at = now() WHERE dispatch_id = $1 AND contact_id = ANY($2::uuid[])`, [md.id, started])

    const res = await o.c.post(`/api/mass-dispatches/${md.id}/cancel`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.released_count).toBe(PER - 2)
    expect(res.body.mass_dispatch.status).toBe('cancelled')
    expect(res.body.mass_dispatch.finished_at).toBeTruthy()
    expect(env.jobs.cancelled).toContain(md.id)
    expect(await quota(o)).toMatchObject({ used: 2, remaining: PER - 2 })
    const rs = await recipients(o, md.id)
    expect(rs.filter((r) => r.status === 'cancelled').map((r) => r.contact_id).sort()).toEqual(ids.slice(2).sort())
    expect(rs.filter((r) => r.status === 'started').map((r) => r.contact_id).sort()).toEqual(started.sort())
    expect((await o.c.get(`/api/mass-dispatches/${md.id}`)).body.mass_dispatch).toMatchObject({ status: 'cancelled', cancelled_count: PER - 2 })

    expectApiError(await o.c.post(`/api/mass-dispatches/${md.id}/cancel`), 'INVALID_TRANSITION', 409)
    // a cota devolvida permite novo disparo
    const more = await contacts(o, 3)
    const again = await create(o, body(target, byIds(more)))
    expect(again.status, again.text).toBe(201)
    expect(again.body.warnings.some((w: any) => w.code === 'only_first_n')).toBe(false)
  })

  it('AC-T60-04 permissões: member sem mass_dispatch.create não cria nem cancela; leitura com contacts.view; outra empresa → 404', async () => {
    const { o, target } = await company()
    const ids = await contacts(o, 2)
    const md = (await create(o, body(target, byIds(ids)))).body.mass_dispatch
    const member = await newMember(env, o.companyId, null)
    expectApiError(await create(member, body(target, byIds(ids))), 'FORBIDDEN', 403)
    expectApiError(await member.c.post(`/api/mass-dispatches/${md.id}/cancel`), 'FORBIDDEN', 403)
    const reader = await newMember(env, o.companyId, ['contacts.view'])
    expect((await reader.c.get(`/api/mass-dispatches/${md.id}`)).status).toBe(200)
    expect((await reader.c.get('/api/mass-dispatches/quota')).status).toBe(200)
    const admin = await newMember(env, o.companyId, null, 'admin')
    expect((await admin.c.post(`/api/mass-dispatches/${md.id}/cancel`)).status).toBe(200)
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/mass-dispatches/${md.id}`), 'NOT_FOUND', 404)
    expectApiError(await other.c.post(`/api/mass-dispatches/${md.id}/cancel`), 'NOT_FOUND', 404)
  })
})

describe('AC-T60-05 alvos', () => {
  it('AC-T60-05 fluxo precisa estar ativo e acionável (rascunho, pausado ou de outra empresa → 422)', async () => {
    const { o, conn } = await company()
    const ids = await contacts(o, 1)
    const draft = await newFlow(o, 'draft')
    const paused = await newFlow(o, 'paused')
    const other = await newOwner(env)
    const foreign = await newFlow(other)
    for (const f of [draft, paused, foreign]) {
      const res = await create(o, body([{ connection_id: conn.id, flow_id: f.id }], byIds(ids)))
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(fieldPaths(res).join(' ')).toContain('targets.0.flow_id')
    }
    const active = await newFlow(o)
    const badB = await create(o, body([{ connection_id: conn.id, flow_id: active.id }], byIds(ids), { flow_b_id: draft.id }))
    expectApiError(badB, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(badB).join(' ')).toContain('flow_b_id')
    expect(await quota(o)).toMatchObject({ used: 0 })
  })

  it('AC-T60-05 conexão desconectada (ou sem sessão) no alvo → 409; conexão de outra empresa → 422; válido devolve os alvos', async () => {
    const { o, conn, flow } = await company()
    await env.core.addMassDispatchBonus(env.db, o.companyId, 20)
    const ids = await contacts(o, 1)
    const down = await newConnection(env, o.companyId, 'DISCONNECTED')
    const ghost = await newConnection(env, o.companyId, null)
    for (const c of [down, ghost]) {
      const res = await create(o, body([{ connection_id: conn.id, flow_id: flow.id }, { connection_id: c.id, flow_id: flow.id }], byIds(ids)))
      expectApiError(res, 'SESSION_NOT_CONNECTED', 409)
      expect(res.body.error.details?.connection_id).toBe(c.id)
    }
    const other = await newOwner(env)
    const foreign = await newConnection(env, other.companyId)
    const fx = await create(o, body([{ connection_id: foreign.id, flow_id: flow.id }], byIds(ids)))
    expectApiError(fx, 'VALIDATION_ERROR', 422)
    expect(fieldPaths(fx).join(' ')).toContain('targets.0.connection_id')
    expect(await quota(o)).toMatchObject({ used: 0 })

    const warming = await newConnection(env, o.companyId, 'WARMING')
    const ok = await create(o, body([{ connection_id: warming.id, flow_id: flow.id }], byIds(ids)))
    expect(ok.status, ok.text).toBe(201)
    expect(ok.body.mass_dispatch.targets).toEqual([
      expect.objectContaining({ connection_id: warming.id, connection_name: warming.name, flow_id: flow.id, flow_name: flow.name, assigned_count: 1 }),
    ])
  })

  it('AC-T60-05 ordem das checagens: campos inválidos (422) antes do alvo; alvo (409) antes da cota (429)', async () => {
    const o = await newOwner(env)
    const flow = await newFlow(o)
    const down = await newConnection(env, o.companyId, 'DISCONNECTED')
    await env.core.addMassDispatchBonus(env.db, o.companyId, -PER) // cota 0
    const ids = await contacts(o, 1)
    const target = [{ connection_id: down.id, flow_id: flow.id }]
    expectApiError(await create(o, body(target, byIds(ids), { interval_min_seconds: 50, interval_max_seconds: 1 })), 'VALIDATION_ERROR', 422)
    expectApiError(await create(o, body(target, byIds(ids))), 'SESSION_NOT_CONNECTED', 409)
  })
})
