# 01 — Autenticação, Perfil e Multiempresa

> Fonte: análise estática do bundle (`_bundle/pretty.js`, referências `pretty.js:N`) + tabela REA (`_rea/rea-endpoints.md`, rea-agents 6.5.0). Endpoints marcados "(fonte: REA)" constam da tabela do REA; os demais vêm de template literals (`` `/accounts/${id}/switch` ``) que o REA não extrai, marcados "(fonte: grep)". Nenhum dado real foi copiado; exemplos são fictícios.

## 1. Visão geral

O app é uma SPA React com i18n (pt-BR, en, es). A autenticação é por **token Bearer** armazenado no navegador; não há cookies de sessão. Um **usuário** (pessoa) pode pertencer a várias **contas/empresas** (multi-tenant). Existe sempre uma "conta corrente" (`current_account`) definida **no servidor** (endpoint de troca); o front não envia `account_id` em cabeçalho — cada requisição é escopada pela conta corrente do usuário no backend (exceções pontuais passam `?account_id=`).

Dois eixos de papel:
- **Papel de sistema** (`user.role`): `client` (Cliente), `client_employee` (Funcionário), `admin` (Administrador da plataforma — acessa `/admin`), `support` (Suporte — só acessa `/support/access` e poucas rotas) (`pretty.js:256809-256814`).
- **Papel na conta** (`account.user_role`): `owner` (Proprietário), `admin` (Administrador), `member` (Membro) (`pretty.js:36176`, rótulos `pretty.js:14646`). Detalhado no módulo 16.

Funcionalidades deste módulo (≈ 38 features):
1. Login e-mail/senha; 2. Mostrar/ocultar senha; 3. "Lembrar-me" (checkbox sem efeito persistente observável [INFERIDO]); 4. Redirect pós-login seguro (`?redirect=`); 5. Mensagem `login_required`; 6. Toggle de tema na tela de login; 7. Cadastro (`/register` e alias `/cadastro`); 8. Captura de afiliado (`?ref=`/`?via=` → `rewardful_referral`); 9. Esqueci minha senha; 10. Validação do token de reset; 11. Redefinir senha; 12. Logout; 13. Expiração de sessão → logout automático com sonda de confirmação; 14. Carregamento de perfil no boot; 15. Perfil: dados pessoais; 16. Troca de e-mail exigindo senha atual; 17. Indicador de e-mail confirmado; 18. Avatar: upload; 19. Avatar: remoção; 20. Alterar senha (com medidor de força); 21. Tema claro/escuro (persistido local + atalho de teclado Ctrl/Cmd+M); 22. Idioma da interface (salvo no usuário); 23. "Minhas contas" (lista de empresas no perfil); 24. Seletor de empresa (account switcher) com busca e paginação infinita; 25. Troca de empresa ativa; 26. Contador de leads de boas-vindas em tempo real; 27. Criar empresa; 28. Editar empresa; 29. Desativar empresa; 30. Reativar empresa; 31. Sair de empresa; 32. Convite de plataforma — tela `/invitation/:token` (aceitar/recusar); 33. Convite de membro — tela `/member_invitations/:token`; 34. Tela legada `/invitation` (formulário); 35. `/welcome` como página inicial pós-login (dashboard); 36. Guardas de rota (autenticado, público, admin, suporte); 37. Mapa rota→permissão com redirecionamento; 38. Área do suporte `/support/access` (solicitação de acesso temporário).

## 2. Telas e rotas

| Rota | Tipo | Componente / ref | Observações |
|---|---|---|---|
| `/login` (fonte: REA) | pública (redireciona se logado) | `pretty.js:47584-47766` | Campos e-mail, senha; links "Esqueci minha senha" e "Crie uma conta agora" |
| `/register` (fonte: REA), `/cadastro` (fonte: REA) | pública | `pretty.js:47767-48070` | Mesmo componente para as duas rotas |
| `/forgot-password` (fonte: REA) | pública | `pretty.js:48071-48222` | Estado "Email enviado!" após sucesso |
| `/reset-password?token=…` (fonte: REA) | pública | `pretty.js:48223-48491` | Estados: validando, inválido/expirado, formulário, sucesso |
| `/invitation/:token` (fonte: REA) | aberta (sem guarda) | `RTt` `pretty.js:148300` | Convite de plataforma |
| `/member_invitations/:token` (fonte: REA) | aberta (sem guarda) | `DTt` `pretty.js:148663` | Convite para entrar numa conta |
| `/invitation` (fonte: REA) | protegida | `$Tt` `pretty.js:148951` | Formulário legado; sem token não carrega nada [INFERIDO: tela morta] |
| `/welcome` (fonte: REA) | protegida | `Umt` `pretty.js:85625` | Home/dashboard (saudação por horário, nome da empresa, `welcome_leads_count`). Métricas → ver módulo de Dashboard |
| `/profile` (fonte: REA, `profile`) | protegida | `Okt` `pretty.js:122739` | Abas `personal`, `security`, `preferences` |
| `/accounts` (fonte: REA, `accounts`) | protegida (`settings.accounts.view`) | `_At`/`SAt` `pretty.js:134348` | Lista legada de contas [NÃO VERIFICADO no app]; a gestão principal está em `/settings?tab=accounts` |
| `/support/access` (fonte: REA) | só `user.role === "support"` | `Zna` `pretty.js:271000` | Área do suporte |
| `/admin` (fonte: REA) | só `user.role === "admin"` | ver módulo 20 | |
| `/` e `/_temp_/*` (fonte: REA) | protegida | `nse` | Redireciona para a home [INFERIDO] |

Guardas (`pretty.js:47309-47379`):
- **Protegida** (`pHe`): enquanto carrega mostra "Verificando autenticação..."; sem login redireciona para `/login?message=login_required&redirect=<rota atual codificada>`.
- **Pública** (`Tj`): se já autenticado, redireciona para `redirect` (sanitizado) ou para a home do papel (`Em`: suporte → `/support/access`, demais → `/welcome`) (`pretty.js:36146`).
- **Admin** (`fHe`): sem usuário → `/login`; `role !== "admin"` → `/welcome`.
- **Suporte** (`hHe`): `role !== "support"` → `/welcome`.
- **Sanitização de redirect** (`UF`, `pretty.js:47301`): aceita apenas caminho iniciado por `/`, rejeita `//`, `://` e `\`.
- **Mapa prefixo→permissão** (`pretty.js:40903-40942`) aplicado por um hook global (`_Be`, `pretty.js:40972`): se o usuário não tem a permissão, mostra toast "permissão negada" e redireciona para a home do papel. Usuário `support` só pode navegar em `/settings` (exato), `/support/access`, `/settings/mcp-credentials`, `/profile`, `/flows/*` (`pretty.js:36149-36159`).

## 3. Modelo de dados / campos

### 3.1 Usuário (objeto retornado por `/auth/profile`, `/auth/login`)
| Campo | Tipo | Notas / ref |
|---|---|---|
| `id` | int | |
| `name` | string | obrigatório no cadastro |
| `email` | string | único; troca exige senha atual |
| `personal_whatsapp` | string? | "Número pessoal (não utilizado nas automações)"; formato de exemplo `55DDDNÚMERO` só dígitos (placeholder) |
| `role` | enum `client`/`client_employee`/`admin`/`support` | cadastro público sempre envia `client` (`pretty.js:47805`) |
| `locale` | enum `pt_BR`/`en`/`es` | normalizado; valor inválido → `pt_BR` (`pretty.js:34479-34490`) |
| `avatar_url` | string? | |
| `email_confirmed_at` | datetime? | exibe selo "E-mail confirmado" |
| `accounts[]` | Account[] | contas das quais participa (com `user_role`, `welcome_leads_count`) |
| `current_account` | Account | conta ativa (ver 3.2) |
| `active_account` | Account? | fallback legado [INFERIDO] |

### 3.2 Conta/Empresa (`account`)
| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `name` | string | sim | trim; botão salvar desabilitado se vazio | `pretty.js:97588`, `94300` |
| `description` | string? | não | textarea 3 linhas | `pretty.js:94330` |
| `slug` | string? | não | regex `^[a-z0-9-]*$`; na criação é gerado do nome (minúsculas, sem acento, espaços→hífen, colapsa hífens) | `pretty.js:94270-94282` |
| `active` | bool | — | default `true` na criação | `pretty.js:94262` |
| `time_zone` | enum IANA | — | lista fixa de 12: America/Sao_Paulo (default), Fortaleza, Manaus, Belem, Noronha, Buenos_Aires, Santiago, Bogota, Lima, Mexico_City, New_York, UTC; valor fora da lista cai no default | `pretty.js:70977-70997` |
| `connection_status_emails_enabled` | bool | — | default true; "Envia e-mail ao proprietário quando uma instância desconecta ou fica restrita (API Oficial). Disponível com mais de 4 instâncias". O aviso de "restrita" é [REQUER WABA]; o de desconexão funciona no Baileys | `pretty.js:16578` |
| `user_role` | enum owner/admin/member | (leitura) | papel do usuário logado nesta conta | |
| `permissions[]` | string[] | (leitura) | chaves de permissão efetivas do usuário nesta conta | `pretty.js:36199` |
| `subscription_status` | string | (leitura) | `active` bloqueia desativação | `pretty.js:97597` |
| `welcome_leads_count` | int | (leitura) | atualizado por realtime | `pretty.js:35905` |
| `meta_ads_display_currency` | string? | (leitura) | usado no dashboard | |
| `created_at` | datetime | (leitura) | | |

### 3.3 Formulários
**Login**: `email` (type email, required), `password` (required). Payload `{email, password}`.

**Cadastro** (`pretty.js:47784-47830`):
| Campo | Tipo | Obrig. | Validação |
|---|---|---|---|
| Nome completo | text | sim | — |
| E-mail | email | sim | HTML5 |
| WhatsApp Pessoal | tel | não | — |
| Senha | password | sim | mínimo 6 caracteres |
| Confirmar senha | password | sim | igual à senha ("As senhas não coincidem") |
Payload: `{ user: { name, email, personal_whatsapp?, password, password_confirmation, role: "client" }, rewardful_referral? }`. Sucesso → navega para `/login` com mensagem do servidor (ou "Conta criada com sucesso! Faça login para continuar.") e e-mail pré-preenchido.

**Esqueci senha**: `email`. Sempre mostra resposta neutra ("Se o email existir, você receberá instruções…") — não revela existência da conta.

**Reset**: `password`, `password_confirmation` (mín. 6, iguais) + `token` da query.

**Perfil — dados pessoais** (`pretty.js:122790-122830`): `name`, `email`, `personal_whatsapp`, `current_password` (exigido só se e-mail mudou, comparação case-insensitive).

**Perfil — senha** (`pretty.js:122349-122400`): `current_password` (obrig.), `password` (mín. 6), `password_confirmation`. Medidor de força: 4 barras, nível = min(4, floor(len/3)); texto Fraca (<6), Média (<10), Forte (≥10).

**Avatar**: arquivo `image/jpeg|png|webp`, máx. 5 MB (texto de ajuda `pretty.js:14611`; limite validado no backend [INFERIDO]).

## 4. Estados e transições

- **Sessão**: `anônimo → autenticando → autenticado`; `autenticado → anônimo` por logout, 401 com erro "Token inválido ou expirado" (após sonda `/auth/profile` confirmar) ou falha no boot.
- **Token de reset**: `validando → válido | inválido(expirado)`; `válido → redefinido` (redireciona ao login após 2 s).
- **Conta**: `active=true (Ativa) ⇄ active=false (Inativa)`. Desativar bloqueado se `subscription_status === "active"` ("Cancele a assinatura primeiro").
- **Convite de plataforma** (`invitation.status`): `pending` (Pendente) → `accepted` (Aceito) | `declined` (Recusado) | `expired` (Expirado) (`pretty.js:15620-15650`). Expirado também é inferido no cliente quando `expires_at < agora`.
- **Convite de membro** (association): `pending` → aceito/recusado; expiração por `expires_at` (mostra "(Expirado)").
- **Solicitação de acesso de suporte**: `pending` (Pendente) → `approved` (Aprovado) | `rejected` (Recusado) | `cancelled` (Cancelado) (`pretty.js:29240`); grant aprovado tem `expires_at` (12h) e pode ser revogado.
- **Tema**: `light ⇄ dark` (default = preferência do SO).
- **Idioma**: `pt_BR | en | es` (labels "Português (Brasil)", "English (United States)", "Español (Latinoamérica)").

## 5. Ações e regras de negócio

1. **Login** (`pretty.js:34492`): POST; em sucesso grava `auth_token` e `user` no localStorage e navega para `redirect` ou home do papel. Erro mostra alerta inline + toast.
2. **Boot** (`pretty.js:35860`): se há token+user locais, chama `GET /auth/profile`; se usuário sem `accounts`, chama `GET /accounts` para preencher. Se erro "Token inválido ou expirado", limpa storage; outros erros mantêm o usuário do cache (modo offline tolerante).
3. **Sessão expirada** (`pretty.js:34309-34330`): qualquer 401 com mensagem de token inválido dispara uma sonda única `GET /auth/profile` (sem cache); só se a sonda também falhar o app limpa storage e faz `window.location = /login`.
4. **Erros HTTP padronizados**: 401/403/422 extraem `error`/`errors[]`; 403 default "Você não tem permissão para realizar esta ação."; 5xx → mensagem genérica.
5. **Logout**: `DELETE /auth/logout`, limpa storage mesmo com erro, desconecta o WebSocket.
6. **Idioma**: alterar no perfil faz `PUT /auth/profile {user:{locale}}` e troca o idioma do i18n e o `lang` do `<html>`.
7. **Troca de e-mail**: exige `current_password`; erro com `error_code = current_password_invalid` mostra "A senha atual não corresponde."
8. **Troca de empresa** (`pretty.js:35966-35977`): `POST /accounts/:id/switch` → recarrega `GET /auth/profile` → regrava `user` no storage → limpa caches de chat → dispara evento global "accountChanged" que faz cada tela recarregar seus dados. **A conta corrente é estado do servidor**; o cliente só guarda a cópia em `localStorage.user.current_account`.
9. **Account switcher** (`pretty.js:44067`): dropdown com busca (debounce 300 ms), páginas de 20 (`?page&limit=20&search`), botão "Carregar mais empresas" se `pagination.has_more`; mostra "Leads: N" por empresa; oculto se o usuário não tem contas.
10. **Criar empresa**: `POST /accounts {account:{name, description?, slug?, active}}`; depois recarrega a lista. Quem pode criar: `user.role ∈ {admin, client, client_employee}` (`pretty.js:36293`).
11. **Editar empresa** (aba Dados Corporativos): `PUT /accounts/:id {account:{name, description?, slug?, time_zone, connection_status_emails_enabled}}`. Fuso só editável por owner/admin da conta ou admin da plataforma.
12. **Desativar empresa**: modal crítico listando efeitos — acesso bloqueado para todos, conexões desconectadas, fluxos pausados; dados não são excluídos. Executa `DELETE /accounts/:id` (soft delete) (`pretty.js:97604`).
13. **Reativar**: `PUT /accounts/:id {account:{active:true}}`; aviso de que as instâncias precisam ser reconectadas manualmente.
14. **Sair da empresa**: confirmação "Você perderá o acesso até ser convidado novamente" → `POST /accounts/:id/leave` → recarrega perfil e dispara accountChanged.
15. **Convite de plataforma (`/invitation/:token`)**: carrega `GET /invitations/:token`; "Aceitar" → `POST …/accept`; se não logado, vai para `/login` com `returnTo`; se logado vai para `/`. "Recusar" → `POST …/decline` e vai ao login. Exibe "Convite Expirado" se vencido.
16. **Convite de membro (`/member_invitations/:token`)**: `GET /member_invitations/:token` retorna `association` (convidado por, papel, expira em). Aceitar → `POST …/accept` → `/welcome`; se erro contiver "Usuário não encontrado" → orienta criar conta e vai ao login. Recusar → `POST …/decline`.
17. **Contador de leads** (realtime): ao receber `lead_counter_incremented` da conta corrente, atualiza `welcome_leads_count` (usa o maior entre valor local e o enviado, ou soma `increment_by`, default 1).
18. **Tema**: guardado em `localStorage.theme`; atalho Ctrl+M (Windows/Linux) ou Cmd+M (mac) alterna, ignorado dentro de inputs (`pretty.js:36058-36085`).
19. **Área de suporte (`/support/access`)**: o suporte digita o e-mail do cliente (owner/admin) → `lookup` lista contas daquele e-mail (seleciona automaticamente se só uma) → envia solicitação; vê histórico (reenviar/cancelar), acessos ativos e, por grant, lista de fluxos da conta com link para `/flows/:id/edit`. Aprovação dura 12h ("Aprovar por 12h") e dá acesso apenas a fluxos e ao MCP (`pretty.js:29270-29280`).

## 6. Endpoints da API

Base: `https://<api>/api/v1`; header `Authorization: Bearer <token>`; JSON.

| Método | Caminho | Payload / resposta | Fonte |
|---|---|---|---|
| POST | `/auth/login` | `{email,password}` → `{token,user}` | REA |
| POST | `/auth/register` | `{user:{…, role:"client"}, rewardful_referral?}` → `{user,message}` | REA |
| DELETE | `/auth/logout` | — | REA |
| GET | `/auth/profile` | → `{user}` | REA |
| PUT | `/auth/profile` | `{user:{name?,email?,personal_whatsapp?,locale?,current_password?,password?,password_confirmation?}}` → `{user}`; erro pode trazer `error_code` | REA |
| POST | `/auth/profile/avatar` | multipart `avatar` → `{user}` | grep (`pretty.js:34545`) |
| DELETE | `/auth/profile/avatar` | → `{user}` | REA |
| POST | `/auth/password_resets` | `{email}` | REA |
| GET | `/auth/password_resets/:token` | → `{valid, error?, reason?}` | grep |
| PATCH | `/auth/password_resets/:token` | `{password,password_confirmation}` | grep |
| GET | `/accounts?page&limit&search` | → `[Account]` ou `{accounts,pagination{has_more,total_pages…}}` | REA (`/accounts`) |
| POST | `/accounts` | `{account:{name,description?,slug?,active}}` | REA |
| PUT | `/accounts/:id` | `{account:{…}}` → Account | grep |
| DELETE | `/accounts/:id` | desativa | grep |
| POST | `/accounts/:id/switch` | `{}` → dados | grep |
| POST | `/accounts/:id/leave` | `{}` | grep |
| GET | `/account/lifetime_revenue` | faturamento acumulado (dashboard) | REA |
| GET | `/invitations/:token` | → `{invitation}` | grep |
| POST | `/invitations/:token/accept` \| `/decline` | → `{message}` | grep |
| GET | `/member_invitations/:token` | → `{association}` | grep |
| POST | `/member_invitations/:token/accept` \| `/decline` | | grep |
| GET | `/support/access_requests` | → `{requests}` | REA |
| POST | `/support/access_requests/lookup` | `{access_request:{email}}` → `{accounts}` | REA |
| POST | `/support/access_requests` | `{access_request:{email,account_id?}}` → `{request}` | REA |
| DELETE | `/support/access_requests/:id` | cancelar | grep |
| POST | `/support/access_requests/:id/resend` | → `{request}` | grep |
| GET | `/support/access_grants` | → `{grants}` | REA |
| GET | `/support/access_grants/:accountId/flows` | → `{flows}` | grep |

Codec de fluxos: requisições para endpoints de fluxo podem ter o corpo ofuscado (versões v1/v2/v3 com checksum FNV e nonce) — ver módulo de Fluxos (`pretty.js:34150-34260`).

Armazenamento local (fonte: REA, storage): `localStorage.auth_token`, `localStorage.user` (cópia do usuário incl. `current_account`), `localStorage.theme`, `localStorage.sidebarCollapsed`, `localStorage.leona.settingsHubCollapsed`.

## 7. Eventos realtime

WebSocket ActionCable em `wss://<api>/cable` (`pretty.js:11471`).
| Canal | Params | Evento (`type`) | Efeito |
|---|---|---|---|
| `AccountNotificationsChannel` | `{account_id}` | `lead_counter_incremented` `{account_id, welcome_leads_count?, increment_by?}` | atualiza contador de leads (`pretty.js:35890`) |
| `AccountNotificationsChannel` | `{account_id}` | `support_access_requested` / `_granted` / `_revoked` / `_cancelled` | modal de aprovação para owner/admin (módulo 16) |
| `SupportNotificationsChannel` | `{user_id}` | `support_access_approved` / `_rejected` / `_revoked` | atualiza a tela `/support/access` (`pretty.js:270972-270997`) |
Logout chama `disconnect()` de todas as assinaturas.

## 8. Permissões

- Login/cadastro/reset: públicos.
- `/profile`: sempre permitido (`profile.view` sempre concedido).
- Criar conta: `user.role ∈ {admin, client, client_employee}`.
- Ver/editar empresa: `settings.accounts.view`/`edit`/`delete`; fuso: owner/admin da conta ou admin de sistema.
- Owner tem todas as permissões automaticamente (`pretty.js:36250`).
- `support`: só rotas listadas em 2; home = `/support/access`.
- `admin` (sistema): acesso a `/admin`.
- Matriz completa: módulo 16 §8.

## 9. Integrações externas

- **Rewardful** (afiliados): parâmetro `ref`/`via` no cadastro é enviado como `rewardful_referral`.
- E-mail transacional (backend): reset de senha, convites, alertas de desconexão de instância [INFERIDO pelo texto de UI].
- ActionCable (Rails) para realtime.

## 10. Lacunas

- [NÃO VERIFICADO] Duração do token / refresh token — não há refresh no cliente; expiração tratada só via 401.
- [INFERIDO] "Lembrar-me" não altera o armazenamento (sempre localStorage).
- [NÃO VERIFICADO] Confirmação de e-mail: existe `email_confirmed_at`, mas não há rota de confirmação no front.
- [INFERIDO] `/invitation` sem token é tela legada inoperante (formulário de nome/senha não é enviado).
- [NÃO VERIFICADO] Conteúdo da tela `/accounts` legada (`SAt`) e se ainda é alcançável pela navegação.
- [NÃO VERIFICADO] Regras de unicidade do `slug` e do e-mail (apenas backend).
- [NÃO VERIFICADO] Política de limite de upload do avatar (texto diz 5 MB).
- [INFERIDO] `/welcome` é o dashboard; o onboarding guiado não existe no bundle (nenhuma rota/wizard de onboarding encontrado além do Embedded Signup da Meta [REQUER WABA]).

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| E-mail de status "instância restrita (API Oficial)" em `connection_status_emails_enabled` | [REQUER WABA] | Manter só o e-mail de desconexão (evento `connection.update` com `close`); banimento detectado por `DisconnectReason.loggedOut`/403 |
| Onboarding via Embedded Signup da Meta | [REQUER WABA] | Pareamento por QR Code ou código no telefone na tela de conexões |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo.

- **Seletor de empresa (topo da sidebar):** nome da empresa com "Leads: N". O popover lista as empresas do usuário com a descrição (ex. "Empresa criada automaticamente"), que confirma a criação automática de uma empresa no cadastro.
- **Cartão do usuário (rodapé):** avatar com iniciais, nome, e-mail e a marca "(empresa ativa)". O menu tem "Meu perfil" e "Sair".
- **/profile "Meu Perfil":**
  - Avatar: JPEG, PNG ou WebP, máximo 5 MB. Indicador "Online".
  - Abas Dados Pessoais | Segurança | Preferências. Só a primeira foi lida.
  - Dados Pessoais: Nome completo, E-mail, WhatsApp pessoal ("número pessoal, não utilizado nas automações"), botão Salvar.
- **Empresa (/settings?tab=accounts):** botão "Nova Conta" (multiempresa). Formulário: Nome da empresa*, Descrição, Slug, Fuso horário, switch de e-mail de instâncias. Detalhes no spec 16.
