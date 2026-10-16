// Controle negativo do AC-T121-03: remetente fora de MESSAGE_SENDER_TYPES NÃO pode compilar.
import type { ChatSendService } from '@crm/core'

export async function remetenteInvalido(svc: ChatSendService, view: Parameters<ChatSendService['recordOutbound']>[0]['view']) {
  return svc.recordOutbound({ companyId: 'c', chatId: 'h', senderType: 'robo-inexistente', actor: 'x', content: { text: 'x' }, view })
}
