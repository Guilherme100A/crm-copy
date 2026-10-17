import { describe, expect, it } from 'vitest'
import { parseSupportPhone, supportConfig, SUPPORT_SCRIPT_GLOBAL_DEFAULT, SUPPORT_STORAGE_PREFIX_DEFAULT } from './index'

describe('AC-T108-01 TUTORIALS_URL', () => {
  it('http/https vale; ausente ou inválida → null', () => {
    expect(supportConfig({ TUTORIALS_URL: ' https://videos.example.com/t ' }).tutorials_url).toBe('https://videos.example.com/t')
    for (const raw of [undefined, '', 'javascript:alert(1)', 'videos.example.com']) {
      expect(supportConfig({ TUTORIALS_URL: raw }).tutorials_url).toBeNull()
    }
  })
})

describe('AC-T108-02/03 SUPPORT_PROVIDER', () => {
  it('script com URL válida', () => {
    const { support } = supportConfig({ SUPPORT_PROVIDER: 'script', SUPPORT_SCRIPT_URL: 'https://chat.example.com/w.js', SUPPORT_PHONE: '5511999998888' })
    expect(support).toEqual({
      provider: 'script',
      script_url: 'https://chat.example.com/w.js',
      phone: null,
      script_global: SUPPORT_SCRIPT_GLOBAL_DEFAULT,
      storage_prefix: SUPPORT_STORAGE_PREFIX_DEFAULT,
    })
  })

  it('script sem URL válida → none', () => {
    expect(supportConfig({ SUPPORT_PROVIDER: 'script' }).support.provider).toBe('none')
    expect(supportConfig({ SUPPORT_PROVIDER: 'script', SUPPORT_SCRIPT_URL: 'javascript:x' }).support.provider).toBe('none')
  })

  it('whatsapp-link: telefone só dígitos; sem telefone → none', () => {
    const { support } = supportConfig({ SUPPORT_PROVIDER: ' WhatsApp-Link ', SUPPORT_PHONE: '+55 (11) 99999-8888' })
    expect(support.provider).toBe('whatsapp-link')
    expect(support.phone).toBe('5511999998888')
    expect(support.script_url).toBeNull()
    expect(supportConfig({ SUPPORT_PROVIDER: 'whatsapp-link', SUPPORT_PHONE: '123' }).support.provider).toBe('none')
  })

  it('none, ausente ou desconhecido → none', () => {
    for (const raw of [undefined, '', 'none', 'intercom']) {
      expect(supportConfig({ SUPPORT_PROVIDER: raw, SUPPORT_SCRIPT_URL: 'https://x.example.com/a.js', SUPPORT_PHONE: '5511999998888' }).support).toMatchObject({
        provider: 'none',
        script_url: null,
        phone: null,
      })
    }
  })

  it('global e prefixo configuráveis; inválidos (ou com token/session) voltam ao padrão neutro', () => {
    expect(supportConfig({ SUPPORT_SCRIPT_GLOBAL: 'HelpDesk', SUPPORT_STORAGE_PREFIX: 'hd_' }).support).toMatchObject({ script_global: 'HelpDesk', storage_prefix: 'hd_' })
    expect(supportConfig({ SUPPORT_SCRIPT_GLOBAL: 'a.b()', SUPPORT_STORAGE_PREFIX: 'x' }).support).toMatchObject({
      script_global: SUPPORT_SCRIPT_GLOBAL_DEFAULT,
      storage_prefix: SUPPORT_STORAGE_PREFIX_DEFAULT,
    })
    expect(supportConfig({ SUPPORT_STORAGE_PREFIX: 'chat_token_' }).support.storage_prefix).toBe(SUPPORT_STORAGE_PREFIX_DEFAULT)
    expect(supportConfig({ SUPPORT_STORAGE_PREFIX: 'chat_session_' }).support.storage_prefix).toBe(SUPPORT_STORAGE_PREFIX_DEFAULT)
  })

  it('parseSupportPhone', () => {
    expect(parseSupportPhone('+55 11 99999-8888')).toBe('5511999998888')
    expect(parseSupportPhone('1234567')).toBeNull()
    expect(parseSupportPhone('1'.repeat(16))).toBeNull()
    expect(parseSupportPhone(undefined)).toBeNull()
  })
})
