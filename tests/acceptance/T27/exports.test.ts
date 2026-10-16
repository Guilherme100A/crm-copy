// AC-T27-01..05: export registrado em streaming, progresso por SSE, permissão de download, falha sem arquivo parcial
// e lista dos mais recentes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectApiError } from '../helpers/http'
import { uuid } from '../helpers/factories'
import { envelopeOf } from '../helpers/sse'
import { createJob, download, filesUnder, newMember, newOwner, openEvents, parseCsv, setKeys, sleep, startEnv, type Env, type User } from './setup'

let env: Env
let owner: User
const unregister: Array<() => void> = []
/** processed visto pela API quando o gerador chegou na linha 9000 (por job) */
const seenAt9000 = new Map<string, number>()
let pageCalls: number[] = []

const ROWS = 't27_rows'
const PAGED = 't27_paged'
const BOOM = 't27_boom'
const CONTACTS = 'contacts_export'

function register(kind: string, def: Record<string, unknown>) {
  if (kind === CONTACTS && env.core.getExportKind?.(kind)) return // já registrado por outro módulo
  unregister.push(env.core.registerExportKind(kind, def))
}

const columns = [
  { key: 'id', header: 'ID' },
  { key: 'name', header: 'Nome' },
  { key: 'note', header: 'Observação', format: (v: unknown) => (v === null || v === undefined ? '' : String(v)) },
]

beforeAll(async () => {
  env = await startEnv()
  owner = await newOwner(env)
  register(ROWS, {
    permission: 'contacts.view',
    columns,
    count: async (ctx: any) => Number(ctx.filters.n ?? 0),
    async *query(ctx: any) {
      const n = Number(ctx.filters.n ?? 0)
      for (let i = 1; i <= n; i++) {
        if (i === 9000) {
          const res = await owner.c.get(`/api/jobs/${ctx.jobId}`)
          seenAt9000.set(ctx.jobId, Number(res.body?.job?.progress?.processed ?? -1))
        }
        yield { id: i, name: `Linha ${i}`, note: i === 2 ? 'tem "aspas"; e vírgula, e\nquebra' : null }
      }
    },
  })
  register(PAGED, {
    permission: 'contacts.view',
    columns: [{ key: 'id', header: 'ID' }],
    count: async () => 3500,
    query: () =>
      env.core.keysetPages(
        async (after: any, limit: number) => {
          pageCalls.push(limit)
          const start = after ? after.id + 1 : 1
          const out = []
          for (let i = start; i < start + limit && i <= 3500; i++) out.push({ id: i })
          return out
        },
        { pageSize: 1000 },
      ),
  })
  register(BOOM, {
    permission: 'contacts.view',
    columns: [{ key: 'id', header: 'ID' }],
    count: async () => 1000,
    async *query() {
      for (let i = 1; i <= 500; i++) yield { id: i }
      throw new Error('boom')
    },
  })
  register(CONTACTS, { permission: 'contacts.view', columns: [{ key: 'id', header: 'ID' }], async *query() {} })
})
afterAll(async () => {
  for (const u of unregister) u()
  await env?.close()
})

describe('AC-T27-01 export em streaming', () => {
  it('AC-T27-01 export de 10 000 linhas termina completed com row_count e CSV válido (BOM, cabeçalho, linhas, RFC 4180)', async () => {
    const job = await createJob(owner, ROWS, { n: 10_000 })
    expect(job).toMatchObject({ kind: ROWS, type: 'export', status: 'queued', created_by: owner.userId })
    expect(env.enqueued).toContain(job.id)
    expect(await env.process(job.id)).toBeNull()

    const got = await owner.c.get(`/api/jobs/${job.id}`)
    expect(got.status, got.text).toBe(200)
    expect(got.body.job).toMatchObject({ id: job.id, status: 'completed', row_count: 10_000, error: null, download_url: `/api/jobs/${job.id}/file` })
    expect(got.body.job.file_size).toBeGreaterThan(0)
    expect(got.body.job.finished_at).toBeTruthy()

    const file = await download(env, owner, job.id)
    expect(file.status).toBe(200)
    expect(file.headers.get('content-type')).toMatch(/^text\/csv/)
    expect(file.headers.get('content-disposition')).toMatch(/attachment; filename=".+\.csv"/)
    expect([...file.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(file.bytes.byteLength).toBe(got.body.job.file_size)
    const rows = parseCsv(file.text.slice(1).replace(/(\r?\n)+$/, ''))
    expect(rows).toHaveLength(10_001)
    expect(rows[0]).toEqual(['ID', 'Nome', 'Observação'])
    expect(rows[1]).toEqual(['1', 'Linha 1', ''])
    expect(rows[2]).toEqual(['2', 'Linha 2', 'tem "aspas"; e vírgula, e\nquebra'])
    expect(rows[10_000]).toEqual(['10000', 'Linha 10000', ''])
    expect(rows.every((r) => r.length === 3)).toBe(true)
  })

  it('AC-T27-01 sem carregar tudo em memória: progresso já persistido durante a geração e query paginada em lotes', async () => {
    const job = await createJob(owner, ROWS, { n: 10_000 })
    await env.process(job.id)
    const seen = seenAt9000.get(job.id)
    expect(seen, 'o gerador não chegou na linha 9000').toBeDefined()
    expect(seen!).toBeGreaterThanOrEqual(8_000)
    expect(seen!).toBeLessThan(10_000)

    pageCalls = []
    const paged = await createJob(owner, PAGED)
    expect(await env.process(paged.id)).toBeNull()
    expect((await owner.c.get(`/api/jobs/${paged.id}`)).body.job).toMatchObject({ status: 'completed', row_count: 3500 })
    expect(pageCalls.length).toBeGreaterThanOrEqual(4)
    expect(pageCalls.every((l) => l === 1000)).toBe(true)
  })

  it('AC-T27-01 delimitador ";" opcional; kind desconhecido → 422; sem a permissão do kind → 403', async () => {
    const job = await createJob(owner, ROWS, { n: 3 }, { delimiter: ';' })
    await env.process(job.id)
    const file = await download(env, owner, job.id)
    const rows = parseCsv(file.text.slice(1).replace(/(\r?\n)+$/, ''), ';')
    expect(rows[0]).toEqual(['ID', 'Nome', 'Observação'])
    expect(rows[2]).toEqual(['2', 'Linha 2', 'tem "aspas"; e vírgula, e\nquebra'])
    expect(rows).toHaveLength(4)
    expectApiError(await owner.c.post('/api/jobs', { kind: 'nao_existe_t27' }), 'VALIDATION_ERROR', 422)
    const noPerm = await newMember(env, owner.companyId, ['chat.view'])
    expectApiError(await noPerm.c.post('/api/jobs', { kind: ROWS, filters: { n: 1 } }), 'FORBIDDEN', 403)
  })
})

describe('AC-T27-02 progresso em job.progress', () => {
  it('AC-T27-02 publica ao iniciar, ao menos a cada 10% e no fim (só para o criador)', async () => {
    const colleague = await newMember(env, owner.companyId, ['contacts.view', 'chat.view'])
    const mine = await openEvents(env, owner, owner.companyId)
    const theirs = await openEvents(env, colleague, owner.companyId)
    try {
      const job = await createJob(owner, ROWS, { n: 10_000 })
      await env.process(job.id)
      await mine.waitFor((m) => m.event === 'job.progress' && envelopeOf(m).data?.job_id === job.id && envelopeOf(m).data?.status === 'completed', 15_000)
      const evs = mine.events('job.progress').map((m) => envelopeOf(m).data).filter((d) => d.job_id === job.id)
      expect(evs[0]).toMatchObject({ kind: ROWS, status: 'processing' })
      const last = evs[evs.length - 1]
      expect(last).toMatchObject({ status: 'completed', row_count: 10_000, error: null })
      expect(last.progress.percent).toBe(100)
      const percents = evs.map((d) => Number(d.progress?.percent ?? 0))
      for (let i = 1; i < percents.length; i++) expect(percents[i]!).toBeGreaterThanOrEqual(percents[i - 1]!)
      // nenhum salto maior que 10 pontos entre eventos consecutivos
      for (let i = 1; i < percents.length; i++) expect(percents[i]! - percents[i - 1]!, JSON.stringify(percents)).toBeLessThanOrEqual(10)
      for (const k of [10, 20, 30, 40, 50, 60, 70, 80, 90]) expect(percents.some((p) => p >= k && p < k + 10), `marco ${k}%: ${JSON.stringify(percents)}`).toBe(true)
      const processed = evs.map((d) => Number(d.progress?.processed ?? 0))
      expect(processed[processed.length - 1]).toBe(10_000)

      await sleep(500)
      expect(theirs.events('job.progress').some((m) => envelopeOf(m).data?.job_id === job.id)).toBe(false)
    } finally {
      await Promise.all([mine.close(), theirs.close()])
    }
  })
})

describe('AC-T27-03 permissão de download', () => {
  it('AC-T27-03 criador e quem tem a permissão do kind baixam; sem permissão → 403; outra empresa → 404', async () => {
    const job = await createJob(owner, ROWS, { n: 5 })
    await env.process(job.id)
    const reader = await newMember(env, owner.companyId, ['contacts.view'])
    expect((await reader.c.get(`/api/jobs/${job.id}`)).status).toBe(200)
    expect((await download(env, reader, job.id)).status).toBe(200)

    const outsider = await newMember(env, owner.companyId, ['chat.view'])
    expectApiError(await outsider.c.get(`/api/jobs/${job.id}`), 'FORBIDDEN', 403)
    const denied = await download(env, outsider, job.id)
    expect(denied.status).toBe(403)
    expect(denied.text).not.toContain('Linha 1')
    expect((await outsider.c.get(`/api/jobs?kind=${ROWS}&limit=50`)).body.items.map((j: any) => j.id)).not.toContain(job.id)

    const other = await newOwner(env)
    expectApiError(await other.c.get(`/api/jobs/${job.id}`), 'NOT_FOUND', 404)
    const foreign = await download(env, other, job.id)
    expect(foreign.status).toBe(404)
    expect(foreign.text).not.toContain('Linha 1')
    expectApiError(await owner.c.get(`/api/jobs/${uuid()}`), 'NOT_FOUND', 404)
  })

  it('AC-T27-03 o criador continua baixando mesmo depois de perder a permissão do kind', async () => {
    const creator = await newMember(env, owner.companyId, ['contacts.view'])
    const job = await createJob(creator, ROWS, { n: 4 })
    await env.process(job.id)
    await setKeys(env, creator, ['chat.view'])
    expect((await creator.c.get(`/api/jobs/${job.id}`)).status).toBe(200)
    const file = await download(env, creator, job.id)
    expect(file.status).toBe(200)
    expect(file.text).toContain('Linha 4')
    // o owner (tudo liberado) também baixa
    expect((await download(env, owner, job.id)).status).toBe(200)
  })
})

describe('AC-T27-04 falha sem arquivo parcial', () => {
  it('AC-T27-04 erro na query → failed com a mensagem; sem arquivo (409 no download) e nada no diretório de exportações', async () => {
    const before = new Set(filesUnder(env.filesDir))
    const events = await openEvents(env, owner, owner.companyId)
    try {
      const job = await createJob(owner, BOOM)
      await env.process(job.id)
      const got = (await owner.c.get(`/api/jobs/${job.id}`)).body.job
      expect(got).toMatchObject({ status: 'failed', error: 'boom', file_size: null, row_count: null, download_url: null })
      expect(got.finished_at).toBeTruthy()
      const file = await download(env, owner, job.id)
      expect(file.status).toBe(409)
      expect(file.text).not.toContain('500')
      const created = filesUnder(env.filesDir).filter((p) => !before.has(p))
      expect(created, created.join(', ')).toEqual([])
      const ev = await events.waitFor((m) => m.event === 'job.progress' && envelopeOf(m).data?.job_id === job.id && envelopeOf(m).data?.status === 'failed', 10_000)
      expect(envelopeOf(ev).data.error).toBe('boom')
    } finally {
      await events.close()
    }
  })

  it('AC-T27-04 job ainda não concluído não tem arquivo (409)', async () => {
    const job = await createJob(owner, ROWS, { n: 2 })
    expect((await download(env, owner, job.id)).status).toBe(409)
    expect((await owner.c.get(`/api/jobs/${job.id}`)).body.job).toMatchObject({ status: 'queued', download_url: null })
  })
})

describe('AC-T27-05 lista dos mais recentes', () => {
  it('AC-T27-05 GET /api/jobs?kind=contacts_export&limit=3 lista os 3 mais recentes da empresa', async () => {
    const company = await newOwner(env)
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      ids.push((await createJob(company, CONTACTS)).id)
      await sleep(15)
    }
    await createJob(company, ROWS, { n: 1 })
    const other = await newOwner(env)
    await createJob(other, CONTACTS)

    const res = await company.c.get(`/api/jobs?kind=${CONTACTS}&limit=3`)
    expect(res.status, res.text).toBe(200)
    expect(res.body.items.map((j: any) => j.id)).toEqual([ids[4], ids[3], ids[2]])
    for (const j of res.body.items) expect(j.kind).toBe(CONTACTS)
    // padrão do limit = 3
    expect((await company.c.get(`/api/jobs?kind=${CONTACTS}`)).body.items.map((j: any) => j.id)).toEqual([ids[4], ids[3], ids[2]])
    const all = await company.c.get(`/api/jobs?kind=${CONTACTS}&limit=50`)
    expect(all.body.items.map((j: any) => j.id)).toEqual([...ids].reverse())
  })
})
