// Config Playwright da suíte de aceitação (propriedade dos Testers, SPEC 3.10 e T23).
// Uso (a partir da raiz): pnpm exec playwright test --config tests/acceptance/playwright.config.ts tests/acceptance/Txx
// Sobe o harness da T17 (API com fakes + web via `vite preview` com proxy de /api e /__e2e) em portas fixas.
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
export const E2E_WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4317)
export const E2E_API_PORT = Number(process.env.E2E_API_PORT ?? 4318)
const baseURL = `http://127.0.0.1:${E2E_WEB_PORT}`

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  // Um só harness e um seed compartilhado (reset entre testes): execução em série.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: `${ROOT}test-results`,
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } } },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: {
    command: 'node scripts/e2e/serve.mjs',
    cwd: ROOT,
    url: baseURL,
    wait: { stdout: /E2E_READY/ },
    reuseExistingServer: !process.env.CI,
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
