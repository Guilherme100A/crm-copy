// Definição executável das tarefas da SPEC.md (seções 4 e 5).
// Os critérios de aceitação (AC-Txx-nn) NÃO ficam aqui: são lidos da SPEC.md.
// A onda de cada tarefa é CALCULADA a partir das dependências (caminho mais longo),
// respeitando `minWave` quando a tarefa é deliberadamente adiada.

export const WORKSPACES = {
  api: '@crm/api',
  worker: '@crm/worker',
  'wa-worker': '@crm/wa-worker',
  web: '@crm/web',
  shared: '@crm/shared',
  db: '@crm/db',
  'wa-port': '@crm/wa-port',
  'wa-engine': '@crm/wa-engine',
  'wa-gateway-rpc': '@crm/wa-gateway-rpc',
  ai: '@crm/ai',
  core: '@crm/core',
  'node-kit': '@crm/node-kit',
}

// Arquivos que qualquer tarefa pode alterar, SOMENTE de forma aditiva (SPEC 2.4).
export const SHARED_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  '.env.example',
  'docs/**',
  'apps/*/package.json',
  'packages/*/package.json',
  'packages/*/src/index.ts',
  'apps/*/src/index.ts',
  'apps/api/src/routes/index.ts',
  'apps/api/src/middleware/public-routes.ts',
  'packages/core/src/flows/nodes/index.ts', // registro dos grupos de nós: cada tarefa troca só a linha do seu grupo
  // Testes unitários de outras tarefas: ajuste MÍNIMO só quando a tarefa atual invalida legitimamente
  // uma suposição deles (ex.: rota que passou a existir); declarar no relatório (SPEC 2.4).
  'apps/**/*.unit.test.ts', 'packages/**/*.unit.test.ts',
  'apps/worker/src/registry.ts',
  'apps/web/src/routeTree.gen.ts',
  'apps/web/src/app/nav.ts',
  'apps/web/src/features/settings/tabs.ts',
  'apps/web/src/features/flow-editor/node-editors/registry.ts', // registro dos editores de nó (T56/T57): só acréscimo
  'apps/web/src/features/integrations/catalog.ts',
  'packages/db/src/schema/crm/index.ts',
  'packages/db/drizzle/crm/**',
  'packages/db/src/seed/modules/**',
  'packages/shared/src/permissions/catalog.ts',
  'packages/shared/src/permissions/defaults.ts', // matriz padrão por papel: só acréscimo de chaves novas
  'packages/shared/src/realtime/events.ts',
  'packages/shared/src/errors/codes.ts',
]

// Nunca contam como alteração de escopo.
export const IGNORED_PATHS = [
  'spec/reports/**',
  'spec/STATUS.md',
  'spec/verify/**', // só o Orquestrador altera; sincronizado nos worktrees ativos
  'spec/briefs/**', // fichas das tarefas: só o Orquestrador altera
  'spec/SPEC.md',
  '**/node_modules/**',
  '**/dist/**',
  'test-results/**',
  'playwright-report/**',
  '.turbo/**',
  'storage/**',
]

const std = (...ws) =>
  ws.flatMap((w) => {
    if (!WORKSPACES[w]) throw new Error(`workspace desconhecido em tasks.mjs: ${w}`)
    return [`pnpm --filter ${WORKSPACES[w]} typecheck`, `pnpm --filter ${WORKSPACES[w]} lint`, `pnpm --filter ${WORKSPACES[w]} test`]
  })
// i18n:check (criado no T23) falha se alguma chave faltar em pt-BR, en ou es.
const web = () => [...std('web'), 'pnpm --filter @crm/web i18n:check', 'pnpm --filter @crm/web build']

// Atalhos de paths por módulo.
const schema = (m) => `packages/db/src/schema/crm/${m}.ts`
const core = (m) => `packages/core/src/${m}/**`
const route = (m) => `apps/api/src/routes/${m}/**`
const job = (m) => `apps/worker/src/jobs/${m}/**`
const consumer = (m) => `apps/worker/src/consumers/${m}/**`
const i18n = (m) => `apps/web/src/i18n/*/${m}.json`
// O roteador por arquivo serve pela PASTA = URL (spec 18 §2): módulo → pasta de rota quando o nome difere da URL.
const ROUTE_DIR = { contacts: 'customers', chat: 'chats', agents: 'agentes', dashboard: 'welcome', 'mass-dispatch': 'mass-dispatches', 'settings-webhooks': 'settings/inbound-webhooks' }
// rotas avulsas na raiz (ex.: /login, /reset-password) de cada módulo
const ROUTE_FILES = { auth: ['apps/web/src/routes/login.tsx', 'apps/web/src/routes/register.tsx', 'apps/web/src/routes/reset-password.tsx', 'apps/web/src/routes/forgot-password.tsx', 'apps/web/src/routes/cadastro.tsx', 'apps/web/src/routes/invitations/**', 'apps/web/src/routes/invitation/**'] }
const ui = (m) => [`apps/web/src/routes/${ROUTE_DIR[m] ?? m}/**`, ...(ROUTE_FILES[m] ?? []), `apps/web/src/features/${m}/**`, i18n(m)]

/**
 * id, título, deps, paths, workspaces (comandos), opções:
 *  requiredFiles, infra (true = postgres+redis locais), e2e (Playwright no --role tester: desktop; mobile só nos ACs de `mobile`),
 *  minWave (adiamento deliberado), todo (aguardando spec; verify recusa).
 */
function T(id, title, deps, paths, ws, opts = {}) {
  return {
    id,
    title,
    deps,
    paths,
    commands: opts.commands ?? (ws.includes('web') ? [...std(...ws.filter((w) => w !== 'web')), ...web()] : std(...ws)),
    requiredFiles: opts.requiredFiles ?? [],
    testerRequiredFiles: opts.testerRequiredFiles,
    // testes de aceitação de OUTRAS tarefas que o Tester desta pode ajustar (só quando esta tarefa invalida uma suposição deles)
    testerPaths: opts.testerPaths,
    infra: opts.infra ?? true,
    e2e: opts.e2e ?? false,
    // revisão 2 (SPEC 3.11): E2E roda só no projeto desktop; os ACs listados aqui (layout/responsivo) rodam também no mobile
    mobile: opts.mobile ?? [],
    minWave: opts.minWave ?? 0,
    todo: opts.todo ?? false,
  }
}

const RAW = [
  // ---------------- Fundação ----------------
  T('T00', 'Scaffold do monorepo', [],
    ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'tsconfig*.json', 'eslint.config.*', '.prettierrc*', '.gitignore', '.gitattributes', '.npmrc', '.nvmrc',
      '.env.example', 'vitest.workspace.ts', 'apps/*/package.json', 'apps/*/tsconfig.json', 'apps/*/vitest.config.ts', 'apps/*/src/index.ts',
      'packages/*/package.json', 'packages/*/tsconfig.json', 'packages/*/vitest.config.ts', 'packages/*/src/index.ts', 'scripts/**', 'docs/README.md'],
    [], {
      commands: ['pnpm install', 'pnpm -r typecheck', 'pnpm -r lint', 'pnpm -r test', 'pnpm -r build'],
      requiredFiles: ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'eslint.config.mjs', '.env.example',
        'apps/api/package.json', 'apps/worker/package.json', 'apps/wa-worker/package.json', 'apps/web/package.json',
        'packages/shared/package.json', 'packages/db/package.json', 'packages/wa-port/package.json', 'packages/wa-engine/package.json',
        'packages/wa-gateway-rpc/package.json', 'packages/ai/package.json', 'packages/core/package.json', 'packages/node-kit/package.json'],
      testerRequiredFiles: ['tests/acceptance/vitest.config.ts'],
      infra: false,
    }),
  T('T01', '@crm/db: client, migrações e tabelas-base', ['T00'], ['packages/db/**'], ['db'],
    { requiredFiles: ['packages/db/src/client.ts', 'packages/db/src/testing.ts', 'packages/db/drizzle.crm.config.ts'] }),
  T('T02', '@crm/shared: contratos isomórficos', ['T00'], ['packages/shared/**'], ['shared'],
    { requiredFiles: ['packages/shared/src/errors/codes.ts', 'packages/shared/src/permissions/catalog.ts', 'packages/shared/src/realtime/events.ts'], infra: false }),
  T('T03', '@crm/wa-port: WaGateway, WaEvent, fake e suíte de contrato', ['T00'], ['packages/wa-port/**'], ['wa-port'],
    { requiredFiles: ['packages/wa-port/src/gateway.ts', 'packages/wa-port/src/events.ts', 'packages/wa-port/src/testing/fake-gateway.ts', 'packages/wa-port/src/contract/suite.ts'], infra: false }),
  T('T04', '@crm/ai: portas LLM/TTS/STT e fakes', ['T00'], ['packages/ai/src/port/**', 'packages/ai/src/testing/**'], ['ai'],
    { requiredFiles: ['packages/ai/src/port/llm.ts', 'packages/ai/src/port/voice.ts', 'packages/ai/src/testing/fake-llm.ts'], infra: false }),
  T('T05', '@crm/node-kit: logger, cripto, config, Redis/BullMQ, storage, e-mail', ['T00'], ['packages/node-kit/**'], ['node-kit'],
    { requiredFiles: ['packages/node-kit/src/logger.ts', 'packages/node-kit/src/crypto.ts', 'packages/node-kit/src/blob-store.ts', 'packages/node-kit/src/mailer.ts'] }),

  // ---------------- Engine WhatsApp (fork alinhado do ai-manager) ----------------
  T('T06', 'WA: schema public.* e auth state cifrado', ['T01', 'T05'],
    ['packages/db/src/schema/wa/**', 'packages/db/drizzle/wa/**', 'packages/db/drizzle.wa.config.ts', 'packages/wa-engine/src/auth-state/**', 'packages/wa-engine/src/db/**'],
    ['db', 'wa-engine'], { requiredFiles: ['packages/db/src/schema/wa/index.ts', 'packages/wa-engine/src/auth-state/index.ts'] }),
  T('T07', 'WA: transporte (interface, Fake e Baileys)', ['T03', 'T05'], ['packages/wa-engine/src/transport/**'], ['wa-engine'],
    { requiredFiles: ['packages/wa-engine/src/transport/types.ts', 'packages/wa-engine/src/transport/baileys.ts', 'packages/wa-engine/src/transport/fake.ts'], infra: false }),
  T('T13', 'WA: SessionManager e proxy', ['T06', 'T07'], ['packages/wa-engine/src/session/**', 'packages/wa-engine/src/proxy/**'], ['wa-engine'],
    { requiredFiles: ['packages/wa-engine/src/session/states.ts', 'packages/wa-engine/src/session/manager.ts'] }),
  T('T14', 'WA: fila por sessão, antiban, warm-up e limites', ['T06', 'T07'],
    ['packages/wa-engine/src/queue/**', 'packages/wa-engine/src/antiban/**', 'packages/wa-engine/src/warmup/**', 'packages/wa-engine/src/safety/**'], ['wa-engine'],
    { requiredFiles: ['packages/wa-engine/src/queue/queue.ts', 'packages/wa-engine/src/antiban/adapter.ts'] }),
  T('T20', 'WA: SendPipeline, deliver e health', ['T13', 'T14'], ['packages/wa-engine/src/send/**', 'packages/wa-engine/src/health/**'], ['wa-engine'],
    { requiredFiles: ['packages/wa-engine/src/send/pipeline.ts', 'packages/wa-engine/src/send/deliver.ts', 'packages/wa-engine/src/health/score.ts'] }),
  T('T21', 'WA: outbox de eventos, mídia e contatos', ['T13'], ['packages/wa-engine/src/events/**', 'packages/wa-engine/src/media/**', 'packages/wa-engine/src/contacts/**', 'packages/wa-port/src/**' /* aditivo: historical, clientMessageId, quoted, viewOnce, markRead */], ['wa-engine'],
    { requiredFiles: ['packages/wa-engine/src/events/outbox.ts', 'packages/wa-engine/src/media/index.ts'] }),
  T('T29', 'App wa-worker e RPC interno', ['T20', 'T21'], ['apps/wa-worker/**'], ['wa-worker'],
    { requiredFiles: ['apps/wa-worker/src/main.ts', 'apps/wa-worker/src/rpc/server.ts'] }),
  T('T46', '@crm/wa-gateway-rpc: adapter WaGateway por RPC + stream', ['T29'], ['packages/wa-gateway-rpc/**', 'apps/worker/src/main.ts', 'apps/worker/src/boot/**', 'apps/api/src/server.ts' /* aditivo: montagem de produção com WaGateway real */], ['wa-gateway-rpc'],
    { requiredFiles: ['packages/wa-gateway-rpc/src/gateway.ts', 'packages/wa-gateway-rpc/src/profiles.ts'] }),

  // ---------------- Plataforma (API, worker, auth, realtime, harness) ----------------
  T('T08', 'API: esqueleto, middlewares e contexto multiempresa', ['T01', 'T02', 'T05'],
    ['apps/api/src/app.ts', 'apps/api/src/server.ts', 'apps/api/src/config.ts', 'apps/api/src/middleware/**', 'apps/api/src/lib/**', 'apps/api/src/routes/health/**',
      core('platform'), schema('platform')], ['api', 'core'],
    { requiredFiles: ['apps/api/src/app.ts', 'apps/api/src/middleware/auth.ts', 'apps/api/src/middleware/company.ts', 'packages/core/src/platform/index.ts'] }),
  T('T09', 'Worker: esqueleto, consumidor do wsm:events e jobs', ['T01', 'T03', 'T05'],
    ['apps/worker/src/main.ts', 'apps/worker/src/boot/**', 'apps/worker/src/consumers/framework/**', core('jobs'), schema('jobs'),
      'packages/db/src/schema.unit.test.ts', 'packages/db/src/migrations.db.unit.test.ts' /* regressão: testes da T01 deixam de assumir contagem exata */], ['worker', 'core'],
    { requiredFiles: ['apps/worker/src/main.ts', 'apps/worker/src/consumers/framework/consumer.ts', 'packages/core/src/jobs/index.ts'] }),
  T('T15', 'Autenticação, cadastro, perfil e senha', ['T08'], [core('auth'), route('auth'), schema('auth')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/auth/index.ts', 'apps/api/src/routes/auth/index.ts'] }),
  T('T16', 'Realtime: SSE, fan-out e replay', ['T08'], [core('realtime'), 'apps/api/src/routes/events/**'], ['api', 'core'],
    { requiredFiles: ['packages/core/src/realtime/publisher.ts', 'apps/api/src/routes/events/index.ts'] }),
  T('T17', 'Harness E2E (API com fakes, seed, reset)', ['T08', 'T03', 'T04'],
    ['apps/api/src/e2e/**', 'packages/db/src/seed/index.ts', 'packages/db/src/seed/base.ts', 'scripts/e2e/**', 'eslint.config.mjs' /* corrige falso positivo do grupo AI (T00) */], ['api', 'db'],
    { requiredFiles: ['scripts/e2e/serve.mjs', 'apps/api/src/e2e/index.ts', 'packages/db/src/seed/base.ts'] }),
  T('T22', 'Empresas, equipe, convites e permissões', ['T15'],
    [core('companies'), core('team'), core('invitations'), route('companies'), route('team'), route('invitations'), schema('team')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/team/index.ts', 'apps/api/src/routes/team/index.ts'] }),
  T('T23', 'Web: shell, design system, i18n, guards e cliente HTTP', ['T15', 'T16', 'T17'], ['apps/web/**'], ['web'],
    { requiredFiles: ['apps/web/src/main.tsx', 'apps/web/src/app/nav.ts', 'apps/web/src/lib/http.ts', 'apps/web/src/lib/realtime.ts'],
      testerRequiredFiles: ['tests/acceptance/playwright.config.ts'], e2e: true }),

  // ---------------- Contas, equipe, configurações ----------------
  T('T31', 'Departamentos e horários de atendimento', ['T22'], [core('departments'), core('business-hours'), route('departments'), route('business-hours'), schema('departments'), 'packages/db/src/schema/crm/chats.ts' /* aditivo: FK chats.department_id */], ['api', 'core'],
    { requiredFiles: ['packages/core/src/business-hours/is-open.ts'] }),
  T('T32', 'Acesso de suporte', ['T22', 'T16'], [core('support-access'), route('support-access'), schema('support-access'), 'apps/api/src/middleware/company.ts', 'packages/core/src/platform/company-context.ts' /* aditivo: contexto de empresa por concessão de suporte (AC-T32-02) */, 'apps/api/src/routes/events/index.ts', 'packages/core/src/realtime/access.ts' /* aditivo: SSE do usuário support sem vínculo (AC-T32-03) */, 'packages/core/src/auth/auth-service.ts' /* aditivo: listCompanies inclui empresas concedidas */], ['api', 'core'],
    { requiredFiles: ['packages/core/src/support-access/index.ts'] }),
  T('T36', 'UI: autenticação, perfil e troca de empresa', ['T22', 'T23'], [...ui('auth'), ...ui('profile'), 'apps/web/src/features/company-switcher/**', i18n('company-switcher'), 'apps/web/src/app/guard.ts' /* aditivo: rotas públicas */, 'apps/web/src/app/shell/app-shell.tsx' /* troca CompanyBadge por CompanySwitcher */], ['web'],
    { requiredFiles: ['apps/web/src/routes/login.tsx'], e2e: true }),
  T('T53', 'UI: empresa, departamentos e horários', ['T31', 'T36'], [...ui('settings-company'), ...ui('settings-departments'), ...ui('settings-hours'), 'apps/web/src/routes/settings/index.tsx' /* aditivo: abas viram select pesquisável no mobile (AC-T53-05) */], ['web'], { e2e: true }),
  T('T54', 'UI: equipe, permissões, convites e suporte', ['T32', 'T36'], [...ui('settings-team'), ...ui('settings-invitations'), ...ui('settings-support'), 'apps/web/src/routes/support/access.tsx' /* tela do usuário de suporte (placeholder da T23) */, 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: modal global de aprovação + handler support_access.* */, 'apps/web/src/lib/http.ts' /* aditivo: zera empresa ativa em 403 support_access_expired */, 'apps/web/src/routes/settings/index.tsx' /* aditivo: aba só owner/admin */, 'packages/core/src/team/service.ts' /* aditivo: departamentos no MemberDto (AC-T54-01) */, 'scripts/e2e/api.ts' /* aditivo: cooldown de reenvio de convite curto no harness (AC-T54-04) */], ['db', 'core', 'web'], { e2e: true }),

  // ---------------- Contatos, chats, conteúdo ----------------
  T('T26', 'Contatos, etiquetas e campos personalizados', ['T15'],
    [core('contacts'), core('labels'), core('custom-fields'), route('contacts'), route('labels'), route('custom-fields'), schema('contacts')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/contacts/index.ts'] }),
  T('T27', 'Jobs genéricos de exportação e importação', ['T09', 'T16'], [core('exports'), job('exports'), route('exports'), schema('exports')], ['api', 'worker', 'core'],
    { requiredFiles: ['packages/core/src/exports/index.ts'] }),
  T('T33', 'Chats: modelo e ingestão de eventos WhatsApp', ['T26', 'T09', 'T16'], ['packages/core/src/chats/model/**', 'packages/core/src/chats/ingest/**', consumer('chats'), schema('chats')], ['worker', 'core'],
    { requiredFiles: ['packages/core/src/chats/ingest/index.ts'] }),
  T('T35', 'Conteúdo: respostas rápidas, modelos, variáveis globais, figurinhas', ['T26', 'T11'],
    [core('content'), route('content'), schema('content')], ['api', 'core'], { requiredFiles: ['packages/core/src/content/index.ts'] }),
  T('T48', 'Chats: lista, filtros, escopo e ciclo de vida', ['T33', 'T31'], ['packages/core/src/chats/query/**', 'packages/core/src/chats/lifecycle/**', route('chats')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/chats/lifecycle/index.ts'] }),
  T('T49', 'Chats: envio, mídia e leitura', ['T33'], ['packages/core/src/chats/send/**', core('media'), route('chat-messages'), route('media')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/chats/send/index.ts'] }),
  T('T58', 'UI: respostas rápidas, modelos, variáveis, campos e etiquetas', ['T35', 'T26', 'T23'],
    [...ui('settings-quick-replies'), ...ui('settings-templates'), ...ui('settings-variables'), ...ui('settings-fields'), ...ui('settings-labels'), 'packages/core/src/custom-fields/service.ts' /* descrição de campo de sistema editável, como a referência (AC-T58-04) */], ['web', 'core'], { e2e: true }),
  T('T64', 'Agendamento de mensagens', ['T49', 'T35'], [core('schedules'), job('schedules'), route('schedules'), schema('schedules'), 'apps/worker/src/boot/production.ts' /* aditivo: configureSchedules */], ['api', 'worker', 'core']),
  T('T66', 'Contatos: filtros avançados e ações em massa', ['T26', 'T27', 'T50'], ['packages/core/src/contacts-bulk/**', route('contacts-bulk'), job('contacts-bulk'), 'packages/core/src/contacts/**', 'apps/api/src/routes/contacts/**' /* aditivo: filtros avançados na listagem da T26 */], ['api', 'worker', 'core']),
  T('T67', 'Contatos: importação CSV e do WhatsApp', ['T26', 'T27'], ['packages/core/src/contacts-import/**', route('contacts-import'), job('contacts-import')], ['api', 'worker', 'core']),
  T('T69', 'UI chats: lista e filtros', ['T48', 'T23'], [...ui('chat'), 'apps/web/src/features/chat-list/**', i18n('chat-list')], ['web'], { e2e: true }),
  T('T75', 'UI chats: conversa', ['T69', 'T49'], ['apps/web/src/features/chat-thread/**', i18n('chat-thread'), 'apps/api/src/routes/chat-messages/**', 'packages/core/src/chats/send/**' /* aditivo: mídia por mensagem, reações na lista, retry */], ['api', 'core', 'web'], { e2e: true }),
  T('T85', 'UI chats: compositor', ['T75', 'T64'], ['apps/web/src/features/chat-composer/**', i18n('chat-composer'), 'apps/api/src/e2e/**' /* aditivo: pttConverter passthrough só no harness E2E */], ['web'], { e2e: true }),
  T('T91', 'UI chats: painel lateral e agendamentos', ['T75', 'T64'], ['apps/web/src/features/chat-panel/**', i18n('chat-panel'), 'apps/web/src/features/chat/chat-layout.tsx' /* aditivo: slot panel no mobile */, 'packages/core/src/chats/lifecycle/**' /* aditivo: chat.updated também ao escopo antigo */, 'apps/api/src/routes/auth/**', 'packages/core/src/auth/**', 'apps/web/src/lib/session.ts' /* permissões efetivas no perfil e no cliente */], ['api', 'core', 'web'], { e2e: true }),
  T('T77', 'UI contatos: lista e seleção em massa', ['T66', 'T23'], [...ui('contacts')], ['web'], { e2e: true }),
  T('T86', 'UI contatos: formulário, importação e jobs', ['T77', 'T67'], ['apps/web/src/features/contact-form/**', 'apps/web/src/features/contact-jobs/**', i18n('contact-form'), i18n('contact-jobs'), 'apps/web/src/features/contacts/contacts-page.tsx', 'apps/web/src/features/contacts/contact-list.tsx', i18n('contacts') /* aditivo: pontos de entrada (Novo, Importar, Exportações, editar/abrir chat) na lista da T77 */], ['web'], { e2e: true }),
  T('T84', 'UI: central de notificações', ['T33', 'T23'], ['apps/web/src/features/notifications/**', i18n('notifications'), 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: sino + handler notification.created importado no shell */], ['web'], { e2e: true }),

  // ---------------- Kanban, vendas, dashboard ----------------
  T('T50', 'Kanban: quadros, colunas e cards', ['T33'], [core('kanban'), route('kanban'), schema('kanban'), 'packages/core/src/chats/query/**', 'apps/api/src/routes/chats/**' /* aditivo: filtro crm/kanban e PATCH de coluna (T48) */], ['api', 'core'],
    { requiredFiles: ['packages/core/src/kanban/index.ts'] }),
  T('T34', 'Vendas, produtos, despesas e grupos de filtro', ['T26'], [core('sales'), core('products'), route('sales'), route('products'), schema('sales')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/sales/index.ts'] }),
  T('T55', 'Dashboard: métricas de vendas, bootstrap e marcos', ['T34'], ['packages/core/src/dashboard/sales/**', 'packages/core/src/dashboard/bootstrap/**', 'packages/core/src/dashboard/milestones/**', route('dashboard')], ['api', 'core']),
  T('T65', 'Dashboard: métricas de atendimento', ['T48'], ['packages/core/src/dashboard/attendance/**', route('dashboard-attendance')], ['api', 'core']),
  T('T70', 'UI kanban: lista e quadro', ['T50', 'T23'], [...ui('crms')], ['web'], { e2e: true }),
  T('T76', 'UI kanban: modais, filtros, estatísticas e exportação', ['T70', 'T27'], ['apps/web/src/features/kanban-tools/**', 'apps/web/src/features/crms/**', 'apps/web/src/routes/crms/$crmId.tsx', 'packages/core/src/kanban/export*', 'scripts/e2e/api.ts', i18n('kanban-tools')], ['web', 'core'], { e2e: true }),
  T('T78', 'UI dashboard: filtros e vendas', ['T55', 'T23'], [...ui('dashboard'), 'apps/web/src/routes/welcome/index.tsx'], ['web'], { e2e: true }),
  T('T87', 'UI dashboard: histórico, atendimento e marcos', ['T78', 'T65'], ['apps/web/src/features/dashboard-attendance/**', 'apps/web/src/features/dashboard-history/**', i18n('dashboard-attendance'), i18n('dashboard-history'), 'apps/web/src/features/dashboard/tabs.ts', 'apps/web/src/features/dashboard/dashboard-page.tsx' /* aditivo: montagem do histórico e do atendimento (props de período/fuso, slot history) */], ['web'], { e2e: true }),

  // ---------------- Fluxos ----------------
  T('T10', 'Fluxos: FlowDefinition, handles, validate e configs de ação', ['T02'], ['packages/shared/src/flows/**'], ['shared'],
    { requiredFiles: ['packages/shared/src/flows/definition.ts', 'packages/shared/src/flows/validate.ts'], infra: false }),
  T('T11', 'Templating: interpolação de variáveis', ['T02'], [core('templating')], ['core'], { requiredFiles: ['packages/core/src/templating/index.ts'], infra: false }),
  T('T19', 'Fluxos: schema e repositório', ['T01', 'T10'], ['packages/core/src/flows/store/**', schema('flows')], ['core'],
    { requiredFiles: ['packages/core/src/flows/store/index.ts'] }),
  T('T25', 'Motor de fluxos: runner, registro de nós e dry-run', ['T19', 'T11', 'T09'],
    ['packages/core/src/flows/engine/runner*', 'packages/core/src/flows/engine/registry*', 'packages/core/src/flows/engine/context*', 'packages/core/src/flows/engine/dry-run*', 'packages/core/src/flows/nodes/index.ts', 'apps/worker/src/jobs/flow-step/**'],
    ['worker', 'core'], { requiredFiles: ['packages/core/src/flows/engine/runner.ts', 'packages/core/src/flows/nodes/index.ts'] }),
  T('T28', 'API de fluxos, pastas, nós e arestas', ['T19', 'T15'], [route('flows')], ['api', 'core'], { requiredFiles: ['apps/api/src/routes/flows/index.ts'] }),
  T('T30', 'Motor de fluxos: timers, esperas, cancelamento e pausa', ['T25'],
    ['packages/core/src/flows/engine/timers*', 'packages/core/src/flows/engine/waits*', 'packages/core/src/flows/engine/control*', 'apps/worker/src/jobs/flow-timer/**'], ['worker', 'core']),
  T('T41', 'Nós de lógica (condição, distribuidor, conexão de fluxo, intervalo)', ['T25'], ['packages/core/src/flows/nodes/logic/**'], ['core']),
  T('T42', 'Nós externos (HTTP e IA)', ['T25', 'T24'], ['packages/core/src/flows/nodes/external/**'], ['core']),
  T('T43', 'API de execuções, compartilhar, importar e exportar', ['T25', 'T28'], [route('flow-runs'), route('flow-share'), 'apps/api/src/routes/flows/index.ts' /* aditivo: pause/resume via FlowControl (T30) */], ['api', 'core']),
  T('T51', 'Nós de mensagem (mensagem, modelo, notificação, Pix)', ['T25', 'T35'], ['packages/core/src/flows/nodes/messaging/**'], ['core']),
  T('T61', 'Gatilhos, fluxos padrão por conexão e ação fora do horário', ['T30', 'T33', 'T40', 'T31'],
    ['packages/core/src/flows/triggers/**', route('connection-flow-configs'), consumer('flow-triggers'), schema('flow-triggers')], ['api', 'worker', 'core']),
  T('T62', 'Nós interativos (menu, carrossel, espera de resposta)', ['T30', 'T51'], ['packages/core/src/flows/nodes/interactive/**', 'packages/core/src/flows/engine/control.ts', 'packages/core/src/flows/engine/control*.test.ts' /* aditivo: reentry */], ['core']),
  T('T63', 'Nós de CRM (etiquetas, chat, departamento, kanban, manipulador, venda, agente)', ['T25', 'T48', 'T50', 'T34'], ['packages/core/src/flows/nodes/crm/**', 'packages/db/src/schema/crm/sales.ts', 'packages/core/src/sales/**' /* aditivo: note_issuer_id, utmify_integration_id */], ['core']),
  T('T82', 'Simulador de fluxos', ['T41', 'T42', 'T51', 'T62', 'T63', 'T45'], [route('flow-simulate'), 'apps/web/src/features/flow-simulator/**', i18n('flow-simulator'), 'apps/web/src/features/flow-editor/canvas/editor.tsx' /* aditivo: botão Simular + painel no cabeçalho (a T93 virá depois no mesmo arquivo) */], ['api', 'web'], { e2e: true }),
  T('T44', 'UI fluxos: lista e pastas', ['T28', 'T23'], [...ui('flows'), 'apps/api/src/routes/flows/index.ts', 'packages/core/src/flows/store/store.ts' /* aditivo: DELETE lista as configs afetadas (409) e ?force=1 desvincula/desativa e exclui (AC-T44-03) */, 'apps/api/src/routes/flow-share/index.ts' /* aditivo: import com limite atingido → 409 LIMIT_REACHED */], ['api', 'core', 'web'], { e2e: true }),
  T('T45', 'UI fluxos: canvas do editor', ['T28', 'T23'], ['apps/web/src/features/flow-editor/canvas/**', 'apps/web/src/features/flow-editor/palette/**', 'apps/web/src/features/flow-editor/properties/**', 'apps/web/src/features/flow-editor/index.ts*', 'apps/web/src/features/flow-editor/node-editors/registry.ts', 'apps/web/src/routes/flows/$flowId/edit.tsx', 'apps/web/src/routes/flows/$flowId/index.tsx', i18n('flow-editor')], ['web'], { e2e: true }),
  T('T56', 'UI editores de nó: mensagem e interativos', ['T45', 'T10'], ['apps/web/src/features/flow-editor/node-editors/messaging/**', 'apps/web/src/features/flow-editor/node-editors/interactive/**', i18n('node-editors-messaging')], ['web'], { e2e: true }),
  T('T57', 'UI editores de nó: lógica, CRM e externos', ['T45', 'T10'], ['apps/web/src/features/flow-editor/node-editors/logic/**', 'apps/web/src/features/flow-editor/node-editors/crm/**', 'apps/web/src/features/flow-editor/node-editors/external/**', i18n('node-editors-logic')], ['web'], { e2e: true }),

  // ---------------- Conexões ----------------
  T('T40', 'Conexões: API, QR, pareamento, proxy e perfil', ['T22', 'T03'], [core('connections'), route('connections'), schema('connections'), 'packages/db/src/schema/crm/chats.ts' /* aditivo: FK chats.connection_id */, 'packages/db/src/schema/crm/departments.ts' /* aditivo: FKs connection_id (T31) */], ['api', 'core'],
    { requiredFiles: ['packages/core/src/connections/index.ts'], testerPaths: ['tests/acceptance/T31/**', 'tests/acceptance/T33/**', 'tests/acceptance/T39/**', 'tests/acceptance/T43/**', 'tests/acceptance/T48/**', 'tests/acceptance/T49/**', 'tests/acceptance/T50/**', 'tests/acceptance/T119/**'] /* FK chats.connection_id */ }),
  T('T47', 'Conexões: projeção de status, eventos e alertas', ['T40', 'T09', 'T16'], ['packages/core/src/connections-status/**', consumer('connections')], ['worker', 'core']),
  T('T71', 'UI conexões', ['T40', 'T47', 'T23'], [...ui('connections'), 'apps/api/src/routes/connections/**', 'packages/core/src/connections/**' /* aditivo: limite de conexões na lista (AC-T71-05) e rotas de retomar/cancelar fluxos pausados (AC-T71-04) */, 'packages/core/src/connections-status/**' /* aditivo: resume/cancel dos runs pausados por queda + flow.resumed */, 'apps/api/src/e2e/index.ts' /* aditivo: rota /__e2e que muda o estado da sessão no FakeWaGateway (AC-T71-02) */], ['api', 'core', 'web'], { e2e: true }),

  // ---------------- IA ----------------
  T('T12', 'Adapters de IA: AI SDK 7, ElevenLabs, Groq e áudio', ['T04', 'T05'], ['packages/ai/src/aisdk/**', 'packages/ai/src/elevenlabs/**', 'packages/ai/src/groq/**', 'packages/ai/src/audio/**'], ['ai'],
    { requiredFiles: ['packages/ai/src/aisdk/provider.ts', 'packages/ai/src/audio/ptt.ts'], infra: false }),
  T('T18', 'Consumo de IA: preços, ledger, carteira e porta BillingProvider', ['T01', 'T02', 'T04'], [core('ai-usage'), core('billing'), schema('ai-usage')], ['core'],
    { requiredFiles: ['packages/core/src/ai-usage/wallet.ts', 'packages/core/src/billing/port.ts'] }),
  T('T24', 'UsageGuard e provider medido', ['T18', 'T12'], ['packages/core/src/ai-metering/**', 'packages/db/src/schema/crm/ai-usage.ts' /* aditivo: feature, agent_id, error_code, status error */], ['core'], { requiredFiles: ['packages/core/src/ai-metering/guard.ts'] }),
  T('T37', 'API de consumo de IA (empresa e plataforma)', ['T24', 'T22'], [route('ai-usage'), route('platform-ai'), 'apps/api/src/server.ts', 'apps/worker/src/boot/production-worker.ts' /* aditivo: ensureDefaultAiPrices no boot */], ['api', 'core']),
  T('T38', 'Chaves de provedores de IA (BYOK)', ['T12', 'T22'], [core('ai-keys'), route('ai-keys'), schema('ai-keys')], ['api', 'core']),
  T('T39', 'Agentes de IA: schema e CRUD', ['T22', 'T26'], [core('ai-agents'), route('ai-agents'), schema('ai-agents'), 'packages/db/src/schema/crm/chats.ts' /* aditivo: FK chats.ai_agent_id */], ['api', 'core'],
    { requiredFiles: ['packages/core/src/ai-agents/index.ts'] }),
  T('T52', 'Agentes de IA: base de conhecimento', ['T39'], ['packages/core/src/ai-knowledge/**', 'packages/db/src/schema/crm/ai-knowledge.ts', route('ai-knowledge'), job('ai-knowledge')], ['api', 'worker', 'core']),
  T('T59', 'UI: consumo de IA, chaves e hub de integrações', ['T37', 'T38', 'T23'], [...ui('settings-ai-usage'), ...ui('integrations'), 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: chip de saldo de IA + handler ai_wallet.updated (AC-T59-01) */, 'apps/web/src/routes/settings/index.tsx' /* aditivo: ?cat= do hub de integrações */, 'apps/api/src/routes/ai-usage/index.ts', 'apps/api/src/routes/ai-usage/queries.ts' /* aditivo: last_topup em GET /api/ai/wallet (AC-T59-02) */, 'scripts/e2e/api.ts' /* aditivo: aiKeyProbe fake no harness (nunca o provedor real) */], ['api', 'web'], { e2e: true }),
  T('T68', 'Runtime do agente de IA', ['T39', 'T24', 'T12', 'T33', 'T49'], ['packages/core/src/ai-runtime/**', consumer('ai-agent'), job('ai-agent'), schema('ai-runtime'), 'packages/core/src/chats/send/service.ts' /* aditivo: Sender kind ai */, 'packages/ai/src/testing/fake-llm.ts' /* aditivo: providerData */], ['worker', 'core']),
  T('T79', 'Agentes: teste ao vivo, geração de prompt e criação assistida', ['T68'], ['packages/core/src/ai-agent-lab/**', route('ai-agent-lab'), job('ai-agent-lab')], ['api', 'worker', 'core']),
  T('T80', 'Vozes (ElevenLabs)', ['T38', 'T12'], [core('ai-voices'), route('ai-voices'), schema('ai-voices')], ['api', 'core']),
  T('T88', 'UI agentes: lista e editor', ['T79', 'T80', 'T52', 'T23'], [...ui('agents'), 'apps/api/src/routes/ai-agents/index.ts', 'apps/api/src/routes/ai-agents/*.db.unit.test.ts' /* GET /api/ai-agents/model-options */, 'apps/worker/src/index.ts', 'scripts/e2e/api.ts' /* liga o job ai-knowledge no harness */], ['web', 'api', 'worker'], { e2e: true }),
  T('T92', 'UI agentes: teste ao vivo, criação assistida e vozes', ['T88'], ['apps/web/src/features/agent-lab/**', 'apps/web/src/features/agent-voices/**', i18n('agent-lab'), 'apps/web/src/features/agents/editor-page.tsx', 'apps/web/src/features/agents/tabs.tsx', 'apps/web/src/features/agents/list-page.tsx', 'apps/web/src/routes/agentes/**' /* aditivo: pontos de montagem da T88 + handler ai_agent.run.updated */, 'apps/api/src/routes/ai-agent-lab/index.ts' /* aditivo: LLM do harness lido de forma preguiçosa (sobrevive ao reset) */, 'scripts/e2e/api.ts' /* aditivo: lab com FakeLlm, FakeStt no ditado e FakeElevenLabsVoices (nunca rede) */], ['api', 'web'], { e2e: true }),
  T('T93', 'Assistente (copiloto) de fluxo', ['T28', 'T24', 'T12', 'T16', 'T45'], [core('flow-copilot'), route('flow-copilot'), schema('flow-copilot'), 'apps/web/src/features/flow-copilot/**', i18n('flow-copilot'), 'apps/web/src/features/flow-editor/canvas/editor.tsx' /* aditivo: botão + painel do assistente (a T82 também acrescenta no cabeçalho) */, 'apps/web/src/routes/flows/$flowId/edit.tsx' /* aditivo: registrar copilot.* junto do registerFlowEditorRealtime */], ['api', 'core', 'web'],
    { e2e: true }),

  // ---------------- Webhooks, vendas externas, disparos, MCP ----------------
  T('T72', 'Webhooks de entrada: CRUD e recepção pública', ['T26'], [core('inbound-webhooks'), route('inbound-webhooks'), 'apps/api/src/routes/hooks/**', schema('inbound-webhooks')], ['api', 'core']),
  T('T81', 'Webhooks de entrada: processador e escuta de amostras', ['T72', 'T61', 'T50'], ['packages/core/src/inbound-webhooks-processor/**', 'apps/api/src/middleware/request-logger.ts', 'apps/api/src/routes/inbound-webhook-samples/**', job('inbound-webhooks')], ['api', 'worker', 'core']),
  T('T89', 'UI webhooks de entrada', ['T81', 'T23'], [...ui('settings-webhooks'), 'apps/web/src/routes/settings/inbound-webhooks.tsx', 'apps/web/src/routes/settings/inbound-webhooks/**', 'apps/worker/src/index.ts', 'scripts/e2e/api.ts'], ['web', 'worker'], { e2e: true }),
  T('T73', 'Fontes de venda (webhook genérico) e atribuição UTM/CTWA', ['T34', 'T33'], [core('sale-sources'), core('attribution'), route('sale-sources'), 'apps/api/src/routes/hooks-sales/**', job('inbound-sales'), schema('sale-sources')], ['api', 'worker', 'core']),
  T('T90', 'UI fontes de venda e produtos', ['T73', 'T23'], [...ui('settings-sale-sources'), ...ui('settings-products'), 'scripts/e2e/api.ts' /* aditivo: configureInboundSales no harness para processar eventos de venda no E2E (AC-T90-03) */], ['web'], { e2e: true }),
  T('T60', 'Disparos em massa: API e cota', ['T26', 'T43'], [core('mass-dispatch'), route('mass-dispatch'), schema('mass-dispatch')], ['api', 'core']),
  T('T74', 'Disparos em massa: preparação e agendador', ['T60', 'T30'], ['packages/core/src/mass-dispatch-runner/**', job('mass-dispatch')], ['worker', 'core']),
  T('T83', 'UI disparos em massa', ['T60', 'T74', 'T23'], [...ui('mass-dispatch'), 'scripts/e2e/api.ts' /* aditivo: configureMassDispatch no harness com o mesmo FakeWaGateway da API (AC-T83-04) */], ['web'], { e2e: true }),
  T('T94', 'Servidor MCP (token estático)', ['T26', 'T28', 'T40'], [core('mcp'), route('mcp'), schema('mcp'), ...ui('settings-mcp')], ['api', 'core', 'web'], { e2e: true }),

  // ---------------- Admin interno, afiliação, extensão, Meta, E2E ----------------
  T('T95', 'Admin: usuários, empresas, limites e cotas', ['T22', 'T60'], [core('admin'), route('admin'), 'packages/core/src/invitations/service.ts', 'packages/core/src/flows/store/store.ts', 'packages/core/src/inbound-webhooks/service.ts' /* aditivo: aplicar limites de membros, fluxos e webhooks (AC-T95-03) */, 'apps/api/src/routes/companies/guard.ts' /* aditivo: /api/admin e /api/platform isentos para platform_admin */, 'packages/core/src/team/errors.ts', 'apps/api/src/routes/team/support.ts', 'packages/core/src/flows/store/errors.ts', 'apps/api/src/routes/flows/index.ts' /* aditivo: código limit_reached → 409 LIMIT_REACHED, como T39/T40 */], ['api', 'core'], { minWave: 11 }),
  T('T96', 'Admin: avisos, banners, saúde, sessões WhatsApp e IA', ['T22', 'T46', 'T37'], [core('admin-ops'), route('admin-ops'), schema('admin'), 'packages/core/src/dashboard/bootstrap/index.ts' /* aditivo: avisos e banners ativos no bootstrap (AC-T96-01) */, 'packages/core/src/ai-keys/service.ts', 'packages/core/src/ai-agents/provider-keys.ts' /* aditivo: segredo de plataforma do banco tem precedência sobre o env (AC-T96-04) */], ['api', 'core'], { minWave: 11 }),
  T('T97', 'Afiliação: captura de indicação e link externo', ['T36'], ['packages/core/src/affiliate/**', 'apps/web/src/features/affiliate/**', i18n('affiliate'), 'apps/web/src/features/auth/register-route.tsx' /* aditivo: captura ref/via (AC-T97-02) */, 'apps/api/src/routes/app-config/**' /* GET /api/app-config (affiliate_portal_url; a T108 acrescenta campos) */, 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: slot do item de afiliados */], ['api', 'core', 'web'], { e2e: true, minWave: 11 }),
  T('T98', 'Extensão: perfil ai-manager do gateway e documentação', ['T46'], ['packages/wa-gateway-rpc/src/profiles/ai-manager/**', 'docs/extension/**', 'packages/wa-port/src/contract/suite.ts' /* aditivo: only/skip por capacidade na suíte de contrato (AC-T98-01) */, 'packages/wa-gateway-rpc/src/config.ts' /* aditivo: createWaGatewayFromEnv usa o perfil ai-manager quando WA_RPC_PROFILE=ai-manager */], ['wa-port', 'wa-gateway-rpc'], { minWave: 11 }),
  T('T100', 'UI admin interno', ['T95', 'T96', 'T23'], [...ui('admin'), 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: pop-up de aviso no app do cliente (AC-T100-03) */, 'apps/api/src/routes/admin-ops/**', 'packages/core/src/admin-ops/**' /* aditivo: upload global de imagem do admin + rota pública que a serve (AC-T100-03) */], ['api', 'core', 'web'], { e2e: true }),

  // ---------------- Facebook / Meta Ads (spec 11) ----------------
  T('T99', 'Meta: cliente Graph, OAuth, perfis e contas de anúncio', ['T22'],
    ['packages/core/src/meta-ads/client/**', 'packages/core/src/meta-ads/profiles/**', route('meta-oauth'), route('meta-profiles'), schema('meta-ads')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/meta-ads/client/graph.ts'] }),
  T('T101', 'Meta: estrutura, insights e bundle assíncrono', ['T99', 'T09', 'T16'],
    ['packages/core/src/meta-ads/structure/**', route('meta-structure'), job('meta-ads'), 'packages/core/src/meta-ads/client/**' /* aditivo: estrutura, insights, BUC */], ['api', 'worker', 'core']),
  T('T103', 'Meta: edição de status, nome e orçamento', ['T101'], ['packages/core/src/meta-ads/mutations/**', route('meta-entities'), 'packages/core/src/meta-ads/client/**', 'packages/core/src/meta-ads/structure/service.ts' /* aditivo: mutações no fake e invalidação por geração */], ['api', 'core']),
  T('T104', 'Meta: Pixel, Conversions API e nó de fluxo pixel', ['T99', 'T25', 'T34'],
    ['packages/core/src/meta-capi/**', 'packages/core/src/flows/nodes/pixel/**', route('meta-pixels'), job('meta-capi'), schema('meta-pixels'), 'packages/core/src/meta-ads/client/**' /* aditivo: CAPI no FakeMetaGraph */, 'packages/shared/src/flows/handles.ts' /* pixel: source + success + failure */], ['api', 'worker', 'core']),
  T('T105', 'Meta: vendas internas × anúncios (CTWA) e ROAS', ['T101', 'T73'], ['packages/core/src/meta-ads/sales-join/**', 'packages/core/src/meta-ads/structure/service.ts', 'packages/core/src/meta-ads/structure/metrics.ts' /* aditivo: opção internalSales no build do bundle (métricas no Gerenciador) */, 'apps/api/src/routes/meta-structure/index.ts', 'apps/api/src/routes/meta-entities/index.ts', 'apps/worker/src/jobs/meta-ads/index.ts' /* aditivo: passar internalSales ao MetaBundleService */], ['api', 'worker', 'core']),
  T('T106', 'UI Facebook: gerenciador, pixel e perfis', ['T101', 'T103', 'T104', 'T23'], [...ui('facebook'), 'scripts/e2e/api.ts' /* aditivo: FakeMetaGraph + metaConfig/metaFetch + configureMetaAds no harness (nunca a Graph real) */], ['web'], { e2e: true }),

  // ---------------- Shell: extras da spec 18 ----------------
  T('T107', 'Indicador de conexões desconectadas no menu', ['T47', 'T23'], ['apps/web/src/features/shell-disconnect/**', route('connections-alert'), i18n('shell-disconnect'), 'apps/web/src/app/shell/nav-list.tsx' /* aditivo: slot no item connections */, 'apps/web/src/app/shell/app-shell.tsx' /* aditivo: import estático do handler */], ['api', 'web'], { e2e: true }),
  T('T108', 'Tutoriais e widget de suporte plugável', ['T23'], ['apps/web/src/features/support-widget/**', 'apps/web/src/features/tutorials/**', i18n('support-widget'), 'apps/api/src/routes/app-config/**', 'packages/core/src/affiliate/**', 'apps/web/src/features/affiliate/api.ts' /* aditivo: tutorials_url e support no GET /api/app-config da T97 */, 'apps/web/src/app/shell/nav-list.tsx', 'apps/web/src/app/shell/app-shell.tsx', 'apps/web/src/app/shell/controls.tsx' /* aditivo: link de tutoriais, botões Suporte, gancho de logout */], ['api', 'core', 'web'], { e2e: true, minWave: 11 }),

  // ---------------- Integrações de venda (revisão 1: iguais à referência) ----------------
  T('T109', 'Pagamentos ao lead: porta, chaves e adapter XPag', ['T22'],
    ['packages/core/src/payments/port/**', 'packages/core/src/payments/keys/**', 'packages/core/src/payments/xpag/**', route('payment-integrations'), schema('payments')], ['api', 'core'],
    { requiredFiles: ['packages/core/src/payments/port/index.ts', 'packages/core/src/payments/xpag/index.ts'] }),
  T('T110', 'Pagamentos ao lead: adapter Zenith (chave, OAuth e webhook)', ['T109'],
    ['packages/core/src/payments/zenith/**', route('zenith-oauth')], ['api', 'core']),
  T('T111', 'Bloco Pagamento no fluxo e confirmação por webhook', ['T109', 'T30'],
    ['packages/core/src/flows/nodes/payment/**', 'packages/core/src/flows/engine/waits.ts', 'packages/core/src/flows/engine/control.ts', 'packages/core/src/payments/webhooks/**', route('hooks-payments'), job('payment-webhooks')], ['api', 'worker', 'core']),
  T('T112', 'Emissão de NF (Notasy) na venda aprovada', ['T34', 'T22'],
    [core('invoicing'), route('invoice-integrations'), job('invoices'), schema('invoicing'), 'apps/worker/src/boot/production.ts', 'apps/api/src/production.ts' /* aditivo: encadear o emissor de NF no salesPublisher */], ['api', 'worker', 'core']),
  T('T113', 'UTMify: integração e envio de vendas aprovadas', ['T34', 'T22'],
    [core('utmify'), route('utmify'), job('utmify'), schema('utmify'), 'apps/worker/src/boot/production.ts', 'apps/api/src/production.ts' /* aditivo: encadear o envio UTMify no salesPublisher */, 'packages/core/src/sales/service.ts' /* aditivo: transição para refunded passa pelo publisher (AC-T113-02) */], ['api', 'worker', 'core']),
  T('T114', 'UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada', ['T110', 'T111', 'T112', 'T113', 'T45', 'T59'],
    [...ui('settings-payments'), 'apps/web/src/features/flow-editor/node-editors/payment/**', 'apps/web/src/features/sale-invoice/**'], ['web'], { e2e: true }),
  T('T115', 'MCP: OAuth para conectores (Claude)', ['T94'],
    ['packages/core/src/mcp-oauth/**', route('mcp-oauth'), schema('mcp-oauth'), 'apps/web/src/features/mcp-oauth/**', i18n('mcp-oauth'), 'packages/core/src/mcp/credentials.ts', 'apps/api/src/routes/mcp/index.ts', 'apps/web/src/features/settings-mcp/**', i18n('settings-mcp') /* aditivo: oauth no núcleo da T94 (status pending/connected, 401 com resource_metadata, UI) */, 'apps/web/src/routes/oauth/**' /* tela de consentimento */], ['api', 'core', 'web'],
    { e2e: true }),

  T('T117', 'Ajustes de integração: logout encerra SSE, shutdown do hub, cache de chaves único', ['T13', 'T15', 'T16'],
    ['apps/api/src/routes/auth/**', 'apps/api/src/server.ts', 'packages/wa-engine/src/transport/baileys.ts', 'packages/wa-engine/src/auth-state/index.ts'], ['api', 'wa-engine'],
    { requiredFiles: ['apps/api/src/server.ts'] }),

  T('T118', 'Harness de testes: E2E sem travar, porta por worktree, timeouts para máquina compartilhada', ['T17', 'T23'],
    ['scripts/e2e/**', 'apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'], ['api'],
    { e2e: true }),
  T('T119', 'Escopo de chat nas rotas de mensagens e mídia (segurança)', ['T48', 'T49'],
    ['apps/api/src/routes/chat-messages/**', 'apps/api/src/routes/media/**', 'packages/core/src/chats/send/**'], ['api', 'core']),

  T('T120', 'Montagem de produção e registro de mensagens automáticas no chat', ['T24', 'T27', 'T38', 'T46', 'T48', 'T51', 'T61', 'T67', 'T68'],
    ['apps/worker/src/boot/**', 'apps/worker/src/main.ts', 'apps/api/src/server.ts', 'packages/core/src/chats/send/**', 'packages/core/src/chats/lifecycle/**',
      'packages/core/src/flows/nodes/messaging/**', 'packages/core/src/flows/triggers/**', 'packages/core/src/ai-runtime/**'], ['api', 'worker', 'core']),

  T('T121', 'Isolamento de filas BullMQ nos testes e remetente flow', ['T09', 'T120'],
    ['packages/core/src/jobs/**', 'packages/db/src/schema/crm/chats.ts', 'apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'], ['core', 'db', 'worker', 'api'], { testerPaths: ['tests/acceptance/T09/**', 'tests/acceptance/T26/**'] /* prefixo de fila por execução */ }),

  T('T122', 'Redis do harness E2E por worktree e disparos na montagem de produção', ['T74', 'T118', 'T120'],
    ['scripts/e2e/**', 'apps/worker/src/boot/**'], ['api', 'worker'], { e2e: true }),

  T('T123', 'Montagem: eventos dos nós de lógica e CRM e alias customer.name', ['T41', 'T63', 'T120'],
    ['apps/worker/src/boot/**', 'packages/core/src/templating/**', 'packages/core/src/chats/send/**', 'packages/core/src/flows/nodes/messaging/**' /* correção do deadlock: registro pela transação do passo */], ['worker', 'core']),

  T('T124', 'Harness E2E: reset serializado e limpeza de bancos órfãos', ['T17', 'T122'],
    ['scripts/e2e/**', 'apps/api/src/e2e/**'], ['api'], { e2e: true }),
  T('T125', 'Montagem de produção da Meta (insights, CAPI e vendas ao Pixel)', ['T101', 'T104', 'T120'],
    ['apps/worker/src/boot/**', 'apps/api/src/server.ts', 'apps/api/src/production.ts' /* composição de produção da API, testável */], ['api', 'worker']),
  T('T126', 'Estabilidade dos testes sob carga (filas, Redis, teardown e relógio)', ['T121', 'T124', 'T125'],
    ['apps/*/vitest.config.ts', 'packages/*/vitest.config.ts', 'apps/*/src/test-setup*.ts', 'packages/*/src/test-setup*.ts', 'packages/db/src/testing.ts', 'packages/db/src/seed/index.ts' /* resetDatabase do harness E2E (opção A, autorizada) */, 'packages/core/src/meta-capi/sales.ts', 'apps/worker/src/jobs/meta-capi/index.ts' /* Purchase perdido antes do commit (rejeição 1, opção A) */, 'apps/*/src/**/*.unit.test.ts', 'packages/*/src/**/*.unit.test.ts', 'docs/testing.md'], ['api', 'worker', 'core']),
  T('T127', 'Montagem de produção: webhooks, fontes de venda, pagamentos, nós externos e IA', ['T42', 'T47', 'T52', 'T73', 'T79', 'T81', 'T111', 'T125'],
    ['apps/worker/src/boot/**', 'apps/worker/src/main.ts', 'apps/worker/src/jobs/exports/**', 'packages/core/src/exports/**', 'packages/core/src/inbound-webhooks-processor/**' /* rejeição 1: waGateway no ContactsService (consentimento 'webhook') */], ['api', 'worker', 'core']),
  T('T128', 'Harness de testes: banco-modelo por hash das migrações', ['T124', 'T126'],
    ['packages/db/src/testing.ts', 'packages/db/src/testing/**', 'scripts/e2e/serve.mjs', 'scripts/e2e/orphans.mjs', 'scripts/e2e/*.unit.test.mjs', 'scripts/e2e/template-db.mjs', 'docs/testing.md'], ['db']),
  T('T102', 'Integração E2E final', ['T85', 'T86', 'T87', 'T91', 'T92', 'T89', 'T90', 'T83', 'T82', 'T76', 'T71', 'T84', 'T53', 'T54', 'T58', 'T59', 'T44', 'T56', 'T57', 'T93', 'T94', 'T97', 'T98', 'T100', 'T105', 'T106', 'T107', 'T108', 'T114', 'T115', 'T127'],
    ['apps/**', 'packages/**', 'scripts/**'], ['api', 'worker', 'wa-worker', 'web'], {
      commands: ['pnpm -r typecheck', 'pnpm -r lint', 'pnpm -r test', 'pnpm -r build'],
      e2e: true,
    }),
]

// ---------- ondas calculadas ----------
const byId = new Map(RAW.map((t) => [t.id, t]))
for (const t of RAW) for (const d of t.deps) if (!byId.has(d)) throw new Error(`tasks.mjs: ${t.id} depende de ${d}, que não existe`)
const waveOf = new Map()
function wave(id, stack = []) {
  if (waveOf.has(id)) return waveOf.get(id)
  if (stack.includes(id)) throw new Error(`tasks.mjs: ciclo de dependência ${[...stack, id].join(' → ')}`)
  const t = byId.get(id)
  const w = Math.max(t.minWave, ...t.deps.map((d) => wave(d, [...stack, id]) + 1), 0)
  waveOf.set(id, w)
  return w
}
const num = (id) => Number(id.slice(1))
export const TASKS = RAW.map((t) => ({ ...t, wave: wave(t.id) })).sort((a, b) => a.wave - b.wave || num(a.id) - num(b.id))

// ---------- regras proibidas (SPEC 1.4), aplicadas em TODO --role operario ----------
const PRODUCT = ['apps/**', 'packages/**']
const NOT_TESTS = ['**/*.test.ts', '**/*.test.tsx', '**/*.e2e.ts', '**/testing/**', '**/node_modules/**', '**/dist/**']
const TS = ['.ts', '.tsx', '.mts']

export const FORBIDDEN = [
  {
    id: 'F-SEND-CHOKEPOINT',
    regex: /\.sendMessage\s*\(/,
    include: PRODUCT, exclude: [...NOT_TESTS, 'packages/wa-engine/src/send/**', 'packages/wa-engine/src/transport/**'], exts: TS,
    message: 'sendMessage só em packages/wa-engine/src/send|transport (SPEC 1.4 #2)',
  },
  {
    id: 'F-WA-BOUNDARY',
    regex: /from\s+['"](@whiskeysockets\/baileys|baileys|baileys-antiban)['"]|import\(\s*['"](@whiskeysockets\/baileys|baileys-antiban)['"]\s*\)/,
    include: PRODUCT, exclude: [...NOT_TESTS, 'packages/wa-engine/src/transport/**', 'packages/wa-engine/src/antiban/**', 'packages/wa-engine/src/auth-state/**', 'packages/wa-engine/src/media/**'], exts: TS,
    message: 'Baileys só dentro do wa-engine (SPEC 1.4 #11)',
  },
  {
    id: 'F-ENGINE-BOUNDARY',
    regex: /from\s+['"]@crm\/wa-engine['"]/,
    include: ['packages/core/**', 'packages/shared/**', 'apps/api/**', 'apps/worker/**', 'apps/web/**'], exclude: NOT_TESTS, exts: TS,
    message: 'Domínio, API, worker e web falam com o WhatsApp só por @crm/wa-port (SPEC 1.4 #11)',
  },
  {
    id: 'F-AI-BOUNDARY',
    regex: /from\s+['"](ai|@ai-sdk\/[\w-]+|@openrouter\/ai-sdk-provider|@anthropic-ai\/sdk|openai|@google\/genai|@elevenlabs\/elevenlabs-js|groq-sdk)['"]/,
    include: PRODUCT, exclude: [...NOT_TESTS, 'packages/ai/src/aisdk/**', 'packages/ai/src/elevenlabs/**', 'packages/ai/src/groq/**'], exts: TS,
    message: 'SDKs de IA só nos adapters de packages/ai (SPEC 1.4 #11)',
  },
  {
    id: 'F-NO-GROUP-JOIN',
    regex: /groupAcceptInvite/,
    include: PRODUCT, exclude: NOT_TESTS, exts: TS,
    message: 'Entrada automática em grupos é proibida (SPEC 1.4 #5)',
  },
  {
    id: 'F-NO-BAN-CLAIM',
    regex: /(imune\s+a\s+ban|immune\s+to\s+ban|seguro\s+contra\s+(o\s+)?ban|ban[\s-]?proof|[àa]\s+prova\s+de\s+ban|anti-?ban\s+garantido|nunca\s+(ser[áa]\s+)?banid|never\s+(get\s+)?banned)/i,
    include: PRODUCT, exclude: NOT_TESTS, exts: [...TS, '.md', '.json', '.html'],
    message: 'Não prometer imunidade a ban (SPEC 1.4 #6)',
  },
  {
    id: 'F-NO-FILE-AUTH',
    regex: /useMultiFileAuthState/,
    include: PRODUCT, exclude: NOT_TESTS, exts: TS,
    message: 'Credenciais do WhatsApp só cifradas no Postgres (SPEC 1.4 #1)',
  },
  {
    id: 'F-NO-BRAND',
    regex: /\bleona\b|leonapay|leona[_-]?ai/i,
    include: PRODUCT, exclude: ['**/node_modules/**', '**/dist/**'], exts: [...TS, '.json', '.html', '.css', '.md'],
    message: 'Marca neutra: o nome do app vem de APP_NAME (SPEC 1.4 #9)',
  },
  {
    id: 'F-NO-CLOUD-API',
    regex: /graph\.facebook\.com[^'"`\s]*\/(messages|message_templates|phone_numbers)|whatsapp_business_account|wa_cloud|cloud_api/i,
    include: PRODUCT, exclude: NOT_TESTS, exts: TS,
    message: 'WhatsApp só via Baileys; Cloud API/WABA fora de escopo (SPEC 1.4 #12)',
  },
  {
    id: 'F-NO-TOKEN-LOCALSTORAGE',
    regex: /localStorage\.(setItem|getItem)\(\s*['"`][^'"`]*(token|session)[^'"`]*['"`]/i,
    include: ['apps/web/src/**'], exclude: NOT_TESTS, exts: TS,
    message: 'Sessão via cookie httpOnly; nada de token em localStorage (SPEC 3.4)',
  },
  {
    id: 'F-NO-CONSOLE',
    regex: /console\.(log|debug|info)\s*\(/,
    include: ['apps/api/src/**', 'apps/worker/src/**', 'apps/wa-worker/src/**', 'packages/**/src/**'], exclude: [...NOT_TESTS, 'packages/shared/src/**'], exts: TS,
    message: 'Use o logger estruturado (pino) em vez de console.*',
  },
]

// Regras aplicadas em TODO --role tester.
export const TESTER_FORBIDDEN = [
  {
    id: 'F-TEST-NO-REAL-WA',
    regex: /from\s+['"](@whiskeysockets\/baileys|baileys)['"]|require\(\s*['"](@whiskeysockets\/baileys|baileys)['"]\s*\)/,
    include: ['tests/**'], exclude: ['**/node_modules/**'], exts: TS,
    message: 'Testes não importam Baileys; use FakeTransport/FakeWaGateway (SPEC 1.3)',
  },
  {
    id: 'F-TEST-NO-PAID-API',
    regex: /(api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.elevenlabs\.io|api\.groq\.com|graph\.facebook\.com)/,
    include: ['tests/**'], exclude: ['**/node_modules/**'], exts: TS,
    message: 'Testes nunca chamam APIs pagas reais; use os fakes (SPEC 1.3)',
  },
  {
    id: 'F-TEST-NO-SKIP',
    regex: /\b(it|test|describe)\.(skip|todo|only|fixme)\s*\(/,
    include: ['tests/acceptance/**'], exclude: ['**/node_modules/**'], exts: TS,
    message: 'Testes de aceitação não podem usar .skip/.todo/.only/.fixme',
  },
]
