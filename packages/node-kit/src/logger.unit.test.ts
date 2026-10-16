import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger, isSensitiveLogKey, redactSecrets, REDACTED } from './logger'

function capture() {
  const lines: string[] = []
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk))
      cb()
    },
  })
  return { lines, logger: createLogger({ destination, level: 'debug' }) }
}

const SECRETS = ['p@ss', 'k-123', 'NOISE', 'SIGNED', 'VAL-TOK-9', 'VAL-SEC-9', 'Bearer abc', 'sid=1', 'KEYS']

describe('logger com redação (AC-T05-02)', () => {
  it('redige password/apiKey/creds em qualquer profundidade', () => {
    const { lines, logger } = capture()
    logger.info(
      {
        user: { password: 'p@ss', apiKey: 'k-123', name: 'Ana' },
        creds: { noiseKey: 'NOISE', signedIdentityKey: 'SIGNED' },
        deep: { a: { b: { c: [{ token: 'VAL-TOK-9', secret: 'VAL-SEC-9' }] } } },
        headers: { Authorization: 'Bearer abc', cookie: 'sid=1' },
        keys: 'KEYS',
      },
      'login',
    )
    const out = lines.join('')
    for (const s of SECRETS) expect(out).not.toContain(s)
    expect(out).toContain('Ana')
    expect(out).toContain(REDACTED)
  })

  it('redige bindings de child loggers (e de netos) e setBindings', () => {
    const { lines, logger } = capture()
    const child = logger.child({ session: { creds: { noiseKey: 'NOISE' } }, apiKey: 'k-123' })
    child.child({ deep: { password: 'p@ss' } }).warn({ x: { token: 'VAL-TOK-9' } }, 'neto')
    child.setBindings({ secret: 'VAL-SEC-9' })
    child.info('depois')
    const out = lines.join('')
    for (const s of ['NOISE', 'k-123', 'p@ss', 'VAL-TOK-9', 'VAL-SEC-9']) expect(out).not.toContain(s)
    expect(lines).toHaveLength(2)
    // neto herda os bindings do filho; setBindings do filho fica no filho
    const neto = JSON.parse(lines[0]!)
    expect(neto).toMatchObject({ session: { creds: REDACTED }, apiKey: REDACTED, deep: { password: REDACTED } })
    expect(JSON.parse(lines[1]!)).toMatchObject({ apiKey: REDACTED, secret: REDACTED })
  })

  it('setBindings do filho não vaza para o pai', () => {
    const { lines, logger } = capture()
    logger.child({ a: 1 }).setBindings({ b: 2 })
    logger.info('pai')
    expect(JSON.parse(lines[0]!)).not.toHaveProperty('b')
  })

  it('comparação ignora caixa, - e _', () => {
    for (const k of ['API_KEY', 'api-key', 'ApiKey', 'PASSWORD', 'signed_identity_key', 'set-cookie'])
      expect(isSensitiveLogKey(k)).toBe(true)
    expect(isSensitiveLogKey('name')).toBe(false)
  })

  it('redactSecrets não altera o original e trata ciclos', () => {
    const o: Record<string, unknown> = { password: 'x', n: 1 }
    o.self = o
    const r = redactSecrets(o) as Record<string, unknown>
    expect(o.password).toBe('x')
    expect(r.password).toBe(REDACTED)
    expect(r.self).toBe('[Circular]')
  })
})
