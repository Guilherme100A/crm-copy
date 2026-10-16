// Arquivo de fixture A do AC-T126-01 (fora do include da aceitação; só roda pelo teste do AC).
import { it } from 'vitest'
import { runProbe } from './probe'

it('sonda T126 arquivo A', async () => {
  await runProbe('A')
}, 120_000)
