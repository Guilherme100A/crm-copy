import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { firstConnected, jobKey, jobPercent, mergeJobProgress, type JobDto } from './api'
import { chipsOf, clearAdvanced, contactsSearchSchema, effectiveSearch, hasFilters, toApiFilters, withoutChip } from './filters'
import { applyJobProgress } from './realtime'
import { bulkDeleteManifest, emptySelection, exportBody, isSelected, massDispatchDraft, selectAll, selectedCount, toggle, toggleVisible } from './selection'
import { formatDay } from './contacts-page'

const order = ['a', 'b', 'c', 'd', 'e']

describe('busca e filtros (AC-T77-01)', () => {
  it('termos só numéricos com menos de 4 dígitos são ignorados', () => {
    expect(effectiveSearch('123')).toBeUndefined()
    expect(effectiveSearch(' (11) ')).toBeUndefined()
    expect(effectiveSearch('1199')).toBe('1199')
    expect(effectiveSearch('ana')).toBe('ana')
    expect(effectiveSearch('   ')).toBeUndefined()
  })

  it('search params → filtros do fio; valor do campo só com chave', () => {
    const s = contactsSearchSchema.parse({ q: 'ana', labels: ['l1'], columns: ['c1'], from: '2026-01-01', to: '2026-01-31', cf_value: 'x' })
    expect(toApiFilters(s)).toEqual({ search: 'ana', label_ids: ['l1'], crm_column_ids: ['c1'], created_at_from: '2026-01-01', created_at_to: '2026-01-31' })
    expect(toApiFilters({ cf_key: 'origem', cf_value: ' site ' })).toEqual({ custom_field_key: 'origem', custom_field_value: 'site' })
    expect(hasFilters({})).toBe(false)
    expect(hasFilters({ q: '12' })).toBe(false)
    expect(contactsSearchSchema.parse({ labels: 'x' }).labels).toBeUndefined()
  })

  it('chips removíveis um a um e "Limpar filtros" mantém a busca', () => {
    const s = { q: 'ana', labels: ['l1', 'l2'], from: '2026-01-01', cf_key: 'k' }
    expect(chipsOf(s)).toEqual([{ kind: 'label', id: 'l1' }, { kind: 'label', id: 'l2' }, { kind: 'created-at' }, { kind: 'custom-field' }])
    expect(withoutChip(s, { kind: 'label', id: 'l1' }).labels).toEqual(['l2'])
    expect(withoutChip({ labels: ['l1'] }, { kind: 'label', id: 'l1' }).labels).toBeUndefined()
    expect(withoutChip({ from: 'a', to: 'b' }, { kind: 'created-at' })).toEqual({ from: undefined, to: undefined })
    expect(clearAdvanced(s)).toEqual({ q: 'ana' })
    expect(formatDay('2026-03-09')).toBe('09/03/2026')
  })
})

describe('seleção em massa (AC-T77-02)', () => {
  it('Shift+clique seleciona o intervalo a partir da âncora, nos dois sentidos', () => {
    let s = toggle(emptySelection(), 'b', order)
    s = toggle(s, 'd', order, true)
    expect(order.filter((id) => isSelected(s, id))).toEqual(['b', 'c', 'd'])
    s = toggle(s, 'a', order, true)
    expect(order.filter((id) => isSelected(s, id))).toEqual(['a', 'b', 'c', 'd'])
    // Shift sobre um marcado desmarca o intervalo
    s = toggle(s, 'c', order, true)
    expect(order.filter((id) => isSelected(s, id))).toEqual(['d'])
  })

  it('"todos do filtro": contagem = total − excluídos; total desconhecido usa o carregado', () => {
    let s = selectAll()
    s = toggle(s, 'b', order)
    s = toggle(s, 'c', order)
    expect(selectedCount(s, 57, 20)).toEqual({ n: 55, estimated: false })
    expect(selectedCount(s, null, 20)).toEqual({ n: 18, estimated: true })
    expect(selectedCount(toggleVisible(emptySelection(), order), 57, 5)).toEqual({ n: 5, estimated: false })
    expect(selectedCount(toggleVisible(toggleVisible(emptySelection(), order), order), 57, 5).n).toBe(0)
  })
})

describe('ações em massa (AC-T77-03)', () => {
  const filters = { search: 'ana', label_ids: ['l1'] }

  it('manifesto e exportação por modo', () => {
    const ids = toggle(toggle(emptySelection(), 'a', order), 'b', order)
    expect(bulkDeleteManifest(ids, filters)).toEqual({ version: 1, mode: 'ids', filters: {}, ids: ['a', 'b'] })
    const all = toggle(selectAll(), 'c', order)
    expect(bulkDeleteManifest(all, filters)).toEqual({ version: 1, mode: 'all_except', filters, except_ids: ['c'] })
    expect(exportBody(null, filters, true)).toEqual({ mode: 'filtered', filters, include_custom_fields: true })
    expect(exportBody(ids, filters, false)).toEqual({ mode: 'ids', ids: ['a', 'b'], include_custom_fields: false })
    expect(exportBody(all, filters, false)).toEqual({ mode: 'all_except', except_ids: ['c'], filters, include_custom_fields: false })
  })

  it('rascunho do disparo em massa leva seleção, filtros e contagem', () => {
    expect(massDispatchDraft(toggle(selectAll(), 'c', order), filters, 41)).toEqual({ open_create: true, mode: 'all_except', ids: [], except_ids: ['c'], filters, count: 41 })
  })

  it('progresso do job: SSE atualiza o cache e não regride um job terminado', () => {
    const job: JobDto = { id: 'j1', kind: 'contacts_bulk_delete', status: 'processing', progress: { processed: 0, total: 10, percent: 0 }, row_count: null, counters: {}, error: null, file_name: null, download_url: null }
    const qc = new QueryClient()
    qc.setQueryData(jobKey('bulk-delete', 'j1'), job)
    applyJobProgress(qc, { job_id: 'j1', kind: 'contacts_bulk_delete', status: 'processing', progress: { processed: 5, total: 10, percent: 50 } })
    const cur = qc.getQueryData<JobDto>(jobKey('bulk-delete', 'j1'))!
    expect(jobPercent(cur)).toBe(50)
    applyJobProgress(qc, { job_id: 'j1', kind: 'kanban_cards', progress: { processed: 9, total: 10, percent: 90 } })
    expect(jobPercent(qc.getQueryData<JobDto>(jobKey('bulk-delete', 'j1'))!)).toBe(50)
    const done = { ...cur, status: 'completed' as const }
    expect(mergeJobProgress(done, { status: 'processing' }).status).toBe('completed')
    expect(jobPercent({ ...job, progress: { processed: 3, total: null, percent: null } })).toBeNull()
  })
})

describe('Importar do WhatsApp (AC-T77-04)', () => {
  it('só a primeira conexão conectada habilita o botão', () => {
    expect(firstConnected([{ id: '1', name: 'A', status: 'connecting' }])).toBeNull()
    expect(firstConnected([{ id: '1', name: 'A', status: 'disconnected' }, { id: '2', name: 'B', status: 'connected' }])?.id).toBe('2')
    expect(firstConnected(undefined)).toBeNull()
  })
})
