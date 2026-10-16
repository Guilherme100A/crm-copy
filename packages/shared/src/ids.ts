// Identificadores: UUID (Postgres `gen_random_uuid()`) em todas as entidades.
import * as z from 'zod'

export const idSchema = z.uuid()
export type Id = z.infer<typeof idSchema>

export function isId(value: unknown): value is Id {
  return idSchema.safeParse(value).success
}

// `crypto.randomUUID` é global no Node 22 e nos navegadores (contexto seguro); sem import de `node:crypto`.
const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto

/** Novo UUID v4. */
export function newId(): Id {
  if (!webCrypto?.randomUUID) throw new Error('crypto.randomUUID indisponível neste ambiente')
  return webCrypto.randomUUID()
}
