// Postgres real: um nó que grava campo do contato (Manipulador) e o nó seguinte, no mesmo passo, já lê o valor novo.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { companies, contacts, createDb, flowRuns, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import type { FlowDefinition } from '@crm/shared'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { eq, sql } from 'drizzle-orm'
import { FlowStore } from '../store/store'
import { createNodeRegistry } from './registry'
import { FlowEngine } from './runner'

let tmp: TempDatabase
let db: Database
beforeAll(async () => {
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url, { max: 10 })
})
afterAll(async () => {
  await db?.$client.end()
  await tmp?.drop()
})

const node = (id: string, type: string) => ({ id, type, name: id, position: { x: 0, y: 0 }, actions: [] })
const edge = (from: string, handle: string, to: string) => ({ id: `${from}-${handle}-${to}`, from, handle, to })

describe('contato relido entre nós do mesmo passo', () => {
  it('campo gravado por um nó aparece no `{campo}` do nó seguinte (cobrança → Manipulador → Mensagem)', async () => {
    const [c] = await db.insert(companies).values({ name: 'C', slug: `c-reload-${Date.now()}` }).returning()
    const [contact] = await db.insert(contacts).values({ companyId: c!.id, name: 'Ana', phoneE164: '+5511977700001' }).returning()
    const ctx = { companyId: c!.id }
    const store = new FlowStore(db)
    const flow = await store.createFlow(ctx, { name: 'F' })
    const def: FlowDefinition = {
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [node('start', 'start'), node('set', 'manipulator'), node('say', 'message')],
      edges: [edge('start', 'source', 'set'), edge('set', 'source', 'say')],
      variables: [],
      refs: {},
    }
    await store.fromDefinition(ctx, flow.id, def)
    await store.publish(ctx, flow.id)
    const rendered: string[] = []
    const registry = createNodeRegistry()
      .register('manipulator', {
        execute: async (nctx) => {
          const tx = nctx.repo.db as Database
          await tx.execute(sql`update crm.contacts set custom_fields = coalesce(custom_fields, '{}'::jsonb) || '{"spei_code":"646180000000000001"}'::jsonb where id = ${nctx.contactId}`)
          return { next: 'source' }
        },
      })
      .register('message', {
        execute: async (nctx) => {
          rendered.push(nctx.render('CLABE: {spei_code}'))
          return { next: 'source' }
        },
      })
    const engine = new FlowEngine({ db, wa: new FakeWaGateway(), registry })
    const { runId } = await engine.startRun(ctx, { flowId: flow.id, contactId: contact!.id })
    await engine.step(runId, 0)
    expect((await db.select().from(flowRuns).where(eq(flowRuns.id, runId)))[0]!.status).toBe('completed')
    expect(rendered).toEqual(['CLABE: 646180000000000001'])
  })
})
