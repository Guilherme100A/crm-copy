// Postgres real: colunas (0..n−1), cards (ordem, 409, totais, filtro OU), exclusão de coluna e escopo de chat.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chatLabels, chats, companies, companyMembers, connections, contacts, createDb, departments, labels, memberDepartments, users, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { KanbanError } from './errors'
import { KanbanService, createKanbanCard, systemActor } from './service'

let tmp: TempDatabase
let db: Database
let n = 0
beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 6 })
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

async function company() {
  n += 1
  const [c] = await db.insert(companies).values({ name: `K${n}`, slug: `k-t50-${n}-${Date.now()}` }).returning()
  return c!.id
}
async function chat(companyId: string, opts: { departmentId?: string | null } = {}) {
  n += 1
  const [ct] = await db.insert(contacts).values({ companyId, name: `Lead ${n}`, phoneE164: `+55119777${String(n).padStart(5, '0')}` }).returning()
  // T40: chats.connection_id referencia crm.connections.
  const [conn] = await db.insert(connections).values({ companyId, sessionId: `s-${crypto.randomUUID()}`, name: 'Conexão' }).returning()
  const [ch] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: ct!.id, departmentId: opts.departmentId ?? null }).returning()
  return ch!.id
}

const rejects = async (p: Promise<unknown>, kind: KanbanError['kind'], code?: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(KanbanError)
  expect((err as KanbanError).kind).toBe(kind)
  if (code) expect((err as KanbanError).errorCode).toBe(code)
}

describe('KanbanService', () => {
  it('quadro nasce com 3 colunas; mover recompacta 0..n−1; cor inválida recusada', async () => {
    const cid = await company()
    const svc = new KanbanService({ db })
    const actor = systemActor(cid)
    const board = await svc.createBoard(actor, { name: 'Vendas' })
    expect(board.columns.map((c) => [c.name, c.position, c.conversion_goal])).toEqual([
      ['Novo', 0, false],
      ['Qualificação', 1, false],
      ['Ganho', 2, true],
    ])
    const extra = await svc.createColumn(actor, board.id, { name: 'Perdido', accentColor: '#c2410c' })
    expect(extra.position).toBe(3)
    const moved = await svc.moveColumn(actor, board.id, extra.id, 0)
    expect(moved.map((c) => [c.name, c.position])).toEqual([
      ['Perdido', 0],
      ['Novo', 1],
      ['Qualificação', 2],
      ['Ganho', 3],
    ])
    await rejects(svc.createColumn(actor, board.id, { name: 'x', accentColor: 'red' }), 'validation')
    await rejects(svc.updateColumn(actor, board.id, extra.id, { accentColor: '#12345' }), 'validation')
    expect((await svc.updateColumn(actor, board.id, extra.id, { accentColor: null })).accent_color).toBeNull()
  })

  it('card: 409 para chat repetido; mover antes de outro preserva a ordem; totais por coluna', async () => {
    const cid = await company()
    const svc = new KanbanService({ db })
    const actor = systemActor(cid)
    const board = await svc.createBoard(actor, { name: 'Funil' })
    const [novo, qualif] = board.columns
    const [a, b, c] = [await chat(cid), await chat(cid), await chat(cid)]
    const ca = await svc.createCard(actor, board.id, { chatId: a, valueCents: 1000 })
    const cb = await svc.createCard(actor, board.id, { chatId: b, columnId: qualif!.id, valueCents: 2500 })
    const cc = await svc.createCard(actor, board.id, { chatId: c, columnId: qualif!.id })
    await rejects(svc.createCard(actor, board.id, { chatId: a }), 'conflict', 'card_exists')
    expect(ca.column_id).toBe(novo!.id)

    await svc.moveCard(actor, board.id, ca.id, { columnId: qualif!.id, beforeCardId: cc.id })
    const list = await svc.listCards(actor, board.id, { column_id: qualif!.id })
    expect(list.items.map((x) => x.id)).toEqual([cb.id, ca.id, cc.id])
    expect(list.columns.find((t) => t.column_id === qualif!.id)).toMatchObject({ total_count: 3, total_value_cents: 3500, total_value: 35 })
    expect(list.columns.find((t) => t.column_id === novo!.id)).toMatchObject({ total_count: 0 })

    await svc.moveCard(actor, board.id, cc.id, { columnId: qualif!.id, beforeCardId: cb.id })
    expect((await svc.listCards(actor, board.id, { column_id: qualif!.id })).items.map((x) => x.id)).toEqual([cc.id, cb.id, ca.id])
    await rejects(svc.moveCard(actor, board.id, cc.id, { columnId: crypto.randomUUID() }), 'validation')
  })

  it('filtro por etiquetas é OU; excluir coluna apaga os cards dela', async () => {
    const cid = await company()
    const svc = new KanbanService({ db })
    const actor = systemActor(cid)
    const board = await svc.createBoard(actor, { name: 'Tags' })
    const [l1, l2] = await db
      .insert(labels)
      .values([
        { companyId: cid, name: 'A', color: '#000000' },
        { companyId: cid, name: 'B', color: '#111111' },
      ])
      .returning()
    const [x, y, z] = [await chat(cid), await chat(cid), await chat(cid)]
    for (const ch of [x, y, z]) await svc.createCard(actor, board.id, { chatId: ch })
    await db.insert(chatLabels).values([
      { companyId: cid, chatId: x, labelId: l1!.id },
      { companyId: cid, chatId: y, labelId: l2!.id },
    ])
    const filtered = await svc.listCards(actor, board.id, { label_ids: [l1!.id, l2!.id] })
    expect(filtered.items.map((cc) => cc.chat_id).sort()).toEqual([x, y].sort())
    expect(filtered.columns[0]!.total_count).toBe(2)
    expect((await svc.stats(actor, board.id, { label_ids: [l1!.id] })).total_cards).toBe(1)

    const r = await svc.deleteColumn(actor, board.id, board.columns[0]!.id)
    expect(r.deletedCards).toBe(3)
    expect((await svc.getBoard(actor, board.id)).columns.map((cc) => cc.position)).toEqual([0, 1])
  })

  it('escopo: membro sem o departamento do chat não vê nem cria o card; createKanbanCard move se já existe', async () => {
    const cid = await company()
    const svc = new KanbanService({ db })
    const board = await svc.createBoard(systemActor(cid), { name: 'Escopo' })
    const [d1] = await db.insert(departments).values({ companyId: cid, name: 'Vendas', color: '#000000' }).returning()
    const [d2] = await db.insert(departments).values({ companyId: cid, name: 'Suporte', color: '#111111' }).returning()
    const [u] = await db.insert(users).values({ email: `k${n}-${Date.now()}@x.test`, passwordHash: 'x', name: 'M' }).returning()
    const [m] = await db.insert(companyMembers).values({ companyId: cid, userId: u!.id, role: 'member' }).returning()
    // Escopo do membro: só o departamento d1 (T31).
    await db.insert(memberDepartments).values({ companyId: cid, memberId: m!.id, departmentId: d1!.id })
    const member = { companyId: cid, userId: u!.id, perms: new Set<string>() }
    const out = await chat(cid, { departmentId: d2!.id })
    const inside = await chat(cid, { departmentId: d1!.id })

    const card = await createKanbanCard(svc, { companyId: cid }, { crmId: board.id, chatId: out })
    await svc.createCard(member, board.id, { chatId: inside })
    const visible = await svc.listCards(member, board.id, {})
    expect(visible.items.map((c) => c.chat_id)).toEqual([inside])
    expect(visible.columns[0]!.total_count).toBe(1)
    await rejects(svc.getCard(member, board.id, card.id), 'not_found')
    await rejects(svc.createCard(member, board.id, { chatId: out }), 'not_found')
    expect((await svc.availableChats(member, board.id, {})).items).toEqual([])
    const again = await createKanbanCard(svc, { companyId: cid }, { crmId: board.id, chatId: out, columnId: board.columns[2]!.id, valueCents: 900 })
    expect([again.id, again.column_id, again.value_cents]).toEqual([card.id, board.columns[2]!.id, 900])
  })
})
