import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { AI_KNOWLEDGE_QUEUE, createAiKnowledgeProcessor, registerAiKnowledgeJob } from './index'

describe('job ai-knowledge', () => {
  it('registra fila e worker', () => {
    const reg = registerAiKnowledgeJob(createRegistry(), { service: { process: async () => null } })
    expect(reg.queues.map((q) => q.name)).toEqual([AI_KNOWLEDGE_QUEUE])
    expect(reg.workers.map((w) => w.name)).toEqual([AI_KNOWLEDGE_QUEUE])
  })

  it('processa a fonte do job; sem dependências lança', async () => {
    const seen: string[] = []
    const processor = createAiKnowledgeProcessor({ service: () => ({ process: async (id: string) => (seen.push(id), null) }) })
    await processor({ data: { companyId: 'c', sourceId: 's1' } } as never)
    expect(seen).toEqual(['s1'])
    await expect(createAiKnowledgeProcessor({ service: () => undefined })({ data: { companyId: 'c', sourceId: 's' } } as never)).rejects.toThrow(/configureAiKnowledge/)
  })
})
