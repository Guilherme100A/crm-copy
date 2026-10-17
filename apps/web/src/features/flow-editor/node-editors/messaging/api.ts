// Dados dos editores de nó da T56: upload (`POST /api/media`, T49), figurinhas da empresa (`GET /api/stickers`, T35)
// e as variáveis do seletor (globais `GET /api/global-variables`, T26; campos `GET /api/custom-fields`).
import { queryOptions } from '@tanstack/react-query'
import { api, HttpError } from '@/lib/http'

export interface UploadedMedia {
  id: string
  mime: string
  size: number
  kind: string | null
  sha256: string
  file_name: string | null
}

export interface StickerItem {
  id: string
  name: string
  media_id: string
  url: string
}

/** Lista que a falta de permissão (403) não deve quebrar: o seletor só mostra menos itens. */
async function optional<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load()
  } catch (err) {
    if (err instanceof HttpError && (err.status === 403 || err.status === 404)) return fallback
    throw err
  }
}

export const nodeEditorsApi = {
  upload: async (file: Blob, name: string): Promise<UploadedMedia> => {
    const form = new FormData()
    form.append('file', file, name)
    return (await api.post<{ media: UploadedMedia }>('/api/media', form)).media
  },
  /**
   * Figurinha da biblioteca → referência `blob:`: a lista só traz o `media_id` (opaco), então os bytes são relidos
   * e reenviados ao `/api/media`, que é endereçado por conteúdo e devolve o mesmo `sha256` sem duplicar o arquivo.
   */
  stickerMedia: async (sticker: StickerItem): Promise<UploadedMedia> => {
    const res = await fetch(sticker.url, { credentials: 'same-origin' })
    if (!res.ok) throw new HttpError(res.status, 'STICKER_FETCH', res.statusText)
    const blob = await res.blob()
    return nodeEditorsApi.upload(blob, sticker.name || 'sticker.webp')
  },
}

export const NODE_EDITORS_KEY = ['flow-node-editors'] as const

export const stickersQuery = () =>
  queryOptions({
    queryKey: [...NODE_EDITORS_KEY, 'stickers'] as const,
    staleTime: 60_000,
    queryFn: () => optional(async () => (await api.get<{ items: StickerItem[] }>('/api/stickers')).items, [] as StickerItem[]),
  })

export const globalVariablesQuery = () =>
  queryOptions({
    queryKey: [...NODE_EDITORS_KEY, 'globals'] as const,
    staleTime: 60_000,
    queryFn: () => optional(async () => (await api.get<{ items: { name: string }[] }>('/api/global-variables', { query: { limit: 100 } })).items.map((g) => g.name), [] as string[]),
  })

export const customFieldsQuery = () =>
  queryOptions({
    queryKey: [...NODE_EDITORS_KEY, 'custom-fields'] as const,
    staleTime: 60_000,
    queryFn: () => optional(async () => (await api.get<{ items: { key: string }[] }>('/api/custom-fields')).items.map((f) => f.key), [] as string[]),
  })
