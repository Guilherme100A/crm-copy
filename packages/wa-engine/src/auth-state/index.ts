// Auth state do Baileys persistido cifrado no Postgres (SPEC T06, portado de ai-manager core/auth-state).
// Cada creds/key vira uma linha em `session_credentials` com JSON (BufferJSON) cifrado em AES-256-GCM; o AAD
// `sessionId/keyType/keyId` amarra cada ciphertext à sua linha. O key store do banco fica atrás do
// `makeCacheableSignalKeyStore` do Baileys: leituras repetidas da mesma chave saem do cache em memória.
import {
  BufferJSON,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'
import { getCredentialsCipher, type CredentialCipher } from '@crm/node-kit'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { sessionCredentials, type Database } from '../db'

export const CREDS_KEY_TYPE = 'creds'
export const CREDS_KEY_ID = 'creds'

type KeyStoreLogger = Parameters<typeof makeCacheableSignalKeyStore>[1]
type KeyStoreCache = Parameters<typeof makeCacheableSignalKeyStore>[2]

export interface PostgresAuthState {
  /** `keys` já vem envolvido pelo cache (passe direto ao `makeWASocket({ auth: state })`). */
  state: AuthenticationState
  saveCreds: () => Promise<void>
  /** Remove todas as credenciais da sessão (ex.: após logout). */
  clear: () => Promise<void>
}

export interface PostgresAuthStateOptions {
  /** Cifrador; default: o padrão de `CREDENTIALS_KEY` (`@crm/node-kit`). */
  cipher?: CredentialCipher
  /** Logger (pino) repassado ao `makeCacheableSignalKeyStore`. */
  logger?: KeyStoreLogger
  /** Cache do key store (default: o do Baileys, TTL 5 min). `false` desliga o cache. */
  cache?: KeyStoreCache | false
}

/** AAD que amarra cada ciphertext à sua linha (impede trocar valores entre sessões/chaves). */
export const credentialAad = (sessionId: string, keyType: string, keyId: string) => `${sessionId}/${keyType}/${keyId}`

type Row = typeof sessionCredentials.$inferSelect
type SealedRow = typeof sessionCredentials.$inferInsert

/**
 * O cache do Baileys (rc14) guarda o `null` de uma chave removida e o devolve no `get` (`{ '1': null }`).
 * Filtra esses valores para que chave removida seja ausente, como no store do banco, sem perder o cache.
 */
function withoutRemovedKeys(cached: SignalKeyStore): SignalKeyStore {
  return {
    get: async (type, ids) => {
      const data = await cached.get(type, ids)
      for (const id of Object.keys(data)) if (data[id] === null || data[id] === undefined) delete data[id]
      return data
    },
    set: (data) => cached.set(data),
    clear: () => cached.clear?.(),
  }
}

export async function usePostgresAuthState(
  db: Database,
  sessionId: string,
  opts: PostgresAuthStateOptions = {},
): Promise<PostgresAuthState> {
  const cipher = opts.cipher ?? getCredentialsCipher()

  const seal = (keyType: string, keyId: string, value: unknown): SealedRow => {
    const json = JSON.stringify(value, BufferJSON.replacer)
    const enc = cipher.encrypt(json, credentialAad(sessionId, keyType, keyId))
    return { sessionId, keyType, keyId, ciphertext: enc.ciphertext, iv: enc.iv, authTag: enc.authTag, keyVersion: enc.keyVersion }
  }

  const open = (row: Row): unknown => {
    const json = cipher.decrypt<string>(
      { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, keyVersion: row.keyVersion },
      credentialAad(sessionId, row.keyType, row.keyId),
    )
    return JSON.parse(json, BufferJSON.reviver)
  }

  const upsert = async (rows: SealedRow[], exec: Pick<Database, 'insert'> = db) => {
    if (rows.length === 0) return
    await exec
      .insert(sessionCredentials)
      .values(rows)
      .onConflictDoUpdate({
        target: [sessionCredentials.sessionId, sessionCredentials.keyType, sessionCredentials.keyId],
        set: {
          ciphertext: sql`excluded.ciphertext`,
          iv: sql`excluded.iv`,
          authTag: sql`excluded.auth_tag`,
          keyVersion: sql`excluded.key_version`,
          updatedAt: sql`now()`,
        },
      })
  }

  const [credsRow] = await db
    .select()
    .from(sessionCredentials)
    .where(
      and(
        eq(sessionCredentials.sessionId, sessionId),
        eq(sessionCredentials.keyType, CREDS_KEY_TYPE),
        eq(sessionCredentials.keyId, CREDS_KEY_ID),
      ),
    )
    .limit(1)
  const creds: AuthenticationCreds = credsRow ? (open(credsRow) as AuthenticationCreds) : initAuthCreds()

  // `keyType` é texto livre: os tipos novos do v7 (`lid-mapping`, `device-list`, `tctoken`, `identity-key`) passam
  // sem enum no banco.
  const store: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const data: { [id: string]: SignalDataTypeMap[T] } = {}
      if (ids.length === 0) return data
      const rows = await db
        .select()
        .from(sessionCredentials)
        .where(
          and(
            eq(sessionCredentials.sessionId, sessionId),
            eq(sessionCredentials.keyType, type),
            inArray(sessionCredentials.keyId, ids),
          ),
        )
      for (const row of rows) {
        let value = open(row)
        // O proto precisa ser reidratado: o Baileys chama métodos do AppStateSyncKeyData.
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>)
        }
        data[row.keyId] = value as SignalDataTypeMap[T]
      }
      return data
    },
    set: async (data: SignalDataSet) => {
      const toUpsert: SealedRow[] = []
      const toDelete = new Map<string, string[]>()
      for (const category in data) {
        const entries = data[category as keyof SignalDataTypeMap] ?? {}
        for (const id in entries) {
          const value = entries[id]
          if (value !== null && value !== undefined) toUpsert.push(seal(category, id, value))
          else toDelete.set(category, [...(toDelete.get(category) ?? []), id])
        }
      }
      if (toUpsert.length === 0 && toDelete.size === 0) return
      await db.transaction(async (tx) => {
        await upsert(toUpsert, tx)
        for (const [keyType, ids] of toDelete) {
          await tx
            .delete(sessionCredentials)
            .where(
              and(
                eq(sessionCredentials.sessionId, sessionId),
                eq(sessionCredentials.keyType, keyType),
                inArray(sessionCredentials.keyId, ids),
              ),
            )
        }
      })
    },
    // Chamado pelo `clear()` do cache: remove as keys, preservando as creds.
    clear: async () => {
      await db
        .delete(sessionCredentials)
        .where(and(eq(sessionCredentials.sessionId, sessionId), sql`${sessionCredentials.keyType} <> ${CREDS_KEY_TYPE}`))
    },
  }

  const keys = opts.cache === false ? store : withoutRemovedKeys(makeCacheableSignalKeyStore(store, opts.logger, opts.cache))
  // T117: marca o store com cache para o BaileysTransport não reaplicar `makeCacheableSignalKeyStore`
  // (mesma chave de `CACHEABLE_KEY_STORE` em transport/baileys.ts; `Symbol.for` evita importar o transporte).
  if (opts.cache !== false)
    Object.defineProperty(keys, Symbol.for('crm.wa-engine.cacheable-key-store'), { value: true, enumerable: false, configurable: true })

  return {
    state: { creds, keys },
    saveCreds: () => upsert([seal(CREDS_KEY_TYPE, CREDS_KEY_ID, creds)]),
    clear: async () => {
      await keys.clear?.()
      await db.delete(sessionCredentials).where(eq(sessionCredentials.sessionId, sessionId))
    },
  }
}
