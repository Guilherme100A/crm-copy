// T126 (AC-T126-01): arquivo a da sonda de isolamento. Roda junto com o arquivo do par na mesma execução, na MESMA
// fila (`isolation-probe`): cada um tem o seu prefixo (setupFiles) e o worker de um nunca consome job do outro.
import { describe, expect, it } from 'vitest'
import { runQueueIsolationProbe } from '../test-setup-queue-probe'

describe('AC-T126-01 prefixo de fila por arquivo (a)', () => {
  it('prefixo próprio do arquivo e só jobs do próprio arquivo no worker', async () => {
    const prefix = process.env.CRM_QUEUE_PREFIX ?? ''
    const r = await runQueueIsolationProbe('file-a', { count: 20, lingerMs: 3000 })
    // primeiro o isolamento (com prefixo dividido, chegam jobs do outro arquivo), depois o formato
    expect(new Set(r.seen)).toEqual(new Set(['file-a']))
    expect(r.seen).toHaveLength(20)
    expect(r.prefix).toBe(prefix)
    expect(prefix).toMatch(/^crm-t-.+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
    expect(process.env.WA_QUEUE_PREFIX).toMatch(/^wsm-t-.+-f[0-9a-f]{8}-[0-9a-f]{4}$/)
  }, 60_000)
})
