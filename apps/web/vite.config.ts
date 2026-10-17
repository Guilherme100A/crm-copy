// Vite 8 (Rolldown) + TanStack Router (rotas por arquivo) + Tailwind 4 + React (STACK Bloco D).
// A SPA fala com a API na mesma origem: em dev e no preview, `/api` e `/__e2e` vão por proxy para a API
// (`E2E_API_URL` no harness da T17; `VITE_API_URL` em dev; padrão http://127.0.0.1:3000). SSE passa pelo proxy.
//
// Embutido no painel do ai-manager (opcional; sem as envs nada muda):
// - `VITE_BASE_PATH=/crm/`: a SPA e os assets saem em `/crm/` (Vite `base`; o router usa a mesma base).
// - `VITE_API_BASE=/crm/api`: a SPA chama a API em `/crm/api/*`; aqui o proxy tira o prefixo e repassa como `/api/*`
//   (o mesmo que o proxy do ai-manager faz em produção).
// - `CRM_UI_SKIN=ai-manager`: o visual do painel do ai-manager mesmo fora do iframe.
// - `CRM_WEB_PORT`: porta do dev/preview (padrão 5274 quando `VITE_BASE_PATH` está definido; senão a do Vite).
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

const appName = process.env.APP_NAME || 'CRM'
// Visual do painel do ai-manager também fora do iframe (`CRM_UI_SKIN=ai-manager`); vazio = o de sempre (embutido, sempre ai-manager).
const uiSkin = process.env.CRM_UI_SKIN?.trim() || ''
const apiTarget = process.env.E2E_API_URL || process.env.VITE_API_URL || 'http://127.0.0.1:3000'

/** `/crm` → `/crm/`; vazio → `/`. */
function normalizeBase(raw: string | undefined): string {
  const v = raw?.trim()
  if (!v || v === '/') return '/'
  return `/${v.replace(/^\/+|\/+$/g, '')}/`
}

const base = normalizeBase(process.env.VITE_BASE_PATH)
const apiBase = (process.env.VITE_API_BASE?.trim() || '/api').replace(/\/+$/, '') || '/api'
const portEnv = process.env.CRM_WEB_PORT?.trim()
const port = portEnv ? Number(portEnv) : base !== '/' ? 5274 : undefined

const proxy: Record<string, ProxyOptions> = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/__e2e': { target: apiTarget, changeOrigin: true },
}
if (apiBase !== '/api') {
  // `/crm/api/x` → `/api/x` na API do CRM.
  proxy[apiBase] = { target: apiTarget, changeOrigin: true, rewrite: (p) => `/api${p.slice(apiBase.length)}` }
}

export default defineConfig({
  base,
  // O plugin do router vem antes do react() (STACK D §2).
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single', semicolons: false }),
    tailwindcss(),
    react(),
    { name: 'crm-app-name', transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', appName).replaceAll('%CRM_UI_SKIN%', uiSkin) },
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Consome o código-fonte dos pacotes @crm/* (exports com condição `development`), como o ai-manager.
    conditions: ['development'],
  },
  // Nome exibido do produto (SPEC 1.4 nº 9): vem de APP_NAME no build.
  define: { __APP_NAME__: JSON.stringify(appName) },
  server: { proxy, ...(port ? { port } : {}) },
  preview: { proxy, ...(port ? { port } : {}) },
})
