import { nodeHandles, type FlowAction } from '@crm/shared/flows'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '@/lib/http'
import { aiKeysQuery, modelOptionsQuery, pixelsQuery } from '../logic/api'
import { validateConfig } from '../logic/rules'
import {
  addOutputCondition,
  bodyLooksBroken,
  conditionsOf,
  defaultAiCall,
  defaultPixel,
  FALLBACK_KEY,
  hasSavedKey,
  isClean,
  keySourceOf,
  llmKeys,
  mappingErrors,
  MAX_AI_OUTPUT_CONDITIONS,
  modelsFor,
  patchOutputPrompt,
  providerAvailability,
  recordOf,
  removeOutputCondition,
  rowsErrors,
  rowsOf,
  withIntegration,
  withKeySource,
  withMethod,
  withProvider,
} from './external-rules'

const aiNode = (config: Record<string, unknown>) => ({ type: 'ai', actions: [{ id: 'a1', type: 'ai_call', order: 0, config }] as FlowAction[] })
const run = <T,>(q: { queryFn?: unknown }) => (q.queryFn as () => Promise<T>)()

afterEach(() => vi.restoreAllMocks())

describe('AC-T57-04 nó HTTP: método, URL com variáveis, headers, corpo e mapeamento de resposta', () => {
  it('config completa é válida e as saídas são success/failure', () => {
    const c = {
      request_method: 'POST',
      request_url: 'https://api.exemplo.com/leads?tel={phone_number}',
      request_headers: recordOf([{ key: 'Authorization', value: 'Bearer {g_token}' }]),
      request_body: '{"nome": "{full_name}"}',
      response_mapping: recordOf([{ key: 'status_pedido', value: 'data.status' }]),
    }
    expect(validateConfig('make_http_request', c)).toEqual({})
    expect(nodeHandles({ type: 'integration', actions: [{ id: 'a', type: 'make_http_request', order: 0, config: c }] })).toEqual(['success', 'failure'])
  })

  it('URL obrigatória e com http(s) (ou começando por variável)', () => {
    expect(validateConfig('make_http_request', { request_method: 'GET', request_url: '' })).toHaveProperty('request_url', { key: 'required' })
    expect(validateConfig('make_http_request', { request_method: 'GET', request_url: 'ftp://x' })).toHaveProperty('request_url', { key: 'url' })
    expect(validateConfig('make_http_request', { request_method: 'GET', request_url: '{g_base}/leads' })).toEqual({})
  })

  it('headers e mapeamento: linhas ↔ record, com nome repetido/vazio bloqueando', () => {
    const rows = rowsOf({ 'X-Api': '1', Accept: 'application/json' })
    expect(rows).toEqual([
      { key: 'X-Api', value: '1' },
      { key: 'Accept', value: 'application/json' },
    ])
    expect(recordOf([...rows, { key: '', value: '' }])).toEqual({ 'X-Api': '1', Accept: 'application/json' })
    expect(recordOf([])).toBeUndefined()
    expect(rowsErrors([{ key: 'A', value: '1' }, { key: 'a', value: '2' }])).toEqual({ '1.key': { key: 'duplicateName' } })
    expect(rowsErrors([{ key: '', value: 'x' }])).toEqual({ '0.key': { key: 'required' } })
    expect(rowsErrors([{ key: '', value: '' }])).toEqual({})
    expect(isClean(rowsErrors([{ key: 'A', value: '1' }]))).toBe(true)
    expect(isClean(rowsErrors([{ key: 'A', value: '' }]))).toBe(false)
    expect(mappingErrors([{ key: 'status', value: 'data.items.0.id' }])).toEqual({})
    expect(mappingErrors([{ key: 'meu status', value: 'data..x' }])).toEqual({ '0.key': { key: 'variableName' }, '0.value': { key: 'path' } })
  })

  it('corpo some no GET; JSON quebrado só avisa (variáveis sem aspas valem)', () => {
    expect(withMethod({ request_method: 'POST', request_body: 'x' }, 'GET')).toEqual({ request_method: 'GET' })
    expect(withMethod({ request_method: 'GET', request_body: 'x' }, 'PUT')).toMatchObject({ request_body: 'x' })
    expect(bodyLooksBroken('{"valor": {g_preco}}')).toBe(false)
    expect(bodyLooksBroken('{"valor": ')).toBe(true)
    expect(bodyLooksBroken('texto livre')).toBe(false)
  })
})

describe('AC-T57-04 nó de IA: provedor/modelo configurados e saídas condicionais', () => {
  it('provedores da API (openai/google/openrouter) viram o enum do ai_call; sem chave = indisponível', () => {
    const av = providerAvailability([
      { provider: 'openai', available: true },
      { provider: 'google', available: false },
      { provider: 'openrouter', available: true },
      { provider: 'anthropic', available: true },
    ])
    expect(av).toEqual({ gpt: true, gemini: false, openrouter: true, platform: true })
    expect(providerAvailability([])).toEqual({ gpt: false, gemini: false, openrouter: false, platform: false })
  })

  it('modelos do catálogo pelo provedor; o salvo fora do catálogo continua; trocar provedor limpa o modelo', () => {
    const models = [
      { provider: 'openai', model: 'gpt-4.1-mini' },
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'google', model: 'gemini-2.5-flash' },
    ]
    expect(modelsFor('gpt', models)).toEqual(['gpt-4.1-mini', 'gpt-4.1'])
    expect(modelsFor('gemini', models, 'gemini-x')).toEqual(['gemini-x', 'gemini-2.5-flash'])
    expect(withProvider({ provider: 'gpt', model: 'gpt-4.1' }, 'gemini')).toEqual({ provider: 'gemini' })
    expect(validateConfig('ai_call', defaultAiCall())).toEqual({})
  })

  it('chave BYOK: integração exige a chave; o provedor acompanha a chave; manual nunca volta em texto', () => {
    let c = withKeySource(defaultAiCall(), 'integration')
    expect(keySourceOf(c)).toBe('integration')
    expect(validateConfig('ai_call', c)).toHaveProperty('ai_integration_id', { key: 'required' })
    c = withIntegration(c, { id: 'k1', provider: 'google' })
    expect(c).toMatchObject({ ai_integration_id: 'k1', provider: 'gemini' })
    expect(validateConfig('ai_call', c)).toEqual({})
    expect(withKeySource(c, 'platform')).not.toHaveProperty('ai_integration_id')
    expect(withKeySource(c, 'platform')).not.toHaveProperty('api_key_source')
    expect(hasSavedKey({ api_key_source: 'manual', api_key: 'sk-123' })).toBe(true)
    expect(withKeySource({ api_key_source: 'manual', api_key: 'sk-123' }, 'platform')).not.toHaveProperty('api_key')
    expect(llmKeys([
      { id: '1', provider: 'openai', active: true },
      { id: '2', provider: 'elevenlabs', active: true },
      { id: '3', provider: 'google', active: false },
    ]).map((k) => k.id)).toEqual(['1'])
  })

  it('saídas condicionais: output_key estável, saída padrão automática, até 10', () => {
    let c = addOutputCondition(defaultAiCall(), () => 0.5)
    const [first] = conditionsOf(c)
    expect(first!.output_key).toMatch(/^saida_[a-z0-9]{6}$/)
    expect(c.fallback_output_key).toBe(FALLBACK_KEY)
    expect(validateConfig('ai_call', c)).toHaveProperty(['output_conditions.0.prompt'], { key: 'required' })
    c = patchOutputPrompt(c, first!.output_key, 'quer falar com humano')
    c = addOutputCondition(c)
    const second = conditionsOf(c)[1]!
    c = patchOutputPrompt(c, second.output_key, 'quer comprar')
    expect(validateConfig('ai_call', c)).toEqual({})
    expect(nodeHandles(aiNode(c))).toEqual([`output:${first!.output_key}`, `output:${second.output_key}`, `output:${FALLBACK_KEY}`, 'failure'])
    // Remover a primeira não muda a chave (handle) da segunda.
    c = removeOutputCondition(c, first!.output_key)
    expect(conditionsOf(c)).toEqual([{ prompt: 'quer comprar', output_key: second.output_key }])
    c = removeOutputCondition(c, second.output_key)
    expect(c).not.toHaveProperty('output_conditions')
    expect(c).not.toHaveProperty('fallback_output_key')
    expect(nodeHandles(aiNode(c))).toEqual(['success', 'failure'])
    let full = defaultAiCall()
    for (let i = 0; i < MAX_AI_OUTPUT_CONDITIONS + 2; i++) full = addOutputCondition(full)
    expect(conditionsOf(full)).toHaveLength(MAX_AI_OUTPUT_CONDITIONS)
    expect(validateConfig('ai_call', { ...c, output_conditions: [{ prompt: 'x'.repeat(201), output_key: 'a' }], fallback_output_key: 'a' })).toMatchObject({
      'output_conditions.0.prompt': { key: 'maxLength', vars: { max: 200 } },
      output_conditions: { key: 'duplicateOutput' },
    })
  })

  it('model-options e ai-keys: 403 vira lista vazia com aviso', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new HttpError(403, 'FORBIDDEN', 'x'))
    expect(await run(modelOptionsQuery())).toEqual({ providers: [], models: [], denied: true })
    expect(await run(aiKeysQuery())).toEqual({ items: [], denied: true })
    expect(await run(pixelsQuery())).toEqual({ items: [], denied: true })
  })
})

describe('nó Pixel (T104)', () => {
  it('pixel obrigatório; Compra exige valor; saídas source/success/failure', () => {
    expect(validateConfig('send_pixel_event', defaultPixel())).toHaveProperty('pixel_config_id', { key: 'required' })
    expect(validateConfig('send_pixel_event', { pixel_config_id: 'p1', event_type: 'Compra' })).toHaveProperty('item_value', { key: 'required' })
    expect(validateConfig('send_pixel_event', { pixel_config_id: 'p1', event_type: 'Compra', item_value: '{venda.valor}', currency: 'BRL' })).toEqual({})
    expect(nodeHandles({ type: 'pixel', actions: [] })).toEqual(['source', 'success', 'failure'])
  })
})
