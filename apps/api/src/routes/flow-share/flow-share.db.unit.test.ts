// Compartilhar/importar/exportar/colar por HTTP (app.request), Postgres real e blob store em diretório temporário.
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, labels, type Database } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { FsBlobStore, createLogger, MemoryMailer, redisConnection } from '@crm/node-kit'
import { eq } from 'drizzle-orm'
import { createApp, type RedisClient } from '../../app'
import { generateShareCode } from './index'
import { labelNamesOf } from './transfer'

let temp: TempDatabase
let db: Database
let redis: RedisClient
let app: ReturnType<typeof createApp>
let dir: string

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const rnd = () => randomBytes(4).toString('hex')
const H = { 'content-type': 'application/json', 'x-requested-with': 'crm' }
interface Who {
  cookie: string
  companyId: string
}

async function call(who: Who, method: string, path: string, body?: unknown) {
  const res = await app.request(path, { method, headers: { ...H, cookie: who.cookie, 'x-company-id': who.companyId }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
  return { status: res.status, body: (await res.json()) as Json }
}

async function owner(): Promise<Who> {
  const email = `s${rnd()}@x.com`
  await app.request('/api/auth/register', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Ana', email, password: 's3nha-forte', password_confirmation: 's3nha-forte' }) })
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { ...H, 'x-forwarded-for': `10.5.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ email, password: 's3nha-forte' }),
  })
  const body = (await res.json()) as Json
  return { cookie: `crm_session=${/crm_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')![1]}`, companyId: body.companies[0].id }
}

async function upload(a: Who): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], { type: 'image/png' }), 'x.png')
  const res = await app.request('/api/media', { method: 'POST', headers: { cookie: a.cookie, 'x-company-id': a.companyId, 'x-requested-with': 'crm' }, body: form })
  return ((await res.json()) as Json).media.id
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crm-share-'))
  temp = await createTempDatabase({ migrate: true })
  db = createDb(temp.url, { max: 6 })
  redis = redisConnection({ url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/1' })
  app = createApp({
    db,
    redis,
    mailer: new MemoryMailer({ from: 'no-reply@example.com' }),
    blobStore: new FsBlobStore({ dir }),
    trustProxy: true,
    logger: createLogger({ level: 'silent' }),
    flowStepEnqueue: async () => undefined,
  })
}, 60_000)

afterAll(async () => {
  await db?.$client.end()
  redis?.disconnect()
  await temp?.drop()
  rmSync(dir, { recursive: true, force: true })
})

describe('compartilhar e importar', () => {
  it('código: outra empresa recria o fluxo com etiquetas por nome, mídia reemitida e referência ausente vira aviso', async () => {
    const a = await owner()
    const b = await owner()
    const mediaId = await upload(a)
    const flow = (await call(a, 'POST', '/api/flows', { name: 'Origem' })).body.flow
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, {
      id: 't',
      type: 'tags',
      position: { x: 0, y: 0 },
      actions: [{ id: 'a1', type: 'add_tags', config: { action: 'add', tags: ['VIP', 'Lead quente'] } }],
    })
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, {
      id: 'm',
      type: 'message',
      position: { x: 1, y: 1 },
      actions: [{ id: 'a2', type: 'send_multi_media', config: { media_type: 'image', media_source: 'file', media_url: `/api/media/${mediaId}` } }],
    })
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, {
      id: 'j',
      type: 'connection_flow',
      position: { x: 2, y: 2 },
      actions: [{ id: 'a3', type: 'execute_flow', config: { target_flow_id: crypto.randomUUID() } }],
    })
    const { code } = (await call(a, 'GET', `/api/flows/${flow.id}/share-code`)).body
    expect((await call(a, 'GET', `/api/flows/${flow.id}/share-code`)).body.code).toBe(code)

    const imp = await call(b, 'POST', '/api/flows/import', { codes: [code.toLowerCase(), 'NAOEXISTE'] })
    expect(imp.status).toBe(201)
    expect(imp.body.errors).toEqual([{ code: 'NAOEXISTE', reason: 'invalid_code' }])
    const item = imp.body.items[0]
    expect(item.flow).toMatchObject({ name: 'Origem', status: 'draft' })
    expect(item.warnings).toEqual([expect.objectContaining({ code: 'flow_reference_missing' })])
    const created = await db.select({ name: labels.name }).from(labels).where(eq(labels.companyId, b.companyId))
    expect(created.map((l) => l.name).sort()).toEqual(['Lead quente', 'VIP'])
    const def = (await call(b, 'GET', `/api/flows/${item.flow.id}/editor-bundle`)).body.definition
    const media = def.nodes.find((n: Json) => n.type === 'message').actions[0].config.media_url as string
    expect(media).not.toContain(mediaId)
    const newId = media.replace('/api/media/', '')
    expect((await app.request(`/api/media/${newId}`, { headers: { cookie: b.cookie, 'x-company-id': b.companyId } })).status).toBe(200)
    expect(def.nodes.find((n: Json) => n.type === 'connection_flow').actions[0].config.target_flow_id).toBe('')
    expect(def.nodes.map((n: Json) => n.id)).not.toContain('t')
  })

  it('export → import-json reproduz o grafo (exceto ids) e devolve os erros do validate', async () => {
    const a = await owner()
    const flow = (await call(a, 'POST', '/api/flows', { name: 'Exp' })).body.flow
    await call(a, 'POST', `/api/flows/${flow.id}/nodes`, { id: 'm', type: 'message', position: { x: 3, y: 4 }, actions: [{ type: 'send_message', config: { message_text: 'oi' } }] })
    await call(a, 'POST', `/api/flows/${flow.id}/connections`, { from: 'start', handle: 'source', to: 'm' })
    const exp = (await call(a, 'GET', `/api/flows/${flow.id}/export`)).body
    expect(exp.format).toBe('crm.flow.export/v1')
    const imp = await call(a, 'POST', '/api/flows/import-json', exp)
    expect(imp.status).toBe(201)
    expect(imp.body.validation_errors).toEqual([])
    const def = (await call(a, 'GET', `/api/flows/${imp.body.flow.id}/editor-bundle`)).body.definition
    const strip = (d: Json) => ({ nodes: d.nodes.map((n: Json) => [n.type, n.position, n.actions.map((x: Json) => x.config)]), edges: d.edges.length })
    expect(strip(def)).toEqual(strip(exp.definition))
    expect((await call(a, 'POST', '/api/flows/import-json', { definition: { nodes: 'x' } })).status).toBe(422)
  })

  it('colar nós de outro fluxo clona nós e arestas internas com deslocamento', async () => {
    const a = await owner()
    const src = (await call(a, 'POST', '/api/flows', { name: 'A' })).body.flow
    const dst = (await call(a, 'POST', '/api/flows', { name: 'B' })).body.flow
    for (const [id, x] of [['p', 10], ['q', 20]] as const) await call(a, 'POST', `/api/flows/${src.id}/nodes`, { id, type: 'message', position: { x, y: 0 } })
    await call(a, 'POST', `/api/flows/${src.id}/connections`, { from: 'p', handle: 'source', to: 'q' })
    await call(a, 'POST', `/api/flows/${src.id}/connections`, { from: 'start', handle: 'source', to: 'p' })
    const r = await call(a, 'POST', `/api/flows/${dst.id}/paste-nodes`, { source_flow_id: src.id, nodes: [{ id: 'p' }, { id: 'q', position: { x: 500, y: 500 } }, { id: 'start' }] })
    expect(r.status).toBe(201)
    expect(r.body.nodes.map((n: Json) => n.position)).toEqual([{ x: 60, y: 50 }, { x: 500, y: 500 }])
    expect(r.body.edges).toHaveLength(1)
    expect(r.body.nodes.map((n: Json) => n.id)).not.toContain('p')
    const b = await owner()
    expect((await call(b, 'POST', `/api/flows/${dst.id}/paste-nodes`, { source_flow_id: src.id, nodes: [{ id: 'p' }] })).status).toBe(404)
  })

  it('helpers: código sem caracteres ambíguos; nomes de etiquetas únicos', async () => {
    expect(generateShareCode()).toMatch(/^[A-HJ-NP-Z2-9]{10}$/)
    const names = labelNamesOf({
      schema: 'crm.flow/v1',
      entry: 'start',
      nodes: [{ id: 'x', type: 'tags', name: 'x', position: { x: 0, y: 0 }, actions: [{ id: 'a', type: 'add_tags', order: 0, config: { tags: ['VIP', 'vip', ' '] } }] }],
      edges: [],
      variables: [],
      refs: {},
    })
    expect(names).toEqual(['vip'])
  })
})
