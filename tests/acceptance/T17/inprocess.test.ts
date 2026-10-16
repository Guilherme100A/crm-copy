// AC-T17-02 (rotas /__e2e só com E2E=1) e AC-T17-05 (seeds de módulo em ordem determinística), em processo.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDb } from '@crm/db'
import { createTempDatabase, type TempDatabase } from '@crm/db/testing'
import { redisConnection } from '@crm/node-kit'

let tmp: TempDatabase
let db: any
let redis: any
let dbMod: any

beforeAll(async () => {
  dbMod = await import('@crm/db')
  tmp = await createTempDatabase({ migrate: true })
  db = createDb(tmp.url)
  redis = redisConnection({ url: 'redis://127.0.0.1:6379/14' })
  redis.on?.('error', () => {})
})
afterAll(async () => {
  vi.unstubAllEnvs()
  await Promise.resolve(redis?.quit()).catch(() => redis?.disconnect())
  await db?.$client.end().catch(() => {})
  await tmp?.drop()
})

const E2E_ROUTES: Array<[string, string]> = [
  ['POST', '/__e2e/reset'],
  ['GET', '/__e2e/mail'],
  ['DELETE', '/__e2e/mail'],
  ['POST', '/__e2e/wa/emit'],
  ['GET', '/__e2e/wa/deliveries'],
  ['POST', '/__e2e/llm/script'],
  ['GET', '/__e2e/llm/script'],
  ['GET', '/__e2e/qualquer-coisa'],
]

async function appWith(e2e: string | undefined) {
  vi.stubEnv('E2E', e2e)
  const api: any = await import('@crm/api')
  const app = api.createApp({ db, redis })
  vi.unstubAllEnvs()
  return app
}

const req = (app: any, method: string, path: string) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'crm' },
    body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify({}),
  })

describe('T17 — /__e2e só com E2E=1', () => {
  it('AC-T17-02 app criado sem E2E=1: toda rota /__e2e/* → 404', async () => {
    const app = await appWith(undefined)
    for (const [method, path] of E2E_ROUTES) {
      const res = await req(app, method, path)
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })

  it('AC-T17-02 E2E com valor diferente de "1" também não monta as rotas', async () => {
    for (const v of ['0', 'true', '']) {
      const app = await appWith(v)
      expect((await req(app, 'POST', '/__e2e/reset')).status, `E2E=${JSON.stringify(v)}`).toBe(404)
      expect((await req(app, 'GET', '/__e2e/mail')).status).toBe(404)
    }
  })

  it('AC-T17-02 sanidade: com E2E=1 as rotas existem (o 404 acima vem da flag)', async () => {
    const app = await appWith('1')
    const res = await req(app, 'GET', '/__e2e/mail')
    expect(res.status, await res.text()).toBe(200)
  })
})

describe('T17 — seeds de módulo', () => {
  const executed: string[] = []
  const unregister: Array<() => void> = []
  const NAMES = ['t17-zeta', 't17-alfa', 't17-meio', 't17-cedo', 't17-padrao']

  beforeAll(() => {
    const reg = (name: string, order?: number) =>
      unregister.push(dbMod.registerSeedModule({ name, ...(order === undefined ? {} : { order }), run: async () => void executed.push(name) }))
    // registro fora de ordem de propósito
    reg('t17-zeta', 50)
    reg('t17-padrao')
    reg('t17-alfa', 50)
    reg('t17-meio', 60)
    reg('t17-cedo', 5)
  })
  afterAll(() => {
    for (const u of unregister) u()
  })

  const mine = (list: string[]) => list.filter((n) => NAMES.includes(n))
  const EXPECTED = ['t17-cedo', 't17-alfa', 't17-zeta', 't17-meio', 't17-padrao']

  it('AC-T17-05 listSeedModules devolve a ordem de execução: order crescente, desempate pelo nome', () => {
    const list = dbMod.listSeedModules().map((m: any) => m.name)
    expect(mine(list)).toEqual(EXPECTED)
  })

  /** runSeeds num banco novo e migrado (o seed-base pressupõe banco limpo, como no /__e2e/reset). */
  async function seedFresh() {
    const t = await createTempDatabase({ migrate: true })
    const d = createDb(t.url)
    try {
      executed.length = 0
      const r = await dbMod.runSeeds(d)
      return { applied: r.applied as string[], executed: [...executed] }
    } finally {
      await d.$client.end().catch(() => {})
      await t.drop()
    }
  }

  it('AC-T17-05 runSeeds aplica base primeiro e os módulos na ordem determinística', async () => {
    const r = await seedFresh()
    expect(r.applied[0]).toBe('base')
    expect(mine(r.applied)).toEqual(EXPECTED)
    expect(r.executed).toEqual(EXPECTED)
    const listed = dbMod.listSeedModules().map((m: any) => m.name)
    expect(r.applied.slice(1)).toEqual(listed)
  })

  it('AC-T17-05 rodar de novo repete exatamente a mesma ordem', async () => {
    const r1 = await seedFresh()
    const r2 = await seedFresh()
    expect(r2.executed).toEqual(r1.executed)
    expect(r2.applied).toEqual(r1.applied)
    expect(r1.executed).toEqual(EXPECTED)
  })

  it('AC-T17-05 nome de módulo duplicado é rejeitado', () => {
    expect(() => dbMod.registerSeedModule({ name: 't17-alfa', run: async () => {} })).toThrow()
  })
})
