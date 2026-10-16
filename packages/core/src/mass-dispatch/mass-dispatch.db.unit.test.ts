// Postgres real + FakeWaGateway: cota, público (opt-out skipped, só N), alvos, warm-up e cancelamento.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { createDb, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { MassDispatchError } from './rules'
import { MassDispatchService, addMassDispatchBonus, setMassDispatchPerConnectionLimit } from './service'

let tmp: TempDatabase
let db: Database
let wa: FakeWaGateway
let svc: MassDispatchService
const prepared: string[] = []
const cancelled: string[] = []
let n = 0

beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 4 })
  wa = new FakeWaGateway()
  svc = new MassDispatchService({
    db,
    waGateway: wa,
    jobs: { enqueuePrepare: async (id) => void prepared.push(id), cancel: async (id) => void cancelled.push(id) },
  })
  await setMassDispatchPerConnectionLimit(db, 3)
}, 60_000)
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
}, 60_000)

const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute(q)).rows[0] as T

async function world(state: 'STABLE' | 'DISCONNECTED' = 'STABLE') {
  n += 1
  const co = await one<{ id: string }>(sql`insert into crm.companies (name, slug) values (${`C${n}`}, ${`c-t60-${n}-${Date.now()}`}) returning id`)
  const session = `s-t60-${n}-${Date.now()}`
  wa.addSession({ id: session, name: session, state })
  const conn = await one<{ id: string }>(sql`insert into crm.connections (company_id, session_id, name) values (${co.id}, ${session}, 'Número teste') returning id`)
  const flow = await one<{ id: string }>(sql`insert into crm.flows (company_id, name, status, published_version) values (${co.id}, 'Fluxo', 'active', 1) returning id`)
  return { co: co.id, conn: conn.id, flow: flow.id, actor: { companyId: co.id, userId: null } }
}
async function contact(co: string, phone: string | null, optOut = false) {
  return (
    await one<{ id: string }>(
      sql`insert into crm.contacts (company_id, name, phone_e164, wa_lid, opt_out, consent, consent_source) values (${co}, 'C', ${phone}, ${phone ? null : `${Date.now()}${n}@lid`}, ${optOut}, ${!optOut}, 'import') returning id`,
    )
  ).id
}
const base = (w: Awaited<ReturnType<typeof world>>, manifest: Record<string, unknown>) => ({
  targets: [{ connection_id: w.conn, flow_id: w.flow }],
  weekdays: [1, 2, 3, 4, 5],
  manifest,
})
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (err) {
    return (err as MassDispatchError).code
  }
  return 'ok'
}

describe('cota e público', () => {
  it('limite = conexões × por conexão + bônus; só os N primeiros; opt-out e sem telefone skipped', async () => {
    const w = await world()
    const ids = [await contact(w.co, '+5511900000001'), await contact(w.co, '+5511900000002'), await contact(w.co, '+5511900000003'), await contact(w.co, '+5511900000004')]
    const opt = await contact(w.co, '+5511900000005', true)
    const lid = await contact(w.co, null)
    expect(await svc.quota(w.co)).toMatchObject({ limit: 3, used: 0, remaining: 3, billable_slots: 1, per_instance_limit: 3, bonus: 0 })

    const { massDispatch, warnings } = await svc.create(w.actor, base(w, { version: 1, mode: 'all_except', filters: {}, except_ids: [] }))
    expect(warnings).toEqual([expect.objectContaining({ code: 'only_first_n', n: 3, total: 4 })])
    expect(massDispatch).toMatchObject({ status: 'preparing', total_count: 3, pending_count: 3, skipped_count: 2, preparation_progress: { phase: 'queued', target_count: 3 } })
    expect(massDispatch.targets[0]).toMatchObject({ connection_id: w.conn, assigned_count: 3 })
    expect(prepared).toContain(massDispatch.id)
    const rec = await svc.recipients(w.co, massDispatch.id, { page: 1, limit: 50 })
    expect(rec.items.filter((r) => r.status === 'skipped').map((r) => [r.contact_id, r.skip_reason]).sort()).toEqual([[opt, 'opt_out'], [lid, 'no_phone']].sort())
    expect(rec.items.filter((r) => r.status === 'pending').map((r) => r.contact_id).sort()).toEqual(ids.slice(0, 3).sort())

    expect(await code(svc.create(w.actor, base(w, { mode: 'ids', ids: [ids[3]] })))).toBe('quota_exceeded')
    await addMassDispatchBonus(db, w.co, 2)
    expect(await svc.quota(w.co)).toMatchObject({ limit: 5, used: 3, remaining: 2, bonus: 2 })
    await addMassDispatchBonus(db, w.co, -5)
    expect(await svc.quota(w.co)).toMatchObject({ limit: 0, remaining: 0, bonus: -3 })
  })

  it('cancelar devolve a cota dos não iniciados e chama o cancelamento dos jobs', async () => {
    const w = await world()
    const ids = [await contact(w.co, '+5511900000011'), await contact(w.co, '+5511900000012')]
    const { massDispatch } = await svc.create(w.actor, base(w, { mode: 'ids', ids }))
    await db.execute(sql`update crm.mass_dispatch_recipients set status = 'started', started_at = now() where dispatch_id = ${massDispatch.id} and contact_id = ${ids[0]}`)
    const res = await svc.cancel(w.co, massDispatch.id)
    expect(res.releasedCount).toBe(1)
    expect(res.massDispatch).toMatchObject({ status: 'cancelled', sent_count: 1, cancelled_count: 1 })
    expect(cancelled).toContain(massDispatch.id)
    expect(await svc.quota(w.co)).toMatchObject({ used: 1, remaining: 2 })
    expect(await code(svc.cancel(w.co, massDispatch.id))).toBe('invalid_transition')
  })
})

describe('alvos e validação', () => {
  it('conexão desconectada → 409; fluxo inativo ou não publicado → 422; outra empresa → 404 na leitura', async () => {
    const w = await world()
    const down = await world('DISCONNECTED')
    const ids = [await contact(w.co, '+5511900000021')]
    const other = await one<{ id: string }>(sql`insert into crm.connections (company_id, session_id, name) values (${w.co}, ${`s-t60-down-${Date.now()}`}, 'Desligado') returning id`)
    wa.addSession({ id: `s-t60-down-x-${Date.now()}`, name: 'x', state: 'DISCONNECTED' })
    expect(await code(svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), targets: [{ connection_id: other.id, flow_id: w.flow }] }))).toBe('session_not_connected')
    const draft = await one<{ id: string }>(sql`insert into crm.flows (company_id, name, status) values (${w.co}, 'Rascunho', 'active') returning id`)
    expect(await code(svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), targets: [{ connection_id: w.conn, flow_id: draft.id }] }))).toBe('invalid')
    expect(await code(svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), targets: [{ connection_id: down.conn, flow_id: w.flow }] }))).toBe('invalid')
    expect(await code(svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), weekdays: [] }))).toBe('invalid')
    expect(await code(svc.create(w.actor, base(w, { mode: 'ids', ids: [] })))).toBe('invalid')
    const { massDispatch } = await svc.create(w.actor, base(w, { mode: 'ids', ids }))
    expect(await code(svc.get(down.co, massDispatch.id))).toBe('not_found')
  })

  it('limite diário acima da capacidade de warm-up gera aviso', async () => {
    const w = await world()
    const ids = [await contact(w.co, '+5511900000031')]
    const { warnings } = await svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), daily_limit: 50 })
    expect(warnings).toEqual([expect.objectContaining({ code: 'daily_limit_exceeds_warmup', daily_limit: 50, capacity: 20 })])
    const ok = await svc.create(w.actor, { ...base(w, { mode: 'ids', ids }), daily_limit: 20 })
    expect(ok.warnings).toEqual([])
  })
})
