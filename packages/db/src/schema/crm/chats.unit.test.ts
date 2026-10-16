// T121: `flow` é um remetente de mensagem válido (nós de fluxo, T120), tipado sem cast e aceito pela coluna.
import { describe, expect, expectTypeOf, it } from 'vitest'
import { MESSAGE_SENDER_TYPES, messages, type MessageSenderType } from './chats'

describe('MESSAGE_SENDER_TYPES', () => {
  it('inclui flow e system (mensagens automáticas) além dos remetentes de antes', () => {
    expect(MESSAGE_SENDER_TYPES).toEqual(expect.arrayContaining(['contact', 'user', 'bot', 'ai', 'system', 'flow']))
  })

  it('flow tipa sem cast como MessageSenderType e no insert de crm.messages', () => {
    const sender: MessageSenderType = 'flow'
    expectTypeOf<'flow'>().toExtend<MessageSenderType>()
    expect(sender).toBe('flow')
    const row: typeof messages.$inferInsert = {
      companyId: '00000000-0000-4000-8000-000000000001',
      chatId: '00000000-0000-4000-8000-000000000002',
      direction: 'outbound',
      senderType: 'flow',
      type: 'text',
      status: 'queued',
    }
    expect(row.senderType).toBe('flow')
  })
})
