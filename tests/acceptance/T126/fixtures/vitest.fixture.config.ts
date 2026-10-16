// Config das fixtures do AC-T126-01: herda a config REAL de packages/core (setupFiles com o prefixo por arquivo,
// env da execução) e só troca onde procurar os testes. Os dois arquivos rodam em paralelo, cada um no seu processo.
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig } from 'vitest/config'
import core from '../../../../packages/core/vitest.config'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))

export default mergeConfig(
  core,
  defineConfig({
    root: ROOT,
    test: {
      include: ['tests/acceptance/T126/fixtures/*.fixture.ts'],
      fileParallelism: true,
      maxWorkers: 2,
      testTimeout: 120_000,
    },
  }),
)
