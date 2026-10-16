// Agente de proxy por sessão (ai-manager `baileys.ts:40-79`): vira `agent` e `fetchAgent` do socket.
import type { Agent } from 'node:https'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksProxyAgent } from 'socks-proxy-agent'

export class UnsupportedProxyError extends Error {
  constructor(proxyUrl: string) {
    super(`protocolo de proxy não suportado: ${redactProxyUrl(proxyUrl)} (use http, https ou socks5)`)
    this.name = 'UnsupportedProxyError'
  }
}

/** Remove usuário/senha da URL do proxy para mensagens e logs. */
export function redactProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl)
    if (url.username || url.password) {
      url.username = '***'
      url.password = ''
    }
    return url.toString()
  } catch {
    return '<proxy inválido>'
  }
}

/** http/https (CONNECT) ou socks5. */
export function createProxyAgent(proxyUrl: string): Agent {
  let protocol: string
  try {
    protocol = new URL(proxyUrl).protocol
  } catch {
    throw new UnsupportedProxyError(proxyUrl)
  }
  switch (protocol) {
    case 'http:':
    case 'https:':
      return new HttpsProxyAgent(proxyUrl)
    case 'socks5:':
    case 'socks5h:':
      return new SocksProxyAgent(proxyUrl)
    default:
      throw new UnsupportedProxyError(proxyUrl)
  }
}
