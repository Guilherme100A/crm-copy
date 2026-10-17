import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError } from '@/lib/http'
import { labApi, runKey, type PublicRun, type TestMessageResult } from './api'
import {
  agentMessages,
  appendDictation,
  canSubmitRun,
  fieldEntries,
  firstFieldMessage,
  formatCredits,
  isTerminal,
  labErrorKey,
  mergeRun,
  recordingFilename,
  REVIEW_STATE_KEY,
  reviewStateOf,
  runErrorKey,
  runInput,
  skillKey,
  stagesDone,
  stageState,
  totalCredits,
  warningKey,
  type ChatMessage,
} from './lab'
import { applyRunEvent } from './realtime'
import { pickMime } from './recorder'

const result = (over: Partial<TestMessageResult> = {}): TestMessageResult => ({
  blocks: [{ type: 'text', text: 'Oi!' }],
  audio: { requested: false, allowed: false, reason: null },
  skills_fired: [],
  fields_filled: {},
  collected: {},
  handoff: null,
  trace: { model: { provider: 'openai', model: 'x' }, instructions: '', knowledge_hits: [], tool_calls: [], finish: 'stop', steps: 1 },
  charged_credits: 0,
  charged_tokens: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  eval: { used: 1, limit: 200 },
  ...over,
})

const run = (over: Partial<PublicRun> = {}): PublicRun => ({
  id: 'r1',
  status: 'queued',
  stage: null,
  stages_done: [],
  warnings: [],
  agent_id: null,
  error_message: null,
  ...over,
})

afterEach(() => vi.restoreAllMocks())

describe('teste ao vivo (AC-T92-01)', () => {
  it('um bloco por bolha; resposta só com ações vira uma bolha vazia com os detalhes', () => {
    const r = result({ blocks: [{ type: 'text', text: 'Oi' }, { type: 'text', text: 'Tudo bem?' }, { type: 'text', text: ' ' }] })
    const msgs = agentMessages(r)
    expect(msgs.map((m) => m.text)).toEqual(['Oi', 'Tudo bem?'])
    expect(msgs.every((m) => m.role === 'agent' && m.result === r)).toBe(true)
    const empty = agentMessages(result({ blocks: [] }))
    expect(empty).toHaveLength(1)
    expect(empty[0]).toMatchObject({ role: 'agent', text: '' })
  })

  it('créditos somam uma vez por resposta (várias bolhas) e formatam com até 4 casas', () => {
    const a = result({ charged_credits: 0.12345 })
    const b = result({ charged_credits: 1 })
    const msgs: ChatMessage[] = [
      { id: '1', role: 'user', text: 'oi' },
      ...agentMessages({ ...a, blocks: [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }] }).map((m) => ({ ...m, result: a }) as ChatMessage),
      { id: '2', role: 'error', text: 'falhou' },
      ...agentMessages(b),
    ]
    expect(totalCredits(msgs)).toBe(1.1235)
    expect(formatCredits(0.5)).toBe('0.5')
    expect(formatCredits(2)).toBe('2')
  })

  it('campos preenchidos em ordem e habilidades com rótulo conhecido', () => {
    expect(fieldEntries({ telefone: '119', nome: 'Ana' })).toEqual([
      ['nome', 'Ana'],
      ['telefone', '119'],
    ])
    expect(fieldEntries(undefined)).toEqual([])
    expect(skillKey('transfer_human')).toBe('transfer_human')
    expect(skillKey('fill_field')).toBe('fill_field')
    expect(skillKey('algo_novo')).toBe('other')
  })

  it('erros do laboratório pelo details.reason', () => {
    const e = (code: string, status: number, reason?: string) => new HttpError(status, code, 'x', reason ? { reason } : undefined)
    expect(labErrorKey(e('VALIDATION_ERROR', 422, 'not_configured'))).toBe('notConfigured')
    expect(labErrorKey(e('QUOTA_EXCEEDED', 429, 'no_balance'))).toBe('noBalance')
    expect(labErrorKey(e('QUOTA_EXCEEDED', 429, 'eval_cap'))).toBe('evalCap')
    expect(labErrorKey(e('CONFLICT', 409, 'create_in_progress'))).toBe('inProgress')
    expect(labErrorKey(e('VALIDATION_ERROR', 422, 'invalid_audio'))).toBe('invalidAudio')
    expect(labErrorKey(e('QUOTA_EXCEEDED', 429))).toBe('noBalance')
    expect(labErrorKey(e('NOT_FOUND', 404))).toBe('notFound')
    expect(labErrorKey(new Error('rede'))).toBe('generic')
    const v = new HttpError(422, 'VALIDATION_ERROR', 'x', { reason: 'validation', fields: [{ path: 'draft.name', message: 'Nome obrigatório' }] })
    expect(firstFieldMessage(v)).toBe('Nome obrigatório')
    expect(firstFieldMessage(new Error('x'))).toBeNull()
  })

  it('envia o rascunho só quando há um; limpar chama o DELETE', async () => {
    const http = await import('@/lib/http')
    const post = vi.spyOn(http.api, 'post').mockResolvedValue(result())
    const del = vi.spyOn(http.api, 'delete').mockResolvedValue({ ok: true })
    await labApi.testMessage('a/1', 'oi', null)
    expect(post).toHaveBeenLastCalledWith('/api/ai-agents/a%2F1/test-messages', { text: 'oi' })
    await labApi.testMessage('a1', 'oi', { purpose: 'x' })
    expect(post).toHaveBeenLastCalledWith('/api/ai-agents/a1/test-messages', { text: 'oi', draft: { purpose: 'x' } })
    await labApi.resetTest('a1')
    expect(del).toHaveBeenCalledWith('/api/ai-agents/a1/test-messages')
  })
})

describe('criação assistida (AC-T92-02)', () => {
  it('estágios: concluídos, ativo, falho e pendentes', () => {
    const r = run({ status: 'running', stage: 'compose', stages_done: ['extract'] })
    expect(stagesDone(r)).toEqual(['extract'])
    expect(stageState(r, 'extract')).toBe('done')
    expect(stageState(r, 'compose')).toBe('active')
    expect(stageState(r, 'persist')).toBe('pending')
    // Evento do SSE sem stages_done: os anteriores ao estágio atual contam como feitos.
    expect(stagesDone(run({ status: 'running', stage: 'persist', stages_done: undefined }))).toEqual(['extract', 'compose'])
    expect(stagesDone(run({ status: 'completed', stage: 'persist' }))).toEqual(['extract', 'compose', 'persist'])
    expect(stageState(run({ status: 'failed', stage: 'compose', stages_done: ['extract'] }), 'compose')).toBe('failed')
    expect(isTerminal(run({ status: 'failed' }))).toBe(true)
    expect(isTerminal(run({ status: 'running' }))).toBe(false)
    expect(isTerminal(null)).toBe(false)
  })

  it('mescla o SSE: guarda estágios e avisos, não volta atrás nem reabre run terminado', () => {
    const old = run({ status: 'running', stage: 'compose', stages_done: ['extract'], warnings: ['site_unread'] })
    const next = mergeRun(old, run({ status: 'running', stage: 'persist', stages_done: undefined, warnings: ['empty_knowledge'] }))
    expect(next).toMatchObject({ stage: 'persist', stages_done: ['extract'], warnings: ['site_unread', 'empty_knowledge'] })
    expect(mergeRun(next, run({ status: 'running', stage: 'extract' }))).toBe(next)
    const done = mergeRun(next, run({ status: 'completed', stage: 'persist', agent_id: 'a1' }))
    expect(done).toMatchObject({ status: 'completed', agent_id: 'a1' })
    expect(mergeRun(done, run({ status: 'running', stage: 'persist' }))).toBe(done)
    expect(mergeRun(undefined, run())).toEqual(run())
  })

  it('ai_agent.run.updated atualiza o run em cache', () => {
    const qc = new QueryClient()
    qc.setQueryData(runKey('r1'), run({ stages_done: [] }))
    applyRunEvent(qc, { run: run({ status: 'running', stage: 'compose', stages_done: undefined, warnings: ['site_unread'] }) })
    expect(qc.getQueryData<PublicRun>(runKey('r1'))).toMatchObject({ status: 'running', stage: 'compose', warnings: ['site_unread'] })
    applyRunEvent(qc, { run: run({ status: 'completed', stage: 'persist', agent_id: 'a9' }) })
    expect(qc.getQueryData<PublicRun>(runKey('r1'))).toMatchObject({ status: 'completed', agent_id: 'a9' })
    applyRunEvent(qc, null)
    applyRunEvent(qc, { run: { id: '' } })
    expect(qc.getQueryData(runKey(''))).toBeUndefined()
  })

  it('avisos, erros do run e validação do formulário', () => {
    expect(warningKey('site_unread')).toBe('site_unread')
    expect(warningKey('empty_knowledge')).toBe('empty_knowledge')
    expect(warningKey('novo')).toBe('other')
    expect(runErrorKey('no_balance')).toBe('no_balance')
    expect(runErrorKey('x')).toBe('request_failed')
    expect(runErrorKey(null)).toBe('request_failed')
    expect(canSubmitRun('Vendo bolos caseiros', '')).toBe(true)
    expect(canSubmitRun('curto', '')).toBe(false)
    expect(canSubmitRun('', 'https://loja.test')).toBe(true)
    expect(canSubmitRun('', 'loja.test')).toBe(false)
    expect(canSubmitRun('curto', 'https://loja.test')).toBe(false)
    expect(runInput(' Vendo bolos ', ' ')).toEqual({ pitch: 'Vendo bolos' })
    expect(runInput('Vendo bolos', ' https://a.test ')).toEqual({ pitch: 'Vendo bolos', site_url: 'https://a.test' })
  })

  it('banner de revisão vem do history.state', () => {
    expect(reviewStateOf({ [REVIEW_STATE_KEY]: { runId: 'r1', warnings: ['site_unread', 3] } })).toEqual({ runId: 'r1', warnings: ['site_unread'] })
    expect(reviewStateOf({ [REVIEW_STATE_KEY]: { warnings: [] } })).toBeNull()
    expect(reviewStateOf({ __TSR_index: 1 })).toBeNull()
    expect(reviewStateOf(undefined)).toBeNull()
  })
})

describe('ditado (AC-T92-04)', () => {
  it('insere a transcrição no fim do campo', () => {
    expect(appendDictation('', ' olá ')).toBe('olá')
    expect(appendDictation('Vende bolos.', 'Entrega em SP')).toBe('Vende bolos. Entrega em SP')
    expect(appendDictation('Linha 1\n', 'Linha 2')).toBe('Linha 1\nLinha 2')
    expect(appendDictation('abc', '  ')).toBe('abc')
  })

  it('envia o áudio em multipart no campo file e devolve o texto', async () => {
    const http = await import('@/lib/http')
    const post = vi.spyOn(http.api, 'post').mockResolvedValue({ text: 'texto ditado' })
    const text = await labApi.transcribe(new Blob(['x'], { type: 'audio/webm' }), 'ditado.webm')
    expect(text).toBe('texto ditado')
    const [path, body] = post.mock.calls[0]!
    expect(path).toBe('/api/ai-agents/transcriptions')
    expect((body as FormData).get('file')).toBeInstanceOf(Blob)
  })

  it('nome do arquivo pela mime e mime do gravador', () => {
    expect(recordingFilename('audio/webm;codecs=opus')).toBe('ditado.webm')
    expect(recordingFilename('audio/ogg')).toBe('ditado.ogg')
    expect(recordingFilename('audio/mp4')).toBe('ditado.m4a')
    expect(recordingFilename('x/y')).toBe('ditado.webm')
    expect(pickMime((m) => m === 'audio/webm')).toBe('audio/webm')
    expect(pickMime(() => false)).toBeUndefined()
    expect(
      pickMime(() => {
        throw new Error('x')
      }),
    ).toBeUndefined()
  })
})
