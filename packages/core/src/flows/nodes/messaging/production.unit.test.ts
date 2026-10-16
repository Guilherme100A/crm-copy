// Dependências de produção dos nós de mensagem (T120): registro no chat como `flow` e mídia por referência blob.
import { describe, expect, it, vi } from 'vitest'
import { flowMessageRecorder, mediaUrlFrom, productionNodeRegistry } from './production'

const ctx = { companyId: 'co', chatId: 'ch', contactId: 'ct', runId: 'run-9' } as never

describe('flowMessageRecorder', () => {
  it('grava com sender_type flow, actor flow:<runId> e o destino da sessão', async () => {
    const recordOutbound = vi.fn(async () => null)
    const view = { id: 'pipe-1' } as never
    await flowMessageRecorder({ recordOutbound })(ctx, { target: { sessionId: 's1', phone: '+55' } as never, content: { text: 'oi' }, viewOnce: false, actionId: 'a1', view })
    expect(recordOutbound).toHaveBeenCalledWith({
      companyId: 'co',
      chatId: 'ch',
      contactId: 'ct',
      sessionId: 's1',
      senderType: 'flow',
      actor: 'flow:run-9',
      content: { text: 'oi' },
      view,
      viewOnce: false,
    })
  })
})

describe('mediaUrlFrom', () => {
  it('mídia da empresa → blob:<sha256> com mime; id inválido → null', async () => {
    const info = vi.fn(async (_companyId: string, id: string) => {
      if (id !== 'ok') throw new Error('not found')
      return { id, sha256: 'abc', mime: 'image/png', size: 1, kind: 'image' as const, file_name: null }
    })
    const resolve = mediaUrlFrom({ info })
    expect(await resolve(ctx, 'ok')).toEqual({ url: 'blob:abc', mime: 'image/png' })
    expect(await resolve(ctx, 'x')).toBeNull()
    expect(info).toHaveBeenCalledWith('co', 'ok')
  })
})

describe('productionNodeRegistry', () => {
  it('tem os nós de mensagem e os demais do registro padrão', () => {
    const registry = productionNodeRegistry({})
    for (const t of ['start', 'message', 'notification', 'pix']) expect(registry.has(t)).toBe(true)
  })
})
