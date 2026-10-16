// Vite 8 (Rolldown) + TanStack Router (rotas por arquivo) + Tailwind 4 + React (STACK Bloco D).
// A SPA fala com a API na mesma origem: em dev e no preview, `/api` e `/__e2e` vão por proxy para a API
// (`E2E_API_URL` no harness da T17; `VITE_API_URL` em dev; padrão http://127.0.0.1:3000). SSE passa pelo proxy.
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appName = process.env.APP_NAME || 'CRM'
const apiTarget = process.env.E2E_API_URL || process.env.VITE_API_URL || 'http://127.0.0.1:3000'
const proxy = {
  '/api': { target: apiTarget, changeOrigin: true },
  '/__e2e': { target: apiTarget, changeOrigin: true },
}

export default defineConfig({
  // O plugin do router vem antes do react() (STACK D §2).
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single', semicolons: false }),
    tailwindcss(),
    react(),
    { name: 'crm-app-name', transformIndexHtml: (html) => html.replaceAll('%APP_NAME%', appName) },
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // Consome o código-fonte dos pacotes @crm/* (exports com condição `development`), como o ai-manager.
    conditions: ['development'],
  },
  // Nome exibido do produto (SPEC 1.4 nº 9): vem de APP_NAME no build.
  define: { __APP_NAME__: JSON.stringify(appName) },
  server: { proxy },
  preview: { proxy },
})
