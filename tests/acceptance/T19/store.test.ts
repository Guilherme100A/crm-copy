// AC-T19-03..05: FlowStore — round-trip de definição, publicação de versões e hierarquia de pastas.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { lit, sql, sqlState } from '../helpers/pg'
import { canon, caught, ctxOf, flowStore, migratedCrmDb, newCompany, sampleDefinition, type CrmDb } from './support'

let pg: CrmDb
let store: any
let FlowStoreError: any
let companyA: string
let companyB: string

beforeAll(async () => {
  pg = await migratedCrmDb()
  ;({ store, FlowStoreError } = await flowStore(pg.db))
  companyA = newCompany(pg.tmp.url)
  companyB = newCompany(pg.tmp.url)
})

afterAll(async () => {
  await pg?.close()
})

const A = () => ctxOf(companyA)
const json = (x: unknown) => JSON.parse(JSON.stringify(x))

describe('T19 — round-trip rascunho ↔ FlowDefinition (AC-T19-03)', () => {
  it('AC-T19-03 fromDefinition seguido de toDefinition reproduz nós, ações, edges, entry, variáveis e refs', async () => {
    const flow = await store.createFlow(A(), { name: 'Round-trip' })
    const def = await sampleDefinition()
    await store.fromDefinition(A(), flow.id, def)
    const back = await store.toDefinition(A(), flow.id)
    expect(canon(json(back))).toEqual(canon(def))
  })

  it('AC-T19-03 toDefinition → fromDefinition → toDefinition é estável (idempotente)', async () => {
    const flow = await store.createFlow(A(), { name: 'Estável' })
    await store.fromDefinition(A(), flow.id, await sampleDefinition())
    const d1 = json(await store.toDefinition(A(), flow.id))
    await store.fromDefinition(A(), flow.id, d1)
    const d2 = json(await store.toDefinition(A(), flow.id))
    expect(canon(d2)).toEqual(canon(d1))
    // o resultado é uma FlowDefinition válida pelo schema compartilhado
    const { FlowDefinitionSchema } = await import('@crm/shared/flows')
    expect(FlowDefinitionSchema.safeParse(d2).success).toBe(true)
  })

  it('AC-T19-03 fluxo novo já tem um rascunho válido com nó start como entry', async () => {
    const flow = await store.createFlow(A(), { name: 'Novo' })
    const def = await store.toDefinition(A(), flow.id)
    expect(def.schema).toBe('crm.flow/v1')
    const entry = def.nodes.find((n: any) => n.id === def.entry)
    expect(entry?.type).toBe('start')
  })

  it('AC-T19-03 fromDefinition substitui o rascunho inteiro (nós removidos somem com ações e edges)', async () => {
    const flow = await store.createFlow(A(), { name: 'Substitui' })
    await store.fromDefinition(A(), flow.id, await sampleDefinition())
    const small = await sampleDefinition()
    small.nodes = small.nodes.filter((n: any) => n.id === 'start' || n.id === 'msg1')
    small.edges = small.edges.filter((e: any) => e.id === 'e1')
    await store.fromDefinition(A(), flow.id, small)
    expect(canon(json(await store.toDefinition(A(), flow.id)))).toEqual(canon(small))
  })

  it('AC-T19-03 fluxo de outra empresa → NOT_FOUND', async () => {
    const flow = await store.createFlow(A(), { name: 'Privado' })
    const err = await caught(store.toDefinition(ctxOf(companyB), flow.id))
    expect(err).toBeInstanceOf(FlowStoreError)
    expect(err.code).toBe('NOT_FOUND')
    const err2 = await caught(store.fromDefinition(ctxOf(companyB), flow.id, await sampleDefinition()))
    expect(err2?.code).toBe('NOT_FOUND')
  })
})

describe('T19 — publicação de versões (AC-T19-04)', () => {
  it('AC-T19-04 publish grava versão 1, 2… com a definição do rascunho no momento', async () => {
    const flow = await store.createFlow(A(), { name: 'Versões' })
    await store.fromDefinition(A(), flow.id, await sampleDefinition('versão um'))
    const v1 = await store.publish(A(), flow.id)
    expect(v1.version).toBe(1)
    expect(canon(json(v1.definition))).toEqual(canon(json(await store.toDefinition(A(), flow.id))))

    await store.fromDefinition(A(), flow.id, await sampleDefinition('versão dois'))
    const v2 = await store.publish(A(), flow.id)
    expect(v2.version).toBe(2)
    expect(JSON.stringify(v2.definition)).toContain('versão dois')
    expect((await store.listVersions(A(), flow.id)).map((v: any) => v.version).sort()).toEqual([1, 2])
    expect((await store.getVersion(A(), flow.id)).version).toBe(2)
  })

  it('AC-T19-04 editar o rascunho depois de publicar não altera a versão publicada', async () => {
    const flow = await store.createFlow(A(), { name: 'Imutável' })
    await store.fromDefinition(A(), flow.id, await sampleDefinition('original'))
    const v1 = await store.publish(A(), flow.id)
    const frozen = json(v1.definition)

    const edited = await sampleDefinition('EDITADO depois')
    edited.nodes = edited.nodes.filter((n: any) => n.id !== 'tags1')
    edited.edges = edited.edges.filter((e: any) => e.to !== 'tags1')
    await store.fromDefinition(A(), flow.id, edited)

    const again = await store.getVersion(A(), flow.id, 1)
    expect(json(again.definition)).toEqual(frozen)
    expect(JSON.stringify(again.definition)).toContain('original')
    expect(JSON.stringify(again.definition)).not.toContain('EDITADO')
  })

  it('AC-T19-04 a versão é imutável no banco (UPDATE em crm.flow_versions falha)', async () => {
    const flow = await store.createFlow(A(), { name: 'Trigger' })
    const v1 = await store.publish(A(), flow.id)
    const r = sql(pg.tmp.url, `UPDATE crm.flow_versions SET definition = '{}'::jsonb WHERE id = ${lit(v1.id)};`)
    expect(r.code, 'UPDATE de versão publicada aceito').not.toBe(0)
    expect(sqlState(r), r.stderr).toBe('23001')
    expect(json((await store.getVersion(A(), flow.id, 1)).definition)).toEqual(json(v1.definition))
  })

  it('AC-T19-04 números de versão são sequenciais por fluxo, mesmo com publicações concorrentes', async () => {
    const f1 = await store.createFlow(A(), { name: 'Concorrente' })
    const f2 = await store.createFlow(A(), { name: 'Outro fluxo' })
    const vs = await Promise.all([1, 2, 3, 4].map(() => store.publish(A(), f1.id)))
    expect(vs.map((v: any) => v.version).sort()).toEqual([1, 2, 3, 4])
    expect((await store.publish(A(), f2.id)).version).toBe(1)
  })
})

describe('T19 — hierarquia de pastas (AC-T19-05)', () => {
  async function tree() {
    const a = await store.createFolder(A(), { name: `A-${Math.random()}` })
    const b = await store.createFolder(A(), { name: 'B', parentFolderId: a.id })
    const c = await store.createFolder(A(), { name: 'C', parentFolderId: b.id })
    return { a, b, c }
  }

  const expectConflict = (err: any) => {
    expect(err, 'ciclo aceito').toBeDefined()
    expect(err).toBeInstanceOf(FlowStoreError)
    expect(err.code).toBe('CONFLICT')
  }

  it('AC-T19-05 mover a pasta para dentro de uma descendente (neta) → CONFLICT', async () => {
    const { a, c } = await tree()
    expectConflict(await caught(store.moveFolder(A(), a.id, c.id)))
    expect((await store.getFolder(A(), a.id)).parentFolderId ?? null).toBeNull()
  })

  it('AC-T19-05 filha direta como pai e a própria pasta como pai → CONFLICT (também via updateFolder)', async () => {
    const { a, b } = await tree()
    expectConflict(await caught(store.moveFolder(A(), a.id, b.id)))
    expectConflict(await caught(store.moveFolder(A(), b.id, b.id)))
    expectConflict(await caught(store.updateFolder(A(), a.id, { parentFolderId: b.id })))
  })

  it('AC-T19-05 movimentos válidos são aceitos (subir para a raiz, mover para irmã)', async () => {
    const { a, b, c } = await tree()
    const other = await store.createFolder(A(), { name: 'Irmã' })
    await store.moveFolder(A(), c.id, other.id)
    expect((await store.getFolder(A(), c.id)).parentFolderId).toBe(other.id)
    await store.moveFolder(A(), b.id, null)
    expect((await store.getFolder(A(), b.id)).parentFolderId ?? null).toBeNull()
    // agora A não é mais ancestral de B: B pode receber A
    await store.moveFolder(A(), a.id, b.id)
    expect((await store.getFolder(A(), a.id)).parentFolderId).toBe(b.id)
  })

  it('AC-T19-05 pai de outra empresa → NOT_FOUND (não vaza existência)', async () => {
    const mine = await store.createFolder(A(), { name: 'Minha' })
    const theirs = await store.createFolder(ctxOf(companyB), { name: 'Deles' })
    const err = await caught(store.moveFolder(A(), mine.id, theirs.id))
    expect(err?.code).toBe('NOT_FOUND')
  })
})
