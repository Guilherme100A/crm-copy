import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it } from 'vitest'
import { boardQuery } from '@/features/crms/api'
import { configureHttp } from '@/lib/http'
import { COLUMN_COLORS, exportApi, fileUrl, mergeJobProgress, statsQuery, type JobDto } from './api'
import { colorTestId } from './column-modal'
import { progressLabel } from './export-control'
import { activeFilterCount, boardSearchSchema, cleanSearch, localDayToIso, toApiFilters, toggleLabel, toQuery } from './filters'
import { applyJobProgress, jobKey } from './realtime'
import { formatRate } from './stats-panel'

afterEach(() => configureHttp({ companyId: null }))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const job = (over: Partial<JobDto> = {}): JobDto => ({
  id: 'j1',
  kind: 'kanban_cards',
  status: 'queued',
  progress: { processed: 0, total: null, percent: null },
  row_count: null,
  error: null,
  file_name: null,
  download_url: null,
  ...over,
})

describe('filtros na URL (AC-T76-02)', () => {
  it('valida a search e descarta lixo', () => {
    expect(boardSearchSchema.parse({ column_id: 'c1', label_ids: ['a', 'b'], updated_from: '2026-01-02', updated_to: 'ontem' })).toEqual({
      column_id: 'c1',
      label_ids: ['a', 'b'],
      updated_from: '2026-01-02',
      updated_to: undefined,
    })
  })

  it('traduz para a T50: datas locais viram início/fim do dia em ISO, etiquetas em lista', () => {
    const f = toApiFilters({ column_id: 'c1', label_ids: ['a', 'a', 'b'], assigned_to: 'me', updated_from: '2026-03-01', updated_to: '2026-03-02' })
    expect(f).toEqual({
      column_id: 'c1',
      label_ids: ['a', 'b'],
      assigned_to: 'me',
      updated_from: new Date(2026, 2, 1, 0, 0, 0, 0).toISOString(),
      updated_to: new Date(2026, 2, 2, 23, 59, 59, 999).toISOString(),
    })
    expect(toQuery(f)).toMatchObject({ label_ids: 'a,b', column_id: 'c1' })
    expect(toApiFilters({})).toEqual({})
    expect(localDayToIso('2026-12-31', true)).toBe(new Date(2026, 11, 31, 23, 59, 59, 999).toISOString())
  })

  it('etiquetas alternam na hora; limpar tira chaves vazias; contador conta o período uma vez', () => {
    const on = toggleLabel({}, 'a')
    expect(on).toEqual({ label_ids: ['a'] })
    expect(toggleLabel(on, 'a')).toEqual({})
    expect(cleanSearch({ column_id: '', label_ids: [], assigned_to: undefined })).toEqual({})
    expect(activeFilterCount({ column_id: 'c', updated_from: '2026-01-01', updated_to: '2026-01-02', label_ids: ['x'] })).toBe(3)
  })

  it('filtro de etapa carrega só aquela coluna (uma request de cards)', async () => {
    const calls: string[] = []
    const col = (id: string, position: number) => ({ id, crm_id: 'b1', name: id, position, accent_color: null, conversion_goal: false, created_at: '', updated_at: '' })
    configureHttp({
      fetch: async (url) => {
        calls.push(url)
        if (url === '/api/crms/b1')
          return json({ crm: { id: 'b1', name: 'B', columns: [col('a', 0), col('b', 1)], quantity_of_columns: 2, summary: {}, created_at: '', updated_at: '' } })
        return json({ items: [], page: { page: 1, limit: 20, total_count: 0, has_more: false }, columns: [{ column_id: 'b', total_count: 0, total_value_cents: 0 }] })
      },
    })
    const qc = new QueryClient()
    const state = await qc.fetchQuery(boardQuery(qc, 'b1', { column_id: 'b', label_ids: ['l1', 'l2'] }))
    const cardCalls = calls.filter((u) => u.includes('/cards'))
    expect(cardCalls).toHaveLength(1)
    expect(cardCalls[0]).toContain('column_id=b')
    expect(cardCalls[0]).toContain('label_ids=l1%2Cl2')
    expect(state.visible).toEqual(['b'])
    expect(state.columns.map((c) => c.id)).toEqual(['a', 'b'])
  })
})

describe('modal de coluna (AC-T76-01)', () => {
  it('8 cores + Automático com testids estáveis', () => {
    expect(COLUMN_COLORS).toHaveLength(8)
    expect(colorTestId(null)).toBe('kt-column-color-auto')
    expect(colorTestId('#3B82F6')).toBe('kt-column-color-3b82f6')
  })
})

describe('estatísticas (AC-T76-03)', () => {
  it('formata taxas (— na primeira etapa) e pede /stats com os filtros', async () => {
    expect(formatRate(null)).toBe('—')
    expect(formatRate(50)).toBe('50,0%')
    expect(formatRate(28.571, 2)).toBe('28,57%')
    const seen: string[] = []
    configureHttp({
      fetch: async (url) => {
        seen.push(url)
        return json({ total_cards: 0, stages: [], conversion_count: 0, conversion_rate: 0, totals: {} })
      },
    })
    const qc = new QueryClient()
    await qc.fetchQuery(statsQuery('b1', { assigned_to: 'none' }))
    expect(seen[0]).toBe('/api/crms/b1/stats?assigned_to=none')
  })
})

describe('exportação (AC-T76-04)', () => {
  it('cria o job kanban_cards com crm_id e os filtros', async () => {
    let body: unknown
    configureHttp({
      fetch: async (url, init) => {
        body = JSON.parse(String(init.body))
        expect(url).toBe('/api/jobs')
        return json({ job: job() }, 201)
      },
    })
    await exportApi.start('b1', { column_id: 'c', label_ids: ['l'] })
    expect(body).toEqual({ kind: 'kanban_cards', filters: { crm_id: 'b1', column_id: 'c', label_ids: ['l'] } })
    expect(fileUrl('j1')).toBe('/api/jobs/j1/file')
  })

  it('job.progress atualiza o cache sem regredir um estado final', () => {
    expect(mergeJobProgress(job(), { job_id: 'j1', status: 'processing', progress: { processed: 5, total: 10, percent: 50 } })).toMatchObject({
      status: 'processing',
      progress: { percent: 50 },
    })
    expect(mergeJobProgress(job({ status: 'completed' }), { job_id: 'j1', status: 'processing' }).status).toBe('completed')
    expect(mergeJobProgress(job(), { job_id: 'outro', status: 'failed' }).status).toBe('queued')
    const qc = new QueryClient()
    qc.setQueryData(jobKey('j1'), job())
    applyJobProgress(qc, { job_id: 'j1', status: 'processing', progress: { processed: 1, total: 4, percent: 25 } })
    expect(qc.getQueryData<JobDto>(jobKey('j1'))?.progress.percent).toBe(25)
  })

  it('rótulo do progresso', () => {
    const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}:${v.n}` : k)
    expect(progressLabel(job(), t)).toBe('export.queued')
    expect(progressLabel(job({ status: 'processing', progress: { processed: 4, total: 9, percent: 44.6 } }), t)).toBe('45%')
    expect(progressLabel(job({ status: 'processing' }), t)).toBe('export.processing')
    expect(progressLabel(job({ status: 'completed', row_count: 3 }), t)).toBe('export.completed:3')
  })
})
