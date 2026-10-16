// Montagem de produção do worker (T46): injeta o WaGateway real (`wa-gateway-rpc` com WA_GATEWAY=rpc, FakeWaGateway
// com WA_GATEWAY=fake) e o banco nos módulos registrados no registry (chats T33, flow-timer T30, flow-step T25), e
// o LlmProvider da plataforma (chaves do ambiente) nos nós de IA dos fluxos e no runtime do agente de IA (T68).
// A T38 troca a chave da plataforma por resolução BYOK por empresa (`resolveCredentials`).
import { crmConnectionSessionResolver, crmConnectionsResolver, MediaService, type ChatPublisher } from '@crm/core'
import type { Database } from '@crm/db'
import { createAiSdkProvider, FakeLlm, LLM_PROVIDERS, toPttOgg, type LlmProvider, type LlmProviderId } from '@crm/ai'
import { FsBlobStore, type BlobStore, type Logger } from '@crm/node-kit'
import type { WaGateway } from '@crm/wa-port'
import { configureChatsConsumer } from '../consumers/chats'
import { configureAiAgent } from '../jobs/ai-agent'
import { configureFlowStep } from '../jobs/flow-step'
import { configureFlowTimer } from '../jobs/flow-timer'

type Env = Record<string, string | undefined>
type WarnLogger = Pick<Logger, 'warn' | 'info'>

/** Variável de ambiente com a chave da plataforma de cada provedor. */
export const PLATFORM_LLM_KEYS: Record<LlmProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
}

export class PlatformKeyMissingError extends Error {
  readonly code = 'PLATFORM_KEY_MISSING'
  constructor(readonly provider: LlmProviderId) {
    super(`sem chave da plataforma para ${provider} (${PLATFORM_LLM_KEYS[provider]})`)
    this.name = 'PlatformKeyMissingError'
  }
}

/**
 * LlmProvider da plataforma a partir do ambiente: `AI_MODE=fake` → FakeLlm; senão AI SDK com as chaves
 * ANTHROPIC/OPENAI/GOOGLE/OPENROUTER_API_KEY. Sem chave nenhuma devolve `undefined` e registra um aviso.
 */
export function platformLlmFromEnv(env: Env = process.env, logger?: WarnLogger): LlmProvider | undefined {
  if (env.AI_MODE?.trim().toLowerCase() === 'fake') {
    logger?.info({ ai_mode: 'fake' }, 'LLM da plataforma: FakeLlm (AI_MODE=fake)')
    return new FakeLlm()
  }
  const keys = new Map<LlmProviderId, string>()
  for (const provider of LLM_PROVIDERS) {
    const key = env[PLATFORM_LLM_KEYS[provider]]?.trim()
    if (key) keys.set(provider, key)
  }
  if (keys.size === 0) {
    logger?.warn({ keys: Object.values(PLATFORM_LLM_KEYS) }, 'nenhuma chave de LLM da plataforma configurada: nós de IA dos fluxos e agentes ficam sem modelo')
    return undefined
  }
  return createAiSdkProvider({
    resolveCredentials: ({ provider }) => {
      const apiKey = keys.get(provider)
      if (!apiKey) throw new PlatformKeyMissingError(provider)
      return { apiKey }
    },
  })
}

export interface WorkerProductionDeps {
  db: Database
  waGateway: WaGateway
  llm?: LlmProvider | undefined
  logger?: Logger
  /** Mídia do agente (mesmo `STORAGE_DIR` da API). Default `new FsBlobStore()`. */
  blobStore?: BlobStore
  /** Eventos realtime das mensagens do agente (`chat.*`). */
  publisher?: ChatPublisher
}

/** Configura os módulos do registry do processo com as dependências reais. Chamar antes do `startWorker`. */
export function configureWorkerProduction(deps: WorkerProductionDeps): void {
  const logger = deps.logger ? { logger: deps.logger } : {}
  configureChatsConsumer({ db: deps.db, waGateway: deps.waGateway, resolveConnection: crmConnectionsResolver(deps.db), ...logger })
  configureFlowTimer({ db: deps.db, ...logger })
  configureFlowStep({ db: deps.db, wa: deps.waGateway, ...(deps.llm ? { llm: deps.llm } : {}), ...logger })
  if (!deps.llm) {
    deps.logger?.warn({}, 'agente de IA não configurado: sem LLM da plataforma (a T38 trará BYOK por empresa)')
    return
  }
  configureAiAgent({
    db: deps.db,
    llm: deps.llm,
    waGateway: deps.waGateway,
    resolveSession: crmConnectionSessionResolver(deps.db),
    media: new MediaService({ blobStore: deps.blobStore ?? new FsBlobStore() }),
    pttConverter: (data) => toPttOgg(data),
    ...(deps.publisher ? { publisher: deps.publisher } : {}),
    ...logger,
  })
}
