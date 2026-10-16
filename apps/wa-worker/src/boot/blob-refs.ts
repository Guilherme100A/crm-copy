// Mídia enviada pelo CRM chega como `MediaRef { url: 'blob:<sha256>' }` (T49): o arquivo já está no BlobStore
// compartilhado (STORAGE_DIR). Antes de entregar, a referência vira bytes (`{ data }`); a mensagem gravada em
// `public.messages` continua com a referência curta.
import type { BlobStore } from '@crm/node-kit'
import type { DeliverFn } from '@crm/wa-engine'

export const BLOB_URL_PREFIX = 'blob:'
const MEDIA_KEYS = ['image', 'video', 'audio', 'document', 'sticker'] as const

export class BlobRefNotFoundError extends Error {
  readonly code = 'MEDIA_NOT_FOUND'
  constructor(readonly key: string) {
    super(`blob ${key} não encontrado no storage`)
    this.name = 'BlobRefNotFoundError'
  }
}

/** Troca `{ url: 'blob:<key>' }` por `{ data }` lido do BlobStore. Outros conteúdos passam intactos. */
export async function resolveBlobRefs<T>(content: T, store: Pick<BlobStore, 'get'>): Promise<T> {
  if (!content || typeof content !== 'object') return content
  const c = content as Record<string, unknown>
  for (const kind of MEDIA_KEYS) {
    const ref = c[kind] as { url?: unknown } | undefined
    if (ref && typeof ref.url === 'string' && ref.url.startsWith(BLOB_URL_PREFIX)) {
      const key = ref.url.slice(BLOB_URL_PREFIX.length)
      const data = await store.get(key)
      if (!data) throw new BlobRefNotFoundError(key)
      return { ...c, [kind]: { data: new Uint8Array(data) } } as T
    }
  }
  return content
}

/** Embrulha o deliver (T20) para resolver referências `blob:` antes do antiban e do transporte. */
export function withBlobRefs(deliver: DeliverFn, store: Pick<BlobStore, 'get'>): DeliverFn {
  return async (transport, to, content) => deliver(transport, to, await resolveBlobRefs(content, store))
}
