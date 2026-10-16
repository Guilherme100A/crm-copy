// Testes unitários junto do código (SPEC 3.10): *.unit.test.ts e *.db.unit.test.ts.
// O antiban roda em passthrough por configuração EXPLÍCITA; produção nunca decide o modo por NODE_ENV.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.{ts,tsx}'],
    environment: 'node',
    env: { ANTIBAN_MODE: 'passthrough' },
    // Máquina compartilhada por vários worktrees (T118): folga para builds/bancos concorrentes.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
