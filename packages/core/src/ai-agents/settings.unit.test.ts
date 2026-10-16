import { describe, expect, it } from 'vitest'
import { envProviderKeys } from './provider-keys'
import { AGENT_SETTINGS_DEFAULTS, agentSettingsSchema, agentSkillSchema, DEFAULT_COLLECTION_FIELDS } from './settings'

describe('AgentSettings (07 §3.2)', () => {
  it('defaults', () => {
    expect(AGENT_SETTINGS_DEFAULTS).toMatchObject({
      buffer_enabled: true,
      buffer_seconds: 5,
      split_messages: true,
      audio_choice_enabled: true,
      audio_max_per_conversation: 3,
      understand_audio: true,
      understand_image: true,
      understand_receipt: true,
      sign_name: false,
      business_hours_only: false,
      pause_on_human: true,
      stall_limit_enabled: true,
      stall_limit: 12,
      engine: 'balanced',
      no_balance_action: 'none',
      no_balance_notify_country_code: '55',
    })
    expect(Object.isFrozen(AGENT_SETTINGS_DEFAULTS)).toBe(true)
  })

  it('rejeita valores fora do domínio', () => {
    expect(agentSettingsSchema.safeParse({ buffer_seconds: 0 }).success).toBe(false)
    expect(agentSettingsSchema.safeParse({ engine: 'turbo' }).success).toBe(false)
    expect(agentSettingsSchema.safeParse({ no_balance_flow_id: 'x' }).success).toBe(false)
  })
})

describe('habilidades e campos', () => {
  it('trigger_flow exige flow_id; demais aceitam params vazios', () => {
    expect(agentSkillSchema.safeParse({ action_type: 'trigger_flow', action_params: {} }).success).toBe(false)
    const ok = agentSkillSchema.parse({ action_type: 'transfer_human' })
    expect(ok).toMatchObject({ enabled: true, schedule_mode: 'now', silence_amount: 1, silence_unit: 'days', action_params: {} })
    expect(agentSkillSchema.safeParse({ action_type: 'voar' }).success).toBe(false)
  })

  it('5 campos padrão na ordem', () => {
    expect(DEFAULT_COLLECTION_FIELDS.map((f) => `${f.key}:${f.enabled}`)).toEqual(['nome:true', 'cidade:true', 'produto:true', 'email:false', 'recompra:false'])
  })
})

describe('envProviderKeys', () => {
  it('chave da plataforma no ambiente', () => {
    const keys = envProviderKeys({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: '  ' })
    expect(keys.isConfigured({ companyId: 'c', provider: 'anthropic' })).toBe(true)
    expect(keys.isConfigured({ companyId: 'c', provider: 'openai' })).toBe(false)
    expect(keys.isConfigured({ companyId: 'c', provider: 'google' })).toBe(false)
  })
})
