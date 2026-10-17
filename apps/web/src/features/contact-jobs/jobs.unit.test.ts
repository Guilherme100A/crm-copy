import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { CONTACTS_KEY, type JobDto } from '@/features/contacts/api'
import { importJobKey, RECENT_EXPORTS_KEY, type ExportJobDto } from './api'
import {
  formatBytes,
  IMPORT_POLL_MS,
  importCounts,
  importFileError,
  importPhase,
  importReport,
  sortRecentExports,
} from './jobs'
import { applyContactJobProgress } from './realtime'

const job = (patch: Partial<JobDto> = {}): JobDto => ({
  id: 'j1',
  kind: 'contacts_import',
  status: 'queued',
  progress: { processed: 0, total: null, percent: null },
  row_count: null,
  counters: {},
  error: null,
  file_name: null,
  download_url: null,
  ...patch,
})

describe('progresso da importação (AC-T86-03)', () => {
  it('fase visual: fila → leitura → importação → fim', () => {
    expect(importPhase(job())).toBe('starting')
    expect(importPhase(job({ status: 'processing' }))).toBe('reading')
    expect(
      importPhase(
        job({ status: 'processing', progress: { processed: 0, total: null, percent: null, phase: 'reading' } }),
      ),
    ).toBe('reading')
    expect(
      importPhase(
        job({ status: 'processing', progress: { processed: 10, total: 100, percent: 10, phase: 'importing' } }),
      ),
    ).toBe('importing')
    expect(importPhase(job({ status: 'completed' }))).toBe('completed')
    expect(importPhase(job({ status: 'failed' }))).toBe('failed')
  })

  it('contadores parciais vêm do progresso; os finais de `counters`', () => {
    const partial = job({
      status: 'processing',
      progress: {
        processed: 200,
        total: 500,
        percent: 40,
        counters: { created: 150, updated: 40, skipped: 5, errors: 5 },
      },
    })
    expect(importCounts(partial)).toEqual({ created: 150, updated: 40, skipped: 5, errors: 5 })
    const done = job({
      status: 'completed',
      counters: { created: 400, updated: 90, skipped: 5, errors: 5 },
      progress: partial.progress,
    })
    expect(importCounts(done)).toEqual({ created: 400, updated: 90, skipped: 5, errors: 5 })
    expect(importCounts(job())).toEqual({ created: 0, updated: 0, skipped: 0, errors: 0 })
  })

  it('reserva do SSE: consulta a cada 2 s', () => {
    expect(IMPORT_POLL_MS).toBe(2_000)
  })

  it('arquivo: só .csv e até 50 MB', () => {
    expect(importFileError({ name: 'contatos.CSV', size: 10 })).toBeNull()
    expect(importFileError({ name: 'contatos.xlsx', size: 10 })).toBe('type')
    expect(importFileError({ name: 'a.csv', size: 50 * 1024 * 1024 + 1 })).toBe('size')
  })
})

describe('relatório final da importação (AC-T86-03)', () => {
  it('erros agrupados por mensagem com as linhas, avisos agrupados e etiquetas criadas', () => {
    const r = importReport(
      job({
        status: 'completed',
        counters: {
          created: 2,
          updated: 1,
          skipped: 0,
          errors: 4,
          labels_created: ['VIP'],
          error_groups: [
            { message: 'Telefone inválido', count: 2, lines: [3, 5] },
            { message: 'Nome obrigatório', count: 1, lines: [7] },
          ],
          errors_report: ['Linha 3: Telefone inválido'],
          warning_groups: [{ message: 'UF ignorada', count: 3 }],
        },
      }),
    )
    expect(r).toMatchObject({ created: 2, updated: 1, skipped: 0, errors: 4, labelsCreated: ['VIP'], extraErrors: 1 })
    expect(r.errorGroups).toEqual([
      { message: 'Telefone inválido', count: 2, lines: [3, 5] },
      { message: 'Nome obrigatório', count: 1, lines: [7] },
    ])
    expect(r.warningGroups).toEqual([{ message: 'UF ignorada', count: 3 }])
  })

  it('contadores ausentes ou malformados viram vazio', () => {
    const r = importReport(job({ status: 'completed', counters: { error_groups: 'x', labels_created: null } }))
    expect(r).toMatchObject({
      created: 0,
      errors: 0,
      errorGroups: [],
      warningGroups: [],
      labelsCreated: [],
      extraErrors: 0,
    })
  })
})

describe('job.progress no cache (AC-T86-03/04)', () => {
  it('importação: mescla o progresso; ao terminar recarrega job, lista e etiquetas', () => {
    const qc = new QueryClient()
    qc.setQueryData(importJobKey('j1'), job({ status: 'processing' }))
    applyContactJobProgress(qc, {
      job_id: 'j1',
      kind: 'contacts_import',
      status: 'processing',
      progress: { processed: 200, total: 400, percent: 50 },
    })
    expect(qc.getQueryData<JobDto>(importJobKey('j1'))).toMatchObject({
      status: 'processing',
      progress: { processed: 200, total: 400, percent: 50 },
    })

    const invalidated: unknown[] = []
    qc.invalidateQueries = (async (f?: { queryKey?: unknown }) =>
      void invalidated.push(f?.queryKey)) as QueryClient['invalidateQueries']
    applyContactJobProgress(qc, {
      job_id: 'j1',
      kind: 'contacts_import',
      status: 'completed',
      progress: { processed: 400, total: 400, percent: 100 },
    })
    expect(qc.getQueryData<JobDto>(importJobKey('j1'))?.status).toBe('completed')
    expect(invalidated).toEqual([importJobKey('j1'), [...CONTACTS_KEY, 'list'], [...CONTACTS_KEY, 'labels']])
  })

  it('exportação recarrega o painel de recentes; outros kinds e eventos sem id são ignorados', () => {
    const qc = new QueryClient()
    const invalidated: unknown[] = []
    qc.invalidateQueries = (async (f?: { queryKey?: unknown }) =>
      void invalidated.push(f?.queryKey)) as QueryClient['invalidateQueries']
    applyContactJobProgress(qc, { job_id: 'e1', kind: 'contacts_export', status: 'completed' })
    applyContactJobProgress(qc, { job_id: 'b1', kind: 'contacts_bulk_delete', status: 'completed' })
    applyContactJobProgress(qc, { kind: 'contacts_import', status: 'completed' })
    applyContactJobProgress(qc, null)
    expect(invalidated).toEqual([RECENT_EXPORTS_KEY])
    expect(qc.getQueryData(importJobKey('x'))).toBeUndefined()
  })
})

describe('exportações recentes (AC-T86-04)', () => {
  const ex = (id: string, status: JobDto['status'], created_at: string): ExportJobDto => ({
    ...job({ id, kind: 'contacts_export', status }),
    created_at,
  })

  it('em andamento primeiro, depois a mais nova', () => {
    const sorted = sortRecentExports([
      ex('old', 'completed', '2026-10-01T10:00:00Z'),
      ex('new', 'completed', '2026-10-03T10:00:00Z'),
      ex('run', 'processing', '2026-09-01T10:00:00Z'),
    ])
    expect(sorted.map((j) => j.id)).toEqual(['run', 'new', 'old'])
  })

  it('tamanho legível', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1,5 KB')
    expect(formatBytes(1536, 'en')).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatBytes(null)).toBe('')
  })
})
