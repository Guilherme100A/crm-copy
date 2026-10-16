// Configuração da API (SPEC 3.12), validada com zod sobre `process.env`.
import { z } from 'zod'
import { loadConfig, parseCredentialsKey, type Env } from '@crm/node-kit'

export const apiConfigSchema = z.object({
  APP_NAME: z.string().default('CRM'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  CREDENTIALS_KEY: z.string().refine(
    (v) => {
      try {
        parseCredentialsKey(v)
        return true
      } catch {
        return false
      }
    },
    { message: 'deve ter 32 bytes em base64' },
  ),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).default(30),
  API_PUBLIC_URL: z.url().default('http://localhost:3000'),
  WEB_PUBLIC_URL: z.url().default('http://localhost:5173'),
  /** Confia em `X-Forwarded-For` (só atrás de proxy reverso). */
  TRUST_PROXY: z.stringbool().default(false),
})

export type ApiConfig = z.output<typeof apiConfigSchema>

export function loadApiConfig(env: Env = process.env): ApiConfig {
  return loadConfig(apiConfigSchema, env)
}
