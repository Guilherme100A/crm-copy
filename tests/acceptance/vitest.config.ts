// Config compartilhada da suíte de aceitação (propriedade dos Testers, SPEC 3.10).
// Uso (a partir da raiz): pnpm exec vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/T00
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).split('\\').join('/')

const PACKAGES = 'shared|db|node-kit|wa-port|wa-engine|wa-gateway-rpc|ai|core'
const APPS = 'api|worker|wa-worker|web'

// T121: prefixo das filas BullMQ único por EXECUÇÃO. Vários worktrees testam no mesmo Redis (db 1); com o prefixo
// fixo, workers de uma execução consumiriam jobs de outra. Calculado uma vez no carregamento desta config.
const RUN_ID = `${process.pid}-${randomBytes(4).toString('hex')}`

export default defineConfig({
  root: ROOT,
  resolve: {
    // A raiz não depende dos workspaces: os testes importam os pacotes pelo nome (@crm/...)
    // e o alias aponta para o fonte (mesma resolução da condição `development`, SPEC 3.1).
    // Subpaths (`@crm/wa-port/testing`, `@crm/db/wa`): plugin crm-subpath-exports abaixo.
    alias: [
      { find: new RegExp(`^@crm/(${PACKAGES})$`), replacement: `${ROOT}packages/$1/src/index.ts` },
      { find: new RegExp(`^@crm/(${APPS})$`), replacement: `${ROOT}apps/$1/src/index.ts` },
    ],
  },
  // Subpaths seguem o alvo `development` do `exports` do pacote (ex.: `./wa` → src/schema/wa/tables/index.ts);
  // sem entrada em `exports`, cai na convenção packages/<nome>/src/<subpath>(.ts | /index.ts).
  plugins: [
    {
      name: 'crm-subpath-exports',
      enforce: 'pre',
      resolveId(source: string) {
        const m = new RegExp(`^@crm/(${PACKAGES})/(.+)$`).exec(source)
        if (!m) return null
        const dir = `${ROOT}packages/${m[1]}/`
        try {
          const entry = JSON.parse(readFileSync(`${dir}package.json`, 'utf8')).exports?.[`./${m[2]}`]
          const pick = (e: any): string | undefined =>
            typeof e === 'string' ? e : e ? (pick(e.development) ?? pick(e.import) ?? pick(e.default)) : undefined
          const target = pick(entry)?.replace(/^\.\//, '')
          if (target && existsSync(`${dir}${target}`)) return `${dir}${target}`
        } catch {
          /* package.json ilegível: usa a convenção */
        }
        for (const f of [`src/${m[2]}.ts`, `src/${m[2]}/index.ts`]) if (existsSync(`${dir}${f}`)) return `${dir}${f}`
        return null
      },
    },
  ],
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
      CRM_QUEUE_PREFIX: `crm-t-${RUN_ID}`,
      WA_QUEUE_PREFIX: `wsm-t-${RUN_ID}`,
    },
  },
})
