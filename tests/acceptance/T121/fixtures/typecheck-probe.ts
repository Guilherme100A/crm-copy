// AC-T121-03 (tipos): gravar uma mensagem de remetente `flow` por recordOutbound compila SEM cast.
// Verificado com tsc --noEmit -p tests/acceptance/T121/fixtures/tsconfig.json (não é executado).
import type { MESSAGE_SENDER_TYPES } from '@crm/db'
import type { ChatSendService } from '@crm/core'

type SenderType = (typeof MESSAGE_SENDER_TYPES)[number]
const flowSender = 'flow' satisfies SenderType

export async function gravaMensagemDeFluxo(svc: ChatSendService, view: Parameters<ChatSendService['recordOutbound']>[0]['view']) {
  return svc.recordOutbound({
    companyId: '00000000-0000-4000-8000-000000000001',
    chatId: '00000000-0000-4000-8000-000000000002',
    senderType: flowSender,
    actor: 'flow:run-1',
    content: { text: 'mensagem do fluxo' },
    view,
  })
}

export async function literalFlow(svc: ChatSendService, view: Parameters<ChatSendService['recordOutbound']>[0]['view']) {
  return svc.recordOutbound({ companyId: 'c', chatId: 'h', senderType: 'flow', actor: 'flow:run-2', content: { text: 'x' }, view })
}
