# Modo extensão: o CRM sobre o worker do ai-manager

> SPEC T98 · AI-MANAGER-MAP §13.4–13.8. Este guia descreve como o CRM roda **sobre** o worker do ai-manager trocando
> só configuração, o patch **aditivo** que o ai-manager precisa receber (nada aqui altera o ai-manager) e como mover
> sessões do modo standalone para o modo extensão sem novo QR.

## 1. Os dois modos

| Modo           | Quem abre o Baileys                        | Gateway do CRM                                 | Banco                                                                  |
| -------------- | ------------------------------------------ | ---------------------------------------------- | ---------------------------------------------------------------------- |
| **standalone** | `apps/wa-worker` do CRM (`@crm/wa-engine`) | `WA_GATEWAY=rpc` + `WA_RPC_PROFILE=crm`        | Postgres próprio: `public.*` (schema WhatsApp do ai-manager) + `crm.*` |
| **extensão**   | worker do ai-manager (`apps/worker`)       | `WA_GATEWAY=rpc` + `WA_RPC_PROFILE=ai-manager` | Postgres do ai-manager: `public.*` dele + `crm.*`                      |

Nos dois modos o CRM fala com o WhatsApp só pela porta `WaGateway` (`@crm/wa-port`): comandos pelo
`POST /internal/rpc { target, method, args }` com `Authorization: Bearer <INTERNAL_TOKEN>` e eventos `WaEvent v1` pelo
Redis Stream `wsm:events`. Trocar de modo é trocar o perfil do gateway (`packages/wa-gateway-rpc/src/profiles/ai-manager/`).

### Regra: um dono por socket

**Só um processo abre o socket de uma sessão.** No modo extensão esse processo é o worker do ai-manager: o
`apps/wa-worker` do CRM **não roda** e o CRM nunca instancia `makeWASocket`. Nunca rode os dois workers com a mesma
sessão ao mesmo tempo, nem durante a migração (seção 6): o WhatsApp derruba uma das conexões, a fila da sessão é
processada duas vezes e o antiban perde a contagem de envios.

## 2. Variáveis

As variáveis **reais** do CRM (SPEC 3.12, `packages/wa-gateway-rpc/src/config.ts`):

| Variável            | Valor no modo extensão                          | Observação                                                                                                        |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `WA_GATEWAY`        | `rpc`                                           | Não existe `WA_GATEWAY=ai-manager` (o AI-MANAGER-MAP §13.6 usa esse nome; o código usa `rpc` + perfil).           |
| `WA_RPC_PROFILE`    | `ai-manager`                                    | Perfil registrado ao importar `@crm/wa-gateway-rpc`. Valor desconhecido reprova no boot (`WaGatewayConfigError`). |
| `WA_RPC_URL`        | URL do servidor interno do worker do ai-manager | É o `WORKER_INTERNAL_URL` do ai-manager (porta `WORKER_INTERNAL_PORT`, padrão `9465`), ex.: `http://worker:9465`. |
| `INTERNAL_TOKEN`    | o **mesmo** `INTERNAL_TOKEN` do ai-manager      | Token recusado vira `WorkerUnavailableError` (`reason: 'unauthorized'`), nunca "capacidade ausente".              |
| `DATABASE_URL`      | o `DATABASE_URL` do ai-manager                  | O CRM só lê `public.*` e grava em `crm.*` (seção 5).                                                              |
| `REDIS_URL`         | o Redis **e o db** do ai-manager                | O stream vive no db do ai-manager (padrão dele: db 0; o padrão do CRM é db 1).                                    |
| `WA_EVENTS_STREAM`  | `wsm:events`                                    | O mesmo stream em que o outbox A1 publica.                                                                        |
| `WA_RPC_TIMEOUT_MS` | opcional                                        | Default 30 s por chamada; o pareamento usa 60 s.                                                                  |
| `CRM_QUEUE_PREFIX`  | `crm`                                           | Filas do CRM nunca usam o prefixo `wsm` do ai-manager.                                                            |

Não se aplicam no modo extensão (são do `apps/wa-worker` do CRM, que não roda): `WA_TRANSPORT`, `WA_RPC_PORT`,
`WA_RPC_HOST`, `WA_QUEUE_PREFIX`, `ANTIBAN_*`. O `CREDENTIALS_KEY` só importa na migração de sessões (seção 6).

```sh
# .env do CRM no modo extensão
WA_GATEWAY=rpc
WA_RPC_PROFILE=ai-manager
WA_RPC_URL=http://worker:9465
INTERNAL_TOKEN=<o INTERNAL_TOKEN do ai-manager>
DATABASE_URL=<o DATABASE_URL do ai-manager>
REDIS_URL=<o REDIS_URL do ai-manager, mesmo db>
WA_EVENTS_STREAM=wsm:events
CRM_QUEUE_PREFIX=crm
```

## 3. Mapa de métodos do perfil `ai-manager`

Arquivo: `packages/wa-gateway-rpc/src/profiles/ai-manager/profile.ts`.

| Método do `WaGateway`                                                                          | Alvo RPC no ai-manager             | Hoje                  | Depende de                         |
| ---------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------- | ---------------------------------- |
| `sessions.create/list/get/startQr/getQr/requestPairingCode/pause/resume/restart/logout/remove` | `sessions.*` (mesmo nome)          | existe                | —                                  |
| `fetchGroups`                                                                                  | `sessions.fetchGroups`             | existe                | —                                  |
| `cancel`                                                                                       | `messages.cancel`                  | existe                | —                                  |
| `send`                                                                                         | `messages.send`                    | **ausente**           | A8                                 |
| `sendGroup`                                                                                    | `messages.sendGroup`               | **ausente**           | A8                                 |
| `downloadMedia`                                                                                | `media.download`                   | **ausente**           | A2 + A3                            |
| `presence`                                                                                     | `presence.update`                  | **ausente**           | A3                                 |
| `listContacts`                                                                                 | `contacts.list`                    | **ausente**           | A7                                 |
| `recordConsent`                                                                                | `contacts.recordConsent`           | **ausente**           | A7                                 |
| `optOut`                                                                                       | `contacts.optOut`                  | **ausente**           | A7                                 |
| `subscribe` (eventos)                                                                          | stream `wsm:events`                | **sem eventos**       | A1 (A4/A5 enriquecem)              |
| `react`, `deleteForEveryone`                                                                   | —                                  | sem alvo nem proposta | responde 501 sem rede              |
| `markRead`, `profile.*`                                                                        | —                                  | sem alvo nem proposta | opcionais: ausentes do gateway     |
| `capabilities`                                                                                 | — (`meta.capabilities` não existe) | —                     | valem as do perfil (todas `false`) |

**Por que `send` não usa `messages.enqueue`:** no ai-manager, `messages.enqueue` é a `MessageQueue` crua. Os gates do
`SendPipeline` (`auth`, `sessionExists`, `connected`, `contactAllowed`, `warmupLimit`, `rateLimit`) rodam na API do
ai-manager (`apps/api/src/routes/messages.ts`), não no RPC. Rotear `send` para `enqueue` furaria a regra "todo envio
passa pelo SendPipeline" (SPEC 1.4 nº 2). Até A8, `send`/`sendGroup` são **capacidade ausente**.

### Detecção de capacidades ausentes

Arquivo: `packages/wa-gateway-rpc/src/profiles/ai-manager/detect.ts`. Há duas camadas:

1. **Sem detecção** (`createRpcGateway({ profile: 'ai-manager' })`): o alvo que o worker não conhece responde
   `UNKNOWN_METHOD` (HTTP 400). O gateway transforma isso em `CapabilityNotSupportedError` (`status 501`,
   `remote: true`).
2. **Detecção** (`createWaGatewayFromEnv` com `WA_RPC_PROFILE=ai-manager`, que monta `createLazyAiManagerGateway`;
   ou `createAiManagerGateway(opts)` / `detectAiManagerCapabilities(opts)`, já no boot). No `createWaGatewayFromEnv`
   a montagem continua síncrona e a sonda é **preguiçosa**: roda na primeira chamada de um método aditivo; sessões,
   `cancel` e grupos não esperam por ela. Se a sonda falha (worker fora, token recusado), o erro propaga e a próxima
   chamada tenta de novo. O perfil `crm` não muda (sem sonda). Na sonda, cada alvo aditivo é
   sondado **uma vez** com `args: []`. A lista fechada responde `UNKNOWN_METHOD` antes de chamar qualquer handler,
   então o alvo é marcado como ausente. O perfil efetivo sai **sem** essas rotas: o método lança
   `CapabilityNotSupportedError` (`remote: false`) sem tocar a rede. O relatório traz `supported`, `missing` e
   `missingChanges` (ex.: `['A3', 'A7', 'A8']` no ai-manager de hoje).

Requisito para os alvos novos: o handler **recusa a chamada vazia** (validação dos argumentos) sem efeito colateral,
como o `str()`/`obj()` do RPC do wa-worker do CRM. Falha de rede ou token recusado na sonda propagam
(`WorkerUnavailableError`).

## 4. Patch aditivo proposto para o ai-manager

Tudo é **acréscimo** atrás de feature flag: nenhum alvo existente muda de assinatura, a lista fechada continua fechada
e nenhuma tabela `public.*` é alterada. Caminhos relativos à raiz do ai-manager.

| #      | Mudança                                                                                                                          | Arquivo de destino no ai-manager                                                                                                                                                      | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A1** | `attachEventOutbox(manager, queue, redis)` publica `WaEvent v1` no stream `wsm:events` (`XADD … MAXLEN ~ 100000`, campo `event`) | novo `apps/worker/src/events/` (ex.: `apps/worker/src/events/outbox.ts`) + 1 linha em `apps/worker/src/boot/start.ts`                                                                 | Mesmo padrão `attachX` → `onStop('events-outbox', …)`. Publica `session.state`, `session.connection`, `session.qr`, `message.inbound`, `message.status`. Sem A1 o CRM não recebe nada pelo `subscribe`.                                                                                                                                                                                                                                                                         |
| **A2** | `IncomingMessage.media?` e `WaTransport.downloadMedia?()`                                                                        | `packages/core/src/transport/types.ts` e `packages/core/src/transport/baileys.ts` (`downloadMediaMessage`)                                                                            | Campos opcionais: não quebram consumidores. Base do `media.download` (A3).                                                                                                                                                                                                                                                                                                                                                                                                      |
| **A3** | Alvos RPC `media.download` e `presence.update`                                                                                   | `apps/worker/src/boot/bridge-targets.ts` (alvos) e `apps/worker/src/boot/internal-server.ts` (`BridgeTargets` + `bridgeHandlers`)                                                     | `media.download([sessionId, handle])` → `{ mime, size, sha256, key, data }` (bytes em base64); `presence.update([sessionId, to, kind])` com `kind ∈ composing/recording/paused`.                                                                                                                                                                                                                                                                                                |
| **A4** | Extração de `contextInfo.externalAdReply` (CTWA) e da mensagem citada no `toIncomingMessage`                                     | `packages/core/src/transport/baileys.ts` (`toIncomingMessage`, linha 236)                                                                                                             | Opcional: vira `message.ad` e `message.quoted_id` no `WaEvent`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A5** | Evento de mapeamento LID↔PN (`lid-mapping.update`)                                                                               | `packages/core/src/transport/baileys.ts`                                                                                                                                              | O outbox (A1) publica `contact.lid_mapping`; o CRM guarda a identidade em `crm.*`; `public.contacts` não muda.                                                                                                                                                                                                                                                                                                                                                                  |
| **A6** | Montagem opcional `app.route('/api/crm', createCrmRoutes(deps))`                                                                 | `apps/api/src/routes/index.ts`                                                                                                                                                        | Só para API única; sem ela a API do CRM roda na porta própria.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **A7** | Alvos RPC `contacts.recordConsent`, `contacts.optOut` e `contacts.list`                                                          | `apps/worker/src/boot/bridge-targets.ts` (sobre o `ContactsService` de `packages/core/src/contacts/service.ts`) e `apps/worker/src/boot/internal-server.ts` (`bridgeHandlers`)        | O gate `contactAllowed` do ai-manager exige consentimento em `public.contacts`: o CRM registra consentimento (`inbound`, `manual`, `import`, `webhook`) e opt-out por aqui. `contacts.list([sessionId])` devolve a **agenda da sessão** (transporte) no formato `WaContactSummary`, não a tabela `public.contacts`.                                                                                                                                                             |
| **A8** | Alvos RPC `messages.send` e `messages.sendGroup` pelo `SendPipeline`                                                             | `apps/worker/src/boot/bridge-targets.ts` (um `SendPipeline` como o do `GroupInviteService`) e `apps/worker/src/boot/internal-server.ts` (`BridgeTargets.messages` + `bridgeHandlers`) | Proposta desta tarefa, além de A1–A7. `send([SendRequest])` = `SendPipeline.send` (gates → fila → antiban) e `sendGroup([SendGroupRequest])` = `SendPipeline.sendGroup`; o `SendRejectedError` já viaja serializado com `code`/`status`/`gate`. Idempotência por `(sessionId, clientMessageId)` numa chave Redis (`SET NX` com TTL, prefixo `wsm`), **sem** coluna nova em `public.messages`. `quoted`/`viewOnce` são repassados ao transporte quando o ai-manager os suportar. |

### Esboço do patch

`apps/worker/src/boot/internal-server.ts` (aditivo: tipos opcionais + handlers que só existem quando o alvo foi
montado, para a lista fechada continuar recusando o resto com `UNKNOWN_METHOD`):

```ts
export interface BridgeTargets {
  // …existentes…
  messages: { /* …existentes… */ send?(req: SendRequest): Promise<unknown>; sendGroup?(req: SendGroupRequest): Promise<unknown> } // A8
  media?: { download(sessionId: string, handle: MediaHandle): Promise<unknown> }                                               // A3
  presence?: { update(sessionId: string, to: string, kind: 'composing' | 'recording' | 'paused'): Promise<void> }              // A3
  contacts?: { recordConsent(input: RecordConsentInput): Promise<void>; optOut(input: OptOutInput): Promise<void>; list(sessionId: string): Promise<unknown> } // A7
}

// em bridgeHandlers(t): cada bloco só entra se o alvo existir; args validados (a chamada vazia é recusada).
...(t.messages.send ? { send: ([req]) => t.messages.send!(requireObject(req)) } : {}),
...(t.media ? { media: { download: ([id, handle]) => t.media!.download(requireString(id), requireObject(handle)) } } : {}),
```

`apps/worker/src/boot/start.ts` (A1, uma linha, atrás de flag):

```ts
if (env.WA_EVENTS_OUTBOX === 'on')
  onStop('events-outbox', attachEventOutbox(manager, queue, redis, { stream: 'wsm:events' }))
```

## 5. Banco: só o conjunto `crm`

- No modo extensão o CRM aponta para o `DATABASE_URL` do ai-manager e aplica **só** `runMigrations(db, { set: 'crm' })`
  (pasta `packages/db/drizzle/crm`, controle `crm.__drizzle_migrations`). O conjunto `wa` é do ai-manager e continua
  migrado por ele (`drizzle.__drizzle_migrations`).
- As migrations `crm` não alteram nada em `public` (tabelas, colunas, tipos, defaults, constraints, índices, enums,
  funções, triggers) nem o controle de migrations do ai-manager. Prova: `migrations.db.unit.test.ts` aplica as
  migrations do ai-manager (fixture `profiles/ai-manager/fixtures/public`, cópia de `packages/db/drizzle` do ai-manager),
  tira um snapshot de `public`, aplica `crm` duas vezes e compara.
- O CRM só **lê** `public.sessions`/`public.messages` e grava em `crm.*`.

## 6. Migração standalone → extensão (sem novo QR)

O `public.*` do `wa-engine` tem o mesmo schema do ai-manager e as credenciais cifradas com `CREDENTIALS_KEY`. Com a
**mesma** `CREDENTIALS_KEY` nos dois lados, as sessões mudam de dono sem novo QR:

1. Confira que as duas pontas estão na mesma versão do schema `wa` (as 8 migrations `0000_init` … `0007_session_browser`).
2. **Pare o `apps/wa-worker` do CRM** e confirme que nenhuma sessão está aberta por ele (um dono por socket).
3. Faça o dump das tabelas `sessions`, `session_credentials`, `proxies` e `session_limits` do banco standalone
   (`pg_dump --data-only -t sessions -t session_credentials -t proxies -t session_limits`) e restaure no banco do
   ai-manager. As tabelas `crm.*` vão junto, com o dump do schema `crm`.
4. Garanta `CREDENTIALS_KEY` do ai-manager = a do CRM standalone. Chave diferente = credenciais ilegíveis = novo QR.
5. Troque o `.env` do CRM para o modo extensão (seção 2) e suba o worker do ai-manager **antes** da API/worker do CRM.
6. Valide: `GET /api/connections` mostra as sessões; o relatório de `createAiManagerGateway` lista o que ainda falta
   (`missingChanges`).

O caminho inverso (extensão → standalone) é o mesmo, com os papéis trocados e o worker do ai-manager parado antes.

## 7. Lacunas conhecidas

- **`sessions.setProxy`** (T40): não existe nas duas pontas (wa-worker do CRM e ai-manager). Hoje o proxy fica cifrado
  no CRM e a conexão só é marcada `requires_restart`.
- **`meta.capabilities`**: nem o wa-worker do CRM nem o ai-manager expõem; o gateway usa as capacidades do perfil
  (todas `false`).
- **`markRead`, `profile.*`, `react`, `deleteForEveryone`**: sem alvo no ai-manager e fora de A1–A8. A UI esconde o
  que é opcional; `react`/`deleteForEveryone` respondem 501.
- **Reconciliação de mensagens `processing` após crash** e **`quoted`/`viewOnce`** aceitos no RPC mas não aplicados:
  lacunas do engine do CRM (T29, T14/T20). No modo extensão valem as regras do ai-manager.

## 8. Como validar

```sh
pnpm --filter @crm/wa-gateway-rpc test
```

- `profiles/ai-manager/contract.unit.test.ts`: a suíte de contrato da `@crm/wa-port` contra o servidor RPC simulado do
  ai-manager (`profiles/ai-manager/testing/simulator.ts`). Só com os alvos de hoje roda `capabilities`, `sessions`,
  `cancel` e `groups` (`only`); com A1/A3/A7/A8 simulados roda inteira.
- `profiles/ai-manager/profile.unit.test.ts`: registro do perfil, detecção e a recusa sem rede.
- `profiles/ai-manager/migrations.db.unit.test.ts`: `crm` sobre o schema do ai-manager sem tocar `public`.

## 9. CRM dentro do painel do ai-manager (iframe, `/crm/` e SSO)

Tudo opcional: sem as variáveis abaixo o CRM roda como antes (raiz `/`, API em `/api`, visual próprio, login normal).

### Web servida em `/crm/`

| Variável         | Exemplo     | Efeito                                                                                                   |
| ---------------- | ----------- | -------------------------------------------------------------------------------------------------------- |
| `VITE_BASE_PATH` | `/crm/`     | `base` do Vite (assets em `/crm/assets/*`) e `basepath` do TanStack Router (rotas em `/crm/<rota>`).     |
| `VITE_API_BASE`  | `/crm/api`  | Prefixo que o navegador usa para a API (fetch, SSE `/events`, mídia, downloads). O proxy tira o `/crm`.  |
| `CRM_WEB_PORT`   | `5274`      | Porta do `vite`/`vite preview` (padrão 5274 quando `VITE_BASE_PATH` está definido).                      |
| `CRM_UI_SKIN`    | `ai-manager`| Visual do painel também fora do iframe. Embutido, a skin `ai-manager` vale sempre.                        |

No dev/preview, `<VITE_API_BASE>/*` vai por proxy para `/api/*` da API do CRM (`VITE_API_URL`, padrão
`http://127.0.0.1:3000`). Em produção o proxy do ai-manager faz o mesmo: `/crm/api/x` → `http://<api do crm>/api/x` e
`/crm/*` → arquivos do `apps/web/dist` (com fallback para `index.html`).

```sh
VITE_BASE_PATH=/crm/ VITE_API_BASE=/crm/api pnpm --filter @crm/web build   # dist/index.html referencia /crm/assets/…
VITE_BASE_PATH=/crm/ VITE_API_BASE=/crm/api pnpm --filter @crm/web dev     # http://localhost:5274/crm/
```

### Modo embutido e skin

- Embutido = a página roda num iframe (`window.top !== window`) ou foi aberta com `?embed=1` (lembrado na aba;
  `?embed=0` desliga). O `<html>` ganha `data-embed="true"` e `data-skin="ai-manager"`.
- A skin (`apps/web/src/theme-ai-manager.css`) troca só tokens (cores, raios, sombras, fonte) e estilos de base
  (campos, botões, tabelas, menu) pela paleta do `apps/dashboard/src/styles.css` do ai-manager, claro e escuro.
- Embutido, o shell esconde o nome do produto, o seletor de idioma e o botão de tema; a navegação do CRM (sidebar,
  drawer e barra inferior) continua. O tema segue o do painel: mesma origem, chave `wsm.theme` do localStorage
  (evento `storage` acompanha a troca feita no painel).

### SSO (`/crm/auth/sso#token=<jwt>`)

1. O ai-manager emite um JWT **HS256** com `CRM_SSO_SECRET`: `iss: 'ai-manager'`, `aud: 'crm'`,
   `sub: 'ai-manager:<username>'`, `name`, `email: '<username>@ai-manager.local'`, `iat`, `exp` (iat + 120 s), `jti`.
2. O iframe abre `/crm/auth/sso#token=<token>` (opcional `&redirect=/chats`, só caminho interno). A página lê o token
   **do hash** (nunca da query), apaga o hash do histórico e chama `POST /api/auth/sso { token }` uma vez.
3. A API (`apps/api/src/routes/auth/sso.ts`):
   - sem `CRM_SSO_SECRET` → **404** (rota desligada);
   - verifica assinatura (só HS256), `iss`, `aud`, `iat`/`exp` com tolerância de 30 s e vida máxima de 300 s
     (`packages/core/src/auth/sso-token.ts`); erro → 401 com `details.error_code` `sso_<motivo>`
     (`sso_expired`, `sso_bad_audience`, `sso_bad_signature`, `sso_bad_alg`, `sso_malformed`, …);
   - `jti` de uso único: Redis `SET crm:sso:jti:<jti> NX EX <até exp + 30 s>`; repetido → 401 `sso_replayed`;
   - acha ou cria o usuário pelo e-mail (senha aleatória; só entra por SSO até redefinir), garante a empresa
     `ai-manager` (slug fixo) e cria a sessão como o login normal (cookie `crm_session`, mesmos guards);
   - o primeiro usuário vira `owner`; como a empresa tem no máximo um owner, os seguintes entram como `admin` com a
     lista explícita de todas as permissões do owner;
   - auditoria `auth.sso` (`sub`, `jti`, `user_created`, `role`).
4. A rota é pública (`PUBLIC_API_ROUTES`) mas continua sob o CSRF (`X-Requested-With: crm`), como o login.

Atrás do proxy do ai-manager, defina `TRUST_PROXY=true` na API do CRM para o IP da auditoria vir do `X-Forwarded-For`.
