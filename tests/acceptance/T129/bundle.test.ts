// AC-T129-01..03 + retrabalho (limite da Meta no modo async) pelo contrato HTTP: GET /api/meta/structure-bundle?async=1
// (createApp + worker real do job meta-sync, BullMQ de verdade na fila desta execução) contra o FakeMetaGraph
// (failAccount / setUsage; nunca a Graph real). Os jobs são contados na fila `meta-sync` pelo bundle_key da resposta.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bundleUrl, callsTo, connect, jobCounter, owner, seedAccount, sleep, startEnv, startMetaWorker, until, type Account, type Env, type User } from './setup'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any

let env: Env
let worker: { stop: () => Promise<void> }
let jobs: Awaited<ReturnType<typeof jobCounter>>

beforeAll(async () => {
  env = await startEnv()
  worker = await startMetaWorker(env)
  jobs = await jobCounter()
}, 120_000)

afterAll(async () => {
  await jobs?.close()
  await worker?.stop()
  await env?.close()
})

const PERMISSION_ERROR = { message: 'Permissions error', type: 'OAuthException', code: 200 }

async function ready(u: User, url: string, what: string, pred: (b: Any) => boolean = () => true) {
  return until(what, async () => {
    const r = await u.c.get(url)
    return r.status === 200 && r.body.status === 'ready' && pred(r.body) ? r.body : null
  })
}

async function setup(suffix: string, extra: Record<string, string> = {}): Promise<{ o: User; acc: Account; url: string }> {
  const o = await owner(env)
  const [acc] = await connect(env, o, [{ suffix }])
  seedAccount(env, acc!)
  return { o, acc: acc!, url: bundleUrl([acc!], { async: '1', ...extra }) }
}

describe('T129 — bundle async com erro de conta não fica preso em loading', () => {
  it('AC-T129-01 conta com erro: o GET async seguinte sai de loading (200 ready com errors[]) sem esperar a expiração do job', async () => {
    const { o, acc, url } = await setup('err1')
    env.fake.failAccount(acc.fb, 400, PERMISSION_ERROR)
    const first = await o.c.get(url)
    expect(first.status, first.text).toBe(202)
    expect(first.body.status).toBe('loading')
    const key: string = first.body.bundle_key
    // Antes da correção: as releituras ficavam em 202 loading até os 15 min do estado.
    const body = await ready(o, url, 'pronto com erro (preso em loading?)')
    expect(body.errors).toEqual([expect.objectContaining({ fb_ad_account_id: acc.fb })])
    expect(await jobs.jobsOf(key)).toHaveLength(1)

    // Releituras em sequência (cliente relendo após o SSE): estado final estável, sem laço reler → job → Meta.
    const calls = callsTo(env, acc)
    for (let i = 0; i < 5; i++) {
      const r = await o.c.get(url)
      expect(r.status, r.text).toBe(200)
      expect(r.body.status).toBe('ready')
      expect(r.body.errors.length).toBe(1)
    }
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    expect(callsTo(env, acc)).toBe(calls)
    env.fake.clearAccountFailure(acc.fb)
  })

  it('AC-T129-01 AC-T129-03 passado o prazo curto do pronto com erro (espera real), o GET seguinte enfileira um job NOVO que roda; GETs simultâneos → 1 job', async () => {
    const { o, acc, url } = await setup('err2')
    env.fake.failAccount(acc.fb, 400, PERMISSION_ERROR)
    const first = await o.c.get(url)
    const key: string = first.body.bundle_key
    await ready(o, url, 'pronto com erro')
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    env.fake.clearAccountFailure(acc.fb)

    // Espera real da vida curta do pronto com erro (bem menor que os 15 min do bug). Nada de mexer em chave interna.
    const deadline = Date.now() + 75_000
    let burst: Any[] = []
    for (;;) {
      await sleep(2_000)
      const probe = await o.c.get(url)
      if (probe.status === 202) {
        burst = [probe]
        break
      }
      expect(Date.now(), 'o pronto com erro não expirou em 75 s').toBeLessThan(deadline)
    }
    // Corrida logo depois: mais 4 GETs simultâneos não criam job extra.
    burst.push(...(await Promise.all(Array.from({ length: 4 }, () => o.c.get(url)))))
    expect(burst.every((r) => r.body.bundle_key === key)).toBe(true)
    const ok = await ready(o, url, 'pronto sem erro', (b) => b.errors.length === 0)
    expect(ok.campaign.length).toBeGreaterThan(0)
    const all = await jobs.jobsOf(key)
    expect(all).toHaveLength(2)
    expect(new Set(all.map((j: Any) => j.id)).size).toBe(2)
  }, 150_000)

  it('AC-T129-02 pronto sem erro vem do cache (200 cached:true) sem job nem chamada à Meta; force_refresh=1 cria job novo a cada pedido', async () => {
    const { o, acc, url } = await setup('ok')
    const first = await o.c.get(url)
    expect(first.status, first.text).toBe(202)
    const key: string = first.body.bundle_key
    const body = await ready(o, url, 'pronto')
    expect(body.errors).toEqual([])
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    const calls = callsTo(env, acc)
    for (let i = 0; i < 3; i++) {
      const r = await o.c.get(url)
      expect(r.status, r.text).toBe(200)
      expect(r.body).toMatchObject({ status: 'ready', cached: true })
    }
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    expect(callsTo(env, acc)).toBe(calls)

    const f1 = await o.c.get(`${url}&force_refresh=1`)
    expect(f1.status, f1.text).toBe(202)
    expect(f1.body.status).toBe('refreshing')
    await until('job do 1º force_refresh', async () => (await jobs.jobsOf(key)).length === 2)
    await until('1º refresh concluído', async () => (await jobs.jobsOf(key)).every((j: Any) => j.finishedOn))
    const f2 = await o.c.get(`${url}&force_refresh=1`)
    expect(f2.status, f2.text).toBe(202)
    await until('job do 2º force_refresh', async () => (await jobs.jobsOf(key)).length === 3)
    expect(new Set((await jobs.jobsOf(key)).map((j: Any) => j.id)).size).toBe(3)
    await ready(o, url, 'pronto depois do refresh')
  })

  it('AC-T129-03 cinco GET simultâneos sem cache → no máximo 1 job; todos 202 com o mesmo bundle_key', async () => {
    const { o, url } = await setup('burst')
    const burst = await Promise.all(Array.from({ length: 5 }, () => o.c.get(url)))
    expect(burst.map((r) => r.status)).toEqual(Array(5).fill(202))
    const key: string = burst[0]!.body.bundle_key
    expect(burst.every((r) => r.body.bundle_key === key)).toBe(true)
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    await ready(o, url, 'pronto')
    expect(await jobs.jobsOf(key)).toHaveLength(1)
  })
})

describe('T129 retrabalho — limite da Meta no modo async (envelope com rate_limited)', () => {
  it('AC-T129-01 com cache: refresh async que cai no limite → GET async devolve 200 ready cached:true + rate_limited com as linhas do cache, sem job extra', async () => {
    const { o, acc, url } = await setup('rlcache')
    const first = await o.c.get(url)
    const key: string = first.body.bundle_key
    const cached = await ready(o, url, 'pronto')
    expect(cached.campaign.length).toBeGreaterThan(0)
    expect((await o.c.get(url)).body).toMatchObject({ status: 'ready', cached: true, warnings: [] })

    env.fake.setUsage(acc.fb, 95, 2)
    const refresh = await o.c.get(`${url}&force_refresh=1`)
    expect(refresh.status, refresh.text).toBe(202)
    expect(refresh.body.status).toBe('refreshing')
    // O job do refresh cai no limite e é adiado; o GET async (sem force) passa a avisar.
    const after = await ready(o, url, 'cache com rate_limited', (b) => (b.warnings ?? []).includes('rate_limited'))
    env.fake.setUsage(acc.fb, null)
    expect(after).toMatchObject({ status: 'ready', cached: true })
    expect(after.campaign.map((r: Any) => r.id)).toEqual(cached.campaign.map((r: Any) => r.id))
    expect(await jobs.jobsOf(key)).toHaveLength(2)
    for (let i = 0; i < 3; i++) {
      const r = await o.c.get(url)
      expect(r.status).toBe(200)
      expect(r.body).toMatchObject({ status: 'ready', cached: true, warnings: expect.arrayContaining(['rate_limited']) })
    }
    expect(await jobs.jobsOf(key)).toHaveLength(2)
    // O job adiado não falhou: o worker o roda quando a espera acabar.
    expect((await jobs.jobsOf(key)).filter((j: Any) => j.failedReason && j.finishedOn)).toHaveLength(0)
  })

  it('AC-T129-01 sem cache: carga inicial async que cai no limite → 200 ready vazio + rate_limited (não loading), 1 job só', async () => {
    const { o, acc, url } = await setup('rlempty')
    env.fake.setUsage(acc.fb, 95, 2)
    const first = await o.c.get(url)
    expect(first.status, first.text).toBe(202)
    expect(first.body.status).toBe('loading')
    const key: string = first.body.bundle_key
    const after = await ready(o, url, 'ready com rate_limited (preso em loading?)')
    env.fake.setUsage(acc.fb, null)
    expect(after.warnings).toContain('rate_limited')
    expect(after.campaign ?? []).toEqual([])
    for (let i = 0; i < 3; i++) {
      const r = await o.c.get(url)
      expect(r.status, r.text).toBe(200)
      expect(r.body).toMatchObject({ status: 'ready', warnings: expect.arrayContaining(['rate_limited']) })
    }
    expect(await jobs.jobsOf(key)).toHaveLength(1)
    // Sync na mesma chave e no mesmo limite: mesmo status e aviso.
    const sync = await o.c.get(bundleUrl([acc]))
    expect(sync.status, sync.text).toBe(200)
    expect(sync.body).toMatchObject({ status: 'ready', warnings: expect.arrayContaining(['rate_limited']) })
  })
})
