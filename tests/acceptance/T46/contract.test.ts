// AC-T46-01: a suíte de contrato de @crm/wa-port (T03) passa contra o wa-worker REAL (transporte fake),
// usando o gateway RPC de produção por HTTP. O wa-worker roda em processo (startWaWorker, servidor interno
// numa porta real) para o harness poder segurar a fila (`queue.pause`): sem isso o caso de `cancel` disputa
// corrida com a entrega imediata. Um gateway RPC novo por teste.
import { afterAll, beforeAll, describe } from 'vitest'
import { REDIS_URL, newWorkerEnv, type WorkerEnv } from '../helpers/wa-worker'
import { gatewayFor, rpcTesting } from './support'

let env: WorkerEnv
let worker: any

beforeAll(async () => {
  env = newWorkerEnv()
  const { startWaWorker }: any = await import('@crm/wa-worker')
  worker = await startWaWorker({ env: { ...process.env, ...env.vars, WA_RPC_PORT: '0' } })
}, 180_000)

afterAll(async () => {
  await worker?.stop?.().catch(() => {})
  env?.cleanup()
}, 60_000)

const { defineWaGatewayContract } = await import('@crm/wa-port/contract')

describe('AC-T46-01 suíte de contrato da wa-port contra o wa-worker real via gateway RPC', () => {
  defineWaGatewayContract('rpc → wa-worker (WA_TRANSPORT=fake)', async () => {
    const { createWorkerContractHarness } = await rpcTesting()
    const { FsBlobStore }: any = await import('@crm/node-kit')
    const target = { url: worker.url, proc: undefined } as any
    const gateway = await gatewayFor(target, env)
    return createWorkerContractHarness({
      gateway,
      url: worker.url,
      token: env.token,
      fake: worker.fake,
      queue: worker.queue,
      redis: REDIS_URL,
      stream: env.stream,
      blobStore: new FsBlobStore(env.storageDir),
      eventTimeoutMs: 8000,
      teardown: async () => {
        await gateway.close?.()
      },
    })
  })
})
