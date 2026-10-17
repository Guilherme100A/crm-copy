# Lições da obra (armadilhas conhecidas)

> Montado a partir da tabela "Pendências" e das notas de `spec/STATUS.md`. Cada item indica a tarefa de origem. Leia antes de começar qualquer tarefa.

## Máquina e verify
- **Um verify pesado por vez.** Verifies simultâneos derrubaram o Postgres por falta de memória (OOM): a T94 falhou 3 vezes e a T47 ficou para depois da T126. O Orquestrador mantém a fila serializada. Só rode o verify formal quando ele mandar. (T47, T94, T88)
- **Sob carga, testes oscilam.** Antes de rejeitar, o gate repete 1 vez. Para medir tempo, não use `sleep` real: use relógio injetável ou fake timers (`docs/testing.md`). (T20, T52, T68, T126)
- **Bancos de teste órfãos** (`crm_e2e_*`, `crm_test_*`, `crm_acc_*`) acumulam quando uma execução morre: houve 72 apagados à mão. Agora o harness limpa ao subir. (T124)
- **context7 sem cota desde 2026-10-16.** Use `spec/STACK.md` e os `.d.ts` instalados em `node_modules`. (T25)

## Filas, Redis e testes de backend
- **O BullMQ 6.3.8 recusa `:` em jobId.** Use `run-<id>-seq-<n>` (`flowStepJobId`), nunca `run:<id>:seq:<n>`. (T25/T30)
- **Prefixo de fila:** a variável é `CRM_QUEUE_PREFIX` e o prefixo é único por arquivo de teste. Com prefixo fixo, workers de outros worktrees roubavam jobs. (T120, T121, T126)
- **Teardown:** feche workers, filas e pools ANTES do `drop()` do banco temporário. Sem isso aparece o erro 57P01 `admin_shutdown`. (verify T79, T126)
- **Redis db fixo é perigoso:** o reset do E2E apaga `crm:*` do db inteiro. Use a reserva de db por harness. (T124, T126)

## Montagem de produção
- **Consumidor ou job novo precisa ser registrado no boot de produção.** Isso vale para as chamadas `configure*` em `apps/worker/src/boot/production.ts` e `startProductionWorker`. Sem elas, o código passa nos testes e não roda em produção. Já faltaram: `configureExports`, `configureFlowTriggers`, `configureMassDispatch`, `configureAiKnowledge`, `configureInboundWebhooks`, `configureInboundSales` e `configurePaymentWebhooks`. Declare no relatório o que precisa ser ligado. (T27, T61, T52, T81, T73, T111, T120, T122)
- **Efeitos de passo de fluxo** (eventos realtime, enfileiramentos) saem antes do commit do passo. Dentro do passo, use `ctx.repo.db`: gravar por outra conexão causa deadlock. (T123, T126)
- **Mensagens enviadas por fluxo ou automação** precisam ser registradas no chat (`recordOutbound`), senão somem do histórico. (T51, T61, T120)

## Harness E2E
- **Harness por worktree:** as portas (`E2E_WEB_PORT`/`E2E_API_PORT`) e o db do Redis derivam do hash do caminho do worktree. Não fixe porta nem db. Documentação em `docs/e2e-harness.md`. (T118, T122)
- **`POST /__e2e/reset` sob carga:** passava de 15 s e o reset seguinte começava por cima, causando 500 por chave duplicada. Agora é serializado, com timeout de `E2E_RESET_TIMEOUT_MS` (padrão 60 s). Ao estourar, responde 504. (T124)
- **Não há rota `/__e2e` que leve uma sessão WhatsApp a STABLE.** O E2E da T77 intercepta `GET /api/connections`. (T77)
- **Testid de placeholder some quando a tela real chega** (`page-chats`, T23 × T69). Teste por testids estáveis. (T45)

## Web / UI
- **Os paths de UI seguem a URL,** pelo mapeamento `ui(m)` em `spec/verify/tasks.mjs`: contacts→customers, chat→chats, agents→agentes, dashboard→welcome, mass-dispatch→mass-dispatches, settings-webhooks→settings/inbound-webhooks. Pasta com o nome errado gera rota inexistente. (T23)
- **Abas de Configurações entram por `apps/web/src/features/settings/tabs.ts`** (compartilhado, só aditivo). Não editam `routes/settings/index.tsx`. (T23)
- **i18n obrigatório nas três línguas** (pt-BR, en, es), um JSON por módulo. `pnpm --filter @crm/web i18n:check` reprova chave faltante. (T23)
- **Os testids são contrato com o Tester.** Combine-os antes de fechar e mantenha o padrão `<módulo>-<coisa>` e `<módulo>-item-<campo>-${id}`. (T77, T88, T89)
- **Search params também são contrato.** Em `/agentes`, o filtro de status é `?filter=<status>`, e não `?status=`. Divergência entre operário e tester custa um ciclo. (T88)
- **A web só importa `@crm/shared`.** Regras e listas que estão em `@crm/core` (fusos, validação de horário etc.) precisam ser replicadas no cliente. (T53/T58, levantamento)
- **Slots do chat:** use `features/<módulo>/chat-slot.tsx` (contrato da T69). Não edite arquivos da T69. (T69)
- **Marca neutra:** a regra `F-NO-BRAND` reprova "leona" no produto; `F-NO-CLOUD-API` reprova termos de WABA. (SPEC 1.4)

## Segurança e API
- **O `requestLogger` não pode logar token de URL** (`/api/hooks/**`, convites, reset de senha). Mascare. (T72, T109, T22)
- **Validação que normaliza em silêncio esconde erro:** o fuso inválido vira America/Sao_Paulo com 200. Prefira 422. (T78)

## Do piloto sob demanda (2026-10-16)
- O seed do harness E2E não tem conexão de WhatsApp: telas que listam conexões precisam criar uma (`POST /api/connections {name}`, gateway fake, status `pending`). (T53)
- Textos do hub/shell vivem em `i18n/*/shell.json` (T23): uma tarefa que mexe no hub põe as chaves novas no JSON do próprio módulo (ex.: `settings-company:hub.*`). (T53)
- Não rode prettier em arquivos compartilhados: o código existente não segue o printWidth 120 e o diff deixa de ser aditivo (o verify de escopo/union no gate sofre). Formate só os seus arquivos. (T53)
- Handlers de realtime registrados em módulo carregado sob demanda (lazy) não entram no SSE já aberto: `lib/realtime.ts` registra os tipos ao conectar. (T53)
- Webhook de entrada que cria contato precisa registrar consentimento `webhook` no gateway, senão o wa-engine recusa o envio (`contact_not_found`). (T127)
- `DROP DATABASE` no Postgres 16/Windows espera checkpoint (10–16 s sob carga): drops em série e timeouts folgados em testes que removem banco; `src/migrations.db.unit.test.ts` (30 s) estoura sob carga. (T128)
- Testes de `scripts/e2e/*.unit.test.mjs` rodam no vitest do `@crm/api`, não no verify de tarefas só-db; rode à mão. (T128)
- Harness em segundo plano: `E2E_IGNORE_STDIN=1 node scripts/e2e/serve.mjs` (sem isso ele sai ao fechar o stdin). O seed não tem contatos, conexões nem figurinhas: crie pela API no teste. (T58, T53)
- Decisão que muda comportamento existente: procure o teste que trava o comportamento antigo (ex.: `contacts.db.unit.test.ts`) e ajuste-o de forma mínima (`*.unit.test.ts` é compartilhado, SPEC 2.4). (T58)
- No mobile (< 1024 px) o hub de Configurações não tem os botões `settings-tab-<id>`: usa `settings-tab-select` → `settings-tab-select-search` → `settings-tab-option-<id>` (`aria-selected`). Testes de abas novas conferem a aba pelo select no mobile. (T53/T58)
- Tarefas de UI feitas em paralelo podem quebrar os E2E uma da outra só no gate (base nova): o tester ajusta o teste, sem afrouxar o AC. (T58)
- O Orquestrador pode avançar o branch da tarefa por fast-forward (main nova); nesse caso use `--base` = o novo HEAD da main no verify (o escopo compara com a base). (T112)
- Nunca chame a API real de terceiros, nem para "conferir a rota": a pesquisa é só por documentação e bundles públicos. (T112)
- Mudança de comportamento no core precisa atualizar os testes dos pacotes que dependem dele (api, worker); o gate agora roda os dependentes (`pnpm --filter "...[base]"`). (T58 → regressão em `apps/api` contacts)
- O filtro `[ref]` do pnpm (`--filter "...[base]"`) não acha nada dentro de worktree no Windows: use filtro de diretório (`--filter "...{./apps/x}"`). O gate testa os dependentes assim. (orquestração)
- Mudar o seed (ex.: usuário novo) muda o que o reset do harness devolve: atualize `apps/api/src/e2e/e2e.db.unit.test.ts`. (T54)
- E2E: capture a URL só depois de ela estabilizar (redirect de home, replace de aba/filtro). Use `await expect(page).toHaveURL(...)` antes de guardar/recarregar; um `start` capturado cedo quebra sob carga. (T53)
- Search params do TanStack Router são um tipo unido entre todas as rotas: não reuse um nome com outro tipo (`?status=` já é do `/chats`; a lista de fluxos usa `?flow_status=`). (T44)
- dnd-kit marca item desabilitado com `aria-disabled` + `role="button"` e o Playwright passa a ver o menu interno como desabilitado: não registre no dnd o que o usuário não pode arrastar. (T44)
- Migrations: gere normalmente no worktree (os testes precisam); se o número colidir com outra tarefa, o gate regenera a sua sobre a main com o mesmo nome e confere que o SQL é o mesmo. Não edite à mão o `_journal.json` de outra tarefa nem renumere. Migration com SQL manual (que o drizzle-kit não gera) faz o gate PARAR: avise no relatório. (orquestração)
- Registry de editores de nó com `import.meta.glob`: os grupos não podem importar VALORES do registry (só `import type`) nem chamar `registerNodeEditor` no topo — o ciclo de import dá TDZ. (T56)
