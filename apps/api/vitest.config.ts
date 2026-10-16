// Testes unitários junto do código (SPEC 3.10): *.unit.test.ts e *.db.unit.test.ts.
// O antiban roda em passthrough por configuração EXPLÍCITA; produção nunca decide o modo por NODE_ENV.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // scripts/e2e (harness, T118) não tem package próprio: os testes dele rodam aqui.
    include: ['src/**/*.unit.test.{ts,tsx}', '../../scripts/e2e/**/*.unit.test.mjs'],
    environment: 'node',
    env: { ANTIBAN_MODE: 'passthrough' },
    // Máquina compartilhada por vários worktrees (T118): folga para builds/bancos concorrentes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
