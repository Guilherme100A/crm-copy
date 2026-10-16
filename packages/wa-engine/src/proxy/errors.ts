// Erros de domínio de proxies (fork de ai-manager core/proxy/errors.ts).

export type ProxyErrorCode = 'PROXY_NOT_FOUND' | 'SESSION_NOT_FOUND' | 'PROXY_IN_USE' | 'PROXY_UNAVAILABLE'

export class ProxyError extends Error {
  constructor(
    readonly code: ProxyErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ProxyError'
  }
}

/** O proxy configurado da sessão está indisponível: a conexão NÃO segue sem ele. */
export class ProxyUnavailableError extends ProxyError {
  constructor(
    readonly proxyId: string,
    reason?: string | null,
  ) {
    super('PROXY_UNAVAILABLE', `proxy ${proxyId} indisponível${reason ? `: ${reason}` : ''}`)
    this.name = 'ProxyUnavailableError'
  }
}

/** Violação de unicidade do Postgres (23505), inclusive embrulhada pelo Drizzle em `cause`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++) {
    const pg = e as { code?: string; constraint?: string }
    if (pg.code === '23505') return constraint === undefined || pg.constraint === constraint
  }
  return false
}
