// T91: transferir de departamento publica o chat.updated também com o escopo ANTIGO (quem perde o acesso tira o
// chat da lista sem recarregar); sem troca de escopo, um único evento como antes (AC-T48-04).
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chats, companies, connections, contacts, createDb, departments, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { ChatLifecycleService } from './service'

let temp: TempDatabase
let db: Database

beforeAll(async () => {
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 4 })
}, 120_000)

afterAll(async () => {
  await db?.$client.end()
  await temp?.drop()
})

async function setup() {
  const slug = `c-${randomBytes(4).toString('hex')}`
  const [co] = await db.insert(companies).values({ name: slug, slug }).returning({ id: companies.id })
  const companyId = co!.id
  const [ct] = await db.insert(contacts).values({ companyId, name: 'Ana', phoneE164: '+5511999990001' }).returning({ id: contacts.id })
  const [conn] = await db.insert(connections).values({ companyId, sessionId: `s-${slug}`, name: 'Conexão' }).returning({ id: connections.id })
  const [x] = await db.insert(departments).values({ companyId, name: 'X' }).returning({ id: departments.id })
  const [y] = await db.insert(departments).values({ companyId, name: 'Y' }).returning({ id: departments.id })
  const [chat] = await db.insert(chats).values({ companyId, connectionId: conn!.id, contactId: ct!.id, departmentId: x!.id }).returning({ id: chats.id })
  const published: { type: string; scope: unknown; data: Record<string, unknown> }[] = []
  const svc = new ChatLifecycleService({
    db,
    publisher: { publish: async (_c: string, type: string, data: unknown, opts?: { scope?: unknown }) => void published.push({ type, scope: opts?.scope, data: data as Record<string, unknown> }) } as never,
  })
  // Token de API: age pela empresa inteira (sem escopo de membro).
  const actor = { companyId, userId: null, perms: new Set(['chat.view']) }
  return { svc, actor, chatId: chat!.id, connId: conn!.id, x: x!.id, y: y!.id, published }
}

describe('publicação no escopo antigo (T91)', () => {
  it('transferir publica para o departamento novo e para o antigo, com o mesmo DTO', async () => {
    const s = await setup()
    const dto = await s.svc.update(s.actor, s.chatId, { department_id: s.y })
    expect(dto.department_id).toBe(s.y)
    const updates = s.published.filter((p) => p.type === 'chat.updated')
    expect(updates.map((p) => p.scope)).toEqual([
      { connection_id: s.connId, department_id: s.y },
      { connection_id: s.connId, department_id: s.x },
    ])
    expect(updates[1]!.data).toEqual(updates[0]!.data)
  })

  it('sem mudança de escopo (agente de IA, etiqueta) segue com um único evento', async () => {
    const s = await setup()
    await s.svc.update(s.actor, s.chatId, { ai_agent_id: null, department_id: s.x })
    expect(s.published).toEqual([])
    await s.svc.update(s.actor, s.chatId, { department_id: null })
    expect(s.published.filter((p) => p.type === 'chat.updated').map((p) => p.scope)).toEqual([
      { connection_id: s.connId, department_id: null },
      { connection_id: s.connId, department_id: s.x },
    ])
  })
})
