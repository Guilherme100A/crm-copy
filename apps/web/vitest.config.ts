// Testes unitários junto do código (SPEC 3.10): *.unit.test.ts e *.db.unit.test.ts.
// O antiban roda em passthrough por configuração EXPLÍCITA; produção nunca decide o modo por NODE_ENV.
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    conditions: ['development'],
  },
  define: { __APP_NAME__: JSON.stringify('CRM') },
  test: {
    include: ['src/**/*.unit.test.{ts,tsx}'],
    environment: 'node',
    env: { ANTIBAN_MODE: 'passthrough' },
  },
})
