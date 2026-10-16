// Arquivo de fixture B do AC-T126-01 (fora do include da aceitação; só roda pelo teste do AC).
import { it } from 'vitest'
import { runProbe } from './probe'

it('sonda T126 arquivo B', async () => {
  await runProbe('B')
}, 120_000)
