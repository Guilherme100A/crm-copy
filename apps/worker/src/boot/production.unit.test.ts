// Montagem de produção (T46): o gateway e o banco chegam aos módulos do registry; LLM da plataforma pelo ambiente.
import { FakeLlm } from '@crm/ai'
import { MediaService } from '@crm/core'
import type { Database } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ chats: [] as unknown[], timer: [] as unknown[], step: [] as unknown[], agent: [] as unknown[] }))
vi.mock('../consumers/chats', () => ({ configureChatsConsumer: (d: unknown) => calls.chats.push(d) }))
vi.mock('../jobs/flow-timer', () => ({ configureFlowTimer: (d: unknown) => calls.timer.push(d) }))
vi.mock('../jobs/flow-step', () => ({ configureFlowStep: (d: unknown) => calls.step.push(d) }))
vi.mock('../jobs/ai-agent', () => ({ configureAiAgent: (d: unknown) => calls.agent.push(d) }))

const { configureWorkerProduction, platformLlmFromEnv, PlatformKeyMissingError } = await import('./production')

const db = { fake: 'db' } as unknown as Database

beforeEach(() => {
  calls.chats.length = 0
  calls.timer.length = 0
  calls.step.length = 0
  calls.agent.length = 0
})

describe('configureWorkerProduction', () => {
  it('chats recebe gateway, banco e o resolver de crm.connections; flow-timer o banco; flow-step gateway e LLM', () => {
    const waGateway = new FakeWaGateway()
    const llm = new FakeLlm()
    configureWorkerProduction({ db, waGateway, llm })
    expect(calls.chats).toEqual([{ db, waGateway, resolveConnection: expect.any(Function) }])
    expect(calls.timer).toEqual([{ db }])
    expect(calls.step).toEqual([{ db, wa: waGateway, llm }])
    expect(calls.agent).toEqual([
      { db, llm, waGateway, resolveSession: expect.any(Function), media: expect.any(MediaService), pttConverter: expect.any(Function) },
    ])
  })

  it('sem LLM: flow-step só com gateway e banco; agente de IA não configurado e aviso no log', () => {
    const waGateway = new FakeWaGateway()
    const logger = { warn: vi.fn() }
    configureWorkerProduction({ db, waGateway, logger: logger as never })
    expect(calls.step).toEqual([{ db, wa: waGateway, logger }])
    expect(calls.agent).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith({}, expect.stringContaining('agente de IA não configurado'))
  })
})

describe('platformLlmFromEnv', () => {
  const logger = () => ({ warn: vi.fn(), info: vi.fn() })

  it('sem chave nenhuma: não configura e registra aviso', () => {
    const log = logger()
    expect(platformLlmFromEnv({ ANTHROPIC_API_KEY: '  ' }, log)).toBeUndefined()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('AI_MODE=fake → FakeLlm', () => {
    expect(platformLlmFromEnv({ AI_MODE: 'fake', OPENAI_API_KEY: 'sk' }, logger())).toBeInstanceOf(FakeLlm)
  })

  it('com chave: provider do AI SDK; provedor sem chave falha com PlatformKeyMissingError (sem chamar a rede)', async () => {
    const log = logger()
    const llm = platformLlmFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' }, log)
    expect(llm).toBeDefined()
    expect(log.warn).not.toHaveBeenCalled()
    const err = await llm!
      .generate({ companyId: 'c1', model: { provider: 'openai', model: 'gpt-x' }, messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] } as never)
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(PlatformKeyMissingError)
  })
})
