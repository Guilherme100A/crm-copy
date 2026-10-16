// Regra de conexão com proxy (fork de ai-manager core/proxy/connect.ts): sessão com proxy configurado NUNCA
// conecta sem ele. Proxy indisponível → a conexão falha e a sessão fica DISCONNECTED (sem fallback direto).
import type { CredentialCipher } from '@crm/node-kit'
import { and, eq, isNull } from 'drizzle-orm'
import { proxies, sessions, type Database } from '../db'
import { browserForSession, type AuthenticationState, type BrowserDescription, type ConnectOptions, type WaTransport } from '../transport'
import { ProxyError, ProxyUnavailableError } from './errors'
import { proxyConnectionUrl } from './service'

export interface SessionProxy {
  proxyId?: string
  /** URL em claro (com senha) para o transporte; `undefined` só quando a sessão não tem proxy. */
  proxyUrl?: string
}

/**
 * Rede da sessão. Sem proxy → `{}` (conexão direta é a configuração dela). Proxy configurado mas indisponível
 * (flag `available = false`, linha ausente ou senha que não decifra) → `ProxyUnavailableError`.
 */
export async function resolveSessionProxy(db: Database, sessionId: string, cipher?: CredentialCipher): Promise<SessionProxy> {
  const [row] = await db
    .select({ sessionId: sessions.id, proxyId: sessions.proxyId, proxy: proxies })
    .from(sessions)
    .leftJoin(proxies, eq(proxies.id, sessions.proxyId))
    .where(eq(sessions.id, sessionId))
  if (!row) throw new ProxyError('SESSION_NOT_FOUND', `sessão ${sessionId} não encontrada`)
  if (!row.proxyId) return {}
  if (!row.proxy) throw new ProxyUnavailableError(row.proxyId, 'proxy não encontrado')
  if (!row.proxy.available) throw new ProxyUnavailableError(row.proxyId, row.proxy.lastError)
  let proxyUrl: string
  try {
    proxyUrl = proxyConnectionUrl(row.proxy, cipher)
  } catch (err) {
    throw new ProxyUnavailableError(row.proxyId, `não foi possível decifrar as credenciais do proxy (${(err as Error).name})`)
  }
  return { proxyId: row.proxyId, proxyUrl }
}

/**
 * Aparelho fixo da sessão: o gravado no banco; na 1ª vez grava o derivado do id, para que reconexões e mudanças
 * futuras na lista de fingerprints nunca troquem o aparelho de um chip existente.
 */
export async function resolveSessionBrowser(db: Database, sessionId: string): Promise<BrowserDescription> {
  const [row] = await db.select({ browser: sessions.browser }).from(sessions).where(eq(sessions.id, sessionId))
  if (row?.browser) return row.browser
  const browser = browserForSession(sessionId)
  const [saved] = await db
    .update(sessions)
    .set({ browser })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.browser)))
    .returning({ browser: sessions.browser })
  if (saved?.browser) return saved.browser
  const [again] = await db.select({ browser: sessions.browser }).from(sessions).where(eq(sessions.id, sessionId))
  return again?.browser ?? browser
}

export interface ConnectSessionOptions extends Omit<ConnectOptions, 'proxyUrl' | 'auth' | 'browser'> {
  db: Database
  transport: WaTransport
  auth: AuthenticationState
  cipher?: CredentialCipher
}

/**
 * Conecta a sessão pelo proxy configurado. Se o proxy não puder ser usado, NÃO chama `transport.connect`, marca a
 * sessão como `DISCONNECTED` e rejeita com o erro. O proxy é lido do banco a cada conexão (troca vale no próximo).
 */
export async function connectSession(opts: ConnectSessionOptions): Promise<SessionProxy> {
  const { db, transport, cipher, ...connect } = opts
  let resolved: SessionProxy
  try {
    resolved = await resolveSessionProxy(db, connect.sessionId, cipher)
  } catch (err) {
    if (err instanceof ProxyError && err.code === 'SESSION_NOT_FOUND') throw err
    await db.update(sessions).set({ status: 'DISCONNECTED', updatedAt: new Date() }).where(eq(sessions.id, connect.sessionId))
    throw err
  }
  const browser = await resolveSessionBrowser(db, connect.sessionId)
  const connectOpts: ConnectOptions = resolved.proxyUrl ? { ...connect, browser, proxyUrl: resolved.proxyUrl } : { ...connect, browser }
  await transport.connect(connectOpts)
  return resolved
}
