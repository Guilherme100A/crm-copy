import { describe, expect, it } from 'vitest'
import { canAdvanceStatus, crmMessageType, identityOf, isIgnoredJid, matchOptOutKeyword, optOutKeywordsFrom, previewOf } from './rules'

describe('regras de chats', () => {
  it('status de entrega nunca regride', () => {
    expect(canAdvanceStatus('sent', 'delivered')).toBe(true)
    expect(canAdvanceStatus('read', 'delivered')).toBe(false)
    expect(canAdvanceStatus('read', 'failed')).toBe(false)
    expect(canAdvanceStatus('queued', 'failed')).toBe(true)
    expect(canAdvanceStatus('failed', 'retrying')).toBe(true)
    expect(canAdvanceStatus('failed', 'sent')).toBe(true)
    expect(canAdvanceStatus('delivered', 'delivered')).toBe(false)
  })

  it('JIDs ignorados e identidade', () => {
    expect(isIgnoredJid('123-456@g.us')).toBe(true)
    expect(isIgnoredJid('status@broadcast')).toBe(true)
    expect(isIgnoredJid('1@newsletter')).toBe(true)
    expect(isIgnoredJid('5511999998888@s.whatsapp.net')).toBe(false)
    expect(identityOf('123456789012345@lid', '5511999998888:2@s.whatsapp.net')).toEqual({ phone: '+5511999998888', lid: '123456789012345@lid' })
    expect(identityOf('5511999998888@s.whatsapp.net')).toEqual({ phone: '+5511999998888', lid: null })
  })

  it('tipo e prévia', () => {
    expect(crmMessageType('extendedTextMessage')).toBe('text')
    expect(crmMessageType('imageMessage')).toBe('image')
    expect(crmMessageType('weirdMessage')).toBe('unknown')
    expect(previewOf('image', null)).toBe('📷 Imagem')
    expect(previewOf('text', 'x'.repeat(300))).toHaveLength(200)
  })

  it('palavras de opt-out: mensagem inteira, normalizada; lista da empresa substitui a padrão', () => {
    expect(matchOptOutKeyword(' parar! ')).toBe('PARAR')
    expect(matchOptOutKeyword('cancelar.')).toBe('CANCELAR')
    expect(matchOptOutKeyword('Stop')).toBe('STOP')
    expect(matchOptOutKeyword('não quero parar de receber')).toBeNull()
    const custom = optOutKeywordsFrom({ opt_out_keywords: ['Descadastrar', 'não quero'] })
    expect(matchOptOutKeyword('SAIR', custom)).toBeNull()
    expect(matchOptOutKeyword('descadastrar', custom)).toBe('Descadastrar')
    expect(matchOptOutKeyword('Nao quero!', custom)).toBe('não quero')
    expect(optOutKeywordsFrom({ opt_out_keywords: [] })).toContain('SAIR')
  })
})
