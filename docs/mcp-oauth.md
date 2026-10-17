# MCP: OAuth para conectores (T115)

Credenciais MCP do tipo `oauth` (spec 09 §3.4) para conectores que fazem login, como o do Claude. O token estático
da T94 (`crm_mcp_…`) continua igual.

## Vínculo cliente ↔ credencial
- Criar a credencial `oauth` em Configurações → Credenciais MCP devolve a **URL do conector**:
  `<API_PUBLIC_URL>/api/mcp/<credentialId>`. É ela que o usuário cola no Claude.
- O cliente chama a URL sem token, recebe `401` com
  `WWW-Authenticate: Bearer realm="mcp", resource_metadata="<API>/.well-known/oauth-protected-resource/api/mcp/<id>"`
  e descobre o servidor de autorização (RFC 9728 → RFC 8414).
- O `resource` (RFC 8707) enviado ao `/authorize` é a URL do conector: liga o pedido à credencial e à empresa dela.
  O consentimento confirma essa empresa (exige vínculo + `settings.mcp.edit`).
- A credencial fica `pending` até existir um grant ativo; depois `connected`, com `connected_client_hint` = nome do
  cliente registrado. Revogar a credencial (DELETE da T94) derruba access e refresh na hora.

## Endpoints
| Método | Caminho | Sessão |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | não |
| GET | `/.well-known/oauth-protected-resource[/api/mcp[/<id>]]` | não |
| POST | `/api/mcp-oauth/register` (RFC 7591) | não |
| GET | `/api/mcp-oauth/authorize` → 302 `<WEB_PUBLIC_URL>/oauth/consent?request=<id>` | não |
| GET/POST | `/api/mcp-oauth/consent` (lê o pedido / aprova ou nega) | sim (+ CSRF no POST) |
| POST | `/api/mcp-oauth/token` (`authorization_code`, `refresh_token`) | não |
| POST | `/api/mcp-oauth/revoke` (RFC 7009) | não |
| ALL | `/api/mcp/<id>` (endpoint MCP do conector) | Bearer |

Rotas públicas ficam em `PUBLIC_API_ROUTES` e fora do CSRF; `/.well-known/*` e register/token/revoke têm CORS aberto.
Erros no formato OAuth (`{ error, error_description }`).

## Segurança e TTLs
- PKCE obrigatório, só `S256` (`plain`/ausente → `invalid_request` no authorize; verifier ausente/errado →
  `invalid_grant` no token). `redirect_uri` igual ao registrado (https, ou http em loopback).
- Pedido de autorização: 10 min. Código: 2 min, uso único (reuso derruba o que foi emitido com ele).
- Access token (`crm_mcpat_…`): 1 h. Refresh (`crm_mcprt_…`): 30 dias, com rotação; reapresentar um refresh já
  rotacionado revoga a família (grant) inteira.
- No banco só o SHA-256 de código, tokens e `client_secret`. Nada disso aparece no caminho da URL (o logger registra o
  caminho).
- Escopo único `mcp:read` (as ferramentas somente leitura da T94); escopos pedidos a mais são ignorados.

## Configuração
`API_PUBLIC_URL` (URLs do conector e dos endpoints), `WEB_PUBLIC_URL` (tela de consentimento) e `MCP_OAUTH_ISSUER`
(opcional; padrão `API_PUBLIC_URL`).
