import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contentKind, defaultCapabilities } from './gateway'

describe('gateway', () => {
  it('defaultCapabilities devolve todas as flags false (objeto novo a cada chamada)', () => {
    expect(defaultCapabilities()).toEqual({ nativeButtons: false, nativeCarousel: false, calls: false, labelsSync: false, businessProfile: false })
    const caps = defaultCapabilities()
    caps.calls = true
    expect(defaultCapabilities().calls).toBe(false)
  })

  it('contentKind identifica o tipo do conteúdo', () => {
    expect(contentKind({ text: 'x' })).toBe('text')
    expect(contentKind({ audio: { url: 'u' }, ptt: true })).toBe('audio')
    expect(contentKind({ contact: { displayName: 'A', vcard: 'BEGIN:VCARD' } })).toBe('contact')
    expect(contentKind({ location: { latitude: 1, longitude: 2 } })).toBe('location')
    expect(contentKind({ react: { messageId: 'm', emoji: 'ok' } })).toBe('react')
    expect(contentKind({ delete: { messageId: 'm' } })).toBe('delete')
  })

  it('o pacote só depende de zod', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies?: Record<string, string> }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod'])
  })
})
