// AC-T50-01..05: quadros e colunas, cards (unicidade e movimento), totais com filtros, stats do funil, exclusão e evento.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { envelopeOf } from '../helpers/sse'
import { department, labelChat, newLabel, newMember, newOwner, openEvents, seedChat, setScope, sleep, startEnv, type Env, type User } from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

async function newBoard(u: User = owner, name = `Funil ${uuid().slice(0, 8)}`) {
  const res = await u.c.post('/api/crms', { name })
  if (res.status !== 201) throw new Error(`POST /api/crms → ${res.status} ${res.text}`)
  return res.body.crm
}

async function addCard(u: User, crmId: string, chatId: string, columnId?: string, valueCents?: number) {
  const res = await u.c.post(`/api/crms/${crmId}/cards`, { chat_id: chatId, ...(columnId ? { column_id: columnId } : {}), ...(valueCents !== undefined ? { value_cents: valueCents } : {}) })
  if (res.status !== 201) throw new Error(`POST cards → ${res.status} ${res.text}`)
  return res.body.card
}

/** Cria um chat na empresa e um card dele na coluna. */
async function cardIn(u: User, crmId: string, columnId: string, valueCents = 0) {
  const chatId = await seedChat(env, u.companyId)
  return addCard(u, crmId, chatId, columnId, valueCents)
}

async function columnIds(u: User, crmId: string, columnId: string, extra = '') {
  const res = await u.c.get(`/api/crms/${crmId}/cards?column_id=${columnId}&limit=100${extra}`)
  expect(res.status, res.text).toBe(200)
  return res.body.items.map((c: any) => c.id as string)
}

const totalsOf = (cols: any[]) => Object.fromEntries(cols.map((c) => [c.column_id, [c.total_count, Number(c.total_value_cents)]]))

describe('AC-T50-01 quadros e colunas', () => {
  it('AC-T50-01 criar quadro cria as 3 colunas padrão (0..2, Ganho é conversão)', async () => {
    const crm = await newBoard()
    expect(crm.columns.map((c: any) => [c.name, c.position, c.conversion_goal])).toEqual([
      ['Novo', 0, false],
      ['Qualificação', 1, false],
      ['Ganho', 2, true],
    ])
    expect(crm.quantity_of_columns).toBe(3)
    expect(crm.summary).toMatchObject({ total_cards: 0, conversion_count: 0 })
    const got = await owner.c.get(`/api/crms/${crm.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.body.crm.columns.map((c: any) => c.id)).toEqual(crm.columns.map((c: any) => c.id))
    const list = await owner.c.get('/api/crms')
    expect(list.body.items.map((c: any) => c.id)).toContain(crm.id)
  })

  it('AC-T50-01 nova coluna vai para o fim; mover coluna recompacta 0..n−1; excluir recompacta', async () => {
    const crm = await newBoard()
    const [novo, qual, ganho] = crm.columns
    const add = await owner.c.post(`/api/crms/${crm.id}/columns`, { name: 'Perdido', accent_color: '#C2410C' })
    expect(add.status, add.text).toBe(201)
    const perdido = add.body.column
    expect(perdido).toMatchObject({ name: 'Perdido', position: 3, accent_color: expect.stringMatching(/^#c2410c$/i), conversion_goal: false })

    const mv = await owner.c.patch(`/api/crms/${crm.id}/columns/${perdido.id}/move`, { position: 0 })
    expect(mv.status, mv.text).toBe(200)
    expect(mv.body.columns.map((c: any) => [c.id, c.position])).toEqual([
      [perdido.id, 0],
      [novo.id, 1],
      [qual.id, 2],
      [ganho.id, 3],
    ])

    const mv2 = await owner.c.patch(`/api/crms/${crm.id}/columns/${novo.id}/move`, { position: 3 })
    expect(mv2.status, mv2.text).toBe(200)
    expect(mv2.body.columns.map((c: any) => c.id)).toEqual([perdido.id, qual.id, ganho.id, novo.id])
    expect(mv2.body.columns.map((c: any) => c.position)).toEqual([0, 1, 2, 3])

    const del = await owner.c.delete(`/api/crms/${crm.id}/columns/${qual.id}`)
    expect(del.status, del.text).toBe(200)
    const after = (await owner.c.get(`/api/crms/${crm.id}`)).body.crm.columns
    expect(after.map((c: any) => [c.id, c.position])).toEqual([
      [perdido.id, 0],
      [ganho.id, 1],
      [novo.id, 2],
    ])
  })

  it('AC-T50-01 cor inválida → 422 (criar e editar); null = automática; cor válida aceita', async () => {
    const crm = await newBoard()
    for (const bad of ['red', '#12345', '#GGGGGG', '123456', '#1234567']) {
      const res = await owner.c.post(`/api/crms/${crm.id}/columns`, { name: 'X', accent_color: bad })
      expectApiError(res, 'VALIDATION_ERROR', 422)
      expect(JSON.stringify(res.body.error.details?.fields ?? [])).toContain('accent_color')
    }
    const col = crm.columns[0]
    expectApiError(await owner.c.patch(`/api/crms/${crm.id}/columns/${col.id}`, { accent_color: 'azul' }), 'VALIDATION_ERROR', 422)
    const ok = await owner.c.patch(`/api/crms/${crm.id}/columns/${col.id}`, { accent_color: '#0d9488', conversion_goal: true })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.column).toMatchObject({ accent_color: '#0d9488', conversion_goal: true })
    const auto = await owner.c.patch(`/api/crms/${crm.id}/columns/${col.id}`, { accent_color: null })
    expect(auto.status, auto.text).toBe(200)
    expect(auto.body.column.accent_color).toBeNull()
    // nada foi criado pelas tentativas inválidas
    expect((await owner.c.get(`/api/crms/${crm.id}`)).body.crm.columns).toHaveLength(3)
  })

  it('AC-T50-01 permissões e isolamento: quadro de outra empresa → 404; sem kanban.edit → 403', async () => {
    const crm = await newBoard()
    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/crms/${crm.id}`), 'NOT_FOUND', 404)
    expectApiError(await other.c.post(`/api/crms/${crm.id}/columns`, { name: 'Y' }), 'NOT_FOUND', 404)
    expect((await other.c.get('/api/crms')).body.items.map((c: any) => c.id)).not.toContain(crm.id)
    const viewer = await newMember(env, owner.companyId, ['kanban.view', 'chat.view'])
    expect((await viewer.c.get(`/api/crms/${crm.id}`)).status).toBe(200)
    expectApiError(await viewer.c.post('/api/crms', { name: 'Z' }), 'FORBIDDEN', 403)
    expectApiError(await viewer.c.patch(`/api/crms/${crm.id}/columns/${crm.columns[0].id}/move`, { position: 2 }), 'FORBIDDEN', 403)
    const none = await newMember(env, owner.companyId, ['chat.view'])
    expectApiError(await none.c.get(`/api/crms/${crm.id}`), 'FORBIDDEN', 403)
  })
})

describe('AC-T50-02 cards: unicidade e movimento', () => {
  it('AC-T50-02 chat que já tem card no quadro → 409 card_exists; em outro quadro pode', async () => {
    const crm = await newBoard()
    const chatId = await seedChat(env, owner.companyId)
    const card = await addCard(owner, crm.id, chatId)
    expect(card).toMatchObject({ crm_id: crm.id, chat_id: chatId, column_id: crm.columns[0].id })
    const dup = await owner.c.post(`/api/crms/${crm.id}/cards`, { chat_id: chatId, column_id: crm.columns[1].id })
    expectApiError(dup, 'CONFLICT', 409)
    expect(dup.body.error.details?.error_code).toBe('card_exists')
    const other = await newBoard()
    expect((await owner.c.post(`/api/crms/${other.id}/cards`, { chat_id: chatId })).status).toBe(201)
    // chat de outra empresa → 404; coluna de outro quadro → 422
    const foreignChat = await seedChat(env, (await newOwner(env)).companyId)
    expectApiError(await owner.c.post(`/api/crms/${crm.id}/cards`, { chat_id: foreignChat }), 'NOT_FOUND', 404)
    const chat2 = await seedChat(env, owner.companyId)
    expectApiError(await owner.c.post(`/api/crms/${crm.id}/cards`, { chat_id: chat2, column_id: other.columns[0].id }), 'VALIDATION_ERROR', 422)
    // available-chats exclui quem já tem card
    const avail = await owner.c.get(`/api/crms/${crm.id}/available-chats?limit=100`)
    expect(avail.status, avail.text).toBe(200)
    const ids = avail.body.items.map((c: any) => c.id)
    expect(ids).not.toContain(chatId)
    expect(ids).toContain(chat2)
  })

  it('AC-T50-02 mover card entre colunas respeita before_card_id e atualiza contagens e totais', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const a1 = await cardIn(owner, crm.id, A.id, 1000)
    const a2 = await cardIn(owner, crm.id, A.id, 2000)
    const a3 = await cardIn(owner, crm.id, A.id, 3000)
    const b1 = await cardIn(owner, crm.id, B.id, 500)
    const b2 = await cardIn(owner, crm.id, B.id, 700)
    expect(await columnIds(owner, crm.id, A.id)).toEqual([a1.id, a2.id, a3.id])

    // b1 vai para A entre a1 e a2
    const mv = await owner.c.patch(`/api/crms/${crm.id}/cards/${b1.id}/move`, { column_id: A.id, before_card_id: a2.id })
    expect(mv.status, mv.text).toBe(200)
    expect(mv.body.card).toMatchObject({ id: b1.id, column_id: A.id })
    expect(await columnIds(owner, crm.id, A.id)).toEqual([a1.id, b1.id, a2.id, a3.id])
    expect(await columnIds(owner, crm.id, B.id)).toEqual([b2.id])
    const t = totalsOf(mv.body.columns)
    expect(t[A.id]).toEqual([4, 6500])
    expect(t[B.id]).toEqual([1, 700])

    // a3 para o topo de B; a1 para o fim de B (before_card_id null)
    await owner.c.patch(`/api/crms/${crm.id}/cards/${a3.id}/move`, { column_id: B.id, before_card_id: b2.id })
    const last = await owner.c.patch(`/api/crms/${crm.id}/cards/${a1.id}/move`, { column_id: B.id, before_card_id: null })
    expect(last.status, last.text).toBe(200)
    expect(await columnIds(owner, crm.id, B.id)).toEqual([a3.id, b2.id, a1.id])
    expect(await columnIds(owner, crm.id, A.id)).toEqual([b1.id, a2.id])

    // reordenar dentro da mesma coluna
    await owner.c.patch(`/api/crms/${crm.id}/cards/${a1.id}/move`, { column_id: B.id, before_card_id: a3.id })
    expect(await columnIds(owner, crm.id, B.id)).toEqual([a1.id, a3.id, b2.id])

    const list = await owner.c.get(`/api/crms/${crm.id}/cards?limit=100`)
    const tot = totalsOf(list.body.columns)
    expect(tot[A.id]).toEqual([2, 2500])
    expect(tot[B.id]).toEqual([3, 4700])
    expect((await owner.c.get(`/api/crms/${crm.id}`)).body.crm.summary).toMatchObject({ total_cards: 5, total_value_cents: 7200 })
  })

  it('AC-T50-02 editar valor (value_cents) muda o total; mover para coluna de outro quadro → 422', async () => {
    const crm = await newBoard()
    const other = await newBoard()
    const card = await cardIn(owner, crm.id, crm.columns[0].id, 1000)
    const upd = await owner.c.patch(`/api/crms/${crm.id}/cards/${card.id}`, { value_cents: 123456 })
    expect(upd.status, upd.text).toBe(200)
    expect(upd.body.card).toMatchObject({ value_cents: 123456, currency: 'BRL' })
    expect(Number(upd.body.card.value)).toBeCloseTo(1234.56, 2)
    const tot = totalsOf((await owner.c.get(`/api/crms/${crm.id}/cards`)).body.columns)
    expect(tot[crm.columns[0].id]).toEqual([1, 123456])
    expectApiError(await owner.c.patch(`/api/crms/${crm.id}/cards/${card.id}/move`, { column_id: other.columns[1].id }), 'VALIDATION_ERROR', 422)
    const viewer = await newMember(env, owner.companyId, ['kanban.view', 'chat.view'])
    expectApiError(await viewer.c.patch(`/api/crms/${crm.id}/cards/${card.id}/move`, { column_id: crm.columns[1].id }), 'FORBIDDEN', 403)
  })
})

describe('AC-T50-03 totais por coluna com filtros', () => {
  it('AC-T50-03 filtro por etiquetas é OU e os totais por coluna seguem os filtros', async () => {
    const crm = await newBoard()
    const [A, B, C] = crm.columns
    const [L1, L2, L3] = [await newLabel(env, owner.companyId), await newLabel(env, owner.companyId), await newLabel(env, owner.companyId)]
    const mk = async (col: string, value: number, labels: string[]) => {
      const chatId = await seedChat(env, owner.companyId)
      for (const l of labels) await labelChat(env, owner.companyId, chatId, l)
      return addCard(owner, crm.id, chatId, col, value)
    }
    const c1 = await mk(A.id, 100, [L1])
    const c2 = await mk(A.id, 200, [L2])
    const c3 = await mk(B.id, 400, [L1, L2])
    const c4 = await mk(B.id, 800, [L3])
    const c5 = await mk(C.id, 1600, [])

    const all = await owner.c.get(`/api/crms/${crm.id}/cards?limit=100`)
    expect(all.body.page.total_count).toBe(5)
    expect(totalsOf(all.body.columns)).toEqual({ [A.id]: [2, 300], [B.id]: [2, 1200], [C.id]: [1, 1600] })

    const or = await owner.c.get(`/api/crms/${crm.id}/cards?limit=100&label_ids[]=${L1}&label_ids[]=${L2}`)
    expect(or.status, or.text).toBe(200)
    expect(or.body.items.map((c: any) => c.id).sort()).toEqual([c1.id, c2.id, c3.id].sort())
    expect(or.body.page.total_count).toBe(3)
    expect(totalsOf(or.body.columns)).toEqual({ [A.id]: [2, 300], [B.id]: [1, 400], [C.id]: [0, 0] })

    // column_id filtra só os itens; os totais continuam de todas as colunas
    const onlyB = await owner.c.get(`/api/crms/${crm.id}/cards?limit=100&column_id=${B.id}&label_ids[]=${L3}&label_ids[]=${L2}`)
    expect(onlyB.body.items.map((c: any) => c.id).sort()).toEqual([c3.id, c4.id].sort())
    expect(totalsOf(onlyB.body.columns)).toEqual({ [A.id]: [1, 200], [B.id]: [2, 1200], [C.id]: [0, 0] })
    expect(onlyB.body.items.some((c: any) => c.id === c5.id)).toBe(false)
  })

  it('AC-T50-03 responsável (me/none/id), período de atualização e paginação refletem nos totais', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const mine = await seedChat(env, owner.companyId)
    await env.q(`UPDATE crm.chats SET assigned_user_id = $2 WHERE id = $1`, [mine, owner.userId])
    const cMine = await addCard(owner, crm.id, mine, A.id, 1000)
    const cNone = await cardIn(owner, crm.id, B.id, 2000)

    const me = await owner.c.get(`/api/crms/${crm.id}/cards?assigned_to=me`)
    expect(me.body.items.map((c: any) => c.id)).toEqual([cMine.id])
    expect(totalsOf(me.body.columns)).toMatchObject({ [A.id]: [1, 1000], [B.id]: [0, 0] })
    const byId = await owner.c.get(`/api/crms/${crm.id}/cards?assigned_to=${owner.userId}`)
    expect(byId.body.items.map((c: any) => c.id)).toEqual([cMine.id])
    const none = await owner.c.get(`/api/crms/${crm.id}/cards?assigned_to=none`)
    expect(none.body.items.map((c: any) => c.id)).toEqual([cNone.id])
    expect(totalsOf(none.body.columns)).toMatchObject({ [A.id]: [0, 0], [B.id]: [1, 2000] })

    await sleep(1_100)
    const mid = new Date().toISOString()
    await sleep(50)
    const late = await cardIn(owner, crm.id, B.id, 4000)
    const recent = await owner.c.get(`/api/crms/${crm.id}/cards?updated_from=${encodeURIComponent(mid)}&updated_to=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)
    expect(recent.status, recent.text).toBe(200)
    expect(recent.body.items.map((c: any) => c.id)).toEqual([late.id])
    expect(totalsOf(recent.body.columns)).toMatchObject({ [A.id]: [0, 0], [B.id]: [1, 4000] })
    const old = await owner.c.get(`/api/crms/${crm.id}/cards?updated_to=${encodeURIComponent(mid)}`)
    expect(old.body.items.map((c: any) => c.id).sort()).toEqual([cMine.id, cNone.id].sort())

    const p1 = await owner.c.get(`/api/crms/${crm.id}/cards?limit=2&page=1`)
    expect(p1.body.items).toHaveLength(2)
    expect(p1.body.page).toMatchObject({ page: 1, limit: 2, total_count: 3, total_pages: 2, has_more: true })
    const p2 = await owner.c.get(`/api/crms/${crm.id}/cards?limit=2&page=2`)
    expect(p2.body.items).toHaveLength(1)
    expect(totalsOf(p2.body.columns)).toEqual(totalsOf(p1.body.columns))
  })

  it('AC-T50-03 membro com escopo de departamento não vê nem conta cards de chats fora do escopo', async () => {
    const crm = await newBoard()
    const [A] = crm.columns
    const dX = await department(owner)
    const dY = await department(owner)
    const inX = await seedChat(env, owner.companyId, { departmentId: dX })
    const inY = await seedChat(env, owner.companyId, { departmentId: dY })
    const cX = await addCard(owner, crm.id, inX, A.id, 100)
    const cY = await addCard(owner, crm.id, inY, A.id, 900)
    const member = await newMember(env, owner.companyId, ['chat.view', 'kanban.view', 'kanban.edit'])
    await setScope(owner, member.memberId!, [dX])

    const res = await member.c.get(`/api/crms/${crm.id}/cards`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.items.map((c: any) => c.id)).toEqual([cX.id])
    expect(totalsOf(res.body.columns)[A.id]).toEqual([1, 100])
    expectApiError(await member.c.get(`/api/crms/${crm.id}/cards/${cY.id}`), 'NOT_FOUND', 404)
    expectApiError(await member.c.patch(`/api/crms/${crm.id}/cards/${cY.id}/move`, { column_id: crm.columns[1].id }), 'NOT_FOUND', 404)
    const avail = (await member.c.get(`/api/crms/${crm.id}/available-chats?limit=100`)).body.items.map((c: any) => c.id)
    const freeY = await seedChat(env, owner.companyId, { departmentId: dY })
    expect(avail).not.toContain(freeY)
    expect(totalsOf((await owner.c.get(`/api/crms/${crm.id}/cards`)).body.columns)[A.id]).toEqual([2, 1000])
  })
})

describe('AC-T50-04 estatísticas do funil', () => {
  it('AC-T50-04 stats reproduz as fórmulas da 04#3.6 (funil acumulado, conversão por etapa, totais)', async () => {
    const crm = await newBoard()
    const [novo, qual, ganho] = crm.columns
    const pos = (await owner.c.post(`/api/crms/${crm.id}/columns`, { name: 'Pós-venda' })).body.column
    // fixture: Novo 4 (sem valor), Qualificação 3 (300 c), Ganho 2 (1000 + 2500 c, conversão), Pós-venda 1 (9900 c)
    for (let i = 0; i < 4; i++) await cardIn(owner, crm.id, novo.id, 0)
    for (let i = 0; i < 3; i++) await cardIn(owner, crm.id, qual.id, 100)
    await cardIn(owner, crm.id, ganho.id, 1000)
    await cardIn(owner, crm.id, ganho.id, 2500)
    await cardIn(owner, crm.id, pos.id, 9900)

    const res = await owner.c.get(`/api/crms/${crm.id}/stats`)
    expect(res.status, res.text).toBe(200)
    const s = res.body
    expect(s.total_cards).toBe(10)
    const stages = s.stages.map((x: any) => ({
      column_id: x.column_id,
      position: x.position,
      column_count: x.column_count,
      count: x.count,
      from_prev: x.conversion_rate_from_previous === null ? null : Number(x.conversion_rate_from_previous),
      wave: Number(x.wave_progress_percent),
      value: Number(x.total_value_cents),
    }))
    expect(stages).toEqual([
      { column_id: novo.id, position: 0, column_count: 4, count: 10, from_prev: null, wave: 100, value: 0 },
      { column_id: qual.id, position: 1, column_count: 3, count: 6, from_prev: 60, wave: 60, value: 300 },
      { column_id: ganho.id, position: 2, column_count: 2, count: 3, from_prev: 50, wave: 30, value: 3500 },
      { column_id: pos.id, position: 3, column_count: 1, count: 1, from_prev: 33.3, wave: 10, value: 9900 },
    ])
    expect(s.conversion_count).toBe(2)
    expect(Number(s.conversion_rate)).toBe(20)
    expect(s.totals).toMatchObject({ total_leads: 10, total_purchases: 2 })
    expect(Number(s.totals.overall_conversion_rate)).toBe(20)
    expect(Number(s.totals.total_revenue_cents)).toBe(3500)
  })

  it('AC-T50-04 arredondamento (1 e 2 casas), stats com filtro e quadro vazio sem divisão por zero', async () => {
    const crm = await newBoard()
    const [novo, qual, ganho] = crm.columns
    const empty = (await owner.c.get(`/api/crms/${crm.id}/stats`)).body
    expect(empty.total_cards).toBe(0)
    expect(Number(empty.conversion_rate)).toBe(0)
    expect(empty.stages.map((x: any) => [x.count, Number(x.wave_progress_percent)])).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ])
    expect(empty.stages.slice(1).map((x: any) => Number(x.conversion_rate_from_previous))).toEqual([0, 0])

    // 9 cards: Novo 4, Qualificação 3, Ganho 2 → 9/5/2
    const L = await newLabel(env, owner.companyId)
    const labelled: string[] = []
    for (const [col, n] of [[novo.id, 4], [qual.id, 3], [ganho.id, 2]] as const)
      for (let i = 0; i < n; i++) {
        const chatId = await seedChat(env, owner.companyId)
        if (col !== qual.id) {
          await labelChat(env, owner.companyId, chatId, L)
          labelled.push(chatId)
        }
        await addCard(owner, crm.id, chatId, col, 0)
      }
    const s = (await owner.c.get(`/api/crms/${crm.id}/stats`)).body
    expect(s.stages.map((x: any) => x.count)).toEqual([9, 5, 2])
    expect(s.stages.map((x: any) => Number(x.wave_progress_percent))).toEqual([100, 55.6, 22.2])
    expect(Number(s.stages[1].conversion_rate_from_previous)).toBe(55.6)
    expect(Number(s.stages[2].conversion_rate_from_previous)).toBe(40)
    expect(Number(s.conversion_rate)).toBe(22.22)

    // com filtro de etiqueta: Novo 4, Qualificação 0, Ganho 2 → 6/2/2
    const f = (await owner.c.get(`/api/crms/${crm.id}/stats?label_ids[]=${L}`)).body
    expect(f.total_cards).toBe(6)
    expect(f.stages.map((x: any) => x.count)).toEqual([6, 2, 2])
    expect(Number(f.stages[2].conversion_rate_from_previous)).toBe(100)
    expect(Number(f.conversion_rate)).toBe(33.33)
  })
})

describe('AC-T50-05 excluir coluna e evento de movimento', () => {
  it('AC-T50-05 excluir coluna remove os cards dela (e libera o chat para novo card)', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const chatId = await seedChat(env, owner.companyId)
    const gone1 = await addCard(owner, crm.id, chatId, B.id, 500)
    const gone2 = await cardIn(owner, crm.id, B.id, 700)
    const kept = await cardIn(owner, crm.id, A.id, 100)
    const viewer = await newMember(env, owner.companyId, ['kanban.view', 'kanban.edit', 'chat.view'])
    expectApiError(await viewer.c.delete(`/api/crms/${crm.id}/columns/${B.id}`), 'FORBIDDEN', 403)

    const del = await owner.c.delete(`/api/crms/${crm.id}/columns/${B.id}`)
    expect(del.status, del.text).toBe(200)
    expect(del.body).toMatchObject({ deleted: true, deleted_cards: 2 })
    expectApiError(await owner.c.get(`/api/crms/${crm.id}/cards/${gone1.id}`), 'NOT_FOUND', 404)
    expectApiError(await owner.c.get(`/api/crms/${crm.id}/cards/${gone2.id}`), 'NOT_FOUND', 404)
    const list = await owner.c.get(`/api/crms/${crm.id}/cards?limit=100`)
    expect(list.body.items.map((c: any) => c.id)).toEqual([kept.id])
    expect(list.body.columns.map((c: any) => c.column_id)).not.toContain(B.id)
    expect((await owner.c.get(`/api/crms/${crm.id}`)).body.crm.summary).toMatchObject({ total_cards: 1, total_value_cents: 100 })
    expect((await owner.c.post(`/api/crms/${crm.id}/cards`, { chat_id: chatId })).status).toBe(201)
  })

  it('AC-T50-05 mover card publica kanban.card.moved para a empresa (e não para membro fora do escopo)', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const dX = await department(owner)
    const dY = await department(owner)
    const chatId = await seedChat(env, owner.companyId, { departmentId: dX })
    const card = await addCard(owner, crm.id, chatId, A.id)
    const peer = await newMember(env, owner.companyId, ['chat.view', 'kanban.view'])
    const outsider = await newMember(env, owner.companyId, ['chat.view', 'kanban.view'])
    await setScope(owner, outsider.memberId!, [dY])
    const stranger = await newOwner(env)

    const sPeer = await openEvents(env, peer, owner.companyId)
    const sOut = await openEvents(env, outsider, owner.companyId)
    const sStr = await openEvents(env, stranger, stranger.companyId)
    try {
      const mv = await owner.c.patch(`/api/crms/${crm.id}/cards/${card.id}/move`, { column_id: B.id })
      expect(mv.status, mv.text).toBe(200)
      const ev = await sPeer.waitFor((m) => m.event === 'kanban.card.moved' && envelopeOf(m).data?.card_id === card.id, 10_000)
      const env0 = envelopeOf(ev)
      expect(env0.company_id).toBe(owner.companyId)
      expect(env0.data).toMatchObject({ crm_id: crm.id, card_id: card.id, chat_id: chatId, column_id: B.id, from_column_id: A.id })
      await sleep(1_000)
      expect(sOut.messages.some((m: any) => m.event === 'kanban.card.moved')).toBe(false)
      expect(sStr.messages.some((m: any) => m.event?.startsWith('kanban.'))).toBe(false)
    } finally {
      await Promise.all([sPeer.close(), sOut.close(), sStr.close()])
    }
  })
})
