// GET /api/app-config (T97; T108 acrescenta campos): configuração do app em tempo de execução para a SPA, lida do
// ambiente a cada request (o build da web não muda com o env do servidor). Autenticada (não está em PUBLIC_API_ROUTES).
import { Hono } from 'hono'
import { affiliateConfig, type AppConfigDto } from '@crm/core'
import type { AppDeps, AppEnv } from '../../lib/types'

declare module '../../lib/types' {
  interface AppDeps {
    /** Ambiente lido por `GET /api/app-config`. Default `process.env` (lido a cada request). */
    appConfigEnv?: Record<string, string | undefined>
  }
}

export function appConfig(env: Record<string, string | undefined>): AppConfigDto {
  return { ...affiliateConfig(env) }
}

export function appConfigRoutes(deps: Pick<AppDeps, 'appConfigEnv'>) {
  return new Hono<AppEnv>().get('/api/app-config', (c) => c.json(appConfig(deps.appConfigEnv ?? process.env), 200))
}
