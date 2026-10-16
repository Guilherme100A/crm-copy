// Definição executável das tarefas da SPEC.md (seções 4 e 5).
// Os critérios de aceitação (AC-Txx-nn) NÃO ficam aqui: são lidos da SPEC.md.

export const WORKSPACES = {
  api: '@wsm/api',
  worker: '@wsm/worker',
  dashboard: '@wsm/dashboard',
  core: '@wsm/core',
  db: '@wsm/db',
}

// Arquivos que qualquer tarefa pode alterar (somente de forma aditiva, ver SPEC 2.4).
export const SHARED_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'docker-compose.yml',
  '.env.example',
  'docs/**',
  'apps/*/package.json',
  'packages/*/package.json',
  'apps/api/src/app.ts',
  'apps/api/src/routes/index.ts',
  'apps/worker/src/index.ts',
  'packages/core/src/index.ts',
  'packages/db/src/schema/**',
  'packages/db/drizzle/**',
]

// Nunca contam como alteração de escopo.
export const IGNORED_PATHS = ['spec/reports/**', 'spec/STATUS.md', '**/node_modules/**', '**/dist/**']

const std = (...ws) => ws.flatMap((w) => [
  `pnpm --filter ${WORKSPACES[w]} typecheck`,
  `pnpm --filter ${WORKSPACES[w]} lint`,
  `pnpm --filter ${WORKSPACES[w]} test`,
])

export const TASKS = [
  {
    id: 'T00', title: 'Scaffold do monorepo e infraestrutura', wave: 0, deps: [],
    paths: ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig*.json', 'eslint.config.*', '.prettierrc',
      '.gitignore', '.env.example', 'docker-compose.yml', 'vitest.workspace.ts',
      'apps/*/package.json', 'apps/*/tsconfig.json', 'apps/*/src/index.ts*', 'apps/*/Dockerfile', 'apps/dashboard/index.html', 'apps/dashboard/vite.config.ts',
      'packages/*/package.json', 'packages/*/tsconfig.json', 'packages/*/src/index.ts'],
    requiredFiles: ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.env.example', 'docker-compose.yml',
      'apps/api/package.json', 'apps/worker/package.json', 'apps/dashboard/package.json',
      'packages/core/package.json', 'packages/db/package.json'],
    testerRequiredFiles: ['tests/acceptance/vitest.config.ts'],
    commands: ['pnpm install', 'pnpm -r build', 'pnpm -r typecheck', 'docker compose config -q'],
    infra: false,
  },
  {
    id: 'T01', title: 'Schema do banco (Drizzle)', wave: 1, deps: ['T00'],
    paths: ['packages/db/**'],
    requiredFiles: ['packages/db/src/schema/index.ts', 'packages/db/drizzle.config.ts'],
    commands: [...std('db')],
    infra: true,
  },
  {
    id: 'T03', title: 'Esqueleto da API (Hono)', wave: 1, deps: ['T00'],
    paths: ['apps/api/**'],
    requiredFiles: ['apps/api/src/app.ts'],
    commands: [...std('api')],
    infra: true,
  },
  {
    id: 'T04', title: 'Abstração de transporte (Baileys + Fake)', wave: 1, deps: ['T00'],
    paths: ['packages/core/src/transport/**'],
    requiredFiles: ['packages/core/src/transport/types.ts', 'packages/core/src/transport/baileys.ts', 'packages/core/src/transport/fake.ts'],
    commands: [...std('core')],
    infra: false,
  },
  {
    id: 'T02', title: 'Criptografia de credenciais e auth state', wave: 2, deps: ['T01', 'T04'],
    paths: ['packages/core/src/crypto/**', 'packages/core/src/auth-state/**', 'packages/core/src/logger/**'],
    requiredFiles: ['packages/core/src/crypto/index.ts', 'packages/core/src/auth-state/index.ts'],
    commands: [...std('core')],
    infra: true,
  },
  {
    id: 'T06', title: 'Gerenciamento de proxies', wave: 2, deps: ['T01', 'T03'],
    paths: ['packages/core/src/proxy/**', 'apps/api/src/routes/proxies*', 'apps/worker/src/proxy/**'],
    requiredFiles: ['packages/core/src/proxy/index.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T07', title: 'Contatos e consentimento', wave: 2, deps: ['T01', 'T03'],
    paths: ['packages/core/src/contacts/**', 'apps/api/src/routes/contacts*', 'apps/worker/src/optout/**'],
    requiredFiles: ['packages/core/src/contacts/index.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T05', title: 'Session Manager', wave: 3, deps: ['T02', 'T03', 'T04', 'T06'],
    paths: ['packages/core/src/session/**', 'apps/worker/src/sessions/**', 'apps/api/src/routes/sessions*'],
    requiredFiles: ['packages/core/src/session/states.ts', 'apps/worker/src/sessions/manager.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T08', title: 'Fila de mensagens por sessão', wave: 4, deps: ['T05', 'T07'],
    paths: ['packages/core/src/queue/**', 'packages/core/src/send/deliver.ts', 'apps/worker/src/queue/**', 'apps/api/src/routes/messages*'],
    requiredFiles: ['packages/core/src/queue/index.ts', 'packages/core/src/send/deliver.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T10', title: 'Warm-up e Health Monitor', wave: 4, deps: ['T05'],
    paths: ['packages/core/src/warmup/**', 'packages/core/src/health/**', 'apps/worker/src/health/**', 'apps/api/src/routes/health-session*'],
    requiredFiles: ['packages/core/src/health/score.ts', 'packages/core/src/warmup/index.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T09', title: 'Motor de segurança (pipeline de envio)', wave: 5, deps: ['T07', 'T08', 'T10'],
    paths: ['packages/core/src/send/**', 'packages/core/src/safety/**', 'packages/core/src/antiban/**', 'apps/api/src/routes/messages*'],
    requiredFiles: ['packages/core/src/send/pipeline.ts', 'packages/core/src/antiban/adapter.ts'],
    commands: [...std('core', 'api')],
    infra: true,
  },
  {
    id: 'T11', title: 'Alertas', wave: 5, deps: ['T10', 'T06'],
    paths: ['packages/core/src/alerts/**', 'apps/worker/src/alerts/**', 'apps/api/src/routes/webhooks*'],
    requiredFiles: ['packages/core/src/alerts/index.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T14', title: 'Grupos', wave: 5, deps: ['T05'],
    paths: ['packages/core/src/groups/**', 'apps/api/src/routes/groups*'],
    requiredFiles: ['packages/core/src/groups/index.ts'],
    commands: [...std('core', 'api')],
    infra: true,
  },
  {
    id: 'T13', title: 'IA assistiva', wave: 6, deps: ['T09'],
    paths: ['packages/core/src/ai/**', 'apps/worker/src/ai/**', 'apps/api/src/routes/suggestions*'],
    requiredFiles: ['packages/core/src/ai/router.ts'],
    commands: [...std('core', 'api', 'worker')],
    infra: true,
  },
  {
    id: 'T15', title: 'Observabilidade', wave: 6, deps: ['T08', 'T10'],
    paths: ['packages/core/src/observability/**', 'apps/*/src/observability/**', 'docker-compose.yml'],
    requiredFiles: ['packages/core/src/observability/metrics.ts'],
    commands: [...std('core', 'api', 'worker'), 'docker compose config -q'],
    infra: true,
  },
  {
    id: 'T12', title: 'Dashboard', wave: 6, deps: ['T05', 'T06', 'T07', 'T08', 'T10', 'T11', 'T14'],
    paths: ['apps/dashboard/**'],
    requiredFiles: ['apps/dashboard/src/main.tsx'],
    commands: [...std('dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: false,
  },
  {
    id: 'T16', title: 'Integração E2E', wave: 7, deps: ['T00', 'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08', 'T09', 'T10', 'T11', 'T12', 'T13', 'T14', 'T15'],
    paths: ['docker-compose.yml', 'apps/*/Dockerfile', 'apps/**'],
    requiredFiles: ['docker-compose.yml'],
    commands: ['pnpm -r typecheck', 'pnpm -r lint', 'pnpm -r test', 'pnpm -r build', 'docker compose config -q'],
    infra: 'full',
  },
  {
    id: 'T17', title: 'Login admin e proxy na sessão (API)', wave: 8, deps: ['T03', 'T05', 'T06'],
    paths: ['apps/api/src/auth/**', 'apps/api/src/middleware/auth*', 'apps/api/src/routes/auth*', 'apps/api/src/routes/sessions*', 'apps/api/src/config.ts', 'packages/core/src/proxy/**', 'packages/core/src/session/**', '.env.example', 'docs/auth.md'],
    requiredFiles: ['apps/api/src/routes/auth.ts'],
    commands: [...std('core', 'api')],
    infra: true,
  },
  {
    id: 'T18', title: 'Dashboard: login admin e proxy no cadastro', wave: 8, deps: ['T17', 'T12'],
    paths: ['apps/dashboard/**'],
    requiredFiles: ['apps/dashboard/src/main.tsx'],
    commands: [...std('dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: false,
  },
  {
    id: 'T19', title: 'Configurações do modelo de LLM', wave: 8, deps: ['T13', 'T12'],
    paths: ['packages/core/src/ai/**', 'apps/worker/src/ai/**', 'apps/worker/src/boot/**', 'apps/api/src/routes/ai-settings*', 'packages/db/src/schema/**', 'packages/db/drizzle/**', 'apps/dashboard/src/**', '.env.example', 'docs/ai.md'],
    requiredFiles: ['apps/api/src/routes/ai-settings.ts'],
    commands: [...std('core', 'api', 'worker', 'dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: true,
  },
  {
    id: 'T20', title: 'Adicionar número a grupo (manual)', wave: 8, deps: ['T14', 'T16', 'T18'],
    paths: ['packages/core/src/transport/**', 'packages/core/src/groups/**', 'apps/api/src/routes/groups*', 'apps/api/src/bridge/**', 'apps/worker/src/boot/**', 'apps/dashboard/src/**', 'docs/groups.md'],
    requiredFiles: ['packages/core/src/groups/index.ts'],
    commands: [...std('core', 'api', 'worker', 'dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: true,
  },
  {
    id: 'T21', title: 'Redesign do dashboard', wave: 8, deps: ['T12', 'T18', 'T19'],
    paths: ['apps/dashboard/**', 'docs/dashboard-design.md'],
    requiredFiles: ['apps/dashboard/src/main.tsx'],
    commands: [...std('dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: false,
  },
  {
    id: 'T22', title: 'Chip pessoal / conexão direta', wave: 8, deps: ['T21', 'T18'],
    paths: ['apps/dashboard/**'],
    requiredFiles: ['apps/dashboard/src/main.tsx'],
    commands: [...std('dashboard'), 'pnpm --filter @wsm/dashboard build'],
    infra: false,
  },
]

// Regras proibidas — aplicadas em TODO --role operario (SPEC 1.4).
const PRODUCT = ['apps/**', 'packages/**']
const NOT_TESTS = ['**/*.test.ts', '**/*.test.tsx', '**/node_modules/**', '**/dist/**']

export const FORBIDDEN = [
  {
    id: 'F-SEND-CHOKEPOINT',
    regex: /\.sendMessage\s*\(/,
    include: PRODUCT, exclude: [...NOT_TESTS, 'packages/core/src/send/**', 'packages/core/src/transport/**'],
    exts: ['.ts', '.tsx'],
    message: 'sendMessage só pode ser chamado em packages/core/src/send/ (SPEC 1.4 #2, AC-T09-04)',
  },
  {
    id: 'F-NO-GROUP-JOIN',
    regex: /groupAcceptInvite/,
    include: PRODUCT, exclude: NOT_TESTS, exts: ['.ts', '.tsx'],
    message: 'Entrada automática em grupos é proibida (SPEC 1.4 #5, AC-T14-03)',
  },
  {
    id: 'F-NO-BAN-CLAIM',
    regex: /(imune\s+a\s+ban|immune\s+to\s+ban|seguro\s+contra\s+(o\s+)?ban|ban[\s-]?proof|[àa]\s+prova\s+de\s+ban|anti-?ban\s+garantido|nunca\s+(ser[áa]\s+)?banid|never\s+(get\s+)?banned)/i,
    include: PRODUCT, exclude: NOT_TESTS, exts: ['.ts', '.tsx', '.md', '.json', '.html'],
    message: 'Não prometer imunidade a ban (SPEC 1.4 #6, AC-T10-05)',
  },
  {
    id: 'F-NO-FILE-AUTH',
    regex: /useMultiFileAuthState/,
    include: PRODUCT, exclude: NOT_TESTS, exts: ['.ts', '.tsx'],
    message: 'useMultiFileAuthState grava credenciais em texto puro; use usePostgresAuthState (SPEC 1.4 #1)',
  },
  {
    id: 'F-NO-CONSOLE',
    regex: /console\.(log|debug|info)\s*\(/,
    include: ['apps/api/src/**', 'apps/worker/src/**', 'packages/core/src/**', 'packages/db/src/**'], exclude: NOT_TESTS,
    exts: ['.ts'],
    message: 'Use o logger estruturado (pino) em vez de console.*',
  },
]

// Regras aplicadas em TODO --role tester.
export const TESTER_FORBIDDEN = [
  {
    id: 'F-TEST-NO-REAL-WA',
    regex: /from\s+['"](@whiskeysockets\/baileys|baileys)['"]|require\(\s*['"](@whiskeysockets\/baileys|baileys)['"]\s*\)/,
    include: ['tests/**'], exclude: ['**/node_modules/**'], exts: ['.ts', '.tsx'],
    message: 'Testes não podem importar Baileys diretamente; use o FakeTransport (AC-T04-04)',
  },
  {
    id: 'F-TEST-NO-SKIP',
    regex: /\b(it|test|describe)\.(skip|todo|only)\s*\(/,
    include: ['tests/acceptance/**'], exclude: ['**/node_modules/**'], exts: ['.ts', '.tsx'],
    message: 'Testes de aceitação não podem usar .skip/.todo/.only',
  },
]
