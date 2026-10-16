# 18 — Shell, navegação, tutoriais e suporte

Features documentadas: ~38

> Fonte: tabela REA `_rea/rea-endpoints.md` (rea-agents 6.5.0), com itens marcados "(fonte: REA)", e leitura estática de `_bundle/pretty.js`, citada como `pretty.js:N`. Análise clean-room: o texto descreve comportamento, sem código copiado e sem dados reais. Este módulo cobre o "esqueleto" do app autenticado: layout, menu, guardas de rota, redirecionamentos, atalhos, tutoriais e widget de suporte. Os assuntos que já têm spec próprio aparecem só como referência: 01 (auth/multiempresa), 02 (dashboard), 12 (tokens/cobrança), 13 (afiliação), 14 (notificações/banners), 16 (acesso de suporte), 21 (realtime).

---

## 1. Visão geral

O app é uma SPA React com React Router. A árvore de rotas (`pretty.js:282440-282608`) tem duas partes:

- **Rotas públicas**: `/login`, `/register`, `/cadastro`, `/forgot-password` e `/reset-password`. Ficam dentro de um guarda "somente deslogado": um usuário já logado é mandado para o destino em `?redirect=` ou para a home. Também são públicas as rotas de convite (`invitation/:token`, `member_invitations/:token` e `invitation`), que não passam por esse guarda. Detalhes no spec 01.
- **Rota-layout `/` protegida**: exige login e renderiza o **shell**, com header mobile, sidebar desktop, drawer mobile, barra inferior mobile e área principal (`<main>`). Todas as telas internas são filhas dela.

O shell monta, uma única vez, vários componentes globais (`pretty.js:47240-47253`):
- modal de assinatura em atraso (spec 12/14);
- modal de pedidos de acesso de suporte para owner/admin (spec 16);
- modal de alerta de desconexão de conexões e campanhas (spec 08/14);
- carregador do widget de chat de suporte (`window.LeonaChat`, seção 9);
- guarda de permissões por rota (seção 5.3).

Os toasts globais ficam num portal no canto superior direito (`pretty.js:43207-43280`).

## 2. Telas e rotas

### 2.1 Mapa de rotas internas (filhas do layout `/`)

| Rota | Destino | Fonte |
|---|---|---|
| `/welcome` | Dashboard (home), ver spec 02 | REA; `pretty.js:86357` |
| `/chat`, `/chats` | Chats (03) | `pretty.js:187723-187724` |
| `/crms`, `/crms/:id` | Kanban (04) | `pretty.js:133761-133762` |
| `/customers` | Contatos (05) | `pretty.js:156290` |
| `/flows`, `/flows/new`, `/flows/:id`, `/flows/:id/edit` | Fluxos (06) | `pretty.js:249794-249797` |
| `/agentes`, `/agentes/novo`, `/agentes/:id` | Agentes de IA (07) | `pretty.js:282430-282432` |
| `/connections` | Conexões (08) | `pretty.js:148299` |
| `/settings/inbound-webhooks`, `.../new` e `.../:id/edit` | Webhooks de entrada (09) | `pretty.js:122319-122321` |
| `/mass-dispatches` | Disparos em massa (10) | `pretty.js:276336` |
| `/facebook` (index), `/facebook/campaigns`, `/facebook/pixel` e `/facebook/profiles` | Meta Ads (19) | `pretty.js:272811-272819` |
| `/billing`, `/billing/invoices`, `/billing/refunds`, `/plans` | Cobrança (12) | `pretty.js:256449-256451`, `157131` |
| `/settings`, `/settings/invitations` | Hub de configurações (16/17) | `pretty.js:122308-122313` |
| `/accounts` | Empresas (16) | `pretty.js:134349` |
| `/products` | Produtos (17) | `pretty.js:157139` |
| `/integrations/leonapay/callback`, `/integrations/zenith/callback`, `/integrations/zenith/connect` | Callbacks OAuth (19) | `pretty.js:157347-157349` |
| `/profile` | Meu perfil (01) | `pretty.js:123208` |
| `/admin` | Painel interno (20), com guarda `role === "admin"` | `pretty.js:270971`, `47364-47371` |
| `/support/access` | Tela do agente de suporte (16), com guarda `role === "support"` | REA; `pretty.js:271510`, `47372-47379` |
| `/` e `/_temp_/*` | Redirecionam para a home do usuário (seção 5.2) | REA (`/_temp_/*`, `/`); `pretty.js:282599-282600`, `282434-282437` |

### 2.2 Todos os redirecionamentos declarados (`<Navigate replace>`)

Todos usam `replace`, então não deixam entrada no histórico.

| De | Para | Fonte |
|---|---|---|
| `/` | home do usuário: `/welcome`, ou `/support/access` se `role=support` | `pretty.js:282436`, `36134-36136` |
| `/_temp_/*` | home do usuário (usado como rota "tampão" para forçar remontagem, seção 5.6) | `pretty.js:282599` |
| `/quick_replies` | `/settings?tab=quick_replies` | REA; `pretty.js:133766-133767` |
| `/global_variables` | `/settings?tab=global_variables` | `pretty.js:157134-157135` |
| `/integrations` | `/settings?tab=integrations` | `pretty.js:157332-157333` |
| `/integrations/nf-issuer` | `/settings?tab=integrations` | `pretty.js:157336-157337` |
| `/integrations/utmify` | `/settings?tab=integrations` | `pretty.js:157340-157341` |
| `/integrations/payments` | `/settings?tab=integrations` | `pretty.js:157344-157345` |
| `/integrations/ai` | `/settings?tab=integrations` | `pretty.js:157351-157352` |
| `/invoice_integrations` | `/settings?tab=integrations` | `pretty.js:157355-157356` |
| `/customer_custom_fields` | `/settings?tab=custom_fields` | `pretty.js:157361-157362` |
| `/connection_flow_configs` | `/settings?tab=connection_flow_configs` | `pretty.js:249801-249805` |
| `/business-hours` | `/settings?tab=accounts&company_tab=hours` | `pretty.js:249810-249814` |
| `/labels` | `/settings?tab=tags` | `pretty.js:123211-123212` |
| `/departments` | `/settings?tab=accounts&company_tab=departments` | `pretty.js:123217-123221` |
| `/users` | `/settings?tab=team` | `pretty.js:149222-149223` |
| `/settings/labels` | `/settings?tab=tags` | `pretty.js:122310-122311` |
| `/settings/pixels` | `/facebook/pixel` | `pretty.js:122315-122316` |
| `/settings/meta` | `/facebook/profiles`, preservando a query string | `pretty.js:122303-122306`, `122318` |
| `/settings/mcp-credentials` | `/settings?tab=mcp_credentials` | `pretty.js:122323-122324` |
| `/settings/support-access` | `/settings?tab=support_access` | REA; `pretty.js:122327-122328` |
| `/settings/whatsapp-templates` | `/settings?tab=whatsapp_templates` **[REQUER WABA]** (templates da Meta Cloud API) | `pretty.js:122331-122335` |
| `/facebook` (index) | primeira subrota do Facebook que o usuário pode ver; sem nenhuma, vai para `/welcome` com `state.permissionDenied` | `pretty.js:271582-271592` |
| guarda de login (não autenticado) | `/login?message=login_required&redirect=<caminho+query>`, em que o redirect só é aceito se for um caminho relativo seguro | `pretty.js:47301-47336` |
| guarda "somente deslogado" (já autenticado) | `?redirect=` (validado), ou o `redirectTo` da rota, ou a home do usuário | `pretty.js:47337-47362` |
| guarda `/admin` (não admin) | `/welcome`; sem usuário, vai para `/login` | `pretty.js:47364-47371` |
| guarda `/support/access` (não `support`) | `/welcome`; sem usuário, vai para `/login` | `pretty.js:47372-47379` |

O redirect só é aceito se for "seguro" (`pretty.js:47301-47309`): precisa começar com `/` e não pode começar com `//` nem conter `://` ou `\`. Isso evita open redirect.

### 2.3 Página 404

Não existe rota curinga (`*`) nem componente de "página não encontrada" no roteador (`pretty.js:282440-282608`). [INFERIDO] Com o React Router, um caminho desconhecido não casa com nenhuma rota e a área renderizada fica em branco. O clone deve criar uma 404 própria; no original ela não existe.

### 2.4 Shell (layout) e seus elementos

- **Sidebar desktop** (`Eq`, `variant="desktop"`, `pretty.js:46396-47080`): coluna fixa à esquerda, visível a partir do breakpoint `lg`. Tem 240px de largura expandida e 64px recolhida.
- **Drawer mobile** (`Eq`, `variant="mobile"`): o mesmo menu em painel deslizante pela esquerda, com largura de cerca de 17,5rem (no máximo 88vw) e um backdrop clicável para fechar (`pretty.js:43861-43868`, `47254-47260`).
- **Header mobile** (`pretty.js:45580-45665`): logo, que leva à home; seletor de empresa (`variant="mobileTopBar"`); sino de notificações; menu do usuário compacto (avatar).
- **Barra inferior mobile** (`pretty.js:45667-45770`): seção 2.6.
- **Área principal** (`<main>`): mostra o banner "permissão negada" quando aplicável e o `Outlet`, com uma chave que muda para forçar a remontagem (seção 5.6).

### 2.5 Menu lateral: seções, itens e ordem (`pretty.js:46296-46386`)

Os rótulos pt-BR estão em `pretty.js:15067-15117` (namespace `nav`).

| Seção (rótulo) | Ordem | Item (rótulo pt-BR) | Rota | Permissão (qualquer uma basta) |
|---|---|---|---|---|
| PRINCIPAL ("Principal") | 1 | Dashboard | `/welcome` | `dashboard.sales` ou `dashboard.support` |
| | 2 | Chats ao vivo | `/chats` | `chat.view` |
| | 3 | Kanban | `/crms` | `kanban.view` |
| | 4 | Contatos | `/customers` | `contacts.view` |
| OPERAÇÕES ("Operações") | 5 | Fluxos | `/flows` | `flows.view` |
| | 6 | Agentes de IA, com selo "Novo" | `/agentes` | `flows.view` |
| | 7 | Conexões, com indicador de alerta (seção 5.5) | `/connections` | `connections.view` |
| | 8 | Webhooks de entrada | `/settings/inbound-webhooks` | `webhooks.view` |
| | 9 | Disparos em massa | `/mass-dispatches` | `contacts.view` |
| | 10 | Facebook | primeira subrota permitida entre `/facebook/campaigns`, `/pixel` e `/profiles` | `facebook.campaigns`, `facebook.pixel` ou `facebook.profiles` |
| GESTÃO ("Gestão") | 11 | Cobranças e assinaturas | `/billing` | `billing.view` |
| | 12 | Configurações | `/settings` | `settings.view` |
| | 13 | Administrativo (só se `user.role === "admin"`) | `/admin` | papel global |
| | 14 | **Tutoriais** (link externo, abre em nova aba) | URL externa de vídeos do fornecedor | nenhuma |

**Menu reduzido para o papel `support`** (`pretty.js:46387-46400`, `46430-46433`): um usuário com `role === "support"` (agente interno de suporte) vê só uma seção, "Principal", com dois itens: "Acessos de suporte" (`/support/access`) e "Credenciais MCP" (`/settings?tab=mcp_credentials`, que exige `settings.mcp.view`).

**Regras de visibilidade** (`pretty.js:46418-46429`):
- Um item com `permission` aparece se o usuário é **owner** da empresa ou tem pelo menos uma das permissões listadas. Itens sem `permission` sempre aparecem.
- Uma seção que fica sem itens visíveis some.
- O link do item Facebook é recalculado para a primeira subrota que o usuário pode ver (`pretty.js:40964-40966`).
- O item "Administrativo" e o item "Tutoriais" são acrescentados ao fim de GESTÃO, nessa ordem. Só entram se a seção GESTÃO existir, ou seja, se o usuário vê Cobranças ou Configurações (`pretty.js:46440-46465`). [INFERIDO] Um membro sem `billing.view` e sem `settings.view` não vê "Tutoriais".

**Sidebar recolhida**:
- Os títulos de seção viram divisores curtos.
- Os itens mostram só o ícone. Um tooltip flutuante (portal) com o rótulo aparece em hover ou foco (`pretty.js:47060-47078`).

**Rodapé da sidebar** (`cHe`, `pretty.js:45925-46294`), de cima para baixo:
1. Chip de saldo de tokens (ver spec 12). Fica oculto para o papel `support`.
2. Botões "Suporte" e "Afiliação". Recolhida, só os ícones.
3. Botão de tema ("Claro"/"Escuro" + dica "Ctrl+M · ⌘M") e o sino de notificações (ver spec 14).
4. Cartão do usuário: avatar com indicador verde/vermelho de empresa ativa/inativa, nome e e-mail. Abre um menu com "Meu perfil" e "Sair".

### 2.6 Barra inferior mobile (`pretty.js:45667-45770`)

| Ordem | Rótulo | Destino | Permissão |
|---|---|---|---|
| 1 | Início | home do usuário (`/welcome`), match exato | `dashboard.sales` ou `dashboard.support` |
| 2 | Chats ao vivo | `/chats` | `chat.view` |
| 3 | Kanban | `/crms` | `kanban.view` |
| 4 | Fluxos | `/flows` | `flows.view` |
| 5 | Mais | botão (não é link) | sempre visível |

- Para `role=support`, a barra mostra só "Início" (`/support/access`), "Fluxos" e "Mais".
- O filtro de permissão é o mesmo da sidebar: owner vê tudo.
- O item ativo tem um indicador visual.
- **"Mais"** abre e fecha o **drawer mobile**, com o mesmo conteúdo da sidebar completa: todas as seções, Tutoriais, rodapé com Suporte/Afiliação/tema/notificações e cartão do usuário (`pretty.js:47108`, `47254`).
- O drawer fecha sozinho ao trocar de rota ou ao clicar no backdrop (`pretty.js:47134-47136`).

### 2.7 Menu do usuário compacto (header mobile, `pretty.js:45417-45580`)

Itens, na ordem:
1. Meu perfil (`/profile`).
2. Modo claro/escuro + dica de atalho.
3. "Suporte": abre o widget de chat.
4. "Programa de afiliação": link direto para o portal externo de parceiros em nova aba, **sem** o modal de confirmação usado na sidebar.
5. Sair.

A tradução "Entrar no grupo de avisos" (`userMenu.alertsGroup`) e o rótulo "Avisos" (`sidebar.alertsShort`) existem, mas não têm uso no JSX encontrado. [NÃO VERIFICADO] Feature removida ou desativada.

### 2.8 Breadcrumbs (`zF`, `pretty.js:43355-43460`)

Componente reutilizado pelas páginas:
- Com uma lista explícita de itens, prefixa "Início" (`/welcome`), a menos que o primeiro item já seja a home.
- Sem lista, deriva os itens do `pathname`:
  - ignora `welcome` e segmentos numéricos (IDs);
  - mostra "Link de convite" após `invitation` ou `member_invitations`;
  - traduz cada segmento pela chave `breadcrumbs.segments.<seg>`, com fallback para o segmento em Title Case (`-` e `_` viram espaço).
- O último item não é clicável.
- O botão "Voltar" (`history.back`, ou um callback) aparece se houver histórico.
- Sem itens e sem "Voltar", o componente não renderiza nada.

## 3. Modelo de dados / campos

| Dado | Origem | Uso no shell |
|---|---|---|
| `user.role` (`admin`, `support` ou outro) | `/auth/profile` (spec 01) | Menu reduzido para support, item Administrativo, guardas |
| `user.current_account.{id,name,active,welcome_leads_count}` | perfil | Seletor de empresa, contador "Leads: N", bolinha ativa/inativa |
| `user.accounts[].user_role` (`member`/`admin`/`owner`) | perfil | Papel na empresa, base do `can()` e `isOwner` (`pretty.js:36169-36178`) |
| `user.{name,email,avatar_url,personal_whatsapp}` | perfil | Cartão do usuário e identificação no widget de suporte |
| Lista paginada de empresas `{accounts[], pagination.has_more}` | `GET /accounts?page&limit=20&search` | Seletor de empresa (`pretty.js:34635-34643`, `44067`, `44085-44095`) |
| `{has_recent_disconnected, disconnected_connections[], paused_adsets[], paused_campaigns[]}` | `GET /connections/disconnect_alert` | Indicador no item Conexões e modal de alerta (spec 08/14) |

**Chaves de storage do shell:**

| Chave | Tipo | Valor | Fonte |
|---|---|---|---|
| `sidebarCollapsed` | localStorage | JSON booleano; padrão `false` | REA; `pretty.js:47096-47127` |
| `theme` | localStorage | `"light"` ou `"dark"`; padrão segue `prefers-color-scheme` | `pretty.js:36021`, `36035-36043` |
| `selected_chat_<accountId>` | sessionStorage | id do chat aberto, usado para não notificar o chat atual | `pretty.js:45959-45980` |
| `disconnect_alert_dismissed_<accountId>` | sessionStorage | `"1"`; oculta o modal de desconexão na sessão | `pretty.js:42084`, `42112` |
| `leona_user`, `leona_test_*`, `leona_csat_submitted_*` | localStorage, escritas pelo widget de terceiros | apagadas pelo app ao fechar ou deslogar o widget | `pretty.js:42240-42251` |

## 4. Estados e transições

- **Sidebar**: expandida ou recolhida. O botão "Recolher"/"Expandir menu" alterna o estado, e o valor é persistido a cada mudança. O estado é só do desktop; o mobile usa o drawer.
- **Drawer mobile**: fechado ou aberto. Abre por "Mais" ou pelo botão de menu e fecha por troca de rota, backdrop ou navegação a partir de um item.
- **Tema**: `light` ou `dark`. Muda pelo botão ou pelo atalho, aplica as classes `light`/`dark` e `color-scheme` no `<html>`, e é reaplicado no `pageshow` (bfcache) (`pretty.js:36029-36098`).
- **Banner "permissão negada"**: quando a rota chega com `state.permissionDenied`, o shell mostra um alerta (âmbar) dispensável e limpa o `state` com um `replace` (`pretty.js:47115-47119`, `47268-47275`).
- **Widget de suporte**: não carregado → script injetado → `identify` feito → aberto/fechado. Ao deslogar ou virar `support`, o widget é fechado e as chaves dele são apagadas (`pretty.js:42252-42254`, `42306-42327`).
- **Seletor de empresa**:
  - estados: fechado, aberto, carregando, erro, "carregar mais";
  - a busca tem debounce de 300 ms (`pretty.js:44130-44133`) e "Carregar mais" pede a próxima página enquanto `has_more` for verdadeiro;
  - trocar de empresa chama `POST /accounts/:id/switch`, recarrega o perfil, grava `localStorage.user`, limpa os caches e notifica a mudança de conta (`pretty.js:35966-35975`). Detalhes no spec 01.
- **Body `chat-active-mobile`**: a classe é aplicada no `<body>` quando a rota é de chat e há um chat selecionado. [INFERIDO] Serve para esconder a barra inferior e o header no mobile (`pretty.js:47233-47238`).

## 5. Ações e regras de negócio

### 5.1 Atalhos de teclado
- **Ctrl+M (Windows/Linux) / ⌘M (macOS)** alterna o tema claro/escuro (`pretty.js:36062-36088`).
  - Não dispara com Alt ou Shift, em autorrepetição, nem com Ctrl e Meta juntos.
  - É ignorado com foco em `INPUT`, `TEXTAREA`, `SELECT` ou elemento `contentEditable`.
  - Chama `preventDefault`.
- Nenhum outro atalho global foi encontrado no shell. [NÃO VERIFICADO] Telas específicas, como chat e builder, podem ter atalhos próprios, descritos nos specs delas.

### 5.2 Home por papel
`home(user)` é `/support/access` se `role === "support"`; senão, `/welcome` (`pretty.js:36134-36136`). É usada pelo `/`, pelo `/_temp_/*`, pelo item "Início" do mobile e como destino quando falta permissão.

### 5.3 Guarda de permissões por rota (`pretty.js:40903-40942`, `40968-41030`)
Hook executado no shell a cada mudança de `pathname`:
1. **Papel `support`**: só pode estar em `/settings` (exato) ou em caminhos sob `/support/access`, `/settings/mcp-credentials`, `/profile` e `/flows` (`pretty.js:36137-36149`). Em qualquer outro caminho, vê o toast "permissão negada" e volta para a home com `state.permissionDenied`.
2. **Caminhos `/facebook*`**: sem nenhuma subpermissão de Facebook, o usuário vai para a home (negado). Se tem outra subpermissão mas não a desta subrota, vai para a primeira subrota permitida.
3. **Demais caminhos**: a permissão vem da tabela de prefixos abaixo, em que vence o **primeiro** prefixo que casar (prefixo exato ou `prefixo/…`). `null` significa livre. Um caminho que não está na tabela não tem checagem.
   - livres: `/profile`, `/support/access`, `/settings/support-access`, `/global_variables`;
   - `/settings/mcp-credentials` e `/integrations/ai`: `settings.mcp.view`;
   - `/welcome`: `dashboard.sales` ou `dashboard.support`;
   - `/chats` e `/chat`: `chat.view`;
   - `/crms`: `kanban.view`;
   - `/flows` e `/agentes`: `flows.view`;
   - `/customers` e `/mass-dispatches`: `contacts.view`;
   - `/settings/inbound-webhooks`: `webhooks.view`;
   - `/connections`: `connections.view`;
   - `/users`: `team.view`;
   - `/billing`: `billing.view`;
   - `/labels`: `settings.labels.view`;
   - `/departments`: `settings.departments.view`;
   - `/customer_custom_fields`: `settings.fields.view`;
   - `/products`: `settings.products.view`;
   - `/integrations`: `settings.integrations.view`;
   - `/connection_flow_configs`: `settings.dispatch.view`;
   - `/business-hours`: `settings.business_hours.view`;
   - `/quick_replies`: `settings.quick_replies.view`;
   - `/accounts`: `settings.accounts.view`;
   - `/settings/invitations`: `settings.platform_invitations.view`;
   - `/settings`: `settings.view` ou `settings.mcp.view`.
4. O toast de negação aparece no máximo uma vez por caminho seguido.

### 5.4 Cálculo de permissões
`can(perm)` é derivado do papel do usuário na empresa ativa (`member`, `admin` ou `owner`), com conjuntos padrão por papel (`pretty.js:36150-36200`). O owner sempre passa no filtro do menu. A matriz completa está no spec 16.

### 5.5 Indicador de conexões desconectadas no menu (`pretty.js:45784-45822`)
- Se o usuário não é `support` e (é owner ou tem `connections.view`), o shell consulta `GET /connections/disconnect_alert` ao montar e ao trocar de empresa.
- O item "Conexões" ganha um indicador com o rótulo "Instância desconectada nas últimas 24h" quando `has_recent_disconnected` é verdadeiro.
- O indicador é atualizado em tempo real (seção 7).

### 5.6 Remontagem forçada e rota `/_temp_/*` (`pretty.js:46628-46720`, `47083-47213`)
- O `Outlet` do shell tem uma chave incremental que muda a cada troca de `pathname`, a cada `state.refresh`/`state._force` e a cada evento `router:refresh`, `router:force-refresh` ou `router:hard-refresh`. Um polling de 100 ms detecta mudanças de `window.location.pathname` que não passaram pelo router.
- **Clique em "Fluxos" já estando em `/flows`**: dispara os eventos de refresh, com debounce de 500 ms, para recarregar a lista sem navegar.
- **Clique em "Fluxos" estando em `/flows/...`** (editor): vai para `/flows` com `replace` e dispara o refresh.
- O caminho que usa `/_temp_/<timestamp>` só é alcançado pelo ramo de fallback ("navegação tampão"):
  1. navega para `/_temp_/<timestamp>` com `replace`;
  2. o roteador manda `/_temp_/*` para a home;
  3. em seguida, o shell navega de novo para o destino com `state.refresh`.

  É um truque para forçar a remontagem completa da página. **Recomendação para o clone:** não reproduzir; usar invalidação de cache ou query.
- Os itens Webhooks, Chats, Conexões e Agentes têm tratamento de clique parecido, com refresh se já estiver na rota. [INFERIDO]

### 5.7 Assinatura em atraso (referência)
Ao montar e ao trocar de empresa, se o usuário não é `support`, o shell consulta a assinatura. Se ela estiver inadimplente, abre o modal "Regularizar assinatura", com destino `/billing?regularize=1` (`pretty.js:47137-47165`). Ver spec 12/14.

### 5.8 Home `/welcome` e bootstrap (referência)
A tela `/welcome` é o Dashboard, com abas de vendas e atendimento (spec 02). Ela usa `GET /dashboard/bootstrap` para filtros e dados iniciais, e `GET /dashboard` para as métricas (REA; `pretty.js:85587-85621`). O shell em si **não** chama o bootstrap. Banners e anúncios estão no spec 14.

### 5.9 Saldo de tokens no rodapé (referência)
O chip mostra o saldo e a barra "% usados". Clicar abre o modal de compra de créditos (`pretty.js:45875-45910`; spec 12).

### 5.10 Seletor de empresa e contador "Leads: N"
- O seletor fica no topo da sidebar ou no header mobile (`zoe`, `pretty.js:44068-44400`).
- Só renderiza se o usuário tem pelo menos uma empresa.
- Mostra o nome da empresa ativa e, abaixo, "Leads: N", em que N é `current_account.welcome_leads_count` (padrão 0).
- Recursos: busca, paginação de 20 em 20 e troca de empresa. As traduções incluem "Sair da empresa" (`POST /accounts/:id/leave`, spec 01/16).

## 6. Endpoints da API

| Método | Endpoint | Uso no shell | Fonte |
|---|---|---|---|
| GET | `/accounts?page&limit&search` | Lista do seletor de empresa | REA lista `/accounts` só com POST; o GET com query foi visto por grep (`pretty.js:34635-34643`) |
| POST | `/accounts/:id/switch` | Trocar empresa ativa | grep, `pretty.js:34675-34680` (spec 01) |
| POST | `/accounts/:id/leave` | Sair da empresa | grep, `pretty.js:34681-34682` (spec 01) |
| GET | `/auth/profile` | Recarregar usuário após a troca | REA |
| DELETE | `/auth/logout` | Sair | REA |
| GET | `/connections/disconnect_alert` | Indicador e modal de desconexão | REA |
| GET | `/dashboard/bootstrap` | Home `/welcome` (spec 02) | REA |
| GET | assinatura (spec 12) | Modal de inadimplência | spec 12 |
| GET | `/leona_ai/wallet` | Chip de saldo (spec 12) | `pretty.js:36555-36560` |
| GET | `/support/access_requests` e afins | Modal de pedidos de acesso (spec 16) | REA |

Nenhum endpoint específico de "tutoriais" foi encontrado: o conteúdo é externo.

## 7. Eventos realtime

- **Canal `ConnectionsChannel`** (ActionCable, spec 21; `pretty.js:45805-45821`):
  - `connection_disconnected`, `connection_disconnected_alert`, `flows_auto_paused` e `connection_trial_blocked` ligam o indicador imediatamente;
  - `connection_connected`, `connection_deleted`, `connection_status_changed` e `connection_updated` fazem uma nova consulta a `disconnect_alert`.
- **Pedidos de acesso de suporte** chegam por assinatura realtime (`onRequested`) e alimentam o modal do owner/admin (`pretty.js:41633-41640`; spec 16).
- **Notificações de chat** do sino: spec 14.
- **Eventos internos do navegador (não são de servidor)**:
  - `router:refresh`, `router:force-refresh`, `router:hard-refresh` e `router:navigate`;
  - `leona:selectedChatChanged` (`{accountId, chatId}`);
  - `selectChat` (`{chatId, chatStatus}`), disparado por "abrir chat" a partir de uma notificação: navega para `/chat` e emite o evento após 100 ms (`pretty.js:36518-36532`);
  - `leona-chat-show` e `leona-chat-open`, fallback para abrir o widget de suporte;
  - `storage`, para sincronizar o chat selecionado entre abas.

## 8. Permissões

- **Por permissão na empresa**: a visibilidade dos itens do menu e da barra inferior e a guarda de rota seguem as seções 2.5, 2.6 e 5.3. O owner vê todos os itens do menu.
- **Por papel global**:
  - `admin` vê o item "Administrativo" e acessa `/admin`;
  - `support` recebe menu reduzido, home `/support/access`, rotas limitadas, nenhum chip de saldo, nenhum widget de suporte, nenhum indicador de desconexão e nenhuma checagem de assinatura.
- O modal de pedidos de acesso de suporte só é montado para owner/admin da empresa (`pretty.js:41600-41610`).
- **Tutoriais, Suporte e Afiliação** não exigem permissão. Ressalva: Tutoriais depende de a seção GESTÃO existir (seção 2.5).

## 9. Integrações externas

### 9.1 Tutoriais
- O item "Tutoriais" (`labelKey` interno `support`, rótulo pt-BR "Tutoriais") é um **link externo** que abre em nova aba (`target=_blank`) uma página de vídeos e tutoriais hospedada no site institucional do fornecedor (`pretty.js:46461-46465`, `46530-46560`).
- Não há modal, player embutido, onboarding, tour guiado nem checklist no bundle. A busca por bibliotecas de tour e por "onboarding" só encontrou o fluxo de onboarding do WhatsApp Business App, que é coisa de conexão (spec 08).
- O conteúdo é 100% externo e não vem da API.
- A tela de cobrança tem um link "Falar com Suporte" para uma página de suporte de WhatsApp no mesmo site (`pretty.js:250844`, `252161`, `252905-252930`; spec 12).
- **Clone**: configurar uma URL de tutoriais por ambiente (ou por white-label) e abrir em nova aba.

### 9.2 Widget de chat de suporte (`pretty.js:42230-42330`, `45244-45251`)
- **Carregamento**:
  - quando há usuário logado com e-mail e ele não tem papel `support`, o shell injeta **uma vez** um `<script defer>` vindo do domínio do fornecedor;
  - o script tem id fixo e o atributo de dados `buttonStyle="floating"`, ou seja, botão flutuante próprio do widget;
  - a injeção é idempotente: não injeta se já existir script com o id, com o mesmo `src` ou com `data-leona-chat-widget`.
- **Identificação**: o app espera `window.LeonaChat.identify` existir, com polling de 100 ms e timeout de 10 s, e chama `identify({ email, name, phone })`. `phone` vem de `user.personal_whatsapp`, se houver. Falhas são silenciadas.
- **Abrir**: os botões "Suporte" (rodapé da sidebar, recolhida ou não, e menu do usuário mobile) chamam `LeonaChat.show()` e `LeonaChat.open()` quando existem. Na ausência, disparam os eventos `leona-chat-show` e `leona-chat-open` no `window`.
- **Fechar/limpar**: no logout, na troca para usuário sem e-mail ou no unmount, o app chama `LeonaChat.close()` e remove do localStorage `leona_user`, `leona_test_*` e `leona_csat_submitted_*`. [INFERIDO] O widget tem pesquisa CSAT.
- **Dev**: em `localhost` ou `127.0.0.1`, o app acrescenta `?chat=1` à URL. [INFERIDO] Flag para o widget aparecer em desenvolvimento.
- **Clone**: tratar como uma integração plugável, do tipo "provider de chat de suporte" com `load`, `identify`, `open` e `close`, ou substituir por um widget próprio ou por um link de WhatsApp de suporte.

### 9.3 Acesso de suporte (lado do usuário)
Referência ao spec 16:
- tela/aba `/settings?tab=support_access`;
- modal global de pedidos pendentes para owner/admin;
- endpoints `/account_support_access_requests` e `/account_support_access_grants` (REA).

O agente interno usa `/support/access`.

### 9.4 Programa de afiliação
Referência ao spec 13. No shell:
- o botão "Afiliação" do rodapé abre um modal de confirmação ("Você será levado para um site externo…", Continuar/Cancelar) e, ao confirmar, abre o portal externo de parceiros em nova aba (`pretty.js:46022-46027`, `46282-46293`);
- no menu do usuário mobile, o link vai direto para o portal, sem modal.

### 9.5 Marcação [REQUER WABA]
- O redirect `/settings/whatsapp-templates` → `/settings?tab=whatsapp_templates` **[REQUER WABA]**: templates aprovados pela Meta só existem na Cloud API. No clone só com Baileys, omitir ou deixar o redirect apontando para Respostas rápidas.
- O restante do shell (menu, guardas, tema, tutoriais, widget de suporte, seletor de empresa) **não** depende de WABA.

## 10. Lacunas ([INFERIDO] / [NÃO VERIFICADO])

1. [INFERIDO] **Página 404 inexistente**: sem rota `*`, uma URL desconhecida deve renderizar em branco. Não foi confirmado no app.
2. [NÃO VERIFICADO] **Laço de redirecionamento em `/welcome`**: se um usuário não-support sem `dashboard.sales`/`dashboard.support` acessar `/welcome`, a guarda o mandaria para a própria home (`/welcome`). Em tese isso gera um redirect para o mesmo caminho, com toast uma vez e o banner de negação. O comportamento real (tela vazia? banner?) não foi observado. O clone deve escolher como home a primeira rota permitida.
3. [NÃO VERIFICADO] **"Grupo de avisos"**: as traduções "Entrar no grupo de avisos" e "Avisos" existem sem uso no JSX. Pode ser uma feature desativada, ou um link para um grupo externo de comunicados.
4. [INFERIDO] **"Tutoriais" depende da seção GESTÃO**: membros sem `billing.view` e sem `settings.view` não veriam o item. Pode ser efeito colateral, não intenção.
5. [NÃO VERIFICADO] **Conteúdo e comportamento do widget de suporte de terceiros**: o que acontece além de `identify`/`open`/`close` (horário de atendimento, CSAT, anexos) roda no script externo e não está no bundle.
6. [INFERIDO] **Classe `chat-active-mobile`**: o efeito visual exato (esconder a barra inferior e o header) depende de CSS que não foi inspecionado.
7. [INFERIDO] **Refresh dos demais itens**: o tratamento de clique de Chats, Conexões, Agentes e Webhooks quando já se está na rota foi lido de forma parcial.
8. [NÃO VERIFICADO] **Selo "Novo" em Agentes de IA**: é fixo no código, sem critério de expiração encontrado.
9. [NÃO VERIFICADO] **Ordem real no app**: a ordem dos itens vem do array do bundle; flags do servidor podem mudar a ordem ou a visibilidade em runtime. Nada disso foi encontrado.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo.

- **Sidebar confirmada:**
  - PRINCIPAL: Dashboard → /welcome, Chats ao vivo → /chats, Kanban → /crms, Contatos → /customers.
  - OPERAÇÕES: Fluxos, Agentes de IA, Conexões, Webhooks de entrada → /settings/inbound-webhooks, Disparos em massa, Facebook → /facebook/campaigns.
  - GESTÃO: Cobranças e assinaturas, Configurações, Tutoriais.
  - Botão "Recolher menu".
- **Rodapé da sidebar:** saldo "N tokens Leona" (botão "Ver tokens Leona e comprar"), Suporte, Afiliação, tema (rótulo "Claro"/"Escuro" com a dica "Ctrl+M · ⌘M"), sino de Notificações, cartão do usuário.
- **Popover de notificações:** "Nenhuma notificação", toggle "Receber no dispositivo", controle de volume (50%), link "Avançado".
- **Mobile:** barra inferior com Início, Chats ao vivo, Kanban, Fluxos e Mais.
- **Widget de suporte:** carregado por script externo no domínio do fornecedor (visto na lista de recursos da página).
