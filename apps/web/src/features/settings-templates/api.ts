// API dos modelos internos de mensagem (T35; 17 §3.B adaptado): CRUD paginado, prévia renderizada pelo servidor com o
// contato de exemplo e as fontes das variáveis (contatos e variáveis globais). DTOs locais.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import type { PageMeta } from '@/features/settings-quick-replies/kit'
import { api, HttpError } from '@/lib/http'

export const HEADER_TYPES = ['none', 'text', 'image', 'video', 'document'] as const
export type HeaderType = (typeof HEADER_TYPES)[number]
export const BUTTON_TYPES = ['reply', 'url', 'phone'] as const
export type ButtonType = (typeof BUTTON_TYPES)[number]

export interface TemplateHeader {
  type: HeaderType
  text?: string | null
  media_id?: string | null
}
export interface TemplateButton {
  type: ButtonType
  text: string
  url?: string | null
  phone?: string | null
}
export interface TemplateContent {
  header: TemplateHeader
  body: string
  footer?: string | null
  buttons: TemplateButton[]
}
export interface TemplateDto extends TemplateContent {
  id: string
  name: string
  created_at: string
  updated_at: string
}
export type TemplateInput = TemplateContent & { name: string }

export interface ExampleContact {
  id: string
  name: string
  phone_e164: string | null
}

export const TEMPLATES_PAGE_SIZE = 20
export const TEMPLATES_KEY = ['settings-templates'] as const
const enc = encodeURIComponent

export const templatesPageQuery = (page: number, search: string) =>
  queryOptions({
    queryKey: [...TEMPLATES_KEY, 'list', page, search] as const,
    queryFn: () =>
      api.get<{ items: TemplateDto[]; page: PageMeta }>('/api/message-templates', {
        query: { page, limit: TEMPLATES_PAGE_SIZE, search: search || undefined },
      }),
    placeholderData: keepPreviousData,
  })

/** Contatos para escolher o exemplo da prévia; sem `contacts.view` a lista fica vazia. */
export const exampleContactsQuery = (search: string) =>
  queryOptions({
    queryKey: [...TEMPLATES_KEY, 'contacts', search] as const,
    staleTime: 30_000,
    queryFn: async () => {
      try {
        return (
          await api.get<{ items: ExampleContact[] }>('/api/contacts', {
            query: { limit: 20, search: search || undefined, skip_total_count: 1 },
          })
        ).items
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return []
        throw err
      }
    },
  })

/** Nomes das variáveis globais (chips de inserção). */
export const globalNamesQuery = () =>
  queryOptions({
    queryKey: [...TEMPLATES_KEY, 'globals'] as const,
    staleTime: 60_000,
    queryFn: async () => {
      try {
        return (
          await api.get<{ items: { name: string }[] }>('/api/global-variables', { query: { limit: 100 } })
        ).items.map((g) => g.name)
      } catch (err) {
        if (err instanceof HttpError && err.status === 403) return []
        throw err
      }
    },
  })

export const previewQuery = (template: string, contactId: string | null) =>
  queryOptions({
    queryKey: [...TEMPLATES_KEY, 'preview', template, contactId] as const,
    queryFn: () => api.post<{ text: string }>('/api/content/render', { template, contact_id: contactId }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })

export const templatesApi = {
  create: async (input: TemplateInput) =>
    (await api.post<{ template: TemplateDto }>('/api/message-templates', input)).template,
  update: async (id: string, input: TemplateInput) =>
    (await api.patch<{ template: TemplateDto }>(`/api/message-templates/${enc(id)}`, input)).template,
  remove: (id: string) => api.delete(`/api/message-templates/${enc(id)}`),
  upload: async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return (await api.post<{ media: { id: string; mime: string } }>('/api/media', form)).media
  },
}
