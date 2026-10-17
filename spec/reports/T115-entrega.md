# T115 — MCP: OAuth para conectores (Claude) · entrega do Operário

STATUS: DONE
Verify: 0 (`node spec/verify/verify.mjs T115 --role operario --base bea292d`) — 35 arquivos no escopo, todas as regras FORBIDDEN ok.
Tempo: ~32 min de trabalho (00:42 → 01:14, 2026-10-17), mais ~10 min esperando a fila de verifies (lote T100,T105 e T108).

## Arquivos alterados
Novos:
- `packages/db/src/schema/crm/mcp-oauth.ts` + migration `packages/db/drizzle/crm/0034_t115_mcp_oauth.sql` (+ `meta/0034_snapshot.json`, `_journal.json`). Gerada pelo drizzle-kit, sem SQL manual.
- `packages/core/src/mcp-oauth/{index,service,tokens}.ts` + `mcp-oauth.unit.test.ts`
- `apps/api/src/routes/mcp-oauth/index.ts` + `mcp-oauth.db.unit.test.ts`
- `apps/web/src/features/mcp-oauth/{api.ts,consent-page.tsx,mcp-oauth.unit.test.ts}`, `apps/web/src/routes/oauth/consent.tsx`
- `apps/web/src/i18n/{pt-BR,en,es}/mcp-oauth.json`, `docs/mcp-oauth.md`

Liberados pelo Orquestrador (aditivo):
- `packages/core/src/mcp/credentials.ts`: aceita `oauth` (sem token nem expiração) e devolve `status` `pending|connected`, `connected_client_hint` e `connector_url`. `authenticate` aceita o access token OAuth (`crm_mcpat_`). Revogar uma credencial oauth revoga os grants dela.
- `apps/api/src/routes/mcp/index.ts`: o 401 traz `resource_metadata`. Rota nova `ALL /api/mcp/:credentialId` (URL do conector).
- `apps/web/src/features/settings-mcp/{api.ts,mcp-tab.tsx,settings-mcp.unit.test.ts}`, `i18n/*/settings-mcp.json`

Compartilhados (aditivo):
- `packages/core/src/index.ts`, `packages/db/src/schema/crm/index.ts`
- `apps/api/src/routes/index.ts`, `apps/api/src/middleware/public-routes.ts`
- `apps/web/src/routeTree.gen.ts` (gerado com `routes:gen`)
- `.env.example` (`MCP_OAUTH_ISSUER`)
- `apps/api/package.json` + `pnpm-lock.yaml`: devDependency `@modelcontextprotocol/sdk@1.31.0`, a mesma versão do core. O teste usa os helpers `client/auth` do SDK.

Teste de outra tarefa ajustado (mínimo, SPEC 2.4): `apps/api/src/routes/mcp/mcp.db.unit.test.ts` (T94).
- A lista exata de chaves do DTO ganhou `connected_client_hint` e `connector_url`.
- "oauth → 422" virou "auth_type inválido → 422", porque OAuth agora é aceito.
- O `WWW-Authenticate` passou de `toBe('Bearer realm="mcp"')` para `toMatch(/^Bearer realm="mcp"/)`, porque agora leva `resource_metadata`.

## Vínculo cliente ↔ credencial
- A URL do conector é `<API_PUBLIC_URL>/api/mcp/<credentialId>` (`connector_url` no DTO). O id da credencial vai no **caminho**, que é o "caminho equivalente" da decisão do Orquestrador. Ele não é segredo.
- Sem token, essa URL responde 401 com `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<API>/.well-known/oauth-protected-resource/api/mcp/<id>"`.
- O `resource` (RFC 8707) do `/authorize` precisa ser exatamente essa URL, de uma credencial `oauth` não revogada; senão `invalid_target`. O pedido fica preso à credencial e à empresa dela.
- O consentimento mostra essa empresa e exige vínculo do usuário (sem vínculo → 404) e `settings.mcp.edit` (sem a permissão → 403). Para aprovar, é preciso confirmar `company_id` igual ao da credencial; diferente → 422.
- O access token só vale para a credencial do grant: em `/api/mcp/<outro id>` → 401. Em `/api/mcp` (genérico) ele vale para a empresa do grant.
- `/api/mcp` sem token: 401 com `resource_metadata=".../oauth-protected-resource/api/mcp"`. O `resource` genérico é recusado no authorize (`invalid_target`): o conector precisa usar a URL com id.

## Endpoints finais
| Método | Caminho | Auth |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | público, CORS |
| GET | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/api/mcp`, `/.well-known/oauth-protected-resource/api/mcp/:credentialId` (404 se a credencial não for oauth ativa) | público, CORS |
| POST | `/api/mcp-oauth/register` → 201 (RFC 7591; `none`, `client_secret_post` ou `client_secret_basic`) | público, CORS, sem CSRF |
| GET | `/api/mcp-oauth/authorize` → 302 `<WEB_PUBLIC_URL>/oauth/consent?request=<id>`, ou 302 ao `redirect_uri` com `error` | público |
| GET | `/api/mcp-oauth/consent?request=<id>` → `{ authorization_request: { request_id, client{client_id,name,redirect_uri}, credential{id,name}, company{id,name}, scope, expires_at } }` | sessão |
| POST | `/api/mcp-oauth/consent` `{ request, company_id, approve }` → `{ redirect_to }` (com `code`, `state`, `iss`, ou `error=access_denied`) | sessão + CSRF |
| POST | `/api/mcp-oauth/token` (`authorization_code` / `refresh_token`; form ou JSON; Basic ou corpo) | público, CORS, sem CSRF |
| POST | `/api/mcp-oauth/revoke` (RFC 7009; revoga o grant do token; sempre 200) | público, CORS, sem CSRF |
| ALL | `/api/mcp/:credentialId` | Bearer |

- `PUBLIC_API_ROUTES` ganhou `/api/mcp/*` e as 4 rotas do cliente (`register`, `authorize`, `token`, `revoke`). `isInboundHook` (isenção de CSRF) ganhou as mesmas. A rota `consent` NÃO é pública.
- Erros no formato `OAuthErrorResponseSchema`: `{ error, error_description }`, com `Cache-Control: no-store`.
  - `invalid_client` responde 401 com `WWW-Authenticate: Basic`.
  - Outros erros: `invalid_request`, `invalid_grant`, `unsupported_grant_type`, `unsupported_response_type`, `invalid_target`, `invalid_client_metadata` e `invalid_redirect_uri`.
- A aprovação grava em `audit_logs` (`mcp_oauth.approve` ou `mcp_oauth.deny`) na empresa da credencial.

## Segurança e TTLs
- PKCE só `S256`. `plain` ou `code_challenge` ausente → `invalid_request` (redirect). `code_verifier` ausente ou errado → `invalid_grant`. A comparação é em tempo constante.
- `redirect_uri` igual a um dos registrados: https, ou http em loopback, sem fragmento. Também precisa ser igual no `/token`.
- TTLs:
  - pedido de autorização: 10 min;
  - código: 2 min, de uso único (reuso → `invalid_grant` e revoga o grant emitido com ele);
  - access `crm_mcpat_…`: 1 h;
  - refresh `crm_mcprt_…`: 30 dias, com rotação.
- Refresh já rotacionado reapresentado (inclusive em corrida) → `invalid_grant`, revoga a família (grant) e derruba o access novo (AC-04).
- No banco só ficam SHA-256 de código, access, refresh e `client_secret`. Nada disso vai no caminho da URL.
- Escopo único `mcp:read`. Escopos extras pedidos (ex.: `offline_access`) são ignorados, para não quebrar conectores.
- Revogar a credencial (DELETE da T94) dá 401 na hora para o access e `invalid_grant` para o refresh (AC-02).
- Status: `pending` sem grant ativo; `connected` + `connected_client_hint` (o `client_name` do registro) com grant ativo. Se todos os grants forem revogados, a credencial volta a `pending`.

## Tabelas (migration 0034)
- `crm.mcp_oauth_clients`: global, sem `company_id`, porque o registro acontece antes de qualquer login.
- `crm.mcp_oauth_authorizations`, `crm.mcp_oauth_grants` e `crm.mcp_oauth_tokens`: todas com `company_id` e índice que começa por ele.

## Testes
- `apps/api/src/routes/mcp-oauth/mcp-oauth.db.unit.test.ts` (9 testes): cliente local com os helpers do SDK (`extractWWWAuthenticateParams`, `discoverOAuthProtectedResourceMetadata`, `discoverAuthorizationServerMetadata`, `registerClient`, `startAuthorization`, `exchangeAuthorization`, `refreshAuthorization`) e `fetchFn` em `app.request()`. Não usa rede.
- `packages/core/src/mcp-oauth/mcp-oauth.unit.test.ts`: vetor PKCE do RFC 7636, metadados e validação do registro.
- Web: `features/mcp-oauth/mcp-oauth.unit.test.ts` e `settings-mcp.unit.test.ts` (corpo oauth e rótulo "Conectada · <cliente>").
- UI conferida no harness com Playwright, em desktop 1366×768 e mobile 390×844:
  - criar OAuth mostra a URL e os passos;
  - consentimento → aprovar → redirect com `code` → `/token`;
  - ao recarregar, aparece "Conectada · Claude";
  - sem rolagem horizontal.
  Harness encerrado.

## Para o Tester
Testids:
- Criação, em `settings-mcp`:
  - `mcp-create`, `mcp-name`;
  - `mcp-auth-type` (select `static` | `oauth`);
  - `mcp-expiration` (só no tipo static);
  - `mcp-create-submit`.
- Depois de criar o tipo OAuth: `mcp-connector-url` (texto da URL), `mcp-connector-copy`, `mcp-connector-steps` (4 passos) e `mcp-connector-close`.
- Na lista:
  - `mcp-credential-row` (`data-id`);
  - `mcp-status` (`data-status` = `pending` | `connected` | `active` | `expired`; o texto é "Pendente" ou "Conectada · <cliente>");
  - `mcp-credential-connector-url`.
- Consentimento (`/oauth/consent?request=<id>`):
  - `mcp-oauth-consent`, `mcp-oauth-client`;
  - `mcp-oauth-company` (`data-company-id`);
  - `mcp-oauth-credential`, `mcp-oauth-redirect`;
  - `mcp-oauth-approve`, `mcp-oauth-deny`;
  - `mcp-oauth-error` (`data-reason` = `invalid` | `expired` | `forbidden` | `generic`), `mcp-oauth-loading`.
- No mobile, a aba entra por `settings-tab-select` → `settings-tab-select-search` → `settings-tab-option-mcp_credentials`, ou direto por `/settings?tab=mcp_credentials`.

Roteiro HTTP do cliente de teste (AC-05, contra a API do harness):
1. `POST /api/mcp_credentials {mcp_credential:{name,auth_type:'oauth'}}` com sessão → `connector_url`. Pode ser criada pela UI e a URL lida em `mcp-connector-url`.
2. `POST /api/mcp-oauth/register {client_name:'Claude', redirect_uris:['http://127.0.0.1:9/cb'], token_endpoint_auth_method:'none'}` → `client_id`.
3. `GET /api/mcp-oauth/authorize?response_type=code&client_id&redirect_uri&code_challenge=<S256>&code_challenge_method=S256&state&resource=<connector_url>` (`redirect: 'manual'`) → 302; `request` vem no `Location`.
4. Aprovar:
   - por HTTP: `POST /api/mcp-oauth/consent {request, company_id, approve:true}` com cookie e `X-Requested-With: crm` → `redirect_to` com `code`;
   - ou pela UI, em `/oauth/consent?request=<id>`: `mcp-oauth-approve` (intercepte o `redirect_uri` com `page.route`).
5. `POST /api/mcp-oauth/token` (form) `grant_type=authorization_code&code&code_verifier&redirect_uri&client_id`.
6. Recarregar a aba → `mcp-status` "Conectada · Claude".

No harness, `API_PUBLIC_URL` não está definido. Por isso a `connector_url` sai como `http://localhost:3000/api/mcp/<id>`. Use-a como `resource` exatamente como veio; para chamar o MCP, use o caminho `/api/mcp/<id>` na porta do harness.

## Notas e pendências para outras tarefas
- Breadcrumb do shell na tela de consentimento: mostra "Oauth / Consent". Os rótulos ficam no `app/shell/breadcrumbs.tsx` (T23), fora dos Paths. O consentimento roda dentro do shell, porque `PUBLIC_PATHS` do guard está fora dos Paths. Sem sessão, o guard leva a `/login?redirect=/oauth/consent?request=…`: a query fica codificada e o `safeRedirect` aceita.
- Sem limpeza periódica de pedidos e códigos expirados, nem de clientes não usados. Candidato a job no worker (endurecimento).
- `POST /api/mcp-oauth/register` não tem rate limit. Sugestão: `rateLimit` por IP (endurecimento).
- Produção:
  - `API_PUBLIC_URL` precisa ser a URL pública real da API, porque a `connector_url` e o `resource` saem dela;
  - `/.well-known/*` precisa ser exposto na origem da API;
  - `MCP_OAUTH_ISSUER` é opcional.
  - Nada a ligar no worker.
- Fluxo validado contra o comportamento do SDK 1.31.0. Não houve teste com o Claude real, por regra. Uma divergência do conector real (ex.: método de autenticação ou escopos) aparece só na T102 ou em produção.
- A T102 (E2E final) depende desta tarefa.
