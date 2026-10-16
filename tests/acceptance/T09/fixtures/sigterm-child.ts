// Processo filho do AC-T09-05: sobe o worker com startWorker({ registry }), enfileira um job lento e,
// com o job ATIVO, dispara SIGTERM (process.emit — no Windows process.kill(pid,'SIGTERM') não executa handlers).
// Saída (stdout, uma por linha): READY, JOB_START, SIGTERM_SENT, JOB_DONE, EXIT <code>.
// Env: T09_REDIS_URL, T09_QUEUE, T09_STREAM, T09_JOB_MS.
import { writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')
const out = (s: string) => writeSync(1, `${s}\n`)
const imp = (rel: string) => import(pathToFileURL(resolve(ROOT, rel)).href)

process.on('exit', (code) => out(`EXIT ${code}`))

const url = process.env.T09_REDIS_URL!
const queueName = process.env.T09_QUEUE!
const jobMs = Number(process.env.T09_JOB_MS ?? 1500)

const workerMod: any = await imp('apps/worker/src/index.ts')
const createRegistry = workerMod.createRegistry ?? (await imp('apps/worker/src/registry.ts')).createRegistry
const { defineQueue }: any = await imp('packages/core/src/index.ts')
const { bullConnection, redisConnection }: any = await imp('packages/node-kit/src/index.ts')

let started!: () => void
const jobStarted = new Promise<void>((r) => (started = r))

const registry = createRegistry()
registry.worker(
  queueName,
  async () => {
    out('JOB_START')
    started()
    await new Promise((r) => setTimeout(r, jobMs))
    out('JOB_DONE')
    return 'ok'
  },
  { connection: bullConnection({ url }) },
)

await workerMod.startWorker({
  registry,
  redis: redisConnection({ url }),
  consumer: { stream: process.env.T09_STREAM, blockMs: 100 },
})
out('READY')

const q = defineQueue(queueName, { connection: bullConnection({ url }) })
await q.add('lento', { at: Date.now() })
await jobStarted
out('SIGTERM_SENT')
process.emit('SIGTERM')
// se o boot não sair sozinho, o pai detecta pelo timeout / ausência de EXIT 0
