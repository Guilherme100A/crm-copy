// Config Playwright da suíte de aceitação (propriedade dos Testers, SPEC 3.10, T23 e T118).
// Uso (a partir da raiz): pnpm exec playwright test --config tests/acceptance/playwright.config.ts tests/acceptance/Txx
// Sobe o harness da T17 (API com fakes + web via `vite preview` com proxy de /api e /__e2e).
// T118: portas derivadas do caminho do worktree (scripts/e2e/ports.mjs, sobrescrevíveis por E2E_WEB_PORT/E2E_API_PORT)
// e reaproveitamento do servidor só quando ele é deste worktree (test-results/e2e-server.json + pid vivo).
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'
// @ts-expect-error módulo .mjs sem tipos (scripts/e2e, T118)
import { e2ePorts, isOwnServerRunning } from '../../scripts/e2e/ports.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ports: { api: number; web: number } = e2ePorts(ROOT)
export const E2E_WEB_PORT = ports.web
export const E2E_API_PORT = ports.api
const baseURL = `http://127.0.0.1:${E2E_WEB_PORT}`

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  // Um só harness e um seed compartilhado (reset entre testes): execução em série.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Máquina compartilhada por vários pares: folga nos tempos (T118).
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  outputDir: `${ROOT}test-results/playwright`,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } },
    // revisão 2 (SPEC 3.11): no verify, o mobile roda só os ACs de layout da tarefa (E2E_MOBILE_GREP vem de tasks.mjs `mobile`)
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      ...(process.env.E2E_MOBILE_GREP ? { grep: new RegExp(process.env.E2E_MOBILE_GREP) } : {}),
    },
  ],
  webServer: {
    command: 'node scripts/e2e/serve.mjs',
    cwd: ROOT,
    url: baseURL,
    wait: { stdout: /E2E_READY/ },
    // Só reaproveita o servidor deste worktree; um servidor alheio na porta faz o harness falhar (porta ocupada).
    reuseExistingServer: Boolean(isOwnServerRunning(ROOT)),
    timeout: 600_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      E2E_WEB_PORT: String(E2E_WEB_PORT),
      E2E_API_PORT: String(E2E_API_PORT),
      APP_NAME: 'CRM',
      ANTIBAN_MODE: 'passthrough',
    },
  },
})
