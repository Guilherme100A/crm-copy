// Extensão da lista de chats (T48) pela T50: filtro por quadro/coluna (lista e contadores) e PATCH de coluna pelo chat,
// com o escopo do membro. IDs: AC-T50-02 (card por chat/movimento) e AC-T50-03 (filtros e totais).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError, type ApiClient } from '../helpers/http'
import { department, newMember, newOwner, seedChat, setScope, startEnv, type Env, type User } from './setup'

let env: Env
let owner: User
beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
})
afterAll(async () => {
  await env?.close()
})

async function newBoard(u: User = owner) {
  const res = await u.c.post('/api/crms', { name: `Funil ${Math.random().toString(36).slice(2, 8)}` })
  if (res.status !== 201) throw new Error(`POST /api/crms → ${res.status} ${res.text}`)
  return res.body.crm
}

async function addCard(u: User, crmId: string, chatId: string, columnId: string) {
  const res = await u.c.post(`/api/crms/${crmId}/cards`, { chat_id: chatId, column_id: columnId })
  if (res.status !== 201) throw new Error(`POST cards → ${res.status} ${res.text}`)
  return res.body.card
}

async function listIds(c: ApiClient, query: string): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 50; guard++) {
    const res = await c.get(`/api/chats?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (res.status !== 200) throw new Error(`GET /api/chats?${query} → ${res.status} ${res.text}`)
    ids.push(...res.body.items.map((x: any) => x.id))
    cursor = res.body.next_cursor
    if (!cursor) break
  }
  return ids.sort()
}

const cardsOfChat = async (crmId: string, chatId: string) =>
  ((await owner.c.get(`/api/crms/${crmId}/cards?limit=100`)).body.items as any[]).filter((c) => c.chat_id === chatId)

describe('AC-T50-03 lista de chats filtrada por kanban', () => {
  it('AC-T50-03 GET /api/chats?crm_id&crm_column_id traz só chats com card no quadro/coluna; contadores batem', async () => {
    const crm = await newBoard()
    const other = await newBoard()
    const [A, B] = crm.columns
    const a1 = await seedChat(env, owner.companyId, { status: 'waiting' })
    const a2 = await seedChat(env, owner.companyId, { status: 'attending' })
    const b1 = await seedChat(env, owner.companyId, { status: 'waiting' })
    const outside = await seedChat(env, owner.companyId, { status: 'waiting' })
    const elsewhere = await seedChat(env, owner.companyId, { status: 'waiting' })
    await addCard(owner, crm.id, a1, A.id)
    await addCard(owner, crm.id, a2, A.id)
    await addCard(owner, crm.id, b1, B.id)
    await addCard(owner, other.id, elsewhere, other.columns[0].id)

    const byBoard = await listIds(owner.c, `crm_id=${crm.id}&limit=50`)
    expect(byBoard).toEqual([a1, a2, b1].sort())
    expect(byBoard).not.toContain(outside)
    expect(byBoard).not.toContain(elsewhere)
    expect(await listIds(owner.c, `crm_id=${crm.id}&crm_column_id=${A.id}&limit=50`)).toEqual([a1, a2].sort())
    expect(await listIds(owner.c, `crm_id=${crm.id}&crm_column_id=${B.id}&status=waiting`)).toEqual([b1])

    const counts = (await owner.c.get(`/api/chats/counts?crm_id=${crm.id}`)).body.counts
    expect(counts).toEqual({ waiting: 2, attending: 1, resolved: 0 })
    const countsA = (await owner.c.get(`/api/chats/counts?crm_id=${crm.id}&crm_column_id=${A.id}`)).body.counts
    expect(countsA).toEqual({ waiting: 1, attending: 1, resolved: 0 })
  })

  it('AC-T50-03 filtro por kanban continua respeitando o escopo do membro', async () => {
    const crm = await newBoard()
    const [A] = crm.columns
    const dX = await department(owner)
    const dY = await department(owner)
    const inX = await seedChat(env, owner.companyId, { departmentId: dX })
    const inY = await seedChat(env, owner.companyId, { departmentId: dY })
    await addCard(owner, crm.id, inX, A.id)
    await addCard(owner, crm.id, inY, A.id)
    const member = await newMember(env, owner.companyId, ['chat.view', 'kanban.view'])
    await setScope(owner, member.memberId!, [dX])
    expect(await listIds(member.c, `crm_id=${crm.id}`)).toEqual([inX])
    expect((await member.c.get(`/api/chats/counts?crm_id=${crm.id}`)).body.counts).toEqual({ waiting: 1, attending: 0, resolved: 0 })
    expect(await listIds(owner.c, `crm_id=${crm.id}`)).toEqual([inX, inY].sort())
  })
})

describe('AC-T50-02 PATCH de coluna pelo chat', () => {
  it('AC-T50-02 PATCH /api/chats/:id { crm_id, crm_column_id } cria o card, depois move (mesmo card) e null remove', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const chatId = await seedChat(env, owner.companyId)

    const create = await owner.c.patch(`/api/chats/${chatId}`, { crm_id: crm.id, crm_column_id: A.id })
    expect(create.status, create.text).toBe(200)
    expect(create.body.chat.id).toBe(chatId)
    expect(create.body.card).toMatchObject({ crm_id: crm.id, column_id: A.id, chat_id: chatId })
    const cardId = create.body.card.id

    const move = await owner.c.patch(`/api/chats/${chatId}`, { crm_id: crm.id, crm_column_id: B.id })
    expect(move.status, move.text).toBe(200)
    expect(move.body.card).toMatchObject({ id: cardId, column_id: B.id })
    const cards = await cardsOfChat(crm.id, chatId)
    expect(cards.map((c) => [c.id, c.column_id])).toEqual([[cardId, B.id]])
    expect(await listIds(owner.c, `crm_id=${crm.id}&crm_column_id=${B.id}`)).toEqual([chatId])

    // coluna de outro quadro → 422
    const other = await newBoard()
    expectApiError(await owner.c.patch(`/api/chats/${chatId}`, { crm_id: crm.id, crm_column_id: other.columns[0].id }), 'VALIDATION_ERROR', 422)

    const remove = await owner.c.patch(`/api/chats/${chatId}`, { crm_id: crm.id, crm_column_id: null })
    expect(remove.status, remove.text).toBe(200)
    expect(remove.body.card).toBeNull()
    expect(await cardsOfChat(crm.id, chatId)).toEqual([])
    expectApiError(await owner.c.get(`/api/crms/${crm.id}/cards/${cardId}`), 'NOT_FOUND', 404)
  })

  it('AC-T50-02 PATCH de coluna exige kanban.edit e respeita o escopo (fora → 404); quadro de outra empresa → 404', async () => {
    const crm = await newBoard()
    const [A, B] = crm.columns
    const dX = await department(owner)
    const dY = await department(owner)
    const inX = await seedChat(env, owner.companyId, { departmentId: dX })
    const inY = await seedChat(env, owner.companyId, { departmentId: dY })

    const viewer = await newMember(env, owner.companyId, ['chat.view', 'kanban.view'])
    expectApiError(await viewer.c.patch(`/api/chats/${inX}`, { crm_id: crm.id, crm_column_id: A.id }), 'FORBIDDEN', 403)

    const editor = await newMember(env, owner.companyId, ['chat.view', 'kanban.view', 'kanban.edit'])
    await setScope(owner, editor.memberId!, [dX])
    const ok = await editor.c.patch(`/api/chats/${inX}`, { crm_id: crm.id, crm_column_id: B.id })
    expect(ok.status, ok.text).toBe(200)
    expect(ok.body.card).toMatchObject({ column_id: B.id, chat_id: inX })
    expectApiError(await editor.c.patch(`/api/chats/${inY}`, { crm_id: crm.id, crm_column_id: A.id }), 'NOT_FOUND', 404)
    expect(await cardsOfChat(crm.id, inY)).toEqual([])

    const foreign = await newBoard(await newOwner(env))
    expectApiError(await owner.c.patch(`/api/chats/${inX}`, { crm_id: foreign.id, crm_column_id: foreign.columns[0].id }), 'NOT_FOUND', 404)
    // department_id continua funcionando no mesmo PATCH (contrato da T48)
    const dep = await owner.c.patch(`/api/chats/${inY}`, { department_id: dX })
    expect(dep.status, dep.text).toBe(200)
  })
})
