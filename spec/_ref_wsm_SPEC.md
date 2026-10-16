# SPEC — WhatsApp Session Manager (execução orquestrada)

> Fonte: nota "WhatsApp Session Manager" (canvas Maestri). Esta spec converte a nota em tarefas
> executáveis por um **Orquestrador**, seus **Operários** (implementam) e **Testers** (validam).
> Todo critério de aceitação tem um ID `AC-Txx-nn` rastreável até um teste que passa.

---

## 0. Como ler esta spec

| Seção | Quem usa |
|---|---|
| 1. Papéis e regras | todos |
| 2. Protocolo de execução | Orquestrador |
| 3. Contratos globais (estados, códigos de erro, convenções) | Operários e Testers |
| 4. Grafo de tarefas (ondas) | Orquestrador |
| 5. Tarefas T00–T16 com critérios de aceitação | Operários e Testers |
| 6. Scripts de verificação | todos |
| 7. Prompts de despacho | Orquestrador |

Raiz do projeto: `wa-session-manager/`. A spec fica em `wa-session-manager/spec/`.
Referência do Baileys (somente leitura): `../Baileys/`.

---

## 1. Papéis e regras

### 1.1 Orquestrador (pai)
- **Não escreve código de produto nem testes.** Planeja, despacha, verifica e decide.
- Despacha tarefas por onda (seção 4), respeitando dependências.
- Para cada tarefa, despacha **em paralelo** um Operário (implementação) e um Tester (testes de aceitação).
- Roda `verify.mjs <Txx> --role operario` quando o Operário reporta `DONE`, e `--role tester` quando o Tester reporta `DONE`.
- Só marca uma tarefa como `ACCEPTED` quando **os dois** scripts terminam com exit code 0.
- Mantém `spec/STATUS.md` atualizado (fonte da verdade do andamento).
- Após **3 ciclos de rejeição** na mesma tarefa, escala para o humano com o relatório em `spec/reports/`.

### 1.2 Operário
- Implementa **uma tarefa por vez**, apenas dentro dos `paths` declarados da tarefa (seção 5).
- **Não edita** `tests/acceptance/**`; esses arquivos pertencem ao Tester.
- Escreve testes unitários próprios em `**/*.unit.test.ts` junto do código.
- Antes de reportar `DONE`, roda `node spec/verify/verify.mjs <Txx> --role operario`, que precisa passar.
- Se um critério de aceitação estiver ambíguo, reporta `BLOCKED` com a pergunta. Não inventa requisito.

### 1.3 Tester
- Escreve testes de aceitação **a partir dos critérios**, não da implementação (caixa-preta sempre que possível).
- Arquivos em `tests/acceptance/Txx/*.test.ts`. **Todo teste de aceitação inclui o ID `AC-Txx-nn` no título.**
- Um critério só está coberto se tiver ≥ 1 teste com o ID no título e status `passed`.
- **Não edita** código de produto (`apps/**`, `packages/**`). Se achar bug, reporta `REJECT` com evidência.
- Nenhum teste conecta ao WhatsApp real: usa sempre o `FakeTransport` (T04).
- Antes de reportar `DONE`, roda `node spec/verify/verify.mjs <Txx> --role tester`.

### 1.4 Regras invioláveis (valem para todo código)
1. Credenciais do WhatsApp **nunca** em texto puro (DB, logs, arquivos, respostas da API).
2. Nenhum envio fora do pipeline do Motor de Segurança (T09). `transport.sendMessage` só pode ser chamado em `packages/core/src/send/`.
3. Nenhum envio para contato com `opt_out = true` ou sem consentimento registrado.
4. O sistema **para** a sessão diante de sinais anormais. Nunca aumenta atividade automaticamente para compensar.
5. Proibido: entrar em grupos automaticamente, fabricar conversas, gerar mensagens artificiais para "aquecer" ou alterar reputação.
6. Proibido prometer segurança contra ban em UI, API, logs ou docs ("seguro contra ban", "imune a ban", "ban-proof", "anti-ban garantido"). O Health Score é **apenas** um indicador operacional.

---

## 2. Protocolo de execução (Orquestrador)

### 2.1 Ciclo de vida de uma tarefa
```text
TODO ──dispatch──▶ IN_PROGRESS ──operário DONE──▶ VERIFYING ──ambos verify OK──▶ ACCEPTED
                        ▲                              │
                        └────────── REJECTED ◀─────────┘   (falha em verify ou REJECT do tester)
                   BLOCKED (pergunta pendente ao orquestrador/humano)
```

### 2.2 Passo a passo por onda
1. Selecionar as tarefas da onda cujas dependências estão `ACCEPTED`.
2. Para cada tarefa: despachar o Operário e o Tester em paralelo (prompts da seção 7), com `maestri ask --batch`.
3. Quando o Operário reportar `DONE`, rodar `node spec/verify/verify.mjs Txx --role operario`.
   - Falhou → `REJECTED`, reenviar ao Operário a saída do script e `spec/reports/Txx-operario.json`.
4. Quando o Tester reportar `DONE`, rodar `node spec/verify/verify.mjs Txx --role tester`.
   - Teste de aceitação falhando por bug de produto → `REJECTED` para o Operário.
   - Critério sem cobertura ou teste mal escrito → devolver ao Tester.
5. Ambos com exit 0 → `ACCEPTED`. Atualizar `STATUS.md`. Seguir para a próxima tarefa ou onda.
6. Ao fim de cada onda, rodar `node spec/verify/verify.mjs wave <n>` (regressão: todas as tarefas aceitas até ali).

### 2.3 Formato de reporte (Operário e Tester → Orquestrador)
```text
<STATUS> Txx <papel>
STATUS: DONE | BLOCKED | REJECT
Arquivos alterados: <lista>
Verify: <exit code> (<comando>)
Notas: <decisões, desvios, perguntas>
```
Envio: `maestri ask "Orquestrador" "<mensagem>"`.

### 2.4 Paralelismo e conflitos
- Duas tarefas da mesma onda só rodam em paralelo se seus `paths` não se sobrepuserem (a tabela da seção 4 já considera isso).
- Arquivos compartilhados (lista exata em `SHARED_PATHS` de `spec/verify/tasks.mjs`: `package.json`s, `pnpm-lock.yaml`, `docker-compose.yml`, `.env.example`, `docs/**`, `packages/db/src/schema/**` e migrations, e os pontos de registro `apps/api/src/app.ts`, `apps/api/src/routes/index.ts`, `apps/worker/src/index.ts`, `packages/core/src/index.ts`) só podem ser alterados de forma aditiva. Em caso de conflito, o Orquestrador serializa.
- Tarefas que precisam de novas tabelas ou colunas (ex.: `suggestions` no T13) adicionam ao schema do `@wsm/db` com uma migration nova. Nunca editam uma migration existente.
- **Checagem de escopo:** numa working tree compartilhada, o verify só *avisa* sobre arquivos fora do escopo, porque alterações de outras tarefas aparecem no diff. Para torná-la bloqueante, cada agente trabalha num worktree/branch próprio e o Orquestrador roda o verify com `--base <commit-de-partida>` (ou `--strict-scope`).

---

## 3. Contratos globais

### 3.1 Estrutura do repositório
```text
wa-session-manager/
├── apps/
│   ├── api/          # Hono (HTTP)
│   ├── worker/       # sessões Baileys, filas, monitor de saúde, alertas
│   └── dashboard/    # React + Vite
├── packages/
│   ├── core/         # domínio: transport, estados, segurança, warm-up, health
│   └── db/           # Drizzle schema, migrations, client
├── tests/acceptance/ # propriedade dos Testers (Txx/*.test.ts)
├── spec/             # esta spec, verify, status, reports
├── docker-compose.yml
└── .env.example
```
Gerenciador: **pnpm workspaces**. Testes: **Vitest**. Node ≥ 20. TypeScript `strict: true`.
Nomes dos pacotes: `@wsm/api`, `@wsm/worker`, `@wsm/dashboard`, `@wsm/core`, `@wsm/db`.

### 3.2 Estados da sessão (fonte única: `packages/core/src/session/states.ts`)
| Estado | Indicador | Significado |
|---|---|---|
| `NEW` | ⚫ | criada, ainda não autenticada |
| `WARMING` | 🟡 Warm-up | conectada, dentro do período de warm-up |
| `STABLE` | 🟢 Connected | conectada, warm-up concluído |
| `DEGRADED` | 🟠 Degraded | conectada, health score em alerta |
| `PAUSED` | 🔴 Paused | envio suspenso (manual ou automático) |
| `DISCONNECTED` | ⚫ Disconnected | sem conexão / deslogada |

Transições permitidas:
```text
NEW → WARMING                       (autenticou)
WARMING → STABLE                    (warm-up 100%)
WARMING|STABLE → DEGRADED           (health < limiar de alerta)
DEGRADED → WARMING|STABLE           (health recuperado; volta ao estado anterior)
WARMING|STABLE|DEGRADED → PAUSED    (pausa manual ou automática)
PAUSED → WARMING|STABLE             (somente resume manual)
* → DISCONNECTED                    (logout, loggedOut, falha definitiva)
DISCONNECTED → NEW                  (re-autenticação)
```
Transição inválida → erro `INVALID_TRANSITION` (HTTP 409).

### 3.3 Estados da mensagem
`queued → processing → sent → delivered → read`, com `failed`, `retrying` e `cancelled`.
Toda transição grava uma linha em `message_events`.

### 3.4 Códigos de erro da API
| Código | HTTP | Quando |
|---|---|---|
| `UNAUTHORIZED` | 401 | token ausente ou inválido |
| `VALIDATION_ERROR` | 400 | body/params inválidos (zod) |
| `SESSION_NOT_FOUND` | 404 | sessão inexistente |
| `SESSION_NOT_CONNECTED` | 409 | sessão fora de `WARMING`/`STABLE` |
| `INVALID_TRANSITION` | 409 | transição de estado não permitida |
| `PROXY_IN_USE` | 409 | proxy já vinculado a outra sessão |
| `CONTACT_NOT_ALLOWED` | 403 | opt-out ou sem consentimento |
| `WARMUP_LIMIT` | 429 | limite diário de warm-up atingido |
| `RATE_LIMIT` | 429 | limite de taxa atingido |
| `GROUP_NOT_FOUND` | 404 | grupo inexistente para a sessão (T20) |
| `NOT_GROUP_ADMIN` | 403 | a sessão não é admin do grupo (T20) |

Formato de erro: `{ "error": { "code": "…", "message": "…", "details"?: … } }`.

### 3.5 Variáveis de ambiente (mínimo)
`DATABASE_URL`, `REDIS_URL`, `API_TOKEN`, `CREDENTIALS_KEY` (32 bytes em base64), `LOG_LEVEL`,
`AI_PROVIDER_API_KEY` (opcional), `AI_MODEL_SMALL`, `AI_MODEL_LARGE`, `SMTP_URL` (opcional).

---

## 4. Grafo de tarefas (ondas)

| Onda | Tarefa | Título | Depende de |
|---|---|---|---|
| 0 | T00 | Scaffold do monorepo e infraestrutura | — |
| 1 | T01 | Schema do banco (Drizzle) | T00 |
| 1 | T03 | Esqueleto da API (Hono, auth, audit, erros) | T00 |
| 1 | T04 | Abstração de transporte (Baileys + Fake) | T00 |
| 2 | T02 | Criptografia de credenciais e auth state no Postgres | T01, T04 |
| 2 | T06 | Gerenciamento de proxies | T01, T03 |
| 2 | T07 | Contatos e consentimento | T01, T03 |
| 3 | T05 | Session Manager | T02, T03, T04, T06 |
| 4 | T08 | Fila de mensagens por sessão | T05, T07 |
| 4 | T10 | Warm-up e Health Monitor | T05 |
| 5 | T09 | Motor de segurança (pipeline de envio) | T07, T08, T10 |
| 5 | T11 | Alertas | T10, T06 |
| 5 | T14 | Grupos (somente leitura e ações manuais) | T05 |
| 6 | T13 | IA assistiva (sugestão + aprovação humana) | T09 |
| 6 | T15 | Observabilidade | T08, T10 |
| 6 | T12 | Dashboard | T05, T06, T07, T08, T10, T11, T14 |
| 7 | T16 | Integração E2E e Docker Compose completo | todas |
| 8 | T17 | Login admin e proxy na sessão (API) | T03, T05, T06 |
| 8 | T18 | Dashboard: login admin e proxy no cadastro | T17 (contrato), T12 |
| 8 | T19 | Configurações do modelo de LLM | T13, T12 |
| 8 | T20 | Adicionar número a grupo (manual) | T14, T16, T18 |
| 8 | T21 | Redesign do dashboard | T12, T18, T19 |
| 8 | T22 | Chip pessoal / conexão direta | T21, T18 |

---

## 5. Tarefas

> Formato: **Objetivo**, **Paths** (onde o Operário pode escrever), **Entregáveis**, **Critérios de aceitação**,
> **Notas para o Tester**. Os comandos de verificação ficam em `spec/verify/tasks.mjs`.

---

### T00 — Scaffold do monorepo e infraestrutura
**Objetivo:** base do projeto que todas as outras tarefas usam.
**Paths:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig*.json`, `eslint.config.*`, `.prettierrc`, `.gitignore`, `.env.example`, `docker-compose.yml`, `apps/*/package.json`, `apps/*/tsconfig.json`, `apps/*/src/index.ts*`, `packages/*/package.json`, `packages/*/tsconfig.json`, `packages/*/src/index.ts`, `apps/*/Dockerfile`, `vitest.workspace.ts`
**Entregáveis:** workspaces `apps/api`, `apps/worker`, `apps/dashboard`, `packages/core`, `packages/db`. Cada um com os scripts `build`, `typecheck`, `lint` e `test`. `git init` com commit inicial.

**Critérios de aceitação**
- **AC-T00-01** `pnpm install` seguido de `pnpm -r build` termina com exit 0.
- **AC-T00-02** Os 5 workspaces existem e cada `package.json` tem os scripts `build`, `typecheck`, `lint` e `test`.
- **AC-T00-03** `docker compose config` é válido e declara os serviços `dashboard`, `api`, `worker`, `postgres` e `redis`.
- **AC-T00-04** `.env.example` contém todas as variáveis da seção 3.5, sem nenhum valor secreto real.
- **AC-T00-05** `tsconfig` base com `strict: true` herdado por todos os workspaces.

**Notas para o Tester:** criar `tests/acceptance/vitest.config.ts` (config compartilhada da suíte) e `tests/acceptance/helpers/` (exec de comandos, cliente HTTP, factories). Os testes de T00 podem usar `execSync`.

---

### T01 — Schema do banco (Drizzle)
**Objetivo:** modelo de dados persistente.
**Paths:** `packages/db/**`
**Entregáveis:** schema Drizzle, migrations SQL versionadas, `createDb(url)` e script `pnpm --filter @wsm/db migrate`.

**Critérios de aceitação**
- **AC-T01-01** Migrations criam as tabelas `sessions`, `session_credentials`, `proxies`, `contacts`, `messages`, `message_events`, `health_events`, `webhooks` e `audit_logs`.
- **AC-T01-02** Um proxy só pode ser vinculado a uma sessão (`sessions.proxy_id` único quando não nulo). Inserção duplicada falha no banco.
- **AC-T01-03** `session_credentials` não tem coluna de texto puro para credenciais: só `ciphertext`, `iv`, `auth_tag`, `key_version`, `updated_at` e a chave (`session_id`, `key_type`, `key_id`).
- **AC-T01-04** Rodar as migrations duas vezes seguidas num banco vazio termina sem erro (idempotência).
- **AC-T01-05** `contacts.phone` é único (formato E.164). `opt_out` é boolean com default `false`. Existem `consent`, `consent_at`, `consent_source` e `last_contact_at`.
- **AC-T01-06** `sessions.status` só aceita os valores da seção 3.2, e `messages.status` só os da seção 3.3 (enum ou check constraint).

**Notas para o Tester:** usar o Postgres do `docker compose` com um banco descartável por suíte. Validar constraints com inserts reais.

---

### T02 — Criptografia de credenciais e auth state no Postgres
**Objetivo:** substituir o `useMultiFileAuthState` do Baileys por um auth state cifrado no Postgres.
**Paths:** `packages/core/src/crypto/**`, `packages/core/src/auth-state/**`, `packages/core/src/logger/**`
**Entregáveis:** logger pino compartilhado com redação, `encrypt/decrypt` (AES-256-GCM) e `usePostgresAuthState(db, sessionId)` compatível com o `AuthenticationState` do Baileys (ver `../Baileys/src/Utils/use-multi-file-auth-state.ts`).

**Critérios de aceitação**
- **AC-T02-01** `decrypt(encrypt(x)) === x` para strings e buffers. A chave vem de `CREDENTIALS_KEY` (32 bytes base64). Chave ausente ou inválida lança erro na inicialização.
- **AC-T02-02** Um ciphertext, IV ou auth tag adulterado faz `decrypt` lançar erro (nunca devolve lixo).
- **AC-T02-03** `usePostgresAuthState` implementa `state.creds`, `state.keys.get` e `state.keys.set` (incluindo `null` para remover) e `saveCreds`. Após recriar o objeto (simulando restart), o estado é recarregado idêntico.
- **AC-T02-04** Um valor marcador salvo como credencial não aparece em nenhuma coluna ao ler a tabela `session_credentials` crua.
- **AC-T02-05** O logger redige credenciais: logar um objeto com `creds`, `keys`, `noiseKey` ou `signedIdentityKey` não produz o valor no output.

---

### T03 — Esqueleto da API (Hono)
**Objetivo:** servidor HTTP com autenticação, validação, auditoria e erros padronizados.
**Paths:** `apps/api/**`
**Entregáveis:** app Hono exportável (`createApp(deps)`) para testes sem porta, `GET /health`, middleware de auth, handler de erros (seção 3.4) e middleware de auditoria.

**Critérios de aceitação**
- **AC-T03-01** `GET /health` → 200 `{ status: "ok", db: "ok"|"down", redis: "ok"|"down" }`, sem exigir auth.
- **AC-T03-02** Toda rota `/api/*` sem `Authorization: Bearer <API_TOKEN>` válido → 401 `UNAUTHORIZED`.
- **AC-T03-03** Body inválido → 400 `VALIDATION_ERROR` com `details` indicando o campo.
- **AC-T03-04** Toda requisição mutante (`POST`/`PUT`/`PATCH`/`DELETE`) bem-sucedida grava em `audit_logs` (`actor`, `action`, `target_type`, `target_id`, `created_at`).
- **AC-T03-05** Logs em JSON (pino) com `request_id`. A resposta devolve o header `x-request-id`.

---

### T04 — Abstração de transporte (Baileys + Fake)
**Objetivo:** isolar o Baileys atrás de uma interface para testar tudo sem WhatsApp real.
**Paths:** `packages/core/src/transport/**`
**Entregáveis:** interface `WaTransport`, `BaileysTransport` e `FakeTransport`.

```ts
interface WaTransport {
  connect(opts: { sessionId: string; auth: AuthenticationState; proxyUrl?: string; pairingPhone?: string }): Promise<void>
  on(event: 'qr', cb: (qr: string) => void): void
  on(event: 'pairing-code', cb: (code: string) => void): void
  on(event: 'connection', cb: (u: { state: 'open' | 'close'; reason?: 'loggedOut' | 'forbidden' | 'transient'; statusCode?: number }) => void): void
  on(event: 'message', cb: (m: IncomingMessage) => void): void
  on(event: 'receipt', cb: (r: { messageId: string; status: 'delivered' | 'read' }) => void): void
  sendMessage(to: string, content: OutgoingContent): Promise<{ messageId: string }>
  fetchGroups(): Promise<GroupSummary[]>
  logout(): Promise<void>
  close(): Promise<void>
}
```

**Critérios de aceitação**
- **AC-T04-01** `FakeTransport` expõe helpers de simulação: `emitQr`, `emitPairingCode`, `open()`, `close(reason, statusCode?)`, `receive(msg)`, `receipt(id, status)`, `failNextSend(err)`, e registra os envios em `sent[]`.
- **AC-T04-02** `BaileysTransport` mapeia o `DisconnectReason` do Baileys: `loggedOut` → `loggedOut`, 403 → `forbidden` e o resto → `transient`.
- **AC-T04-03** Com `proxyUrl` (http/https/socks5), `BaileysTransport` passa o agente de proxy nas opções `agent` e `fetchAgent` do socket. Sem `proxyUrl`, nenhum agente é passado.
- **AC-T04-04** Nenhum arquivo em `tests/**` importa `@whiskeysockets/baileys` diretamente nem abre socket real.

---

### T05 — Session Manager
**Objetivo:** criar, autenticar, persistir, reconectar e controlar sessões (seção 4 da nota).
**Paths:** `packages/core/src/session/**`, `apps/worker/src/sessions/**`, `apps/api/src/routes/sessions*`
**Entregáveis:** máquina de estados (seção 3.2), `SessionManager` no worker e rotas da API.

**Critérios de aceitação**
- **AC-T05-01** `POST /api/sessions {name, phone, proxyId?, note?}` → 201 com a sessão em `NEW`. Telefone fora do E.164 → 400.
- **AC-T05-02** `POST /api/sessions/:id/qr` inicia a conexão e `GET /api/sessions/:id/qr` devolve o QR mais recente (data URL). `POST /api/sessions/:id/pairing-code` devolve o código de pareamento.
- **AC-T05-03** Ao abrir a conexão: estado `WARMING`, credenciais persistidas cifradas (T02), `health_event` `connected` gravado e monitoramento iniciado.
- **AC-T05-04** Ao reiniciar o worker, toda sessão com credenciais e estado ≠ `DISCONNECTED`/`PAUSED` reconecta sozinha. Sessões `PAUSED` reconectam mas continuam `PAUSED`.
- **AC-T05-05** `close(loggedOut)` → `DISCONNECTED`, sem reconexão. `close(forbidden)` → `PAUSED` com `health_event` `forbidden_403`. `close(transient)` → reconexão com backoff exponencial (máx. 5 tentativas, depois `DISCONNECTED`).
- **AC-T05-06** `POST /api/sessions/:id/{pause|resume|restart|logout}` respeita as transições da seção 3.2. Transição inválida → 409 `INVALID_TRANSITION`.
- **AC-T05-07** `GET /api/sessions` e `GET /api/sessions/:id` nunca retornam credenciais nem campos cifrados.

**Notas para o Tester:** injetar `FakeTransport` via factory de transporte do worker. Simular restart recriando o `SessionManager` com o mesmo banco.

---

### T06 — Gerenciamento de proxies
**Objetivo:** configuração de rede por sessão sem atribuição acidental errada (seção 5 da nota).
**Paths:** `packages/core/src/proxy/**`, `apps/api/src/routes/proxies*`, `apps/worker/src/proxy/**`
**Critérios de aceitação**
- **AC-T06-01** CRUD em `/api/proxies`. A senha do proxy é armazenada cifrada e a API retorna a URL mascarada (`http://user:***@host:port`).
- **AC-T06-02** Vincular a uma sessão um proxy já vinculado a outra → 409 `PROXY_IN_USE`.
- **AC-T06-03** Trocar o proxy de uma sessão atualiza `last_changed_at`, grava `audit_logs` e marca a sessão como "requer restart". A mudança só vale após restart.
- **AC-T06-04** O verificador periódico registra `available`, `last_check_at`, `last_error` e o contador de erros. Proxy indisponível emite o evento `proxy_unavailable`.
- **AC-T06-05** Sessão com proxy configurado **nunca** conecta sem proxy: se o proxy estiver indisponível, a conexão falha e a sessão fica `DISCONNECTED` (sem fallback para conexão direta).

---

### T07 — Contatos e consentimento
**Objetivo:** só contatos autorizados recebem mensagens (seção 9 da nota).
**Paths:** `packages/core/src/contacts/**`, `apps/api/src/routes/contacts*`, `apps/worker/src/optout/**`
**Critérios de aceitação**
- **AC-T07-01** CRUD em `/api/contacts` com `name`, `phone`, `consent`, `consent_at`, `consent_source`, `opt_out` e `last_contact_at`.
- **AC-T07-02** `POST /api/contacts/import` (CSV) importa só linhas com `consent=true`, `consent_at` e `consent_source`. As demais voltam em `rejected[]` com o motivo.
- **AC-T07-03** Mensagem recebida cujo texto normalizado é uma palavra de opt-out (`SAIR`, `PARAR`, `STOP`, `CANCELAR`, configurável) marca `opt_out=true` e grava auditoria.
- **AC-T07-04** `canMessage(contact)` retorna `{ ok: false, reason }` quando `opt_out=true`, quando `consent=false` ou quando o contato não existe.
- **AC-T07-05** Reverter opt-out só acontece por ação manual autenticada, com registro de novo consentimento (`consent_at` atualizado).

---

### T08 — Fila de mensagens por sessão
**Objetivo:** envio serializado por sessão com ciclo de vida rastreável (seção 8 da nota).
**Paths:** `packages/core/src/queue/**`, `packages/core/src/send/deliver.ts`, `apps/worker/src/queue/**`, `apps/api/src/routes/messages*`
**Nota:** `send/deliver.ts` é o ponto único que chama `transport.sendMessage`. O T09 o envolve com o pipeline e o `AntibanAdapter`.
**Critérios de aceitação**
- **AC-T08-01** Uma fila BullMQ por sessão (`session:<id>`) com concorrência 1: duas mensagens da mesma sessão nunca são processadas ao mesmo tempo.
- **AC-T08-02** Transições `queued→processing→sent` gravam `message_events` com timestamp. Receipts do transporte levam a `delivered` e depois `read`.
- **AC-T08-03** Falha no envio → `retrying` (máx. 3 tentativas, backoff exponencial). Esgotadas as tentativas → `failed` com `last_error`.
- **AC-T08-04** `POST /api/messages/:id/cancel` numa mensagem `queued` → `cancelled`, e ela nunca chega ao transporte. Numa mensagem já `sent` → 409.
- **AC-T08-05** Sessão `PAUSED`: a fila fica pausada e os jobs continuam `queued`. No resume, o processamento retoma na ordem.
- **AC-T08-06** O worker só entrega ao transporte via `packages/core/src/send/` (ponto único, T09).

---

### T09 — Motor de segurança (pipeline de envio)
**Objetivo:** todo envio passa por verificações em ordem fixa (seção 7 da nota).
**Paths:** `packages/core/src/send/**`, `packages/core/src/safety/**`, `packages/core/src/antiban/**`, `apps/api/src/routes/messages*`
**Entregáveis:** `SendPipeline` com os gates `auth → sessionExists → connected → contactAllowed → warmupLimit → rateLimit → enqueue`, e o `AntibanAdapter` que envolve o `baileys-antiban`.

**Critérios de aceitação**
- **AC-T09-01** Os gates rodam na ordem acima e o primeiro que falha interrompe a cadeia com o código da seção 3.4. Teste com gates espiões comprova ordem e curto-circuito.
- **AC-T09-02** `POST /api/sessions/:id/messages` passa pelo pipeline. Cada rejeição devolve o HTTP e o código corretos (`SESSION_NOT_FOUND`, `SESSION_NOT_CONNECTED`, `CONTACT_NOT_ALLOWED`, `WARMUP_LIMIT` ou `RATE_LIMIT`).
- **AC-T09-03** Todo envio efetivo passa pelo `AntibanAdapter` (delays/limites do `baileys-antiban`). Se a API real do pacote divergir do esperado, o Operário documenta em `docs/antiban.md` e mantém a interface do adapter.
- **AC-T09-04** `transport.sendMessage(` só aparece em `packages/core/src/send/` (checado pelo script de verificação).
- **AC-T09-05** Os limites são configuráveis por sessão com defaults conservadores. O sistema pode **reduzir** limites automaticamente, mas nunca **aumentá-los** além do cronograma de warm-up.

---

### T10 — Warm-up e Health Monitor
**Objetivo:** acompanhar a saúde e pausar diante de deterioração (seções 6 e 7 da nota).
**Paths:** `packages/core/src/warmup/**`, `packages/core/src/health/**`, `apps/worker/src/health/**`, `apps/api/src/routes/health-session*`
**Critérios de aceitação**
- **AC-T10-01** O progresso do warm-up (0–100%) é função da idade da sessão e do cronograma configurado (baseado no `baileys-antiban`). O limite diário acompanha o cronograma. Em 100%, a sessão vai `WARMING → STABLE`.
- **AC-T10-02** Health Score de 0 a 100 calculado a partir de falhas, desconexões, eventos 403, taxa de resposta e tendência de erros. Rótulos: `Good` (≥ 70), `Warning` (40–69) e `Critical` (< 40). Função pura, testada com tabela de casos.
- **AC-T10-03** Score < 70 → `DEGRADED`. Score < 40 **ou** qualquer 403 → `PAUSED` automático, fila pausada e `health_event` + evento de alerta. O resume é **somente manual**.
- **AC-T10-04** `GET /api/sessions/:id/health` devolve `{ state, warmupPercent, score, label, sent, received, failed, disconnects, forbidden403, lastEventAt }`.
- **AC-T10-05** Nenhum texto em `apps/**` ou `packages/**` promete imunidade a ban (checado pelo script de verificação).

---

### T11 — Alertas
**Objetivo:** notificar eventos críticos (seção 13 da nota).
**Paths:** `packages/core/src/alerts/**`, `apps/worker/src/alerts/**`, `apps/api/src/routes/webhooks*`
**Critérios de aceitação**
- **AC-T11-01** Eventos alertáveis: `forbidden_403`, `disconnected`, `error_burst`, `proxy_unavailable`, `warmup_paused` e `health_degraded`.
- **AC-T11-02** Canais: Discord webhook, Telegram (bot API), email (SMTP) e webhook HTTP genérico, configurados na tabela `webhooks` (CRUD em `/api/webhooks`).
- **AC-T11-03** O webhook HTTP genérico envia o header `x-wsm-signature` (HMAC-SHA256 do body com o segredo do webhook).
- **AC-T11-04** Deduplicação: o mesmo `(evento, sessão)` não é reenviado por 10 minutos (configurável).
- **AC-T11-05** Falha de entrega é logada e reenviada (máx. 3 tentativas) sem derrubar o worker.

**Notas para o Tester:** subir um servidor HTTP local no teste para receber os webhooks. Discord/Telegram/SMTP via URL base configurável apontando para esse mock.

---

### T12 — Dashboard
**Objetivo:** UI React (seções 3, 4, 12 e 13 da nota).
**Paths:** `apps/dashboard/**`
**Critérios de aceitação**
- **AC-T12-01** Login com API token (guardado em memória/sessionStorage). Sem token, toda rota redireciona ao login.
- **AC-T12-02** A home exibe os 8 cards: conectadas, desconectadas, em warm-up, com risco elevado, enviadas, recebidas, falhas e último evento.
- **AC-T12-03** A lista de sessões mostra o indicador de estado conforme o mapeamento da seção 3.2.
- **AC-T12-04** "+ Adicionar número" abre o formulário (Nome, Número, Proxy/IP, Observação) com os botões "Gerar QR Code" e "Gerar Pairing Code". O QR/código é exibido e atualizado até conectar.
- **AC-T12-05** O detalhe da sessão tem o card da seção 12 da nota (Connected, Warm-up, Health, Sent, Received, Failed, Disconnects e os botões Pause/Restart/Logs) e os gráficos: mensagens/hora, mensagens/dia, recebidas vs enviadas, falhas, desconexões, latência e estado.
- **AC-T12-06** Existem as páginas Proxies, Contatos (com import CSV), Grupos e Alertas/Webhooks.
- **AC-T12-07** `pnpm --filter dashboard build` passa e o smoke E2E (Playwright) contra a API com `FakeTransport` passa.

---

### T13 — IA assistiva
**Objetivo:** classificar mensagens recebidas e sugerir respostas com aprovação humana (seção 10 da nota).
**Paths:** `packages/core/src/ai/**`, `apps/worker/src/ai/**`, `apps/api/src/routes/suggestions*`
**Critérios de aceitação**
- **AC-T13-01** Fluxo: mensagem recebida → classificação → intenção → resposta sugerida salva como `pending_approval`. **Nada é enviado sem aprovação.**
- **AC-T13-02** `POST /api/suggestions/:id/approve` (texto opcionalmente editado) envia pelo `SendPipeline` (T09). `reject` descarta.
- **AC-T13-03** Roteador de modelos: `AI_MODEL_SMALL` por padrão; `AI_MODEL_LARGE` só quando a confiança fica abaixo do limiar configurado. Limite de tokens configurável.
- **AC-T13-04** Cache por hash do texto normalizado: mensagem repetida não chama o provedor de novo.
- **AC-T13-05** Erro ou timeout do provedor leva ao fallback determinístico (respostas por regra/template), sem exceção não tratada.
- **AC-T13-06** A IA só gera sugestão a partir de uma mensagem recebida real. Não existe caminho de código que gere mensagens sem gatilho de entrada.

---

### T14 — Grupos
**Objetivo:** visualização e gestão manual de grupos (seção 11 da nota).
**Paths:** `packages/core/src/groups/**`, `apps/api/src/routes/groups*`
**Critérios de aceitação**
- **AC-T14-01** `GET /api/sessions/:id/groups` lista `{ id, name, participants, status }` via `transport.fetchGroups()`.
- **AC-T14-02** Toda ação sobre grupo é manual, autenticada e auditada.
- **AC-T14-03** Não existe entrada automática em grupos: `groupAcceptInvite` não aparece no código (checado pelo script de verificação).

---

### T15 — Observabilidade
**Paths:** `packages/core/src/observability/**`, `apps/*/src/observability/**`, `docker-compose.yml` (healthchecks, só aditivo)
**Critérios de aceitação**
- **AC-T15-01** `GET /metrics` (formato Prometheus) expõe `wsm_messages_sent_total{session}`, `wsm_messages_failed_total{session}`, `wsm_disconnects_total{session}`, `wsm_queue_depth{session}`, `wsm_send_latency_seconds` (histograma) e `wsm_session_state{session,state}`.
- **AC-T15-02** Todos os serviços do compose têm `healthcheck`.
- **AC-T15-03** Os logs de worker e api são JSON e incluem `session_id` quando aplicável, com redação de credenciais (reusa T02).

---

### T16 — Integração E2E
**Objetivo:** provar o sistema montado. Tarefa principalmente do Tester. O Operário corrige integrações.
**Paths (Operário):** `docker-compose.yml`, `apps/*/Dockerfile`, `apps/*/src/**` (só correções de integração)
**Critérios de aceitação**
- **AC-T16-01** `docker compose up -d --wait` deixa os 5 serviços healthy em ≤ 120 s.
- **AC-T16-02** Fluxo completo com `FakeTransport` (`WA_TRANSPORT=fake`): criar sessão → QR → conectar → cadastrar contato consentido → enviar → `sent` → `delivered`.
- **AC-T16-03** Fluxo de risco: sessão conectada recebe 403 → `PAUSED` → webhook de alerta recebido → envio seguinte rejeitado com `SESSION_NOT_CONNECTED`.
- **AC-T16-04** Fluxo de opt-out: contato envia "SAIR" → `opt_out=true` → envio seguinte rejeitado com `CONTACT_NOT_ALLOWED`.
- **AC-T16-05** Restart do container `worker` → sessões reconectam e a fila retoma sem perder nem duplicar mensagens.


---

### T17 — Login de administrador e proxy dentro da sessão (API)
**Origem:** pedido do humano em 2026-09-24, depois da entrega das 17 tarefas. O proxy passa a ser configurado junto com a sessão (sem cadastro separado), e o login do painel passa a ser por usuário e senha.
**Paths:** `apps/api/src/auth/**`, `apps/api/src/middleware/auth*`, `apps/api/src/routes/auth*`, `apps/api/src/routes/sessions*`, `apps/api/src/config.ts` (aditivo), `packages/core/src/proxy/**` (aditivo), `packages/core/src/session/**` (aditivo), `.env.example` (aditivo), `docs/auth.md`
**Critérios de aceitação**
- **AC-T17-01** `POST /api/auth/login {username, password}` é público. As credenciais vêm de `ADMIN_USERNAME` e `ADMIN_PASSWORD`, com default `admin` / `nimda`.
  - Credenciais certas → 200 `{ token, expiresAt, user: { username, role: 'admin' } }`.
  - Credenciais erradas → 401 `UNAUTHORIZED`, com a mesma mensagem para usuário ou senha errados. A comparação é em tempo constante.
  - 5 falhas em 15 min pelo mesmo IP → 429 `RATE_LIMIT`.
  - O login é auditado, sem registrar a senha.
  - Se `ADMIN_PASSWORD` não estiver definido, o boot loga um warn dizendo que está usando a senha padrão.
- **AC-T17-02** O token de login é assinado (HMAC-SHA256 com `AUTH_SECRET`) e expira em `AUTH_SESSION_TTL_MS` (default 12 h).
  - Sem `AUTH_SECRET`, gera um segredo aleatório por processo e loga um warn: os tokens deixam de valer após restart.
  - `/api/*` aceita `Bearer <token de login>` **ou** `Bearer <API_TOKEN>`; o `API_TOKEN` continua valendo para integrações e para o AC-T03-02.
  - Token expirado, adulterado ou revogado → 401.
  - `GET /api/auth/me` devolve o usuário.
  - `POST /api/auth/logout` revoga o token até a expiração dele.
- **AC-T17-03** `POST /api/sessions` aceita o proxy inline: `proxy: { protocol: 'http'|'https'|'socks5', host, port, username?, password? }`.
  - O proxy é criado (senha cifrada, T06) e vinculado à sessão **na mesma transação**.
  - Proxy inválido → 400 `VALIDATION_ERROR`, e a sessão não é criada.
  - `proxy` junto com `proxyId` → 400.
  - Sem proxy, a sessão é criada sem proxy (como hoje).
- **AC-T17-04** `PATCH /api/sessions/:id { name?, note?, proxy?: {…} | null }` edita a sessão. Trocar ou remover o proxy:
  - marca `requires_restart` e gera auditoria, como no T06;
  - apaga o proxy antigo que ficou sem uso;
  - sessão inexistente → 404.
- **AC-T17-05** `GET /api/sessions` e `GET /api/sessions/:id` trazem `proxy: { id, protocol, host, port, username, hasPassword } | null`. Nunca a senha, nem cifrada. As rotas `/api/proxies` continuam funcionando (compatibilidade), mas deixam de ser o caminho principal.
- **AC-T17-06** Continua valendo: conexão só pelo proxy da sessão, sem fallback direto (T06). As suítes T03, T05, T06 e T16 continuam verdes.

### T18 — Dashboard: login de administrador e proxy no cadastro da sessão
**Paths:** `apps/dashboard/**`
**Substitui:** o AC-T12-01 (login por API token) e a parte "Proxies" do AC-T12-06. O Tester do T18 atualiza `tests/acceptance/T12/**` nesses pontos.
**Critérios de aceitação**
- **AC-T18-01** Tela de login com **Usuário** e **Senha**, que chama `POST /api/auth/login`.
  - O token fica em memória e em sessionStorage (`wsm.token`), nunca em localStorage.
  - Erro de credencial aparece na tela.
  - Sem token, ou com qualquer 401, volta ao login.
  - "Sair" chama `/api/auth/logout`.
- **AC-T18-02** "+ Adicionar número" com os campos: **Nome**, **Número**, **Proxy** (Protocolo, IP/Host, Porta, Usuário, Senha, todos opcionais em bloco) e **Observação**, mais os botões "Gerar QR Code" e "Gerar Pairing Code".
  - A sessão é criada com o proxy inline (AC-T17-03).
  - Proxy incompleto (host sem porta etc.) é validado no cliente.
- **AC-T18-03** A página **Proxies** sai da navegação.
  - O detalhe da sessão mostra o proxy (senha mascarada) e permite editar ou remover via `PATCH` (AC-T17-04), avisando que exige restart.
  - A lista de sessões mostra o IP do proxy de cada número.
- **AC-T18-04** `pnpm --filter @wsm/dashboard build` passa. O smoke Playwright passa: login admin/nimda → adicionar número com proxy → QR → conectado → detalhe mostra o proxy.


### T19 — Configurações do modelo de LLM (painel)
**Origem:** pedido do humano em 2026-09-24: uma seção no painel para configurar a API e as opções do modelo de LLM usado pela IA assistiva (T13).
**Paths:** `packages/core/src/ai/**` (aditivo), `apps/worker/src/ai/**`, `apps/worker/src/boot/**` (só o ponto de ligação da IA), `apps/api/src/routes/ai-settings*`, `packages/db/src/schema/**` + `packages/db/drizzle/**` (migration aditiva), `apps/dashboard/src/pages/AiSettings*`, `apps/dashboard/src/**` (só o item de menu e a rota), `.env.example` (aditivo), `docs/ai.md`
**Critérios de aceitação**
- **AC-T19-01** Tabela `ai_settings` (linha única) com os campos:
  - `provider` (`anthropic`), `apiKey` (cifrada com a cripto do T02), `modelSmall`, `modelLarge`, `confidenceThreshold` (0–1), `maxTokens`, `timeoutMs`, `enabled`, `updatedAt`.
  - Sem linha no banco, valem as variáveis de ambiente do T13 (`AI_*`). Com linha, o banco tem prioridade campo a campo.
- **AC-T19-02** `GET /api/ai/settings` devolve a configuração efetiva com `hasApiKey` e a origem de cada campo (`db` ou `env`). **Nunca** devolve a chave, nem cifrada.
  - `PUT /api/ai/settings` valida com zod (modelos não vazios, limiar entre 0 e 1, `maxTokens` e `timeoutMs` dentro de limites seguros) e é auditado sem a chave.
  - `apiKey: null` remove a chave, e omitir o campo a mantém.
- **AC-T19-03** O worker aplica a configuração nova **sem restart**:
  - o `AiAssistant` relê as configurações (cache curto ou notificação) e troca provedor e modelos;
  - `enabled=false` → nenhuma chamada ao provedor, só o fallback determinístico;
  - o cache de classificação do T13 é invalidado quando o modelo muda.
- **AC-T19-04** `POST /api/ai/settings/test` faz uma chamada mínima ao provedor com a configuração salva (ou com a enviada no body, sem salvar) e devolve `{ ok, model, latencyMs, error? }`, com o erro sanitizado e sem a chave. Nos testes, o provedor é sempre falso e injetado.
- **AC-T19-05** No dashboard, a página **"IA / Modelo LLM"** fica no menu e tem:
  - campo da chave de API mascarado (mostra só "configurada" ou "não configurada", com os botões substituir e remover);
  - os modelos pequeno e grande, o limiar, o limite de tokens, o timeout e o botão ativar/desativar;
  - o botão "Testar conexão" e a origem de cada valor (banco ou env).
- **AC-T19-06** Continua valendo o AC-T13-06: a IA só age a partir de uma mensagem recebida real. As configurações não criam nenhum caminho novo de geração ou envio espontâneo. **Entrada automática em grupos continua proibida** (AC-T14-03 e F-NO-GROUP-JOIN).


### T20 — Adicionar número a um grupo (ação manual do admin)
**Origem:** pedido do humano em 2026-09-24. Substitui a proposta de entrada automática em grupos, que foi recusada (ver STATUS). É uma ação **manual**, uma por vez: não existe lote, agendamento, escolha de grupos por IA nem entrada automática.
**Paths:** `packages/core/src/transport/**` (aditivo: método de adicionar participante), `packages/core/src/groups/**`, `apps/api/src/routes/groups*`, `apps/api/src/bridge/**` e `apps/worker/src/boot/**` (só a rota da ponte), `apps/dashboard/src/pages/Groups*`, `apps/dashboard/src/components/**` (aditivo), `docs/groups.md`
**Critérios de aceitação**
- **AC-T20-01** `WaTransport.addGroupParticipant(groupId, jid)` usa `groupParticipantsUpdate(..., 'add')` do Baileys e devolve `{ status }` por participante. O `FakeTransport` simula: grupo inexistente, "não é admin", sucesso, e o participante já está no grupo.
- **AC-T20-02** `POST /api/sessions/:id/groups/:groupId/participants { targetSessionId }` adiciona **um** número.
  - `targetSessionId` é uma sessão do sistema com telefone.
  - Não existe variante em lote: um único alvo por requisição, e array → 400.
  - A sessão `:id` precisa estar em WARMING/STABLE (senão 409 `SESSION_NOT_CONNECTED`) e ser **admin** do grupo (senão 403 `NOT_GROUP_ADMIN`).
  - Alvo inexistente → 404. Alvo igual à própria sessão → 400.
- **AC-T20-03** Freio anti-rajada no servidor: no máximo 1 adição por minuto por sessão admin (senão 429 `RATE_LIMIT`). Nenhum código chama a adição a partir de timer, fila ou IA; ela só é disparada pela rota, que exige usuário autenticado.
- **AC-T20-04** Toda adição, com sucesso ou falha, é auditada como `group.participant.add`, com a sessão admin, o grupo, a sessão alvo, o resultado e o ator.
- **AC-T20-05** Funciona entre containers: a API chama o worker pela ponte interna do T16, e a rota nova da ponte exige o token interno.
- **AC-T20-06** No dashboard, na página Grupos, cada grupo em que a sessão selecionada é admin mostra o botão **"Adicionar número"**. O botão abre um diálogo para escolher **uma** sessão do sistema e pede confirmação ("Adicionar <nome/número> ao grupo <grupo>?").
  - O resultado aparece na tela: sucesso, já é membro, não é admin ou limite de 1 por minuto.
  - Em grupos em que a sessão não é admin, o botão fica desabilitado, com uma dica explicando o motivo.
- **AC-T20-07** Continuam valendo o F-NO-GROUP-JOIN (`groupAcceptInvite` não aparece no código), o AC-T13-06 e a regra 1.4 nº 5.


### T21 — Redesign do dashboard
**Origem:** pedido do humano em 2026-09-24. Os critérios foram definidos pelo Operário (Nácar) e pelo Tester (Íris), e a **fonte oficial é `docs/dashboard-design.md`**.
**Paths:** `apps/dashboard/**`, `docs/dashboard-design.md`
**Critérios de aceitação** (texto completo em docs/dashboard-design.md)
- **AC-T21-01** ver docs/dashboard-design.md.
- **AC-T21-02** ver docs/dashboard-design.md.
- **AC-T21-03** ver docs/dashboard-design.md.
- **AC-T21-04** ver docs/dashboard-design.md.
- **AC-T21-05** ver docs/dashboard-design.md.
- **AC-T21-06** ver docs/dashboard-design.md.
- **AC-T21-07** ver docs/dashboard-design.md.


### T22 — Chip pessoal / conexão direta no cadastro da sessão
**Origem:** pedido do humano em 2026-09-24. Chips pessoais, com histórico, conectam pelo IP normal da máquina, sem proxy.
**Paths:** `apps/dashboard/**` (a API não muda: sessão sem proxy já conecta direto, como diz o AC-T17-03)
**Depende de:** T21 aceito (mesmos arquivos do dashboard).
**Substitui:** a expectativa de campos de proxy visíveis por padrão (AC-T18-02) e de "—" para sessão sem proxy (AC-T18-03). A Tester do T22 (Íris) atualiza os testes do T12, T18 e T21 nesses pontos: desmarca `new-direct-connection` antes de usar os campos de proxy e espera "Conexão direta" no lugar de "—". O Operário deixa os campos `new-proxy-*` no DOM (com `hidden`) quando a checkbox está marcada.
**Critérios de aceitação**
- **AC-T22-01** "+ Adicionar número" tem a checkbox **"Chip pessoal / conexão direta (sem proxy)"**, **marcada por padrão**.
  - Marcada: os campos de proxy ficam ocultos, e a sessão é criada **sem** `proxy` nem `proxyId`.
- **AC-T22-02** Desmarcada, aparece o bloco de proxy do T18, que passa a ser **obrigatório**: sem host e porta válidos, o formulário mostra erro e não faz o POST.
  - A sessão é criada com o proxy inline, e o AC-T06-05 continua valendo: com proxy configurado, nunca conecta sem ele.
- **AC-T22-03** A lista de sessões e o detalhe mostram **"Conexão direta"** quando `proxy` é null (no lugar de "—").
  - No detalhe, dá para adicionar um proxy depois (PATCH do T17), com o aviso de restart.
- **AC-T22-04** Os `data-testid` do T18, T21 e T12 continuam; o novo (aditivo) é `new-direct-connection`. Com os testes atualizados conforme o "Substitui", as suítes T12, T18, T21 e T17 seguem verdes, e o build passa.

---

## 6. Scripts de verificação

Todos em `spec/verify/`, Node puro (sem dependências) e multiplataforma.

```bash
node spec/verify/verify.mjs list                       # tarefas, ondas, dependências
node spec/verify/verify.mjs T05 --role operario        # checks do Operário
node spec/verify/verify.mjs T05 --role tester          # checks do Tester (cobertura de ACs)
node spec/verify/verify.mjs wave 3                     # regressão de todas as tarefas até a onda 3
node spec/verify/verify.mjs T05 --role operario --base <git-ref>   # checagem de escopo contra uma ref
```

**`--role operario`** executa:
1. **Arquivos obrigatórios** da tarefa existem.
2. **Comandos**: `typecheck`, `lint` e testes unitários dos workspaces tocados.
3. **Regras proibidas** (grep no código de produto): credenciais em texto puro, `sendMessage` fora do ponto único, `groupAcceptInvite`, promessas de "imune a ban", `console.log` em `apps/api` e `apps/worker`.
4. **Escopo** (se houver git): arquivos alterados ⊆ `paths` da tarefa + arquivos compartilhados, e nada em `tests/acceptance/**`.

**`--role tester`** executa:
1. Extrai de `SPEC.md` todos os IDs `AC-Txx-nn` da tarefa.
2. Confere se cada ID aparece em algum `tests/acceptance/Txx/**/*.test.ts`.
3. Sobe a infra se a tarefa exigir (`docker compose up -d --wait postgres redis`).
4. Roda o Vitest com reporter JSON e exige que **cada AC tenha ≥ 1 teste `passed`** e nenhum `skipped`/`todo`.
5. **Escopo** (se houver git): o Tester só alterou `tests/**`.

Saída: tabela no terminal, relatório em `spec/reports/Txx-<papel>.json` e exit code `0` (ok) ou `1` (falhou).

---

## 7. Prompts de despacho (Orquestrador → agentes)

### 7.1 Operário
```text
Você é OPERÁRIO na tarefa {Txx} — {título}.
Leia wa-session-manager/spec/SPEC.md: seções 1, 3 e a tarefa {Txx} inteira.
Escreva SOMENTE dentro dos Paths da tarefa. Não toque em tests/acceptance/**.
Implemente os entregáveis e atenda a todos os critérios AC-{Txx}-nn.
Escreva testes unitários (*.unit.test.ts) para a lógica que criar.
Antes de reportar, rode: node spec/verify/verify.mjs {Txx} --role operario  (tem que dar exit 0)
Ao terminar, reporte com: maestri ask "{Orquestrador}" "<relatório no formato da seção 2.3>"
Dúvida de requisito → reporte BLOCKED com a pergunta. Não invente.
```

### 7.2 Tester
```text
Você é TESTER na tarefa {Txx} — {título}.
Leia wa-session-manager/spec/SPEC.md: seções 1, 3 e a tarefa {Txx} inteira.
Escreva testes de aceitação em tests/acceptance/{Txx}/ — um ou mais por critério.
O título de cada teste DEVE conter o ID (ex.: it('AC-{Txx}-03 reconecta após restart', ...)).
Teste o comportamento pelos contratos (API, interfaces da seção 5), não pelos detalhes internos.
Use sempre o FakeTransport. Nunca conecte ao WhatsApp real. Não edite apps/** nem packages/**.
Enquanto o Operário não terminar, os testes podem falhar; escreva-os mesmo assim.
Quando o Orquestrador avisar que a implementação está pronta, rode:
  node spec/verify/verify.mjs {Txx} --role tester
Reporte com: maestri ask "{Orquestrador}" "<relatório no formato da seção 2.3>"
Se um teste falhar por bug de produto, reporte REJECT com o ID do AC, o esperado e o obtido.
```

### 7.3 Orquestrador
```text
Você é o ORQUESTRADOR do projeto wa-session-manager.
Leia wa-session-manager/spec/SPEC.md inteiro e siga o protocolo da seção 2.
Você não escreve código de produto nem testes.
Use `maestri list` para ver Operários e Testers disponíveis.
Despache por onda (seção 4) com `maestri ask --batch`, usando os prompts 7.1 e 7.2.
Verifique com spec/verify/verify.mjs e mantenha spec/STATUS.md atualizado a cada mudança de estado.
Tarefa só vira ACCEPTED com os dois verify em exit 0.
Após 3 rejeições da mesma tarefa, pare e escale ao humano.
```
