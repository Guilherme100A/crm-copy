// Montagem de produção do worker (T46 → T120): o WaGateway real (`wa-gateway-rpc` com WA_GATEWAY=rpc, FakeWaGateway
// com WA_GATEWAY=fake), o banco, o Redis e o MESMO `STORAGE_DIR` da API ligados a todos os módulos do registry:
//   chats (T33), flow-timer (T30), flow-step com os nós de mensagem gravando no chat (T51 `record`/`mediaUrl`),
//   gatilhos (T61, inclusive a mensagem fora do horário no histórico e o "atendimento finalizado"), exportações e
//   importações (T27/T67), o agente de IA (T68) com LLM e voz por empresa (BYOK, T38) e cota/carteira (T24) e os
//   disparos em massa (T74/T122), que iniciam os fluxos com o mesmo registry de nós e os timers do processo.
//   T125: Gerenciador Meta (meta-sync), Conversions API (meta-capi, nó pixel) e vendas aprovadas ao Pixel.
//   T127: webhooks de entrada (T81), fontes de venda (T73), pagamentos (T111), nós externos com IA medida (T42), base
//   de conhecimento (T52) e criação assistida de agente (T79), com o FlowControl, o LLM e o UsageGuard do processo.
import {
  AiKeysService,
  AiKnowledgeService,
  configureExternalNodes,
  configurePaymentNodes,
  FlowEngine,
  PaymentIntegrationsService,
  ChatSendService,
  configureCrmNodes,
  configureLogicNodes,
  createCompanyLlmProvider,
  crmConnectionSessionResolver,
  crmConnectionsResolver,
  flowMessageRecorder,
  FLOW_TIMER_QUEUE,
  FlowControl,
  FsExportFileStore,
  MediaService,
  bullTimerScheduler,
  defineQueue,
  flowEngineStarter,
  mediaUrlFrom,
  productionNodeRegistry,
  RealtimePublisher,
  registerAttendanceFinishedTrigger,
  resolveStt,
  resolveTts,
  UsageGuard,
  type ExportFileStore,
  type FlowStepJobData,
  type FlowTimerJobData,
  type MassDispatchRunnerDeps,
  type RunPublisher,
} from '@crm/core'
import type { AiKeyProvider, Database } from '@crm/db'
import { createAiSdkProvider, FakeLlm, LLM_PROVIDERS, toPttOgg, type LlmProvider, type LlmProviderId, type LlmRequest, type LlmResult } from '@crm/ai'
import { FsBlobStore, type BlobStore, type Logger } from '@crm/node-kit'
import type { WaGateway } from '@crm/wa-port'
import type { Redis } from 'ioredis'
import { configureChatsConsumer } from '../consumers/chats'
import { configureConnectionsConsumer } from '../consumers/connections'
import { configureFlowTriggers, flowTriggers } from '../consumers/flow-triggers'
import { configureAiAgent } from '../jobs/ai-agent'
import { configureContactsImport } from '../jobs/contacts-import'
import { configureExports } from '../jobs/exports'
import { FLOW_STEP_QUEUE, configureFlowStep, flowStepEnqueuer } from '../jobs/flow-step'
import { configureFlowTimer } from '../jobs/flow-timer'
import { configureSchedules } from '../jobs/schedules'
import { configureMassDispatch } from '../jobs/mass-dispatch'
import { configureMetaAds } from '../jobs/meta-ads'
import { configureMetaCapi, metaCapiEnqueuer } from '../jobs/meta-capi'
import { configureAiAgentLab } from '../jobs/ai-agent-lab'
import { configureAiKnowledge } from '../jobs/ai-knowledge'
import { configureInboundSales } from '../jobs/inbound-sales'
import { configureInboundWebhooks } from '../jobs/inbound-webhooks'
import { configurePaymentWebhooks } from '../jobs/payment-webhooks'
import { configureInvoices, invoicesEnqueuer } from '../jobs/invoices'
import { invoiceJobId, invoiceSalePublisher, type InvoiceEnqueue } from '@crm/core'
import { configureUtmify, utmifyEnqueuer } from '../jobs/utmify'
import { enqueueUtmifySale, utmifySalePublisher, type UtmifyEnqueue } from '@crm/core'
import { capiSalePublisher, configurePixelNodes, fxRatesFromEnv, metaConfigFromEnv, MetaProfilesService } from '@crm/core'

type Env = Record<string, string | undefined>
type KeysResolver = Pick<AiKeysService, 'resolveCredentials'>
type LlmForKey = (companyId: string, keyId: string) => Promise<{ llm: LlmProvider; provider: LlmProviderId }>

const isLlmProvider = (p: string): p is LlmProviderId => (LLM_PROVIDERS as readonly string[]).includes(p)

/**
 * `AI_MODE=fake`: o FakeLlm atrás do MESMO resolvedor da empresa — cada chamada exige a chave efetiva (BYOK ou da
 * plataforma) do provedor do modelo, como o provedor real; sem chave → `ProviderNotConfiguredError`. Nunca chama
 * um provedor real.
 */
export class CompanyKeyedFakeLlm implements LlmProvider {
  /** Chamadas pela chave de uma integração (`llmForKey`, bloco de IA com `ai_integration_id`). */
  readonly keyedCalls: { companyId: string; keyId: string; provider: LlmProviderId }[] = []

  constructor(
    private readonly keys: KeysResolver,
    readonly fake: FakeLlm = new FakeLlm(),
  ) {}

  async generate<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
    await this.keys.resolveCredentials(req.tenantId, req.model.provider as AiKeyProvider)
    return this.fake.generate(req)
  }

  /** O FakeLlm com a chave já aberta (a da integração), sem passar pelo resolvedor da empresa. */
  forKey(companyId: string, keyId: string, provider: LlmProviderId): LlmProvider {
    return {
      generate: <T>(req: LlmRequest<T>) => {
        this.keyedCalls.push({ companyId, keyId, provider })
        return this.fake.generate(req)
      },
    }
  }
}

/** LLM das empresas: AI SDK com a chave de cada empresa (T38) ou, com `AI_MODE=fake`, o FakeLlm pelo mesmo resolvedor. */
export function companyLlmFromEnv(keys: KeysResolver, env: Env = process.env): LlmProvider {
  if (env.AI_MODE?.trim().toLowerCase() === 'fake') return new CompanyKeyedFakeLlm(keys)
  return createCompanyLlmProvider({ keys })
}

/**
 * LLM pela chave de uma integração (T42, `ai_integration_id`): abre a chave por `credentialsForKey` (inexistente ou de
 * outra empresa → erro, e o nó segue a falha). Com o LLM fake do processo, a chamada vai para o MESMO FakeLlm.
 */
export function llmForKeyFrom(keys: Pick<AiKeysService, 'credentialsForKey'>, llm: LlmProvider): LlmForKey {
  return async (companyId, keyId) => {
    const { apiKey, provider } = await keys.credentialsForKey(companyId, keyId)
    if (!isLlmProvider(provider)) throw new Error(`a chave ${keyId} é de ${provider}, não de um provedor de LLM`)
    if (llm instanceof CompanyKeyedFakeLlm) return { llm: llm.forKey(companyId, keyId, provider), provider }
    return { llm: createAiSdkProvider({ resolveCredentials: async () => ({ apiKey }) }), provider }
  }
}

/** `AI_AGENT_CREATE_MODEL=provider:modelo` do env do boot (modelo da criação assistida, T79). */
function composeModelFromEnv(env: Env): { provider: string; model: string } | undefined {
  const v = env.AI_AGENT_CREATE_MODEL?.trim()
  const at = v ? v.indexOf(':') : -1
  return v && at > 0 ? { provider: v.slice(0, at), model: v.slice(at + 1) } : undefined
}

export interface WorkerProductionDeps {
  db: Database
  waGateway: WaGateway
  /** Redis de comandos: realtime (SSE) e contadores do UsageGuard. */
  redis: Redis
  logger?: Logger
  /** Blobs de mídia (mesmo `STORAGE_DIR` da API). Default `new FsBlobStore()`. */
  blobStore?: BlobStore
  /** Arquivos de export/import (mesmo `STORAGE_DIR/exports` da API). Default `new FsExportFileStore()`. */
  files?: ExportFileStore
  /** Chaves de IA (BYOK). Default `new AiKeysService({ db })` (cifrador de `CREDENTIALS_KEY`). */
  keys?: AiKeysService
  /** LLM das empresas. Default `companyLlmFromEnv(keys, env)`. */
  llm?: LlmProvider
  /** Eventos realtime. Default `new RealtimePublisher({ redis })`. */
  publisher?: RealtimePublisher
  env?: Env
}

export interface WorkerProduction {
  publisher: RealtimePublisher
  chatSend: ChatSendService
  keys: AiKeysService
  llm: LlmProvider
  /** Com `AI_MODE=fake`: o FakeLlm usado (roteiro e contagem de chamadas nos testes). */
  fakeLlm: FakeLlm | undefined
  guard: UsageGuard
  /** Desliga os ouvintes de processo registrados aqui ("atendimento finalizado"). */
  dispose(): void
}

/** Configura os módulos do registry do processo com as dependências reais. Chamar antes do `startWorker`. */
export function configureWorkerProduction(deps: WorkerProductionDeps): WorkerProduction {
  const { db, waGateway, redis } = deps
  const env = deps.env ?? process.env
  const logger = deps.logger ? { logger: deps.logger } : {}
  const publisher = deps.publisher ?? new RealtimePublisher({ redis })
  const media = new MediaService({ blobStore: deps.blobStore ?? new FsBlobStore() })
  const files = deps.files ?? new FsExportFileStore()
  const resolveSession = crmConnectionSessionResolver(db)
  const pttConverter = (data: Uint8Array) => toPttOgg(data)
  const chatSend = new ChatSendService({ db, waGateway, resolveSession, media, pttConverter, publisher, ...logger })

  configureChatsConsumer({ db, waGateway, resolveConnection: crmConnectionsResolver(db), publisher, ...logger })
  // T47/T127: status das conexões com o banco, o realtime, o gateway e o Redis do processo (o mailer segue o env).
  configureConnectionsConsumer({ db, publisher, gateway: waGateway, redis, ...logger })
  configureFlowTimer({ db, ...logger })
  // T64: agendamentos enviam pelo mesmo ChatSendService e iniciam fluxos pelo motor do processo.
  configureSchedules({ db, chatSend, waGateway })

  const keys = deps.keys ?? new AiKeysService({ db, env })
  const llm = deps.llm ?? companyLlmFromEnv(keys, env)
  const fakeLlm = llm instanceof CompanyKeyedFakeLlm ? llm.fake : undefined

  // Nós de mensagem gravam no chat o que enviaram (sender_type flow) e resolvem a mídia da empresa.
  const registry = productionNodeRegistry({ record: flowMessageRecorder(chatSend), mediaUrl: mediaUrlFrom(media) })
  configureFlowStep({ db, wa: waGateway, registry, llm, ...logger })

  // Gatilhos: a mensagem fora do horário entra no histórico como `system`; resolver o chat dispara "atendimento finalizado".
  configureFlowTriggers({ db, waGateway, record: (input) => chatSend.recordOutbound(input), ...logger })
  const offAttendance = registerAttendanceFinishedTrigger(flowTriggers()!, deps.logger)

  configureExports({ db, files, publisher, ...logger })
  configureContactsImport({ files, waGateway })

  const guard = new UsageGuard({ db, redis, realtime: publisher })
  // T52: o turno do agente recebe os trechos da base de conhecimento do agente.
  const knowledge = new AiKnowledgeService({ db }).asKnowledgeSearch()
  configureAiAgent({
    knowledge,
    db,
    llm,
    waGateway,
    resolveSession,
    media,
    pttConverter,
    publisher,
    guard,
    resolveTts: (companyId) => resolveTts(companyId, { keys, env }),
    resolveStt: (companyId) => resolveStt(companyId, { keys, env }),
    ...logger,
  })

  // Disparos em massa (T74): o envio de cada destinatário inicia o fluxo do alvo com o mesmo registry de nós (grava
  // no chat) e LLM; esperas do fluxo viram timers `flow-timer` e a continuação vai para `flow-step`.
  // Filas criadas no primeiro uso (configurar não abre conexão com o Redis).
  let timerQueue: ReturnType<typeof defineQueue<FlowTimerJobData>> | undefined
  let stepQueue: ReturnType<typeof defineQueue<FlowStepJobData>> | undefined
  const timers = () => bullTimerScheduler((timerQueue ??= defineQueue<FlowTimerJobData>(FLOW_TIMER_QUEUE)))
  const control = new FlowControl({
    db,
    timers: { schedule: (data, delayMs) => timers().schedule(data, delayMs), cancel: (data) => timers().cancel(data) },
    enqueueStep: (data) => flowStepEnqueuer((stepQueue ??= defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE)))(data),
    ...logger,
  })
  configureMassDispatch({
    db,
    wa: waGateway,
    redis,
    overrides: {
      control,
      starter: flowEngineStarter({ db, wa: waGateway, control, engine: { registry, llm, hooks: control.engineHooks(), ...logger } }),
      publisher: publisher as unknown as MassDispatchRunnerDeps['publisher'],
      ...(deps.logger ? { logger: deps.logger } : {}),
    },
  })

  // Nós de lógica (T41: flow.distributor_updated) e de CRM (T63: contact.updated, chat.updated, kanban.*,
  // notification.created) publicam pelo realtime do processo (T123).
  configureLogicNodes({ publisher, ...logger })
  configureCrmNodes({ publisher, ...logger })

  // T125: Meta. Gerenciador (job meta-sync, T101) com o OAuth/Graph e as cotações do env; Conversions API (job
  // meta-capi e nó pixel, T104) na Graph do env; a venda aprovada pelo nó approved_sale enfileira o Purchase
  // (`sale.recorded` → meta-capi). Fila criada no primeiro uso.
  configureMetaAds({ db, redis, publisher, profiles: new MetaProfilesService({ db, config: metaConfigFromEnv(env) }), fx: fxRatesFromEnv(env), ...logger })
  const capiEnv = { graphUrl: env.META_GRAPH_URL?.trim() || undefined, testEventCode: env.META_CAPI_TEST_EVENT_CODE?.trim() || null, isProduction: env.NODE_ENV === 'production' }
  configureMetaCapi({ db, ...capiEnv })
  configurePixelNodes(capiEnv)
  let capiEnqueue: ReturnType<typeof metaCapiEnqueuer> | undefined
  const capiSaleEnqueue = (data: Parameters<ReturnType<typeof metaCapiEnqueuer>>[0], opts: { jobId: string }) => (capiEnqueue ??= metaCapiEnqueuer())(data, opts)
  const salesPublisher = capiSalePublisher(publisher, { enqueue: capiSaleEnqueue, ...logger })
  configureCrmNodes({ publisher: salesPublisher })

  // T127. Fontes de venda (T73): a venda criada aprovada sai pelo `sale.recorded` envelopado; a que passa de pendente a
  // aprovada, pelo `capiEnqueue` (mesmo enfileirador preguiçoso).
  configureInboundSales({ db, publisher: salesPublisher, capiEnqueue: capiSaleEnqueue, ...logger })
  // Webhooks de entrada (T81): o fluxo inicia pelo motor do processo (registry de produção, enqueue do flow-step,
  // ganchos do FlowControl); a varredura dos pendentes é agendada no start (`production-worker.ts`).
  const flowEngine = new FlowEngine({
    db,
    wa: waGateway,
    registry,
    llm,
    enqueue: (data) => flowStepEnqueuer((stepQueue ??= defineQueue<FlowStepJobData>(FLOW_STEP_QUEUE)))(data),
    hooks: control.engineHooks(),
    ...logger,
  })
  configureInboundWebhooks({ db, engine: flowEngine, control, redis, publisher, waGateway, ...logger })
  // Pagamentos (T111): cobrança do nó e confirmação do webhook pelas integrações com o cipher (`CREDENTIALS_KEY`) e o
  // env do boot (`XPAG_API_URL`, `API_PUBLIC_URL`); o webhook retoma o run pelo FlowControl do processo.
  const paymentIntegrations = new PaymentIntegrationsService({ db, env })
  configurePaymentNodes({ paymentIntegrations })
  configurePaymentWebhooks({ db, control, integrations: paymentIntegrations, ...logger })
  // Nós externos (T42): bloco de IA medido pelo UsageGuard (`feature = 'flow_ai'`), chave por integração.
  configureExternalNodes({ llm, llmForKey: llmForKeyFrom(keys, llm), guard })
  // Base de conhecimento (T52) e criação assistida de agente (T79) com o LLM e o guard do processo.
  configureAiKnowledge({ db, redis, publisher, ...logger })
  const composeModel = composeModelFromEnv(env)
  configureAiAgentLab({ db, redis, llm, guard, publisher: publisher as unknown as RunPublisher, knowledge, ...(composeModel ? { composeModel } : {}), ...logger })

  // T112: emissão de NF (job `invoices`) com o cipher (`CREDENTIALS_KEY`), o env do boot (`NOTASY_API_URL`) e o realtime
  // do processo (`sale.updated`). O emissor é encadeado no MESMO publisher das vendas (depois do CAPI): a venda aprovada
  // do nó approved_sale e das fontes de venda enfileira a emissão; a que passa de pendente a aprovada (T73) também,
  // pelo `capiEnqueue` (o job só emite se a venda tiver `note_issuer_id`). Fila criada no primeiro uso.
  configureInvoices({ db, env, publisher, ...logger })
  let invoicesEnqueue: InvoiceEnqueue | undefined
  const invoiceEnqueue: InvoiceEnqueue = (data, opts) => (invoicesEnqueue ??= invoicesEnqueuer())(data, opts)
  const invoiceSales = invoiceSalePublisher(salesPublisher, { enqueue: invoiceEnqueue, ...logger })
  configureCrmNodes({ publisher: invoiceSales })
  configureInboundSales({
    publisher: invoiceSales,
    capiEnqueue: async (data, opts) => {
      const [capi] = await Promise.allSettled([capiSaleEnqueue(data, opts), invoiceEnqueue({ ...data, generation: 1 }, { jobId: invoiceJobId(data.saleId, 1) })])
      if (capi.status === 'rejected') throw capi.reason
    },
  })

  // T113: envio de vendas à UTMify (job `utmify`) com o cipher (`CREDENTIALS_KEY`), o env do boot (`UTMIFY_API_URL`,
  // `APP_NAME`) e o realtime do processo (`sale.updated`). Encadeado no MESMO publisher das vendas (depois da NF): a venda
  // aprovada do nó approved_sale e das fontes de venda enfileira o envio, e a que passa a reembolsada (`sale.updated` do
  // SalesService) enfileira o reembolso; a que passa de pendente a aprovada (T73), pelo `capiEnqueue` (o job só envia se
  // a venda tiver `utmify_integration_id`). Fila criada no primeiro uso.
  configureUtmify({ db, env, publisher, ...logger })
  let utmifyQueueEnqueue: UtmifyEnqueue | undefined
  const utmifyEnqueue: UtmifyEnqueue = (data, opts) => (utmifyQueueEnqueue ??= utmifyEnqueuer())(data, opts)
  const utmifySales = utmifySalePublisher(invoiceSales, { enqueue: utmifyEnqueue, ...logger })
  configureCrmNodes({ publisher: utmifySales })
  configureInboundSales({
    publisher: utmifySales,
    capiEnqueue: async (data, opts) => {
      const [capi] = await Promise.allSettled([
        capiSaleEnqueue(data, opts),
        invoiceEnqueue({ ...data, generation: 1 }, { jobId: invoiceJobId(data.saleId, 1) }),
        enqueueUtmifySale(utmifyEnqueue, data.companyId, data.saleId, 'approved'),
      ])
      if (capi.status === 'rejected') throw capi.reason
    },
  })

  return { publisher, chatSend, keys, llm, fakeLlm, guard, dispose: offAttendance }
}
