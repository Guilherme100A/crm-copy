// Reexporta o servidor Node para o `scripts/e2e/api.ts`: a raiz do monorepo não depende de @hono/node-server,
// então o script importa por aqui (resolvido a partir de apps/api).
export { serve } from '@hono/node-server'
