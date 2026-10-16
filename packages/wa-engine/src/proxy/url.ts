// URLs de proxy: parse, montagem e mascaramento da senha (fork de ai-manager core/proxy/url.ts).

export const SUPPORTED_PROXY_PROTOCOLS = ['http', 'https', 'socks5'] as const
export type ProxyProtocolName = (typeof SUPPORTED_PROXY_PROTOCOLS)[number]

export interface ProxyParts {
  protocol: ProxyProtocolName
  host: string
  port: number
  username?: string | null
  password?: string | null
}

export class ProxyUrlError extends Error {
  readonly code = 'INVALID_PROXY_URL'
  constructor(message: string) {
    super(message)
    this.name = 'ProxyUrlError'
  }
}

const DEFAULT_PORTS: Record<ProxyProtocolName, number> = { http: 80, https: 443, socks5: 1080 }

/** `http://user:pass@host:port` → partes. Protocolo fora de http/https/socks5 ou host ausente → `ProxyUrlError`. */
export function parseProxyUrl(raw: string): ProxyParts {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new ProxyUrlError('URL de proxy inválida')
  }
  const protocol = url.protocol.replace(/:$/, '') as ProxyProtocolName
  if (!SUPPORTED_PROXY_PROTOCOLS.includes(protocol)) throw new ProxyUrlError(`protocolo de proxy "${protocol}" não suportado (use http, https ou socks5)`)
  if (!url.hostname) throw new ProxyUrlError('a URL do proxy precisa de host')
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new ProxyUrlError('a URL do proxy não pode ter caminho, query ou fragmento')
  return {
    protocol,
    host: url.hostname,
    port: url.port ? Number(url.port) : DEFAULT_PORTS[protocol],
    username: url.username ? decodeURIComponent(url.username) : null,
    password: url.password ? decodeURIComponent(url.password) : null,
  }
}

/** Monta a URL. Com `mask`, a senha (se houver) vira `***`. */
export function buildProxyUrl(parts: ProxyParts, opts: { mask?: boolean } = {}): string {
  let auth = ''
  if (parts.username) {
    auth = encodeURIComponent(parts.username)
    if (parts.password) auth += `:${opts.mask ? '***' : encodeURIComponent(parts.password)}`
    auth += '@'
  }
  return `${parts.protocol}://${auth}${parts.host}:${parts.port}`
}

export function maskProxyUrl(parts: Omit<ProxyParts, 'password'> & { hasPassword: boolean }): string {
  return buildProxyUrl({ ...parts, password: parts.hasPassword ? '***' : null }, { mask: true })
}
