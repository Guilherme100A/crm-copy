import { describe, expect, it } from 'vitest'
import { createRegistry } from '../../registry'
import { AI_AGENT_LAB_QUEUE, createAiAgentLabProcessor, registerAiAgentLabJob } from './index'

describe('job ai-agent-lab (T79)', () => {
  it('registra fila e worker com 1 tentativa e processa o run do job', async () => {
    const seen: string[] = []
    const service = { processRun: async (id: string) => (seen.push(id), null) }
    const reg = registerAiAgentLabJob(createRegistry(), { service })
    expect(reg.queues).toEqual([{ name: AI_AGENT_LAB_QUEUE, opts: { defaultJobOptions: { attempts: 1 } } }])
    expect(reg.workers.map((w) => w.name)).toEqual([AI_AGENT_LAB_QUEUE])
    await createAiAgentLabProcessor({ service: () => service })({ data: { runId: 'r1', companyId: 'c1' } } as never)
    expect(seen).toEqual(['r1'])
  })
})
