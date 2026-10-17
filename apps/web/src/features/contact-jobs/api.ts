// API dos jobs de contatos da T86 (T67/T27): importação CSV (multipart → job `contacts_import`, status, modelo CSV) e
// o painel "Exportações recentes" (as 3 últimas exportações visíveis ao usuário). O job reaproveita o `JobDto` da T77.
import { queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import { CONTACTS_KEY, type JobDto } from '@/features/contacts/api'
import { apiUrl } from '@/lib/base'

const enc = encodeURIComponent

export const IMPORT_TEMPLATE_URL = apiUrl('/api/contacts/import-template.csv')
export const IMPORT_TEMPLATE_FILE_NAME = 'modelo_importacao_contatos.csv'

export interface ExportJobDto extends JobDto {
  file_size?: number | null
  created_at?: string | null
  finished_at?: string | null
}

export const importJobKey = (id: string) => [...CONTACTS_KEY, 'job', 'import', id] as const
export const RECENT_EXPORTS_KEY = [...CONTACTS_KEY, 'exports', 'recent'] as const

export const recentExportsQuery = () =>
  queryOptions({
    queryKey: RECENT_EXPORTS_KEY,
    queryFn: async () => (await api.get<{ items: ExportJobDto[] }>('/api/contacts/exports')).items,
    staleTime: 0,
  })

export const contactJobsApi = {
  /** Multipart (05 §3.6): `file`, `mode=upsert`, `create_missing_labels=true` e as etiquetas padrão. */
  startImport: async (file: File, defaultLabelIds: readonly string[]) => {
    const form = new FormData()
    form.append('file', file, file.name)
    form.append('mode', 'upsert')
    form.append('create_missing_labels', 'true')
    for (const id of defaultLabelIds) form.append('default_label_ids[]', id)
    if (defaultLabelIds.length) form.append('default_label_ids_json', JSON.stringify(defaultLabelIds))
    return (await api.post<{ job: JobDto }>('/api/contacts/imports', form)).job
  },
  getImport: async (id: string) => (await api.get<{ job: JobDto }>(`/api/contacts/imports/${enc(id)}`)).job,
}
