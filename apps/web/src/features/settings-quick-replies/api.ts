// API das respostas rápidas (T35; 17 §3.A): lista paginada com busca, CRUD e a mídia/figurinhas das ações.
// DTOs locais: a web não importa `@crm/core`.
import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { api } from '@/lib/http'
import type { PageMeta } from './kit'

export const QR_ACTION_TYPES = ['send_message', 'send_multi_media', 'send_sticker', 'send_contact'] as const
export type QrActionType = (typeof QR_ACTION_TYPES)[number]
export const QR_MEDIA_TYPES = ['image', 'video', 'audio', 'document'] as const
export type QrMediaType = (typeof QR_MEDIA_TYPES)[number]

export interface QrActionDto {
  id: string
  type: QrActionType
  order: number
  config: Record<string, unknown>
}

export interface QuickReplyDto {
  id: string
  shortcut: string
  actions: QrActionDto[]
  preview: string
  created_at: string
  updated_at: string
}

export interface QuickReplyInput {
  shortcut: string
  actions: { type: QrActionType; order: number; config: Record<string, unknown> }[]
}

export interface StickerDto {
  id: string
  name: string
  media_id: string
  url: string
}

export const QR_PAGE_SIZE = 20
export const QR_KEY = ['settings-quick-replies'] as const
const enc = encodeURIComponent

export const quickRepliesPageQuery = (page: number, search: string) =>
  queryOptions({
    queryKey: [...QR_KEY, 'list', page, search] as const,
    queryFn: () =>
      api.get<{ items: QuickReplyDto[]; page: PageMeta }>('/api/quick-replies', {
        query: { page, limit: QR_PAGE_SIZE, search: search || undefined },
      }),
    placeholderData: keepPreviousData,
  })

export const stickersQuery = () =>
  queryOptions({
    queryKey: [...QR_KEY, 'stickers'] as const,
    queryFn: async () => (await api.get<{ items: StickerDto[] }>('/api/stickers')).items,
    staleTime: 60_000,
  })

export const quickRepliesApi = {
  create: async (input: QuickReplyInput) =>
    (await api.post<{ quick_reply: QuickReplyDto }>('/api/quick-replies', input)).quick_reply,
  update: async (id: string, input: QuickReplyInput) =>
    (await api.patch<{ quick_reply: QuickReplyDto }>(`/api/quick-replies/${enc(id)}`, input)).quick_reply,
  remove: (id: string) => api.delete(`/api/quick-replies/${enc(id)}`),
  upload: async (file: File) => {
    const form = new FormData()
    form.append('file', file, file.name)
    return (await api.post<{ media: { id: string; mime: string } }>('/api/media', form)).media
  },
}
