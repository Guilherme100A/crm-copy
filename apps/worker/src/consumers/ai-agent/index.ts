// Consumidor do agente de IA (T68): cada `crm.inbound` (T33) de chat com agente ativo entra no buffer do runtime.
import type { AiAgentRuntime } from '@crm/core'
import { onCrmInbound } from '../chats'
import { aiAgentRuntime } from '../../jobs/ai-agent'

/**
 * Liga o `crm.inbound` ao runtime. Com `runtime`, usa esse (testes); sem, o do processo (`configureAiAgent`), e
 * ignora a mensagem enquanto o runtime não estiver configurado. Devolve a função que desliga.
 */
export function registerAiAgentConsumer(runtime?: AiAgentRuntime, logger?: { error(obj: object, msg?: string): void }): () => void {
  return onCrmInbound(async (e) => {
    const rt = runtime ?? aiAgentRuntime()
    if (!rt) return
    try {
      await rt.onInbound(e)
    } catch (err) {
      // Falha do agente não pode derrubar o ingest das mensagens nem os outros ouvintes (fluxos).
      logger?.error({ err, chatId: e.chat_id }, 'ai agent: falha ao receber mensagem')
    }
  })
}
