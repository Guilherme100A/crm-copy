// Montagem de produção (T46/T120): cada módulo recebe as dependências reais; LLM por empresa (BYOK) e FakeLlm pelo
// mesmo resolvedor com AI_MODE=fake.
import { FakeLlm, text } from '@crm/ai'
import { AiKeysService, ChatSendService, ProviderNotConfiguredError, RealtimePublisher, UsageGuard } from '@crm/core'
import type { Database } from '@crm/db'
import { FakeWaGateway } from '@crm/wa-port/testing'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  chats: [] as Record<string, unknown>[],
  timer: [] as Record<string, unknown>[],
  step: [] as Record<string, unknown>[],
  agent: [] as Record<string, unknown>[],
  triggers: [] as Record<string, unknown>[],
  exports: [] as Record<string, unknown>[],
  imports: [] as Record<string, unknown>[],
}))
vi.mock('../consumers/chats', () => ({ configureChatsConsumer: (d: Record<string, unknown>) => calls.chats.push(d), onCrmInbound: () => () => undefined }))
vi.mock('../jobs/flow-timer', () => ({ configureFlowTimer: (d: Record<string, unknown>) => calls.timer.push(d) }))
vi.mock('../jobs/flow-step', () => ({ configureFlowStep: (d: Record<string, unknown>) => calls.step.push(d) }))
vi.mock('../jobs/ai-agent', () => ({ configureAiAgent: (d: Record<string, unknown>) => calls.agent.push(d) }))
vi.mock('../jobs/exports', () => ({ configureExports: (d: Record<string, unknown>) => calls.exports.push(d) }))
vi.mock('../jobs/contacts-import', () => ({ configureContactsImport: (d: Record<string, unknown>) => calls.imports.push(d) }))
vi.mock('../consumers/flow-triggers', () => ({
  configureFlowTriggers: (d: Record<string, unknown>) => calls.triggers.push(d),
  flowTriggers: () => ({ handleAttendanceFinished: async () => ({ outcome: 'none' }) }),
}))

const { configureWorkerProduction, companyLlmFromEnv, CompanyKeyedFakeLlm } = await import('./production')

const db = { fake: 'db' } as unknown as Database
const redis = { xadd: async () => '1-0', publish: async () => 1 } as never

beforeEach(() => {
  for (const list of Object.values(calls)) list.length = 0
})

describe('configureWorkerProduction', () => {
  it('liga gateway, banco, publisher, STORAGE_DIR, gatilhos com registro no chat, exports/imports e o agente com guard e voz por empresa', () => {
    const waGateway = new FakeWaGateway()
    const p = configureWorkerProduction({ db, waGateway, redis, env: { AI_MODE: 'fake' } })
    try {
      expect(p.publisher).toBeInstanceOf(RealtimePublisher)
      expect(p.chatSend).toBeInstanceOf(ChatSendService)
      expect(p.guard).toBeInstanceOf(UsageGuard)
      expect(p.fakeLlm).toBeInstanceOf(FakeLlm)
      expect(calls.chats).toEqual([expect.objectContaining({ db, waGateway, publisher: p.publisher, resolveConnection: expect.any(Function) })])
      expect(calls.timer).toEqual([{ db }])
      expect(calls.step).toEqual([expect.objectContaining({ db, wa: waGateway, llm: p.llm })])
      // Registro de nós com o `message` ligado ao registro no chat.
      expect((calls.step[0]!.registry as { has(t: string): boolean }).has('message')).toBe(true)
      expect(calls.triggers).toEqual([expect.objectContaining({ db, waGateway, record: expect.any(Function) })])
      expect(calls.exports).toEqual([expect.objectContaining({ db, files: expect.anything(), publisher: p.publisher })])
      expect(calls.imports).toEqual([expect.objectContaining({ waGateway, files: calls.exports[0]!.files })])
      expect(calls.agent).toEqual([
        expect.objectContaining({ db, llm: p.llm, waGateway, guard: p.guard, publisher: p.publisher, resolveTts: expect.any(Function), resolveStt: expect.any(Function) }),
      ])
    } finally {
      p.dispose()
    }
  })

  it('sem AI_MODE=fake o LLM é o provedor por empresa (BYOK), sem FakeLlm', () => {
    const p = configureWorkerProduction({ db, waGateway: new FakeWaGateway(), redis, env: {} })
    try {
      expect(p.fakeLlm).toBeUndefined()
      expect(p.llm).not.toBeInstanceOf(CompanyKeyedFakeLlm)
    } finally {
      p.dispose()
    }
  })
})

describe('LLM pelo resolvedor da empresa', () => {
  const req = (tenantId: string) =>
    ({ tenantId, agentId: 'a1', model: { provider: 'openai', model: 'gpt-x' }, instructions: '', messages: [{ role: 'user', content: [{ type: 'text', text: 'oi' }] }] }) as never

  it('AI_MODE=fake exige a chave da empresa e então responde pelo FakeLlm', async () => {
    const resolveCredentials = vi.fn(async (companyId: string) => {
      if (companyId !== 'com-chave') throw new ProviderNotConfiguredError('openai')
      return { apiKey: 'sk-test', source: 'company' as const }
    })
    const llm = companyLlmFromEnv({ resolveCredentials } as unknown as AiKeysService, { AI_MODE: 'fake' }) as InstanceType<typeof CompanyKeyedFakeLlm>
    llm.fake.enqueue(text('Olá!'))
    expect((await llm.generate(req('com-chave'))).text).toBe('Olá!')
    await expect(llm.generate(req('sem-chave'))).rejects.toBeInstanceOf(ProviderNotConfiguredError)
    expect(llm.fake.callCount).toBe(1)
    expect(resolveCredentials).toHaveBeenCalledWith('com-chave', 'openai')
  })
})
