// OAuth da Meta (T99; 11 §5.1, §9): configuração vinda do ambiente e o `state` assinado (empresa + usuário + perfil
// opcional + expiração), que o callback confere antes de trocar o `code` (AC-T99-02).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { CredentialsKeyError, loadCredentialsKey } from '@crm/node-kit'
import { META_GRAPH_VERSION, parseGraphUrl } from '../client/graph'

type Env = Record<string, string | undefined>

/** Escopos do Facebook Login (STACK E §1.2): leitura de anúncios, edição (T103) e listagem das contas do BM. */
export const META_OAUTH_SCOPES = ['ads_read', 'ads_management', 'business_management'] as const
export const META_OAUTH_STATE_TTL_MS = 15 * 60_000
export const DEFAULT_META_DIALOG_URL = 'https://www.facebook.com'

export interface MetaConfig {
  appId: string
  appSecret: string
  /** Base da Graph sem versão. */
  graphUrl: string
  version: string
  /** Base do diálogo OAuth (`https://www.facebook.com`). */
  dialogUrl: string
  /** Callback registrado no app da Meta (`<API>/api/meta/oauth/callback`). */
  redirectUri: string
  /** Front para onde o callback volta (`/facebook/profiles?meta_oauth=…`). */
  webUrl: string
  scopes: readonly string[]
}

const val = (env: Env, key: string) => env[key]?.trim() || undefined

/**
 * `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_URL` (com ou sem versão), `META_OAUTH_REDIRECT_URI` (default
 * `<API_PUBLIC_URL>/api/meta/oauth/callback`), `META_OAUTH_DIALOG_URL` e `WEB_PUBLIC_URL`.
 */
export function metaConfigFromEnv(env: Env = process.env): MetaConfig {
  const { graphUrl, version } = parseGraphUrl(val(env, 'META_GRAPH_URL'), META_GRAPH_VERSION)
  const api = (val(env, 'API_PUBLIC_URL') ?? 'http://localhost:3000').replace(/\/+$/, '')
  return {
    appId: val(env, 'META_APP_ID') ?? '',
    appSecret: val(env, 'META_APP_SECRET') ?? '',
    graphUrl,
    version,
    dialogUrl: (val(env, 'META_OAUTH_DIALOG_URL') ?? DEFAULT_META_DIALOG_URL).replace(/\/+$/, ''),
    redirectUri: val(env, 'META_OAUTH_REDIRECT_URI') ?? `${api}/api/meta/oauth/callback`,
    webUrl: (val(env, 'WEB_PUBLIC_URL') ?? 'http://localhost:5173').replace(/\/+$/, ''),
    scopes: [...META_OAUTH_SCOPES],
  }
}

export interface OAuthStatePayload {
  companyId: string
  userId: string
  /** "Reconectar" um perfil existente. */
  profileId: string | null
  /** Expira em (ms epoch). */
  exp: number
  nonce: string
}

let ephemeralKey: Buffer | undefined

/** Chave do `state`: derivada de `CREDENTIALS_KEY` (finalidade separada); sem ela, uma chave do processo (dev/testes). */
export function defaultOAuthStateKey(): Buffer {
  let base: Buffer
  try {
    base = loadCredentialsKey()
  } catch (err) {
    if (!(err instanceof CredentialsKeyError)) throw err
    base = ephemeralKey ??= randomBytes(32)
  }
  return createHmac('sha256', base).update('crm:meta-oauth-state:v1').digest()
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url')
const sign = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest()

/** `<payload base64url>.<hmac base64url>`. */
export function signOAuthState(key: Buffer, input: Omit<OAuthStatePayload, 'exp' | 'nonce'> & { exp?: number; nonce?: string }, now = Date.now()): string {
  const payload: OAuthStatePayload = {
    companyId: input.companyId,
    userId: input.userId,
    profileId: input.profileId ?? null,
    exp: input.exp ?? now + META_OAUTH_STATE_TTL_MS,
    nonce: input.nonce ?? randomBytes(9).toString('base64url'),
  }
  const body = b64(JSON.stringify(payload))
  return `${body}.${b64(sign(key, body))}`
}

/** Payload do `state` se a assinatura confere e não expirou; senão `null`. */
export function verifyOAuthState(key: Buffer, state: string | null | undefined, now = Date.now()): OAuthStatePayload | null {
  if (typeof state !== 'string' || state.length > 2048) return null
  const [body, mac, extra] = state.split('.')
  if (!body || !mac || extra !== undefined) return null
  const expected = sign(key, body)
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as OAuthStatePayload
    if (typeof p.companyId !== 'string' || typeof p.userId !== 'string' || typeof p.exp !== 'number') return null
    if (p.exp < now) return null
    return { companyId: p.companyId, userId: p.userId, profileId: typeof p.profileId === 'string' ? p.profileId : null, exp: p.exp, nonce: String(p.nonce ?? '') }
  } catch {
    return null
  }
}

/** URL do diálogo do Facebook Login com o `state`. */
export function oauthDialogUrl(config: MetaConfig, state: string): string {
  const url = new URL(`${config.dialogUrl}/${config.version}/dialog/oauth`)
  url.searchParams.set('client_id', config.appId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', config.scopes.join(','))
  return url.toString()
}
