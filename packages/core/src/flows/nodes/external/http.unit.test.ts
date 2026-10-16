import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HttpRequestError, getPath, isBlockedAddress, safeHttpRequest } from './http'

let server: Server
let base = ''
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json', 'x-echo': req.headers['x-token'] ?? '' })
        res.end(JSON.stringify({ method: req.method, body, items: [{ id: 7 }] }))
      })
      return
    }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: 'http://10.0.0.1/secret' })
      return res.end()
    }
    if (req.url === '/redirect-loop') {
      res.writeHead(302, { location: '/redirect-loop' })
      return res.end()
    }
    if (req.url === '/slow') return void setTimeout(() => res.end('tarde'), 2000)
    if (req.url === '/big') return void res.end('x'.repeat(5000))
    res.writeHead(404)
    res.end('nada')
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

const reason = async (p: Promise<unknown>) => {
  try {
    await p
    return 'ok'
  } catch (err) {
    return err instanceof HttpRequestError ? err.reason : String(err)
  }
}

describe('isBlockedAddress', () => {
  it('rede interna e IPv4 mapeado em IPv6', () => {
    for (const ip of ['127.0.0.1', '127.1.2.3', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]'])
      expect(isBlockedAddress(ip), ip).toBe(true)
    for (const ip of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isBlockedAddress(ip), ip).toBe(false)
    expect(isBlockedAddress('não é ip')).toBe(true)
  })
})

describe('safeHttpRequest', () => {
  it('bloqueia 127.0.0.1 e localhost por padrão; nome que resolve para IP privado também', async () => {
    expect(await reason(safeHttpRequest({ method: 'GET', url: `${base}/json` }))).toBe('ssrf_blocked')
    expect(await reason(safeHttpRequest({ method: 'GET', url: `http://localhost:1/` }))).toBe('ssrf_blocked')
    expect(await reason(safeHttpRequest({ method: 'GET', url: 'http://api.example.test/' }, { lookup: async () => [{ address: '192.168.0.10', family: 4 }] }))).toBe('ssrf_blocked')
    expect(await reason(safeHttpRequest({ method: 'GET', url: 'http://[::1]:1/' }))).toBe('ssrf_blocked')
  })

  it('com o host liberado (teste) faz a requisição; redirect para rede interna continua bloqueado', async () => {
    const res = await safeHttpRequest({ method: 'POST', url: `${base}/json`, headers: { 'x-token': 'abc' }, body: '{"a":1}' }, { allowHosts: ['127.0.0.1'] })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ method: 'POST', body: '{"a":1}' })
    expect(res.headers['x-echo']).toBe('abc')
    expect(await reason(safeHttpRequest({ method: 'GET', url: `${base}/redirect-private` }, { allowHosts: ['127.0.0.1'] }))).toBe('ssrf_blocked')
    expect(await reason(safeHttpRequest({ method: 'GET', url: `${base}/redirect-loop` }, { allowHosts: ['127.0.0.1'], maxRedirects: 2 }))).toBe('too_many_redirects')
  })

  it('timeout, limite do corpo e URL inválida', async () => {
    expect(await reason(safeHttpRequest({ method: 'GET', url: `${base}/slow` }, { allowHosts: ['127.0.0.1'], timeoutMs: 200 }))).toBe('timeout')
    expect(await reason(safeHttpRequest({ method: 'GET', url: `${base}/big` }, { allowHosts: ['127.0.0.1'], maxResponseBytes: 100 }))).toBe('response_too_large')
    expect(await reason(safeHttpRequest({ method: 'GET', url: 'ftp://x/' }))).toBe('invalid_url')
    expect(await reason(safeHttpRequest({ method: 'GET', url: 'não é url' }))).toBe('invalid_url')
  })

  it('getPath com índices e sem protótipo', () => {
    expect(getPath({ a: { b: [{ c: 1 }] } }, 'a.b.0.c')).toBe(1)
    expect(getPath({ a: 1 }, 'a.x.y')).toBeUndefined()
    expect(getPath({}, '__proto__.polluted')).toBeUndefined()
  })
})
