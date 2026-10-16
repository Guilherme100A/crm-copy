# 16 — Configurações: Empresa, Equipe e Acessos

> Fonte: bundle `_bundle/pretty.js` (refs `pretty.js:N`) + tabela REA (`_rea/rea-endpoints.md`). "(fonte: REA)" = endpoint/rota presente na tabela do REA; "(fonte: grep)" = template literal não extraído pelo REA. Exemplos fictícios; nenhum dado real copiado.

## 1. Visão geral

`/settings` é um **hub de configurações** com menu lateral agrupado (colapsável; estado em `localStorage["leona.settingsHubCollapsed"]`) e, no mobile, um select pesquisável "Selecione a Categoria". A seção ativa vai na query `?tab=<id>`; sub-abas da Empresa em `&company_tab=<id>`. Este módulo cobre: hub e abas, Empresa (Dados Corporativos, Departamentos, Horários de Trabalho), Equipe (membros, papéis, permissões granulares, convites de membro), Convites para Plataforma, Acesso de suporte e Uso da Leona AI. Conteúdo (respostas rápidas, templates, variáveis, campos, etiquetas, fluxos padrões, traduções) → módulo 17.

Features (≈ 46): hub com 3 grupos e 16 seções; seleção por URL com fallback; filtro de seções por permissão/papel; menu colapsável; select mobile pesquisável; **Empresa**: dados corporativos (nome, descrição, slug, fuso, e-mail de status de instâncias), status ativa/inativa, desativar, reativar, criar nova conta, convidar membro, sair da empresa; **Departamentos**: listar paginado (20) com busca, criar, editar, excluir, paleta de 10 cores + cor custom; **Horários**: config por conexão WhatsApp, ativar/desativar, ação fora do horário (mensagem ou fluxo), grade semanal com múltiplos intervalos por dia, toggle de dia, adicionar/remover intervalo; **Equipe**: listar membros, busca (nome/e-mail/papel), filtro por papel, filtro por departamento (incl. "Sem departamento"), ordenação por nome/papel/departamento, menu de ações por membro, alterar papel, transferir propriedade, editar permissões granulares, escopo de chat por departamentos e conexões, remover membro, seleção múltipla + remoção em lote (stub), convidar membro por e-mail, convites pendentes (reenviar com cooldown/limite 3/dia, cancelar); **Convites para Plataforma**: listar paginado, busca, filtro por status, contadores por status, convidar, obter/copiar link, reenviar, cancelar, detalhes; **Acesso de suporte**: listar grants ativos, revogar, modal de aprovação/recusa de solicitações em tempo real; **Uso da Leona AI**: histórico de cobranças por sessão.

## 2. Telas e rotas

| Rota | Destino | Ref |
|---|---|---|
| `/settings` (fonte: REA) | hub (`bjt`) | `pretty.js:117383` |
| `/settings/invitations` (fonte: REA) | página de Convites para Plataforma (mesmo componente da aba) | `pretty.js:122313` |
| `/settings/support-access` (fonte: REA) | redireciona → `/settings?tab=support_access` | `pretty.js:122327` |
| `/settings/labels` (fonte: REA), `/labels` | → `/settings?tab=tags` | `pretty.js:122310`, `123211` |
| `/departments` (fonte: REA) | → `/settings?tab=accounts&company_tab=departments` | `pretty.js:123217` |
| `/business-hours` (fonte: REA) | → `/settings?tab=accounts&company_tab=hours` | `pretty.js:249810` |
| `users` (fonte: REA) | → `/settings?tab=team` | `pretty.js:149222` |
| `/quick_replies`, `/global_variables`, `/customer_custom_fields`, `/connection_flow_configs`, `/integrations/*`, `/settings/mcp-credentials`, `/settings/whatsapp-templates` [REQUER WABA] | redirecionam para a aba correspondente | `pretty.js:122308-122335`, `133766`, `157134-157362`, `249801` |

### 2.1 Abas do hub (ordem, grupo, permissão) — `pretty.js:117161-117335`

| # | id (`?tab=`) | Rótulo pt-BR | Grupo | Inline? | Permissão exigida |
|---|---|---|---|---|---|
| 1 | `accounts` | Empresa | Conta | sim | `settings.accounts.view` |
| 2 | `team` | Equipe | Conta | sim | `team.view` |
| 3 | `platform_invitations` | Convites para Plataforma | Conta | sim | `settings.platform_invitations.view` |
| 4 | `support_access` | Acesso de suporte | Conta | sim | só owner ou admin da conta (`ownerAdminOnly`) |
| 5 | `flow_translator_history` | Traduções de fluxo | Conta | sim | `flows.view` (oculto p/ suporte) |
| 6 | `leona_ai_usage_history` | Uso da Leona AI | Conta | sim | `settings.view` (oculto p/ suporte) |
| 7 | `connection_flow_configs` | Fluxos Padrões | Automação | sim | `settings.dispatch.view` |
| 8 | `mass_dispatches` | Disparos em massa | Automação | **não** (navega para `/mass-dispatches`) | `contacts.view` |
| 9 | `quick_replies` | Respostas Rápidas | Automação | sim | `settings.quick_replies.view` |
| 10 | `whatsapp_templates` | Templates WhatsApp [REQUER WABA] | Automação | sim | nenhuma (flag de build que restringiria a `user.role==="admin"` está desligada; `pretty.js:11479`, `117137-117142`) |
| 11 | `global_variables` | Variáveis Globais | Automação | sim | nenhuma (sempre liberado) |
| 12 | `custom_fields` | Campos Personalizados | Automação | sim | `settings.fields.view` |
| 13 | `tags` | Etiquetas | Automação | sim | `settings.labels.view` |
| 14 | `integrations` | Integrações | Integrações | sim | `settings.integrations.view` |
| 15 | `products` | Produtos | Integrações | sim | `settings.products.view` |
| 16 | `mcp_credentials` | Ferramentas MCP | Integrações | sim | `settings.mcp.view` |

Grupos: "Conta", "Automação", "Integrações" (`pretty.js:15460`). Regras: tab ausente ou não permitida → substitui (replace) pela primeira aba visível; usuário `support` vê só abas com permissão explícita e nunca as 5/6 (`pretty.js:117394-117408`). Cabeçalho mostra "Configurações" + título e descrição da aba ativa.

### 2.2 Sub-abas da Empresa (`company_tab`) — `pretty.js:97449`
`info` = Dados Corporativos · `departments` = Departamentos · `hours` = Horários de Trabalho.

## 3. Modelo de dados / campos

### 3.1 Empresa — Dados Corporativos (`pretty.js:97509-97900`)
| Campo | Tipo | Obrig. | Validação/default |
|---|---|---|---|
| Nome da empresa (`name`) | text | sim | trim; botão "Salvar empresa" desabilitado se vazio |
| Descrição (`description`) | text | não | vazio → omitido |
| Slug (`slug`) | text | não | `^[a-z0-9-]*$` |
| Fuso horário (`time_zone`) | select | — | 12 opções IANA (default America/Sao_Paulo); readonly se não owner/admin ("Somente proprietários e administradores podem alterar o fuso.") |
| Notificações por e-mail de instâncias (`connection_status_emails_enabled`) | switch | — | default ligado |
Também exibe badge Ativa/Inativa e botão Desativar/Ativar. Labels `contactEmail`/`phone` existem no i18n mas não são renderizados [INFERIDO: campos futuros].

### 3.2 Departamento (`pretty.js:95137`, serviço `pretty.js:87420-87434`)
| Campo | Tipo | Obrig. | Validação/default |
|---|---|---|---|
| `name` | string | sim | — |
| `color` | hex | — | default `#3B82F6`; paleta: azul #3B82F6, vermelho #EF4444, verde #10B981, âmbar #F59E0B, roxo #8B5CF6, laranja #F97316, ciano #06B6D4, lima #84CC16, rosa #EC4899, cinza #6B7280; cor fora da paleta aparece como "personalizada" |

### 3.3 Horário de atendimento (por conexão) (`pretty.js:95966-96020`, UI `96522`)
`business_hour_config`:
| Campo | Tipo | Notas |
|---|---|---|
| `connection_id` | int | obrigatório (select "WhatsApp *", mostra Conectada/Desconectada) |
| `active` | bool | "Sistema de horários ativo/desativado" |
| `action_type` | enum `message` \| `flow` | "Tipo de Ação Fora do Horário": Mensagem (envia mensagem automática) / Fluxo (inicia fluxo) |
| `message_text` | text? | obrigatório se ativo e `message` |
| `flow_id` | int? | obrigatório se ativo e `flow` |
| `business_hours[]` | lista | ver abaixo |
`business_hour`: `day_of_week` (0=Domingo … 6=Sábado), `start_time` "HH:MM", `end_time` "HH:MM", `active` bool, `id`. Vários intervalos por dia; novo intervalo default 09:00–18:00.

### 3.4 Membro da equipe (`GET /team`)
`id`, `user_id`, `role` (owner/admin/member), `user{name,email}`, `departments[{id,name,color}]`, `connections[{id,name}]`, `permission_keys[]`.

### 3.5 Convite de membro (`/accounts/:id/invitations`)
`id`, `email`, `role` (member/admin), `status` (pending…), `created_at` (Enviado em), `expires_at`, `can_resend` bool, `resends_remaining_today` int, `invited_by`.

### 3.6 Convite para plataforma (`/account_invitations`)
`id`, `email`, `role` (default enviado `client`; tabela exibe Administrador/Membro), `status` pending/accepted/declined/expired, `token`, `created_at`, `updated_at`, `expires_at`, `can_resend`, `resends_remaining_today`, `invited_by{name}`, `account{name,description,slug}`, `invitation_link` (na criação/obter link). Listagem traz `status_counts`.

### 3.7 Acesso de suporte
Solicitação: `id`, `status`, `support_name`, `support_email`, `account_id`. Grant: `support_user_id`, nome, e-mail, `expires_at`.

### 3.8 Uso da Leona AI (`GET /leona_ai/usage_history` → `sessions[]`)
`kind` (`ai_agent` ou sessão), `session_id`, `title`, `flow_id`, `flow_name`, `flow_kept` (se o fluxo ainda existe → link `/flows/:id/edit`), `status` (`paused_for_payment`=Pausada, `archived`=Arquivada, outro=Ativa, vazio="Sem sessão"), `last_charged_at`, `charged_tokens` (Usado), `event_count` (Turnos) (`pretty.js:116975-117110`).

## 4. Estados e transições

- Empresa: Ativa ⇄ Inativa (desativar bloqueado com assinatura ativa).
- Papel na conta: `member` → `admin` → `owner` (transferência). Só owner promove um **admin** (que não seja ele mesmo) a owner; owner vendo a si mesmo só vê a opção owner (não pode se rebaixar diretamente) (`pretty.js:86955-86962`). Transferência: o owner atual vira Administrador e o novo é o único proprietário; só o novo proprietário gerencia assinatura/faturamento/exclusão.
- Convite (membro e plataforma): `pending` (Pendente) → `accepted` (Aceito) | `declined` (Recusado) | `expired` (Expirado); `pending` → cancelado (sai da lista).
- Reenvio: habilitado se `can_resend`; senão mostra "Limite de 3 reenvios por dia atingido" (quando `resends_remaining_today ≤ 0`) ou "Aguarde alguns minutos antes de reenviar" (cooldown).
- Solicitação de suporte: `pending` → `approved` (grant 12h) | `rejected`; grant ativo → revogado | expirado.
- Horários: config inexistente → tratada como inativa/mensagem vazia.

## 5. Ações e regras de negócio

**Empresa**
1. Carrega a conta corrente via `GET /accounts?limit=100` e escolhe a de `current_account.id`; recarrega quando há troca de empresa.
2. Salvar: `PUT /accounts/:id` → toast "Conta atualizada com sucesso!" → recarrega lista de contas do usuário.
3. Desativar: se `subscription_status==="active"` erro "Não é possível desativar uma conta com assinatura ativa…"; senão modal crítico → `DELETE /accounts/:id`.
4. Reativar: modal "Ativar Empresa" → `PUT {active:true}`.
5. "Nova Conta": modal (nome*, descrição, slug auto, "Conta ativa").
6. "Convidar membro" (dentro da aba Empresa) abre o mesmo modal de convite da Equipe.
7. "Sair da Empresa": confirmação → `POST /accounts/:id/leave`.

**Departamentos**: lista paginada `?page&limit=20&search`; criar/editar `{department:{name,color}}`; excluir com `confirm()` nativo. Departamentos de membro restringem quais chats ele vê ("Se nenhum for selecionado, vê todos os chats").

**Horários** (salvamento explícito pelo botão "Salvar" no topo): valida conexão; se ativo valida mensagem/fluxo; `PATCH /business_hour_config?connection_id=` com config; depois **apaga todos os intervalos existentes e recria** cada intervalo preenchido (`pretty.js:96615-96635`). Carrega fluxos (`GET /flows?all_flows=true`) e conexões para os selects. O fuso usado é o da empresa.

**Equipe** (`pretty.js:89446`)
1. Lista `GET /team`; erro com "permissão/forbidden/403" mostra tela "Acesso Negado".
2. Convites pendentes: `GET /accounts/:id/invitations` filtrando `status==="pending"`.
3. Busca local por nome/e-mail/papel; filtros papel (Todas/Proprietário/Administrador/Membro) e departamento (Todos/Sem departamento/cada departamento existente nos membros); ordenação owner<admin<member.
4. Menu do membro: "Permissões" (owner/admin da conta), "Editar perfil" (`team.edit`), "Remover membro" (`team.delete`, nunca para owner).
5. Alterar papel: `PATCH /account_members/:userId?account_id=X {member:{role}}`; aviso "alterar o perfil do membro pode afetar suas permissões". Owner→ transferir exige modal de confirmação com 4 consequências.
6. Remover: `confirm()` → `DELETE /account_members/:userId?account_id=X`.
7. Remoção em lote: seleção múltipla (só removíveis) — **stub**: o modal avisa que ainda não está ligado à API e só fecha (`pretty.js:17171` texto bulkRemoveModalStubNote).
8. Convidar membro: e-mail (regex `\S+@\S+\.\S+`) + papel (Membro "Acesso básico" / Administrador "Gerenciar recursos") → `POST /accounts/:id/invitations {invitation:{email,role}}`. O usuário precisa já estar cadastrado; recebe e-mail e aceita em `/member_invitations/:token` (módulo 01).
9. Reenviar convite: `PATCH /accounts/:id/invitations/:invId/resend`; cancelar (com confirm): `PATCH …/cancel`.
10. **Permissões granulares** (modal "Permissões do membro", `pretty.js:87436-87990`):
    - Carrega `GET /account_permissions/definitions?role=<papel>` (grupos), departamentos e conexões.
    - Owner: travado ("Proprietário tem acesso total.").
    - Grupos colapsáveis com contador "N ativa(s)". Grupo `settings` é uma matriz Área × (Visualizar, Editar, Excluir) + checkbox "Acessar configurações" (`settings.view`); seções `always_granted` ("Todos os membros têm acesso a esta área.") e `owner_only` ("Somente o proprietário…") não são editáveis.
    - Dependências: marcar edit/delete marca view e `settings.view`; desmarcar view desmarca edit/delete; marcar `chat.block` marca `chat.view`; desmarcar `chat.view` remove `chat.block`; cabeçalho de coluna marca/desmarca toda a coluna.
    - Escopo do chat (só se `chat.view`): seleção múltipla com busca de **Departamentos no chat** e **Conexões no chat**.
    - Salvar: `PATCH /account_members/:userId?account_id=X {member:{permission_keys[], department_ids[], connection_ids[]}}`. Texto: "A pessoa precisa entrar de novo para aplicar."
    - Chaves `settings.global_variables.*` são sempre incluídas.

**Convites para Plataforma** (`pretty.js:108850-110200`): convida um e-mail para a plataforma (associado à conta atual). Lista paginada com busca (debounce 400 ms) por e-mail/convidante/conta, filtro por status e cards de contagem (Total, Pendentes, Aceitos, Recusados, Expirados). Criar: `POST /account_invitations {invitation:{email, role:"client"}}` → exibe "Link de Convite Gerado!" com botão Copiar (`invitation_link`) e toast neutro "Se o email estiver cadastrado no sistema, o convite será enviado." Ações por linha (só pending): reenviar, obter link (copia para a área de transferência), cancelar; linha expansível com dados da conta e do convite (token, criado/atualizado). Existe modal "Criar Usuário e Enviar Convite" (nome, e-mail travado, senha ≥6, confirmação) → `POST /account_invitations/create_user_and_invite {user:{…}}`, e `GET /account_invitations/check_email?email=`, mas o modal de convite atual não os aciona [INFERIDO: fluxo desativado].

**Acesso de suporte** (`pretty.js:116489`, `41600-41700`)
- Aba lista grants ativos (Suporte, E-mail, Expira em) com "Revogar acesso" → `DELETE /account_support_access_grants/:supportUserId`.
- Modal global (owner/admin) aparece quando há solicitação pendente: "{nome} ({e-mail}) solicitou acesso temporário de 12h aos fluxos desta conta"; botões "Recusar" / "Aprovar por 12h"; mostra contagem se houver mais de uma; avança para a próxima pendente.

**Uso da Leona AI**: tabela somente leitura (Data, Sessão, Fluxo, Status, Usado, Turnos); vazio: "Nenhuma cobrança da Leona AI nesta conta."

## 6. Endpoints da API

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/accounts?page&limit&search` | | REA (`/accounts`) |
| POST | `/accounts` | `{account}` | REA |
| PUT | `/accounts/:id` | `{account:{name,description,slug,time_zone,connection_status_emails_enabled,active}}` | grep `pretty.js:34663` |
| DELETE | `/accounts/:id` | desativar | grep |
| POST | `/accounts/:id/leave` | | grep |
| GET | `/team` | membros da conta corrente | REA |
| POST | `/team/create` | `{member}` — sem UI [INFERIDO] | REA |
| GET | `/accounts/:id/account_members` | alternativa a `/team` | grep `pretty.js:86500` |
| PATCH | `/account_members/:userId?account_id=` | `{member:{role}}` ou `{member:{permission_keys,department_ids,connection_ids}}` | grep |
| DELETE | `/account_members/:userId?account_id=` | | grep |
| GET | `/account_permissions/definitions?role=` | → `{groups:[{key, children[{key}], sections[{key,always_granted,owner_only}]}]}` | grep `pretty.js:87400` |
| GET | `/accounts/:id/invitations` | convites de membro | grep |
| POST | `/accounts/:id/invitations` | `{invitation:{email,role}}` | grep |
| PATCH | `/accounts/:id/invitations/:inv/resend` \| `/cancel` | | grep |
| GET | `/invitations` | todos os convites do usuário (sem UI identificada) | REA |
| GET | `/account_invitations?page&limit&search&status` | → `{invitations,pagination,status_counts}` | REA |
| POST | `/account_invitations` | `{invitation:{email,role}}` → `{invitation_link,…}` | REA |
| GET | `/account_invitations/check_email?email=` | | grep |
| POST | `/account_invitations/create_user_and_invite` | `{user:{name,email,password,password_confirmation}}` | REA |
| PATCH | `/account_invitations/:id/resend` \| `/cancel` | | grep |
| GET | `/account_invitations/:id/link` | → `{invitation_link}` | grep |
| GET | `/departments?page&limit&search` | | REA (`/departments`) |
| GET | `/departments/all` | | REA |
| POST | `/departments` | `{department:{name,color}}` | REA |
| PUT/DELETE | `/departments/:id` | | grep |
| GET/PATCH | `/business_hour_config?connection_id=` | `{business_hour_config:{active,connection_id,action_type,message_text,flow_id}}` | grep |
| GET/POST | `/business_hour_config/business_hours?connection_id=` | `{business_hour:{day_of_week,start_time,end_time,active}}` | grep |
| PATCH/DELETE | `/business_hour_config/business_hours/:id?connection_id=` | | grep |
| GET | `/account_support_access_requests` | → `{requests}` | REA |
| POST | `/account_support_access_requests/:id/approve` \| `/reject` | | grep |
| GET | `/account_support_access_grants` | → `{grants}` | REA |
| DELETE | `/account_support_access_grants/:supportUserId` | revogar | grep |
| GET | `/leona_ai/usage_history` | → `{sessions}` | grep `pretty.js:36658` |

## 7. Eventos realtime

`AccountNotificationsChannel {account_id}` (`pretty.js:41497-41528`): `support_access_requested` (payload `{request}` → abre modal), `support_access_granted`, `support_access_revoked` (recarregam listas), `support_access_cancelled` (remove a solicitação). Também `lead_counter_incremented` (módulo 01). Troca de empresa dispara recarga local de todas as abas (evento interno, não WebSocket).

## 8. Permissões

### 8.1 Catálogo de chaves (rótulos do modal, `pretty.js:17171`)
| Grupo | Chaves |
|---|---|
| Dashboard | `dashboard.sales` (Vendas), `dashboard.support` (Atendimento) |
| Chat ao vivo | `chat.view` (Acessar chat), `chat.block` (Bloquear contato) |
| Kanban | `kanban.view/edit/delete` |
| Fluxos | `flows.view/edit/delete` |
| Contatos | `contacts.view/edit/delete` |
| Webhooks | `webhooks.view/edit/delete` |
| Conexões | `connections.view/edit/delete` |
| Facebook / Meta | `facebook.campaigns` (Gerenciador), `facebook.pixel`, `facebook.profiles` (Perfis e contas) |
| Equipe | `team.view` (Visualizar), `team.edit` (Gerenciar membros), `team.delete` (Remover membros) |
| Cobranças | `billing.view` |
| Configurações | `settings.view` + matriz `settings.<área>.<view|edit|delete>` para as áreas: `labels` (Etiquetas), `departments`, `fields` (Campos), `products`, `mcp`, `integrations`, `dispatch` (Fluxos padrões), `business_hours` (Horários), `quick_replies`, `accounts` (Contas), `platform_invitations`, `global_variables` (`pretty.js:36088-36110`) |
Sempre concedidas: `profile.view` e `settings.global_variables.*`.

### 8.2 Matriz padrão (usada quando o servidor não envia `current_account.permissions`; `pretty.js:36186-36227`)
| Permissão | member | admin | owner |
|---|---|---|---|
| chat.view, kanban.view, flows.view, contacts.view, settings.view, profile.view | ✔ | ✔ | ✔ |
| settings.{labels,departments,fields,products,mcp,integrations,dispatch,business_hours,quick_replies,accounts}.view | ✔ | ✔ | ✔ |
| settings.global_variables.view/edit/delete | ✔ | ✔ | ✔ |
| settings.quick_replies.edit | ✔ | ✔ | ✔ |
| settings.{mesmas 10 áreas}.edit/delete | — | ✔ | ✔ |
| dashboard.sales, dashboard.support | — | ✔ | ✔ |
| kanban/flows/contacts .edit/.delete | — | ✔ | ✔ |
| webhooks.*, connections.*, chat.block | — | ✔ | ✔ |
| facebook.campaigns/pixel/profiles | — | ✔ | ✔ |
| team.view/edit/delete, billing.view | — | ✔ | ✔ |
| settings.platform_invitations.* | — | — (só se o servidor conceder) | ✔ (owner = tudo) |
Regras: owner ⇒ `can()` sempre verdadeiro; se o servidor enviar lista não vazia de permissões, ela **substitui** a matriz padrão; usuário `support` usa só a lista explícita (+profile/global_variables).

### 8.3 Mapeamento recurso/ação → chave (`pretty.js:36160-36185`)
Ações: show/index/read→view, create/update→edit, destroy→delete. Recursos: chat→chat, crm→kanban, flow→flows, customer→contacts, connection→connections, billing→billing, user_account/account_invitation→team, inbound_webhook/webhook→webhooks; label→settings.labels.view; quick_reply→settings.quick_replies.view; business_hour(_config)→settings.business_hours.view; global_variable→settings.global_variables.view; account→settings.accounts.view (create: role de sistema admin/client/client_employee); product→settings.products.view; ai_integration→settings.mcp.view; connection_flow_config→settings.dispatch.view.

### 8.4 Regras específicas desta tela
- Aba Acesso de suporte e modal de aprovação: owner ou admin da conta.
- Editar permissões: owner ou admin da conta (o texto diz "Só o proprietário define…" — [NÃO VERIFICADO] se o backend bloqueia admin).
- Fuso: owner/admin da conta ou admin da plataforma.

## 9. Integrações externas

- E-mail (convites de membro/plataforma, reenvio com limite diário, alerta de desconexão de instâncias).
- WhatsApp (conexões usadas em Horários e escopo de chat).
- Leona AI (cobrança por tokens — consulta de uso).

## 10. Lacunas

- [NÃO VERIFICADO] Conteúdo exato de `/account_permissions/definitions` por papel (quais seções vêm `always_granted`/`owner_only`).
- [INFERIDO] Remoção em lote de membros não implementada (stub de UI).
- [INFERIDO] `create_user_and_invite`, `check_email`, `/team/create`, `/invitations` e `getAccountMembers` sem uso na UI atual.
- [NÃO VERIFICADO] Duração do convite e janela de cooldown do reenvio (apenas "3 por dia" é explícito).
- [NÃO VERIFICADO] Como o backend avalia horário comercial (inclusão do minuto final, intervalos sobrepostos, feriados — não há feriados no front).
- [INFERIDO] Campos "E-mail de contato" e "Telefone" da empresa previstos no i18n, não renderizados.
- [NÃO VERIFICADO] Diferença funcional entre `role` "client" no convite de plataforma e "Administrador/Membro" exibidos na tabela.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Aba `whatsapp_templates` (Templates WhatsApp) no hub `/settings` | [REQUER WABA] | Ocultar a aba; usar Respostas Rápidas (módulo 17) como modelos de mensagem livre |
| Redirect `/settings/whatsapp-templates` | [REQUER WABA] | Remover a rota ou redirecionar para `/settings?tab=quick_replies` |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Hub /settings:** menu interno agrupado em CONTA (Empresa, Equipe, Convites para Plataforma, Acesso de suporte, Traduções de fluxo, Uso da Leona AI), AUTOMAÇÃO (Fluxos Padrões, Disparos em massa, Respostas Rápidas, Templates WhatsApp, Variáveis Globais, Campos Personalizados, Etiquetas) e INTEGRAÇÕES (Integrações, Produtos, Ferramentas MCP). Bate com o bundle. Botão "Fechar menu interno".
- **Empresa:** sub-abas Dados Corporativos | Departamentos | Horários de Trabalho, mais o botão "Nova Conta".
  - Dados Corporativos: Nome da empresa* (obrigatório), Descrição (opcional), Slug (letras minúsculas, números e hífens), Fuso horário (ex. "Brasília (America/Sao_Paulo)"), switch "Notificações por e-mail de instâncias", botão "Salvar empresa".
- **Departamentos:** "Novo Departamento"; card "Departamentos Ativos" (setores de distribuição automática de contatos). Vazio: "Criar Primeiro Departamento".
- **Horários de Trabalho:** "Horários de Atendimento" (escalas semanais). Botão "Salvar" no topo, com a nota de que as alterações são confirmadas por ele. Status "Sistema de horários desativado". Select "WhatsApp *" com as conexões e seus status.
- **Equipe:** "N membros", "Convidar membro", busca, filtros Função ("Todas as funções") e Departamento. Tabela Membro, Função (ex. Proprietário), Depto ("Sem departamento"), AÇÕES. Seção "Convites pendentes" (reenviar/cancelar; vazio "Nenhum convite pendente").
- **Convites para Plataforma:** "Convidar para Plataforma". Contadores Total, Pendentes, Aceitos, Recusados, Expirados. Busca e "Filtrar por status: Todos". Vazio com "Convidar Primeira Pessoa".
- **Acesso de suporte:** lista de acessos temporários aprovados, com revogação. Vazio: "Nenhum suporte com acesso ativo."
- **Uso da Leona AI:** cobranças agrupadas por sessão, separadas do tradutor. Vazio: "Nenhuma cobrança da Leona AI nesta conta."
