// Config compartilhada da suíte de aceitação (propriedade dos Testers, SPEC 3.10).
// Uso (a partir da raiz): pnpm exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/T00
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).split('\\').join('/')

const PACKAGES = 'shared|db|node-kit|wa-port|wa-engine|wa-gateway-rpc|ai|core'
const APPS = 'api|worker|wa-worker|web'

export default defineConfig({
  root: ROOT,
  resolve: {
    // A raiz não depende dos workspaces: os testes importam os pacotes pelo nome (@crm/...)
    // e o alias aponta para o fonte (mesma resolução da condição `development`, SPEC 3.1).
    // Subpaths (`@crm/wa-port/testing`, `@crm/db/testing`) → packages/<nome>/src/<subpath> sem extensão:
    // o Vite resolve `src/<subpath>.ts` ou `src/<subpath>/index.ts` (as duas formas existem nas tarefas).
    alias: [
      { find: new RegExp(`^@crm/(${PACKAGES})$`), replacement: `${ROOT}packages/$1/src/index.ts` },
      { find: new RegExp(`^@crm/(${PACKAGES})/(.+)$`), replacement: `${ROOT}packages/$1/src/$2` },
      { find: new RegExp(`^@crm/(${APPS})$`), replacement: `${ROOT}apps/$1/src/index.ts` },
    ],
  },
  test: {
    include: ['tests/acceptance/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    pool: 'forks',
    // Os testes rodam comandos pesados (pnpm install/build/lint) e compartilham infra
    // (Postgres/Redis, portas HTTP): arquivos em série evitam interferência.
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
    env: {
      // SPEC 3.10: modo explícito na config de teste (produção nunca decide por NODE_ENV).
      ANTIBAN_MODE: 'passthrough',
      WA_GATEWAY: 'fake',
      WA_TRANSPORT: 'fake',
      AI_MODE: 'fake',
      MAIL_TRANSPORT: 'memory',
      APP_NAME: 'CRM',
    },
  },
})
