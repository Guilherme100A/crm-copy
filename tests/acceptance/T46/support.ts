// Apoio da suíte T46 (não é arquivo de teste). O wa-worker roda de verdade como processo filho
// (helpers/wa-worker.ts, WA_TRANSPORT=fake) e o CRM fala com ele pelo adapter de produção:
// '@crm/wa-gateway-rpc': createRpcGateway, crmProfile, WorkerUnavailableError, CapabilityNotSupportedError,
// createWaGatewayFromEnv; '@crm/wa-gateway-rpc/testing': createWorkerContractHarness (harness da suíte da T03).
import { REDIS_URL, type Worker, type WorkerEnv } from '../helpers/wa-worker'

export const rpcMod = (): Promise<any> => import('@crm/wa-gateway-rpc')
export const rpcTesting = (): Promise<any> => import('@crm/wa-gateway-rpc/testing')

/** Gateway RPC apontando para o wa-worker filho (stream de eventos isolado do ambiente). */
export async function gatewayFor(w: Worker, env: WorkerEnv, extra: Record<string, unknown> = {}): Promise<any> {
  const { createRpcGateway } = await rpcMod()
  return createRpcGateway({ url: w.url, token: env.token, profile: 'crm', redis: REDIS_URL, stream: env.stream, ...extra })
}

/** Harness da suíte de contrato sobre o wa-worker filho (sem FakeControl em processo). */
export async function harnessFor(w: Worker, env: WorkerEnv): Promise<any> {
  const { createWorkerContractHarness } = await rpcTesting()
  const { FsBlobStore }: any = await import('@crm/node-kit')
  const gateway = await gatewayFor(w, env)
  return createWorkerContractHarness({
    gateway,
    url: w.url,
    token: env.token,
    redis: REDIS_URL,
    stream: env.stream,
    blobStore: new FsBlobStore(env.storageDir),
    eventTimeoutMs: 8000,
    teardown: async () => {
      await gateway.close?.()
    },
  })
}

export const ACTOR = 'crm:user-t46'
