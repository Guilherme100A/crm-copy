// Consumidor de conexões (T47): `session.connection|state|qr|pairing_code` do `wsm:events` → `ConnectionStatusProjector`
// (status em `crm.connections`, eventos `connection.*`/`flow.auto_paused`, pausa de runs e e-mail de desconexão).
// As dependências podem vir na chamada (testes) ou do processo (`configureConnectionsConsumer`); sem elas, banco,
// Redis, publisher e mailer vêm do ambiente na 1ª entrega (como o consumidor de chats), então o worker de produção
// projeta mesmo antes de o boot configurar algo.
import { ConnectionStatusProjector, RealtimePublisher, type ConnectionStatusOptions } from '@crm/core'
import { createDb } from '@crm/db'
import { createMailer, redisConnection } from '@crm/node-kit'
import type { WaEventType } from '@crm/wa-port'
import type { WorkerRegistry } from '../../registry'

/** Eventos tratados pelo consumidor de conexões. */
export const CONNECTION_EVENT_TYPES = ['session.connection', 'session.state', 'session.qr', 'session.pairing_code'] as const satisfies readonly WaEventType[]

let configured: Partial<ConnectionStatusOptions> = {}
let processProjector: ConnectionStatusProjector | undefined

/** Completa/troca as dependências do processo (db, publisher, mailer, gateway, redis, appName, logger…). */
export function configureConnectionsConsumer(deps: Partial<ConnectionStatusOptions>): void {
  configured = { ...configured, ...deps }
  processProjector = undefined
}

function projectorFrom(deps: Partial<ConnectionStatusOptions>): ConnectionStatusProjector {
  const needsRedis = !deps.publisher || (!deps.dedupe && !deps.redis)
  const redis = needsRedis ? redisConnection() : undefined
  return new ConnectionStatusProjector({
    ...deps,
    db: deps.db ?? createDb(),
    publisher: deps.publisher ?? new RealtimePublisher({ redis: redis! }),
    mailer: deps.mailer ?? createMailer(),
    ...(deps.dedupe || deps.redis ? {} : { redis: redis! }),
  })
}

/**
 * Registra os handlers de conexões no registry. Com `deps`, usa um projetor próprio (testes); sem `deps`, o do
 * processo, criado na 1ª entrega com o que `configureConnectionsConsumer` definiu (e o ambiente para o resto).
 */
export function registerConnectionsConsumer(registry: WorkerRegistry, deps?: Partial<ConnectionStatusOptions> & Pick<ConnectionStatusOptions, 'db' | 'publisher'>): WorkerRegistry {
  let own: ConnectionStatusProjector | undefined
  const projector = () => {
    if (deps) return (own ??= new ConnectionStatusProjector(deps))
    return (processProjector ??= projectorFrom(configured))
  }
  for (const type of CONNECTION_EVENT_TYPES) {
    registry.on(
      type,
      async (event) => {
        await projector().handle(event)
      },
      { id: `connections:${type}` },
    )
  }
  return registry
}
