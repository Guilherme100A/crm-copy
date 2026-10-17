import { describe, expect, it } from 'vitest'
import { affiliateConfig, parsePortalUrl } from './index'

describe('AC-T97-03 URL do portal de afiliados (AFFILIATE_PORTAL_URL)', () => {
  it('http/https valem (com trim)', () => {
    expect(parsePortalUrl('https://parceiros.example.com/register')).toBe('https://parceiros.example.com/register')
    expect(parsePortalUrl('  http://localhost:3000/x  ')).toBe('http://localhost:3000/x')
  })

  it('ausente, vazia ou inválida → null', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '   ',
      'parceiros.example.com',
      'javascript:alert(1)',
      'ftp://x.test',
      'data:text/html,x',
      'mailto:a@b.c',
    ]) {
      expect(parsePortalUrl(raw)).toBeNull()
    }
  })

  it('affiliateConfig lê o env dado a cada chamada', () => {
    const env: Record<string, string | undefined> = {}
    expect(affiliateConfig(env)).toEqual({ affiliate_portal_url: null })
    env.AFFILIATE_PORTAL_URL = 'https://p.example.com/'
    expect(affiliateConfig(env)).toEqual({ affiliate_portal_url: 'https://p.example.com/' })
  })
})
