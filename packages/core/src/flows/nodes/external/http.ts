// HTTP do nó Integração (T42) com proteção contra SSRF: o IP é validado no `lookup` do próprio socket (o mesmo
// endereço que a conexão usa, sem brecha de DNS rebinding) e a cada redirect; timeout total e limite do corpo.
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import { BlockList, isIP } from 'node:net'

export type HttpFailure = 'ssrf_blocked' | 'timeout' | 'response_too_large' | 'too_many_redirects' | 'invalid_url' | 'network_error'

export class HttpRequestError extends Error {
  constructor(
    readonly reason: HttpFailure,
    message: string,
  ) {
    super(`${reason}: ${message}`)
    this.name = 'HttpRequestError'
  }
}

const blocked = new BlockList()
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  blocked.addSubnet(net, prefix, 'ipv4')
blocked.addAddress('::1', 'ipv6')
blocked.addAddress('::', 'ipv6')
blocked.addSubnet('fc00::', 7, 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')

/** IP de rede interna (loopback, privado, link-local, CGNAT, ULA), inclusive IPv4 mapeado em IPv6. */
export function isBlockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').split('%')[0]!
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)
  if (mapped) return blocked.check(mapped[1]!, 'ipv4')
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip)
  if (hexMapped) {
    const n = (parseInt(hexMapped[1]!, 16) << 16) | parseInt(hexMapped[2]!, 16)
    return blocked.check([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), 'ipv4')
  }
  const v = isIP(ip)
  if (v === 4) return blocked.check(ip, 'ipv4')
  if (v === 6) return blocked.check(ip, 'ipv6')
  return true
}

export type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>

const defaultLookup: Lookup = (host) =>
  new Promise((resolve, reject) => dnsLookup(host, { all: true }, (err, addrs) => (err ? reject(err) : resolve(addrs as LookupAddress[]))))

export interface SafeHttpOptions {
  timeoutMs?: number
  maxResponseBytes?: number
  maxRedirects?: number
  lookup?: Lookup
  /** Hosts (nome ou IP) liberados mesmo em rede interna — só para testes com servidor local. */
  allowHosts?: readonly string[]
}

export interface SafeHttpRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string | null
}

export interface SafeHttpResponse {
  status: number
  headers: Record<string, string>
  body: string
  url: string
}

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024
export const DEFAULT_MAX_REDIRECTS = 5

function once(url: URL, req: SafeHttpRequest, opts: Required<Omit<SafeHttpOptions, 'allowHosts'>> & { allowHosts: readonly string[] }, signal: AbortSignal): Promise<SafeHttpResponse & { location?: string }> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const allowed = opts.allowHosts.includes(host)
  return new Promise((resolve, reject) => {
    const lookup = (hostname: string, options: { all?: boolean } | number, cb: (...args: unknown[]) => void) => {
      const all = typeof options === 'object' && options?.all === true
      opts
        .lookup(hostname)
        .then((addrs) => {
          if (!addrs.length) return cb(new HttpRequestError('network_error', `sem endereço para ${hostname}`))
          const bad = addrs.find((a) => isBlockedAddress(a.address))
          if (bad && !allowed) return cb(new HttpRequestError('ssrf_blocked', `destino em rede interna (${bad.address})`))
          if (all) cb(null, addrs)
          else cb(null, addrs[0]!.address, addrs[0]!.family)
        })
        .catch((err: unknown) => cb(err))
    }
    // IP literal na URL não passa pelo lookup: confere aqui.
    if (isIP(host) && isBlockedAddress(host) && !allowed) return reject(new HttpRequestError('ssrf_blocked', `destino em rede interna (${host})`))
    const mod = url.protocol === 'https:' ? https : http
    const r = mod.request(
      url,
      { method: req.method, headers: req.headers, lookup: lookup as never, signal, agent: false },
      (res) => {
        const status = res.statusCode ?? 0
        const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]))
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return resolve({ status, headers, body: '', url: url.toString(), location: res.headers.location })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > opts.maxResponseBytes) {
            res.destroy()
            reject(new HttpRequestError('response_too_large', `resposta acima de ${opts.maxResponseBytes} bytes`))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ status, headers, body: Buffer.concat(chunks).toString('utf8'), url: url.toString() }))
        res.on('error', (err) => reject(err))
      },
    )
    r.on('error', (err) => reject(err))
    if (req.body !== undefined && req.body !== null && req.method !== 'GET') r.write(req.body)
    r.end()
  })
}

/** Requisição com SSRF bloqueado (destino, DNS e redirects), timeout total e limite de corpo. */
export async function safeHttpRequest(req: SafeHttpRequest, options: SafeHttpOptions = {}): Promise<SafeHttpResponse> {
  const opts = {
    timeoutMs: options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    lookup: options.lookup ?? defaultLookup,
    allowHosts: options.allowHosts ?? [],
  }
  let url: URL
  try {
    url = new URL(req.url)
  } catch {
    throw new HttpRequestError('invalid_url', `URL inválida: ${req.url.slice(0, 200)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpRequestError('invalid_url', 'use http ou https')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs)
  let current = { ...req }
  try {
    for (let hop = 0; ; hop++) {
      let res
      try {
        res = await once(url, current, opts, ctrl.signal)
      } catch (err) {
        if (err instanceof HttpRequestError) throw err
        if (ctrl.signal.aborted) throw new HttpRequestError('timeout', `sem resposta em ${opts.timeoutMs} ms`)
        const cause = (err as { cause?: unknown }).cause
        if (cause instanceof HttpRequestError) throw cause
        throw new HttpRequestError('network_error', err instanceof Error ? err.message : String(err))
      }
      if (!res.location) return res
      if (hop >= opts.maxRedirects) throw new HttpRequestError('too_many_redirects', `mais de ${opts.maxRedirects} redirecionamentos`)
      const next = new URL(res.location, url)
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new HttpRequestError('invalid_url', 'redirecionamento para protocolo não suportado')
      // 303 (e 301/302 de POST) viram GET sem corpo, como nos navegadores.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && current.method !== 'GET')) current = { ...current, method: 'GET', body: null }
      url = next
    }
  } finally {
    clearTimeout(timer)
  }
}

/** `getPath({ a: { b: [ { c: 1 } ] } }, 'a.b.0.c')` → 1. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.').map((s) => s.trim()).filter(Boolean)) {
    if (seg === '__proto__' || seg === 'constructor' || seg === 'prototype') return undefined
    if (cur === null || cur === undefined) return undefined
    cur = Array.isArray(cur) && /^\d+$/.test(seg) ? cur[Number(seg)] : (cur as Record<string, unknown>)[seg]
  }
  return cur
}
