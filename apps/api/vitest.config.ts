// Testes unitários junto do código (SPEC 3.10): *.unit.test.ts e *.db.unit.test.ts.
// O antiban roda em passthrough por configuração EXPLÍCITA; produção nunca decide o modo por NODE_ENV.
import { defineConfig } from 'vitest/config'

/** Identifica esta execução de testes (pid + aleatório), calculado ao carregar a config. */
const RUN_ID = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`

export default defineConfig({
  test: {
    // scripts/e2e (harness, T118) não tem package próprio: os testes dele rodam aqui.
    include: ['src/**/*.unit.test.{ts,tsx}', '../../scripts/e2e/**/*.unit.test.mjs'],
    environment: 'node',
    // T121: filas BullMQ com prefixo único por execução (todos os worktrees usam o mesmo Redis db). Produção: crm / wsm.
    env: { ANTIBAN_MODE: 'passthrough', CRM_QUEUE_PREFIX: `crm-t-${RUN_ID}`, WA_QUEUE_PREFIX: `wsm-t-${RUN_ID}` },
    // Máquina compartilhada por vários worktrees (T118): folga para builds/bancos concorrentes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
