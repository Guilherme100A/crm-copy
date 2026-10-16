// T126: roda antes de CADA arquivo de teste (setupFiles do vitest.config.ts): prefixo de fila BullMQ próprio do arquivo,
// para um worker de um arquivo nunca consumir job de outro da mesma execução. Regras em docs/testing.md.
import { expect } from 'vitest'
import { isolateTestQueues } from '@crm/db/testing'

isolateTestQueues(expect.getState().testPath)
