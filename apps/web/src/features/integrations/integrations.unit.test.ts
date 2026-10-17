import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/core'
import { SETTINGS_TABS } from '../settings/tabs'
import { AI_KEY_PROVIDERS, patchBody, type AiKeyDto } from './api'
import { aiKeyRecord, CATALOG, INTEGRATION_CATEGORIES, RECORD_SOURCES } from './catalog'
import { activeCounts, matchesSearch, nextCategory, normalizeText, parseCategory, validateAiKeyForm } from './hub-logic'

const key = (over: Partial<AiKeyDto> = {}): AiKeyDto => ({
  id: 'k1',
  provider: 'openai',
  name: 'Produção',
  configured: true,
  hint: '…abcd',
  active: true,
  in_use: false,
  last_tested_at: null,
  last_test_ok: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  ...over,
})

describe('AC-T59-03 hub de integrações', () => {
  it('aba integrations registrada no grupo integrações com settings.integrations.view', () => {
    expect(SETTINGS_TABS.find((x) => x.id === 'integrations')).toMatchObject({ group: 'integrations', labelKey: 'integrations:tab', permissions: ['settings.integrations.view'] })
  })

  it('busca ignora acentos e caixa', () => {
    expect(normalizeText('Integração ÁGIL')).toBe('integracao agil')
    expect(matchesSearch(['Síntese de voz', 'ElevenLabs'], 'sintese')).toBe(true)
    expect(matchesSearch(['Síntese de voz'], 'SÍNTESE')).toBe(true)
    expect(matchesSearch(['OpenRouter', null], 'gemini')).toBe(false)
    expect(matchesSearch(['x'], '   ')).toBe(true)
  })

  it('a busca do catálogo acha o item pela descrição traduzida sem acento', () => {
    const hits = CATALOG.filter((i) => matchesSearch([translate('pt-BR', i.titleKey), translate('pt-BR', i.descriptionKey), i.providerLabel], 'sintese de voz'))
    expect(hits.map((i) => i.id)).toEqual(['elevenlabs'])
  })

  it('abas IA/Vendas/Rastreamento; `?cat=` inválido ou ausente cai em IA; ←/→ circulam, Home/End', () => {
    expect(INTEGRATION_CATEGORIES).toEqual(['ai', 'sales', 'tracking'])
    expect(parseCategory('sales')).toBe('sales')
    expect(parseCategory('xpto')).toBe('ai')
    expect(parseCategory(undefined)).toBe('ai')
    expect(nextCategory('ai', 'ArrowRight')).toBe('sales')
    expect(nextCategory('ai', 'ArrowLeft')).toBe('tracking')
    expect(nextCategory('tracking', 'ArrowRight')).toBe('ai')
    expect(nextCategory('sales', 'End')).toBe('tracking')
    expect(nextCategory('sales', 'Home')).toBe('ai')
    expect(nextCategory('sales', 'a')).toBeNull()
  })

  it('catálogo de IA com os 6 provedores reais, títulos nas 3 línguas', () => {
    const ai = CATALOG.filter((i) => i.category === 'ai')
    expect(ai.map((i) => i.provider)).toEqual([...AI_KEY_PROVIDERS])
    expect(new Set(CATALOG.map((i) => i.id)).size).toBe(CATALOG.length)
    for (const i of CATALOG) {
      expect(i.modalKind).toBe('ai')
      for (const locale of ['pt-BR', 'en', 'es'] as const) {
        expect(translate(locale, i.titleKey)).not.toBe(i.titleKey)
        expect(translate(locale, i.descriptionKey)).not.toBe(i.descriptionKey)
      }
    }
    // Vendas e Rastreamento ficam vazias até a T114.
    expect(CATALOG.some((i) => i.category !== 'ai')).toBe(false)
    expect(RECORD_SOURCES.map((s) => [s.id, s.category])).toEqual([['ai-keys', 'ai']])
  })

  it('status Ativo/Inativo vem de `active` (configured é sempre true); contador só conta ativas por categoria', () => {
    const on = aiKeyRecord(key())
    const off = aiKeyRecord(key({ id: 'k2', active: false, provider: 'elevenlabs', in_use: true }))
    expect(on).toMatchObject({ id: 'k1', title: 'Produção', providerLabel: 'OpenAI', active: true, detail: '…abcd', category: 'ai', modalKind: 'ai' })
    expect(off).toMatchObject({ active: false, providerLabel: 'ElevenLabs', initials: 'EL', inUse: true })
    expect(activeCounts([on, off])).toEqual({ ai: 1, sales: 0, tracking: 0 })
  })
})

describe('AC-T59-04 modal da chave de IA', () => {
  it('editar com segredo em branco não manda `secret` (mantém o atual); preenchido manda aparado', () => {
    expect(patchBody({ name: ' Produção ', secret: '', active: true })).toEqual({ name: 'Produção', active: true })
    expect(patchBody({ name: 'Produção', secret: '   ', active: false })).toEqual({ name: 'Produção', active: false })
    expect(patchBody({ name: 'Produção', secret: ' sk-novo ', active: true })).toEqual({ name: 'Produção', active: true, secret: 'sk-novo' })
  })

  it('validação replica o core: nome 2–80, segredo obrigatório só na criação e até 500', () => {
    expect(validateAiKeyForm({ name: 'ok', secret: 'sk' }, 'create')).toEqual({})
    expect(validateAiKeyForm({ name: ' a ', secret: 'sk' }, 'create')).toEqual({ name: 'nameLength' })
    expect(validateAiKeyForm({ name: 'x'.repeat(81), secret: 'sk' }, 'create')).toEqual({ name: 'nameLength' })
    expect(validateAiKeyForm({ name: 'ok', secret: '  ' }, 'create')).toEqual({ secret: 'secretRequired' })
    expect(validateAiKeyForm({ name: 'ok', secret: '' }, 'edit')).toEqual({})
    expect(validateAiKeyForm({ name: 'ok', secret: 'x'.repeat(501) }, 'edit')).toEqual({ secret: 'secretTooLong' })
  })

  it('textos de latência e erro do "Testar" nas 3 línguas', () => {
    expect(translate('pt-BR', 'integrations:aiKey.testOk', { ms: 123 })).toBe('Conexão OK em 123 ms')
    expect(translate('en', 'integrations:aiKey.testFail', { error: 'HTTP 401' })).toBe('Test failed: HTTP 401')
    expect(translate('es', 'integrations:aiKey.testOk', { ms: 9 })).toBe('Conexión OK en 9 ms')
  })
})
