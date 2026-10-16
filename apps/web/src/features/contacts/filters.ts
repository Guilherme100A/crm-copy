// Filtros da lista de contatos (05 §3.3) em search params tipados da rota `/customers` (SPEC 3.11): busca, etiquetas,
// etapas do kanban, data de criação e campo personalizado. Daqui saem a query da API, os chips e o filtro do manifesto.
import { z } from 'zod'

const list = z.array(z.string()).optional().catch(undefined)
const text = z.string().optional().catch(undefined)

export const contactsSearchSchema = z.object({
  q: text,
  labels: list,
  columns: list,
  from: text,
  to: text,
  cf_key: text,
  cf_value: text,
})
export type ContactsSearch = z.infer<typeof contactsSearchSchema>

/** Busca efetiva: termos só numéricos com menos de 4 dígitos são ignorados (05 §5 nº 2). */
export function effectiveSearch(raw: string | undefined): string | undefined {
  const v = raw?.trim()
  if (!v) return undefined
  const digits = v.replace(/[\s()+.-]/g, '')
  if (/^\d+$/.test(digits) && digits.length < 4) return undefined
  return v
}

/** Filtros no formato do fio (listagem, exportação e manifesto). */
export interface ApiFilters {
  search?: string
  label_ids?: string[]
  crm_column_ids?: string[]
  created_at_from?: string
  created_at_to?: string
  custom_field_key?: string
  custom_field_value?: string
}

export function toApiFilters(s: ContactsSearch): ApiFilters {
  const out: ApiFilters = {}
  const search = effectiveSearch(s.q)
  if (search) out.search = search
  if (s.labels?.length) out.label_ids = [...s.labels]
  if (s.columns?.length) out.crm_column_ids = [...s.columns]
  if (s.from) out.created_at_from = s.from
  if (s.to) out.created_at_to = s.to
  const key = s.cf_key?.trim()
  if (key) {
    out.custom_field_key = key
    const value = s.cf_value?.trim()
    if (value) out.custom_field_value = value
  }
  return out
}

/** Há filtro (busca ou avançado)? Decide entre "Todos do filtro" e "Todos da conta". */
export const hasFilters = (s: ContactsSearch) => Object.keys(toApiFilters(s)).length > 0

/** Só os filtros avançados (sem a busca), para os chips e o contador do botão. */
export const advancedFilters = (s: ContactsSearch): ContactsSearch => ({
  labels: s.labels?.length ? s.labels : undefined,
  columns: s.columns?.length ? s.columns : undefined,
  from: s.from || undefined,
  to: s.to || undefined,
  cf_key: s.cf_key?.trim() || undefined,
  cf_value: s.cf_key?.trim() && s.cf_value?.trim() ? s.cf_value : undefined,
})

export type Chip = { kind: 'label'; id: string } | { kind: 'column'; id: string } | { kind: 'created-at' } | { kind: 'custom-field' }

export function chipsOf(s: ContactsSearch): Chip[] {
  const a = advancedFilters(s)
  const chips: Chip[] = []
  for (const id of a.labels ?? []) chips.push({ kind: 'label', id })
  for (const id of a.columns ?? []) chips.push({ kind: 'column', id })
  if (a.from || a.to) chips.push({ kind: 'created-at' })
  if (a.cf_key) chips.push({ kind: 'custom-field' })
  return chips
}

/** Remove um chip: devolve os search params sem aquele filtro. */
export function withoutChip(s: ContactsSearch, chip: Chip): ContactsSearch {
  const drop = (xs: string[] | undefined, id: string) => {
    const left = (xs ?? []).filter((x) => x !== id)
    return left.length ? left : undefined
  }
  switch (chip.kind) {
    case 'label':
      return { ...s, labels: drop(s.labels, chip.id) }
    case 'column':
      return { ...s, columns: drop(s.columns, chip.id) }
    case 'created-at':
      return { ...s, from: undefined, to: undefined }
    case 'custom-field':
      return { ...s, cf_key: undefined, cf_value: undefined }
  }
}

/** "Limpar filtros": tira os avançados e mantém a busca. */
export const clearAdvanced = (s: ContactsSearch): ContactsSearch => ({ q: s.q })
