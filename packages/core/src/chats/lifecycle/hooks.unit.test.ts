// Ouvintes de "chat resolvido" (T120): em ordem, isolados e canceláveis.
import { describe, expect, it, vi } from 'vitest'
import { emitChatResolved, onChatResolved } from './hooks'

describe('onChatResolved', () => {
  it('chama os ouvintes em ordem; a falha de um vai para o onError dele e não impede os outros; off cancela', async () => {
    const order: string[] = []
    const onError = vi.fn()
    const offA = onChatResolved(() => void order.push('a'))
    const offB = onChatResolved(() => {
      order.push('b')
      throw new Error('boom')
    }, onError)
    const offC = onChatResolved(async () => void order.push('c'))
    const e = { companyId: 'co', chatId: 'ch', actorUserId: 'u' }
    await emitChatResolved(e)
    expect(order).toEqual(['a', 'b', 'c'])
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), e)
    offA()
    offB()
    offC()
    await emitChatResolved(e)
    expect(order).toHaveLength(3)
  })
})
