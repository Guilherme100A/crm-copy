// Dependências de produção dos nós de mensagem (T120): `record` grava no chat o que o nó enviou (sender_type `flow`,
// sem reenviar; idempotente pelo id do pipeline, então o retry do passo não duplica) e `mediaUrl` resolve a mídia da
// empresa (cabeçalho de modelos) para a referência `blob:<sha256>` que o engine lê do BlobStore compartilhado.
import type { RecordOutboundInput } from '../../../chats/send/service'
import { blobUrl, type MediaService } from '../../../media/service'
import { createNodeRegistry, type NodeRegistry } from '../../engine/registry'
import type { MessagingDeps } from './handlers'
import { registerMessagingNodes } from './index'

export function flowMessageRecorder(chatSend: { recordOutbound(input: RecordOutboundInput): Promise<unknown> }): NonNullable<MessagingDeps['record']> {
  return async (ctx, sent) => {
    await chatSend.recordOutbound({
      companyId: ctx.companyId,
      chatId: ctx.chatId,
      contactId: ctx.contactId,
      sessionId: sent.target.sessionId,
      senderType: 'flow',
      actor: `flow:${ctx.runId}`,
      content: sent.content,
      view: sent.view,
      viewOnce: sent.viewOnce,
    })
  }
}

export function mediaUrlFrom(media: Pick<MediaService, 'info'>): NonNullable<MessagingDeps['mediaUrl']> {
  return async (ctx, mediaId) => {
    try {
      const info = await media.info(ctx.companyId, mediaId)
      return { url: blobUrl(info.sha256), mime: info.mime }
    } catch {
      return null
    }
  }
}

/** Registro de nós padrão com os nós de mensagem ligados às dependências de produção. */
export function productionNodeRegistry(deps: MessagingDeps): NodeRegistry {
  return registerMessagingNodes(createNodeRegistry(), deps)
}
