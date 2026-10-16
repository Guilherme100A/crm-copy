// Consumidor de chats (SPEC T33): registra no worker os handlers dos eventos WhatsApp que viram contatos, chats e
// mensagens. As dependências podem vir na chamada (testes) ou ser configuradas depois por quem tem o gateway e o
// resolver de conexões (`configureChatsConsumer`, T40/T46); sem elas, banco e Redis vêm do ambiente na 1ª entrega.
import { ChatIngest, RealtimePublisher, type ChatIngestOptions, type CrmInboundEvent } from '@crm/core'
import { createDb } from '@crm/db'
import { redisConnection } from '@crm/node-kit'
import type { WaEventType } from '@crm/wa-port'
import type { WorkerRegistry } from '../../registry'

/** Eventos tratados pelo ingest de chats. */
export const CHAT_EVENT_TYPES = ['message.inbound', 'history.batch', 'message.status', 'contact.upsert', 'contact.lid_mapping'] as const satisfies readonly WaEventType[]

type InboundListener = (e: CrmInboundEvent) => void | Promise<void>
const inboundListeners = new Set<InboundListener>()

/** `crm.inbound` (interno, não vai ao SSE): fluxos e agentes se inscrevem aqui. Devolve a função que cancela. */
export function onCrmInbound(listener: InboundListener): () => void {
  inboundListeners.add(listener)
  return () => inboundListeners.delete(listener)
}

async function emitInbound(e: CrmInboundEvent): Promise<void> {
  for (const listener of [...inboundListeners]) await listener(e)
}

let configured: Partial<ChatIngestOptions> = {}
let processIngest: ChatIngest | undefined

/** Completa/troca as dependências do consumidor do processo (gateway, resolver de conexões, publisher, db). */
export function configureChatsConsumer(deps: Partial<ChatIngestOptions>): void {
  configured = { ...configured, ...deps }
  processIngest = undefined
}

function ingestFrom(deps: Partial<ChatIngestOptions>): ChatIngest {
  const userInbound = deps.onInbound
  return new ChatIngest({
    ...deps,
    db: deps.db ?? createDb(),
    publisher: deps.publisher ?? new RealtimePublisher({ redis: redisConnection() }),
    onInbound: async (e) => {
      await userInbound?.(e)
      await emitInbound(e)
    },
  })
}

/**
 * Registra os handlers de chats no registry. Com `deps`, usa um ingest próprio (testes, E2E); sem `deps`, usa o do
 * processo, criado na primeira entrega com o que `configureChatsConsumer` definiu (e o ambiente para o resto).
 */
export function registerChatsConsumer(registry: WorkerRegistry, deps?: Partial<ChatIngestOptions> & Pick<ChatIngestOptions, 'db'>): WorkerRegistry {
  let own: ChatIngest | undefined
  const ingest = () => {
    if (deps) return (own ??= ingestFrom(deps))
    return (processIngest ??= ingestFrom(configured))
  }
  for (const type of CHAT_EVENT_TYPES) {
    registry.on(
      type,
      async (event) => {
        await ingest().handle(event)
      },
      { id: `chats:${type}` },
    )
  }
  return registry
}
