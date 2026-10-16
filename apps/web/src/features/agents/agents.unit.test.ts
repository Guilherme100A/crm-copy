import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import { knowledgeKey, type AgentDto, type KnowledgeSource } from './api'
import {
  draftOf,
  fieldErrorsOf,
  filterAgents,
  keyFromLabel,
  limitReached,
  modelOptions,
  newDraft,
  nextAction,
  paramsFor,
  payloadOf,
  sameDraft,
  tabOfField,
  vagueWhen,
} from './form'
import { knowledgeErrorCode } from './knowledge-tab'
import { agentsSearchSchema } from './list-page'
import { applyKnowledgeEvent } from './realtime'

describe('lista (AC-T88-01)', () => {
  it('busca por nome sem acento/caixa e cota', () => {
    const items = [{ name: 'Léo Vendas' }, { name: 'Suporte' }]
    expect(filterAgents(items, 'leo').map((a) => a.name)).toEqual(['Léo Vendas'])
    expect(filterAgents(items, '  ')).toHaveLength(2)
    expect(limitReached({ used: 2, limit: 2 })).toBe(true)
    expect(limitReached({ used: 1, limit: 2 })).toBe(false)
    expect(limitReached({ used: 50, limit: null })).toBe(false)
    expect(limitReached(undefined)).toBe(false)
    expect(agentsSearchSchema.parse({ tab: 'voices', filter: 'paused' })).toEqual({ tab: 'voices', filter: 'paused' })
    expect(agentsSearchSchema.parse({ tab: 'x', filter: 'y' })).toEqual({ tab: undefined, filter: undefined })
  })
})

describe('editor (AC-T88-02)', () => {
  it('erros do servidor por campo e a aba de cada campo', () => {
    const fe = fieldErrorsOf({
      fields: [
        { path: 'name', message: 'curto' },
        { path: 'settings.buffer_seconds', message: 'máx 60' },
        { path: 'name', message: 'dup' },
        { nope: 1 },
      ],
    })
    expect(fe).toEqual({ name: 'curto', 'settings.buffer_seconds': 'máx 60' })
    expect(fieldErrorsOf(undefined)).toEqual({})
    expect(tabOfField('generated_prompt')).toBe('instructions')
    expect(tabOfField('skills.0.when_text')).toBe('skills')
    expect(tabOfField('collection_fields.2.key')).toBe('collection')
    expect(tabOfField('settings.engine')).toBe('settings')
    expect(tabOfField('model')).toBe('settings')
    expect(tabOfField('name')).toBe('photo')
  })

  it('rascunho ↔ payload: defaults de 07 §3.1 e parâmetros só do tipo da habilidade', () => {
    const d = newDraft()
    expect(d).toMatchObject({
      name: 'Leo',
      avatar_key: 'leo-2',
      primary_goal: 'sell',
      personality: 'seller',
      use_emojis: true,
      model: null,
    })
    expect(d.collection_fields.map((f) => [f.key, f.enabled])).toEqual([
      ['nome', true],
      ['cidade', true],
      ['produto', true],
      ['email', false],
      ['recompra', false],
    ])
    expect(paramsFor('trigger_flow', { flow_id: 'f', label_id: 'x' })).toEqual({ flow_id: 'f', return_to_agent: false })
    expect(paramsFor('apply_label', { mode: 'remove', label_id: '' })).toEqual({
      mode: 'remove',
      label_id: null,
      tags: [],
    })
    expect(paramsFor('transfer_human', { flow_id: 'f' })).toEqual({})
    const p = payloadOf({
      ...d,
      skills: [
        {
          enabled: true,
          when_text: 'x',
          action_type: 'transfer_human',
          action_params: { flow_id: 'f' },
          schedule_mode: 'now',
          silence_amount: 1,
          silence_unit: 'days',
        },
      ],
    })
    expect(p.skills?.[0]?.action_params).toEqual({})
    expect(p).not.toHaveProperty('status')

    const agent = {
      ...d,
      id: 'a',
      status: 'draft',
      avatar_url: null,
      last_generated_prompt: '',
      locked_blocks: [],
      resolved_model: null,
      skills_count: 0,
      created_at: '',
      updated_at: '',
      collection_fields: d.collection_fields.map((f, i) => ({ ...f, id: `f${i}` })),
    } as AgentDto
    expect(sameDraft(draftOf(agent), d)).toBe(true)
    expect(sameDraft(draftOf(agent), { ...d, name: 'Outro' })).toBe(false)
  })

  it('"Quando" vago, chave do campo de coleta e transição Publicar/Pausar', () => {
    expect(vagueWhen('quando pedir')).toBe(true)
    expect(vagueWhen('quando o cliente pedir desconto')).toBe(false)
    expect(vagueWhen('')).toBe(false)
    expect(keyFromLabel('Data de Nascimento')).toBe('data_de_nascimento')
    expect(keyFromLabel('2º produto')).toBe('c_2_produto')
    expect(keyFromLabel('!!!')).toBe('')
    expect(nextAction('draft')).toBe('publish')
    expect(nextAction('paused')).toBe('publish')
    expect(nextAction('active')).toBe('pause')
  })
})

describe('seletor de modelo (AC-T88-03)', () => {
  it('marca indisponíveis pelo provedor, disponíveis primeiro, e mantém o modelo atual fora do catálogo', () => {
    const opts = {
      providers: [
        { provider: 'anthropic', available: false },
        { provider: 'openai', available: true },
      ],
      models: [
        { provider: 'anthropic', model: 'a1' },
        { provider: 'openai', model: 'o1' },
      ],
    }
    expect(modelOptions(opts, null)).toEqual([
      { provider: 'openai', model: 'o1', available: true },
      { provider: 'anthropic', model: 'a1', available: false },
    ])
    expect(modelOptions(opts, { provider: 'openai', model: 'custom' })[0]).toEqual({
      provider: 'openai',
      model: 'custom',
      available: true,
    })
    expect(modelOptions(undefined, null)).toEqual([])
  })
})

describe('conhecimento por SSE (AC-T88-04)', () => {
  const src = (id: string, status: KnowledgeSource['status']) =>
    ({ id, agent_id: 'a', kind: 'text', slot: 'text', status }) as KnowledgeSource

  it('ai_knowledge_source.updated atualiza, acrescenta e remove a fonte em cache', () => {
    const qc = new QueryClient()
    qc.setQueryData(knowledgeKey('a'), [src('s1', 'pending')])
    applyKnowledgeEvent(qc, {
      agent_id: 'a',
      source_id: 's1',
      status: 'ready',
      source: { ...src('s1', 'ready'), pages_count: 3 },
    })
    expect(qc.getQueryData<KnowledgeSource[]>(knowledgeKey('a'))).toMatchObject([
      { id: 's1', status: 'ready', pages_count: 3 },
    ])
    applyKnowledgeEvent(qc, { agent_id: 'a', source_id: 's2', status: 'pending', source: src('s2', 'pending') })
    expect(qc.getQueryData<KnowledgeSource[]>(knowledgeKey('a'))!.map((s) => s.id)).toEqual(['s1', 's2'])
    applyKnowledgeEvent(qc, { agent_id: 'a', source_id: 's1', status: 'deleted' })
    expect(qc.getQueryData<KnowledgeSource[]>(knowledgeKey('a'))!.map((s) => s.id)).toEqual(['s2'])
    applyKnowledgeEvent(qc, { source_id: 's2' })
    expect(qc.getQueryData<KnowledgeSource[]>(knowledgeKey('a'))).toHaveLength(1)
    expect(knowledgeErrorCode('site_unreachable')).toBe('site_unreachable')
    expect(knowledgeErrorCode('weird')).toBe('generic')
    expect(knowledgeErrorCode(null)).toBe('generic')
  })
})
