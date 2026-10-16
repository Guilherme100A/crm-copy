import { describe, expect, it } from 'vitest'
import { buildProxyUrl, maskProxyUrl, parseProxyUrl } from '../proxy/url'
import { assertAction, assertTransition, canTransition, SESSION_STATES } from './states'

describe('máquina de estados', () => {
  it('transições da SPEC 3.8', () => {
    expect(canTransition('NEW', 'WARMING')).toBe(true)
    expect(canTransition('NEW', 'STABLE')).toBe(false)
    expect(canTransition('PAUSED', 'STABLE')).toBe(true)
    expect(canTransition('DISCONNECTED', 'WARMING')).toBe(false)
    for (const s of SESSION_STATES) expect(canTransition(s, s)).toBe(false)
    for (const s of SESSION_STATES.filter((x) => x !== 'DISCONNECTED')) expect(canTransition(s, 'DISCONNECTED')).toBe(true)
  })

  it('erros com code INVALID_TRANSITION', () => {
    expect(() => assertTransition('NEW', 'PAUSED')).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    expect(() => assertAction('resume', 'NEW')).toThrow(expect.objectContaining({ code: 'INVALID_TRANSITION' }))
    expect(() => assertAction('pause', 'WARMING')).not.toThrow()
  })
})

describe('URL de proxy', () => {
  it('parse, montagem e máscara', () => {
    const p = parseProxyUrl('socks5://us%40r:p%3Ass@10.0.0.1:1080')
    expect(p).toEqual({ protocol: 'socks5', host: '10.0.0.1', port: 1080, username: 'us@r', password: 'p:ss' })
    expect(buildProxyUrl(p)).toBe('socks5://us%40r:p%3Ass@10.0.0.1:1080')
    expect(maskProxyUrl({ ...p, hasPassword: true })).toBe('socks5://us%40r:***@10.0.0.1:1080')
    expect(parseProxyUrl('http://h').port).toBe(80)
    expect(() => parseProxyUrl('ftp://h:1')).toThrow(expect.objectContaining({ code: 'INVALID_PROXY_URL' }))
    expect(() => parseProxyUrl('http://h:1/x')).toThrow()
  })
})
