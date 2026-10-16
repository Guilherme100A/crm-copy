// `flow_run.updated` (T120): só jobs que mudaram o run publicam, com o estado lido do banco.
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { attachFlowRunEvents, changedRunId } from './flow-run-events'

describe('changedRunId', () => {
  it('flow-step executado e flow-timer que avançou; o resto não', () => {
    expect(changedRunId('flow-step', { data: { runId: 'r1' } }, { executed: true, status: 'completed' })).toBe('r1')
    expect(changedRunId('flow-step', { data: { runId: 'r1' } }, { executed: false, reason: 'stale' })).toBeNull()
    expect(changedRunId('flow-timer', { data: { runId: 'r2' } }, { advanced: true })).toBe('r2')
    expect(changedRunId('flow-timer', { data: { runId: 'r2' } }, { advanced: false })).toBeNull()
    expect(changedRunId('exports', { data: { runId: 'r3' } }, { executed: true })).toBeNull()
  })
})

describe('attachFlowRunEvents', () => {
  it('publica o run lido do banco no completed dos workers de fluxo; off desliga', async () => {
    const row = { id: 'r1', companyId: 'co', flowId: 'f1', contactId: 'ct', chatId: 'ch', status: 'completed' }
    const db = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) } as never
    const publish = vi.fn(async () => undefined)
    const step = Object.assign(new EventEmitter(), { name: 'flow-step' })
    const other = Object.assign(new EventEmitter(), { name: 'exports' })
    const off = attachFlowRunEvents([step, other] as never, { db, publisher: { publish } })
    step.emit('completed', { data: { runId: 'r1' } }, { executed: true })
    other.emit('completed', { data: { runId: 'r1' } }, { executed: true })
    await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(1))
    expect(publish).toHaveBeenCalledWith('co', 'flow_run.updated', { run_id: 'r1', flow_id: 'f1', contact_id: 'ct', chat_id: 'ch', status: 'completed' })
    off()
    step.emit('completed', { data: { runId: 'r1' } }, { executed: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(publish).toHaveBeenCalledTimes(1)
  })
})
