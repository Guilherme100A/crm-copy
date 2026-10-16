// Contratos da SPEC usados pelos testes de T00 (seções 3.1, 3.12 e tarefa T00).
export const WORKSPACES = [
  { name: '@crm/api', dir: 'apps/api' },
  { name: '@crm/worker', dir: 'apps/worker' },
  { name: '@crm/wa-worker', dir: 'apps/wa-worker' },
  { name: '@crm/web', dir: 'apps/web' },
  { name: '@crm/shared', dir: 'packages/shared' },
  { name: '@crm/db', dir: 'packages/db' },
  { name: '@crm/node-kit', dir: 'packages/node-kit' },
  { name: '@crm/wa-port', dir: 'packages/wa-port' },
  { name: '@crm/wa-engine', dir: 'packages/wa-engine' },
  { name: '@crm/wa-gateway-rpc', dir: 'packages/wa-gateway-rpc' },
  { name: '@crm/ai', dir: 'packages/ai' },
  { name: '@crm/core', dir: 'packages/core' },
] as const

export const REQUIRED_SCRIPTS = ['build', 'typecheck', 'lint', 'test'] as const

/** SPEC 3.12 — mínimo do `.env.example`. */
export const ENV_VARS = [
  'APP_NAME', 'NODE_ENV', 'LOG_LEVEL', 'DATABASE_URL', 'REDIS_URL', 'CREDENTIALS_KEY', 'AUTH_SESSION_TTL_DAYS',
  'API_PUBLIC_URL', 'WEB_PUBLIC_URL', 'STORAGE_DIR', 'MAIL_TRANSPORT', 'SMTP_URL', 'MAIL_FROM', 'WA_GATEWAY',
  'WA_RPC_URL', 'WA_RPC_PROFILE', 'INTERNAL_TOKEN', 'WA_TRANSPORT', 'ANTIBAN_MODE', 'ANTIBAN_PRESET',
  'WA_EVENTS_STREAM', 'AI_MODE', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY',
  'GROQ_API_KEY', 'FFMPEG_PATH', 'META_GRAPH_URL', 'META_APP_ID', 'META_APP_SECRET', 'AFFILIATE_PORTAL_URL',
  'PLATFORM_ADMIN_EMAIL', 'PLATFORM_ADMIN_PASSWORD', 'E2E',
] as const

/** Variáveis que guardam segredo: em `.env.example` só vazias ou placeholder. */
export const SECRET_VARS = [
  'CREDENTIALS_KEY', 'INTERNAL_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'ELEVENLABS_API_KEY',
  'GROQ_API_KEY', 'META_APP_SECRET', 'PLATFORM_ADMIN_PASSWORD',
] as const

/** Imports proibidos em packages/core (SPEC 1.4 nº 11) exigidos pelo AC-T00-04. */
export const FORBIDDEN_IN_CORE = ['@whiskeysockets/baileys', '@crm/wa-engine', 'openai'] as const

/**
 * Marca proibida (SPEC 1.4 nº 9), montada sem o literal para este arquivo não se acusar.
 * "palavra" = palavra isolada, mais as variantes coladas (…pay, …-ai). Não pega o nome
 * da pasta do projeto ("…s-crm"), que não é a marca.
 */
const B = ['le', 'ona'].join('')
export const BRAND_RE = new RegExp(`\\b${B}\\b|${B}pay|${B}[_-]?ai`, 'i')
