# 11 — Facebook Ads

Features documentadas: ~48

> Fontes: tabela REA `_rea/rea-endpoints.md` (rea-agents 6.5.0), marcada como "(fonte: REA)", e o bundle formatado `_bundle/pretty.js`, citado como `pretty.js:N`. Tudo aqui é descrição de comportamento. Nenhum ID real de conta de anúncio, pixel ou app foi copiado.
> Referências cruzadas: **02-dashboard** (cards de vendas e gasto Meta), **06-fluxos** (nó Pixel), **08-conexoes** (WABA, Embedded Signup), **16-configuracoes** (permissões), **19-integracoes** (catálogo de integrações; o 19 remete o detalhe da UTMify para este arquivo).

---

## 1. Visão geral

O módulo "Facebook" (no menu: "Facebook — Meta Ads, pixel e perfis conectados", `pretty.js:15113-15119`) junta três áreas, cada uma com permissão própria:

| Sub-área | Rota | Rótulo no menu | Permissão |
|---|---|---|---|
| Gerenciador de anúncios | `/facebook/campaigns` | "Gerenciador" | `facebook.campaigns` |
| Pixel (Conversions API) | `/facebook/pixel` | "Pixel" | `facebook.pixel` |
| Perfis e contas (OAuth Meta) | `/facebook/profiles` | "Perfis e contas" | `facebook.profiles` |

O fluxo de valor:
1. O usuário conecta um ou mais **perfis Meta** por OAuth (Marketing API). Para cada perfil, o backend lista as **contas de anúncio** e o usuário marca quais entram no dashboard (`included_in_dashboard`).
2. O **Gerenciador** mostra campanhas, conjuntos e anúncios das contas incluídas, com métricas da Meta **cruzadas com vendas registradas na Leona**. O cruzamento usa o `source_id` da venda, que deve ser igual ao ID do anúncio. Pelo Gerenciador também é possível ativar/pausar e editar nome e orçamento direto na Meta.
3. O **Pixel** guarda as credenciais da Conversions API (pixel_id + access token). Elas são usadas pelo nó "Pixel" dos fluxos (`send_pixel_event`) para mandar eventos "Compra" ou "Lead".
4. O **dashboard de vendas** (02) usa o gasto Meta das contas selecionadas para calcular ROAS e lucro. Vendas aprovadas podem ser repassadas à **UTMify**.

O carregamento da estrutura de anúncios é **assíncrono**: um GET com `async=1` e, em paralelo, progresso via ActionCable no canal `MetaStructureBundleChannel` (ver §7).

**Impacto Baileys-only (clone):** Marketing API, OAuth Meta, Pixel/CAPI e UTMify **não dependem** de WABA e podem ser reimplementados integralmente. Dependem de WABA apenas: o SDK JS do Facebook (usado só no Embedded Signup do WhatsApp Cloud), os templates oficiais e o reconectar Meta de conexões Cloud. Também o evento CAPI de "business messaging" com `page_id`/`ctwa_clid` conforme detalhado em §9.

---

## 2. Telas e rotas

| Rota | Componente / comportamento | Fonte |
|---|---|---|
| `/facebook` | Layout com cabeçalho (ícone, título "Facebook", subtítulo) e slot de toolbar que as subpáginas preenchem. Se a rota atual não for permitida, redireciona para a primeira sub-rota permitida. | (fonte: REA) `index.js:673:65171`; `pretty.js:271511-271545`, `272810-272820` |
| `/facebook` (index) | Redireciona para a 1ª sub-rota permitida, na ordem campaigns → pixel → profiles. Sem nenhuma permissão, vai para `/welcome` com `state.permissionDenied`. | `pretty.js:271582-271592`, `40945-40966` |
| `/facebook/campaigns` (sub-rota `campaigns`) | Gerenciador de anúncios | (fonte: REA) `index.js:24:157785`, `index.js:673:65254`; `pretty.js:271550-271580` |
| `/facebook/pixel` (sub-rota `pixel`) | Lista e CRUD de configurações de pixel | (fonte: REA) `index.js:24:157867`, `index.js:673:65295`; `pretty.js:272052-272256` |
| `/facebook/profiles` (sub-rota `profiles`) | Perfis Meta (OAuth) e contas de anúncio | (fonte: REA) `index.js:24:157937`; `pretty.js:272320-272800` |
| `/settings/pixels` | Redirect (replace) para `/facebook/pixel` (legado) | (fonte: REA) `index.js:118:174681`; `pretty.js:122321-122324` |
| `/settings/meta` | Redirect para `/facebook/profiles` **preservando a query string**, para que o callback OAuth (`?meta_oauth=...`) continue funcionando | (fonte: REA) `index.js:118:174759`; `pretty.js:122313-122326` |
| `/integrations/utmify` | Redirect para as Integrações (ver 19) | (fonte: REA) `index.js:184:93295` |

Entrada no menu lateral: item "Facebook" aponta para `/facebook/campaigns` e aparece se o usuário tiver **qualquer** uma das 3 permissões (`pretty.js:46360-46368`).

Guarda de rota global: em `/facebook/*`, sem nenhuma permissão facebook, mostra um toast de "acesso bloqueado" e redireciona para a home do usuário. Com permissão parcial, redireciona para a primeira sub-rota permitida (`pretty.js:40996-41010`).

### 2.1 Gerenciador (`/facebook/campaigns`)

Pré-condições (`pretty.js:271550-271580`, `77484-77507`):
- `current_account.meta_oauth_connected = true` **e** `meta_ad_accounts_count > 0`. Sem isso, a lista fica vazia com CTA "Perfis e contas" → `/facebook/profiles`.
- Precisa haver ao menos 1 conta de anúncio com `included_in_dashboard`. Senão, aparece o aviso "Marque ao menos uma conta de anúncio no filtro…".

Layout:
- **Toolbar** (injetada no cabeçalho do layout):
  - filtro de contas de anúncio (multi-seleção com busca por nome/ID, "Selecionar todas", "Limpar", "Aplicar"/"Cancelar");
  - seletor de período;
  - seletor de moeda de exibição;
  - botão "Atualizar" com cooldown, mostrando "Atualizado há X".
- **Abas de nível:** Campanhas | Conjuntos | Anúncios, cada uma com contador ("N campanhas").
- **Filtros:** Status (select, default `ACTIVE`; opção "Todas") e Nome (busca livre). No mobile ficam num painel "Filtros".
- **Tabela:**
  - colunas fixas: Nome (com linha "Campanha: …" / conjunto como contexto), Status e Orçamento;
  - depois, colunas de métricas reordenáveis (§3.4);
  - linha de totais "Totais / médias".
- **Modal de edição** com dois modos: nome ou orçamento (§5.3).
- Dica (tooltip) sobre as métricas: as colunas pareadas "Leona / Meta" ou "Leona / Pixel" usam vendas com `source_id` igual ao ID do anúncio (`pretty.js:16924`, chave `metaAds.listingMetricsHint`).

### 2.2 Pixel (`/facebook/pixel`)

- Header: título "Pixels" e botão "Novo Pixel".
- Tabela com as colunas Nome, Plataforma, Pixel ID (mascarado), Conta de anúncios (placeholder "será implementado"), Access Token (mascarado, "***") e Ações (editar, excluir) (`pretty.js:271960-272050`).
- Vazio: "Nenhum pixel encontrado / Crie sua primeira configuração…".
- Modal "Novo Pixel" / "Editar Pixel" (§3.3). Ao editar, carrega o registro com `include_access_token=true` para preencher o token (`pretty.js:272136`).
- Excluir pede `confirm()` nativo.

### 2.3 Perfis e contas (`/facebook/profiles`)

- Header com título "Integração Meta", subtítulo explicativo (múltiplos perfis, um login por perfil) e botão **"Conectar novo perfil"**, visível só para quem gerencia (§8).
- Vazio: "Nenhum perfil Meta conectado".
- Cada perfil é um card expansível. Com 1 perfil só, ele já abre expandido. O card mostra:
  - avatar (foto ou iniciais);
  - nome (ou ID) do usuário FB;
  - badge Ativo/Inativo;
  - "X de Y contas no dashboard";
  - "Token expira em {data}", só no desktop;
  - ações "Contas de anúncios" (expandir), "Atualizar lista", "Reconectar" e "Remover". As três últimas são só para gestores.
- Expandido: lista de contas de anúncio, cada uma com um checkbox `included_in_dashboard` (desabilitado para não gestores), nome ou ID da conta e um check verde quando incluída.
- Callback OAuth: lê `?meta_oauth=success|error` e `?meta_message=` (o REA classificou esses parâmetros como chamadas de rede; na verdade são params de URL) e mostra um toast:
  - em sucesso, recarrega a lista e a conta, e de novo após 2,5 s;
  - em seguida remove os params da URL.

  (fonte: REA) `index.js:673:59052`, `index.js:673:59228`, `index.js:673:59331`, `index.js:673:59354`; `pretty.js:272365-272381`.

---

## 3. Modelo de dados / campos

### 3.1 `meta_profile` (perfil Meta conectado via OAuth) — `GET /meta_profiles`

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | sim | PK local | `pretty.js:272271-272290` |
| `fb_user_id` | string | sim | ID do usuário Meta; fallback de exibição | `pretty.js:272600-272612` |
| `fb_user_name` | string | não | nome exibido | idem |
| `picture_url` | string (URL) | não | avatar; se a imagem falhar, mostra iniciais | `pretty.js:272292-272318` |
| `active` | bool | sim | badge Ativo/Inativo | `pretty.js:272614` |
| `token_expires_at` | datetime | não | formatado no locale do usuário | `pretty.js:272578` |
| `ad_accounts` | `meta_ad_account[]` | sim | pode ser vazio ("Nenhuma conta de anúncios encontrada…") | `pretty.js:272750` |
| `ad_accounts_count` | int | sim | total | `pretty.js:272630` |
| `ad_accounts_included_count` | int | sim | atualizado de forma otimista no toggle | `pretty.js:272436-272465` |
| access token (servidor) | string | — | **nunca** exposto ao front [INFERIDO] | — |

### 3.2 `meta_ad_account`

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | sim | PK local; é o valor usado em `ad_account_ids[]` | `pretty.js:272286` |
| `fb_account_id` | string | sim | ID da conta na Meta (formato `act_…` [INFERIDO]) | `pretty.js:272758-272790` |
| `name` | string | não | fallback de exibição para `fb_account_id` | idem |
| `included_in_dashboard` | bool | sim | default `false`. Após o OAuth "nada é ativado automaticamente" (`metaAds.oauthChooseAccountsLater`). | `pretty.js:272286-272290` |

`GET /meta_ads/ad_accounts` devolve `{ ad_accounts: [...] }` com as contas disponíveis para o filtro do Gerenciador e do dashboard. O front filtra só as que têm `included_in_dashboard` (`pretty.js:76983-76989`, `77486-77490`).

Campos na **conta/empresa** (`current_account`), atualizados por `PUT /accounts/:id { account: {...} }`:

| Campo | Tipo | Default | Uso |
|---|---|---|---|
| `meta_oauth_connected` | bool (read) | false | habilita o Gerenciador; também aparece no card de conexão WABA |
| `meta_ad_accounts_count` | int (read) | 0 | habilita o Gerenciador e o dashboard Meta |
| `meta_ads_display_currency` | string ISO-4217 | `BRL` | moeda de exibição; validada no front por `/^[A-Z]{3}$/`, com fallback BRL. Seletor com a lista ISO-4217 completa (~160 moedas) e busca (`pretty.js:74143`, `75970`, `77290-77295`, `78610-78630`). |
| `time_zone` | string | — | base para calcular "hoje/ontem/7d…" |

### 3.3 `pixel_config` — `/pixel_configs`

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | — | PK | |
| `name` | string | sim | trim; entre 2 e 255 caracteres | `pretty.js:271686-271689` |
| `platform` | enum | sim | só existe `facebook`; no create, o serviço força `facebook` se vier vazio | `pretty.js:271637`, `225700-225702` |
| `pixel_id` | string numérica | sim | `/^\d+$/`; o input remove o que não for dígito | `pretty.js:271690-271693`, `271842` |
| `access_token` | string (segredo) | sim | token da Conversions API (CAPI). Só é devolvido com `?include_access_token=true` | `pretty.js:271694`, `225690-225694` |
| `masked_pixel_id` | string (read) | — | exibido na listagem | `pretty.js:272004` |
| `masked_access_token` | string (read) | — | exibido na listagem ("***" se ausente) | `pretty.js:272011` |
| ad account (opcional) | — | — | existem strings para "ID da conta de anúncios (opcional)", com validação "só números ou `act_` + números", e para "Conectar com Meta (login) em vez de colar o token", mas **não são renderizadas**: a coluna mostra "será implementado". [NÃO VERIFICADO] | `pretty.js:16160-16168`, `17181-17182` |

### 3.4 Linha da estrutura (campaign / adset / ad) — payload do bundle

| Campo | Tipo | Observação | Ref |
|---|---|---|---|
| `id` | string | ID da entidade na Meta; usado no PATCH | `pretty.js:77134` |
| `name` | string | | |
| `status` | string | `effective_status` da Meta (§4.1) | |
| `campaign_name`, `adset_name` | string | contexto na coluna Nome; entram na busca | `pretty.js:77381-77390` |
| `ad_account_label` | string | entra na busca | idem |
| `fb_ad_account_id` | string | obrigatório para editar/toggle; sem ele, a linha é só leitura | `pretty.js:77985-77999` |
| `daily_budget`, `lifetime_budget` (+ `_display`) | number | orçamento na moeda da conta e na moeda de exibição; ordenação usa o maior dos dois | `pretty.js:77331-77335` |
| `currency` | string | moeda da conta de anúncio | `pretty.js:77925` |
| `objective` | string | strings de objetivos existem (§4.3); uso na tabela [NÃO VERIFICADO] | |
| `metrics` | objeto | abaixo | |

`metrics` (sufixo `_display` = convertido para a moeda de exibição; o front prefere o `_display`):

| Chave | Significado |
|---|---|
| `meta_spend` | valor gasto (Meta) |
| `purchase_value_meta` | valor de compra atribuído pela Meta |
| `purchase_value_leona` | faturamento das vendas Leona com `source_id` = ID do anúncio |
| `purchases_leona` / `purchases_pixel` | nº de compras Leona / Pixel |
| `cost_per_purchase_meta` | CPA Meta |
| `conversations_meta` | conversas iniciadas (mensagens) |
| `cost_per_lead_meta` | custo por lead/conversa |
| `meta_link_clicks`, `meta_impressions` | cliques no link, impressões |

Colunas de métrica (ordem padrão; a ordem fica salva em `localStorage` com chave versionada por empresa) (`pretty.js:76193-76250`):

| Chave da coluna | Rótulo | Cálculo |
|---|---|---|
| `meta_spend` | Valor gasto | `meta_spend` |
| `revenue_pair` | Faturamento (Leona / Meta) | `purchase_value_leona` / `purchase_value_meta` |
| `profit_pair` | Lucro (Leona / Meta) | (valor Leona − gasto) / (valor Meta − gasto) |
| `purchases` | Compras (Leona / Pixel) | `purchases_leona` / `purchases_pixel` |
| `roas_pair` | ROAS (Leona / Meta) | valor ÷ gasto, 2 casas; nulo se gasto ≤ 0 |
| `cost_per_purchase_meta` | Custo / compra (Meta) | |
| `conversations_meta` | Conversas | |
| `cost_per_lead_meta` | Custo / lead | |
| `meta_link_clicks` | Cliques | |
| `meta_impressions` | Impressões | |

Linha de totais (`pretty.js:77226-77289`):
- somas de valor Meta, valor Leona, gasto, compras Leona/Pixel, conversas, cliques e impressões;
- lucro somado só a partir de linhas com dado;
- CPP ponderado = gasto ÷ (compras Leona + Pixel);
- ROAS ponderado = valor ÷ gasto;
- CPL ponderado = gasto ÷ conversas.

### 3.5 Envelope do bundle (`/meta_ads/structure_bundle`)

| Campo | Tipo | Observação |
|---|---|---|
| `campaign`, `adset`, `ad` | array | o payload só é aceito se tiver os três arrays |
| `status` | enum | `loading` \| `partial` \| `refreshing` \| `ready` |
| `leona_metrics_status` | enum | `pending` enquanto cruza vendas ("Cruzando vendas Leona…") |
| `targets_done` | int | progresso (nº de contas processadas) [INFERIDO] |
| `errors` | `{ad_account_id, error}[]` | erros por conta; rate limit é detectado por regex ("request limit", "rate limit", "too many calls") |
| `display_currency` | string | moeda efetiva |

### 3.6 `utmify_integration` — `/utmify_integrations` (o 19 remete para cá)

| Campo | Tipo | Obrig. | Validação | Ref |
|---|---|---|---|---|
| `id` | int | — | | |
| `company_name` | string | sim | trim, ≥ 2 caracteres | `pretty.js:103926-103936` |
| `integration_token` | string write-only | sim na criação | na edição, vazio = manter a credencial atual. Obtido no painel UTMify (Integrações → Webhooks → Credenciais de API). | `pretty.js:103937-103939`, `16057-16079` |
| `token_configured` | bool (read) | — | só integrações com token aparecem nos seletores | `pretty.js:236065` |

Consumidor: bloco "Venda aprovada" do fluxo (`register_approved_sale.utmify_integration_id`; null = "Não enviar para UTMify") — ver 19 §3.9 e 06.

### 3.7 Atribuição em contatos e vendas

| Entidade | Campo | Tipo | Observação | Ref |
|---|---|---|---|---|
| contato | `ctwa_clid` | string | "CTWA Click ID" (seção "Informações de Anúncios", editável só na edição) | `pretty.js:150976-151110`, `22930-22937` |
| contato | `source_url`, `source_id` | string | URL/ID de origem do anúncio que gerou o contato | idem |
| contato | `media_url`, `thumbnail_url` | string | mídia do anúncio | idem |
| fluxo (variáveis) | `ctwa_clid`, `source_url`, `source_id`, `media_url`, `thumbnail_url` | var | disponíveis no seletor de variáveis | `pretty.js:91541-91547` |
| venda | `source_id` | string | editável no modal de venda e mostrado no histórico; **chave de cruzamento com `ad.id`** | `pretty.js:81017`, `82355`, `82916`, `83125` |
| venda | `source` | string | `manual` na criação pelo painel; outros valores [NÃO VERIFICADO] | `pretty.js:80683` |

---

## 4. Estados e transições

### 4.1 Status de entidade Meta (`effective_status`) — `pretty.js:77392-77408`, `77786-77812`

| Valor | Rótulo pt-BR | Badge |
|---|---|---|
| `ACTIVE` | Ativo | sucesso |
| `PAUSED` | Pausado | aviso |
| `CAMPAIGN_PAUSED` | Pausado (campanha) | aviso |
| `ADSET_PAUSED` | Pausado (conjunto) | aviso |
| `ARCHIVED` | Arquivado | neutro |
| `DELETED` | Excluído | neutro |
| `IN_PROCESS` | Em processamento | neutro |
| `WITH_ISSUES` | Com problemas | neutro |
| `PENDING_REVIEW` | Em análise | neutro |
| `DISAPPROVED` | Reprovado | neutro |
| `PENDING_BILLING_INFO` | Pagamento pendente | neutro |
| `PREAPPROVED` | Pré-aprovado | neutro |
| `SCHEDULED` | Agendado | neutro |
| `COMPLETED` | Concluído | neutro |
| outro | "Status ({code})" | neutro |

As opções do filtro de status juntam esta lista fixa com qualquer status novo que apareça nos dados.

Transições pela UI:
- Linhas com status `ACTIVE`, `PAUSED`, `CAMPAIGN_PAUSED`, `ADSET_PAUSED` ou `ARCHIVED` (e com `fb_ad_account_id`) mostram um **switch**. Ligar envia `ACTIVE`; desligar envia `PAUSED`.
- Se a entidade estava `ARCHIVED`, a dica avisa que ao ativar ela volta como ativa.
- Demais status: só badge.

### 4.2 Níveis, períodos e ordenação

- Níveis (`level`): `campaign` | `adset` | `ad`.
- Período: `today` (default) | `yesterday` | `7d` (hoje − 6 dias) | `30d` (hoje − 29) | `month` (do dia 1 até hoje) | `custom` (de/até). Todos no fuso da empresa (`pretty.js:77202-77222`).
- Ordenação:
  - `default` = ativos primeiro, depois nome;
  - também `name`, `status`, `budget` e qualquer coluna de métrica;
  - clicar de novo inverte a ordem; valores nulos vão sempre para o fim.
- Escopo `status_filter` enviado ao servidor: o Gerenciador usa `all`, e o serviço usa `active` por padrão.

### 4.3 Objetivos (strings i18n `metaAds.objective*`)

- Outcome: Vendas, Leads, Engajamento, Reconhecimento, Tráfego, App.
- Legados: Cliques no link, Conversões, Alcance, Branding, Geração de leads, Mensagens.

Mapeamento ODAX: `OUTCOME_SALES`, `OUTCOME_LEADS`, `OUTCOME_ENGAGEMENT`, `OUTCOME_AWARENESS`, `OUTCOME_TRAFFIC`, `OUTCOME_APP_PROMOTION`, `LINK_CLICKS`, `CONVERSIONS`, `REACH`, `BRAND_AWARENESS`, `LEAD_GENERATION`, `MESSAGES`. [INFERIDO]

### 4.4 Ciclo do bundle

`loading` → `partial` (parte das contas carregadas, com `targets_done` subindo) → `ready`. Com `force_refresh`, passa por `refreshing` → `ready`. Em paralelo, `leona_metrics_status: pending` → (ausente/`done` [INFERIDO]) enquanto o servidor cruza as vendas.

### 4.5 Perfil Meta

- `active` true/false.
- Token com expiração (`token_expires_at`). A renovação é feita por "Reconectar", que reabre o OAuth com `profile_id`.

### 4.6 Callback OAuth

`meta_oauth=success` | `meta_oauth=error` (+ `meta_message` opcional).

### 4.7 Evento de pixel (nó de fluxo)

- `event_type`: `Compra` (default) | `Lead`.
- `tracking_type`: `Facebook` (único).

---

## 5. Ações e regras de negócio

### 5.1 Perfis e contas
1. **Conectar novo perfil:** chama `POST /meta_oauth/start` sem corpo, recebe `oauth_url` e redireciona a janela inteira para ela. O callback no backend volta para `/settings/meta?meta_oauth=…` → `/facebook/profiles` (`pretty.js:272258-272267`, `272383-272397`).
2. **Reconectar:** o mesmo fluxo, com `profile_id`, para renovar o token desse perfil.
3. **Atualizar lista:** `POST /meta_profiles/:id/refresh_ad_accounts` busca de novo as contas na Meta e devolve o perfil atualizado, que substitui o card.
4. **Remover perfil:** `confirm()` → `DELETE /meta_profiles/:id`. Os dados das contas daquele perfil deixam de aparecer. Depois recarrega a lista e a conta.
5. **Incluir/excluir conta do dashboard:** checkbox com update otimista → `PUT /meta_ad_accounts/:id { meta_ad_account: { included_in_dashboard } }`. Em seguida recarrega a conta (contadores) e **invalida o cache** do Gerenciador da empresa. Em erro, faz rollback.
6. Uma empresa pode ter **N perfis**, um login por perfil. Para entrar com outro usuário Meta, use "Conectar novo perfil".
7. Ao trocar de empresa (`accountChanged`), recarrega.

### 5.2 Gerenciador — carregamento
1. O conjunto efetivo de contas é: as contas aplicadas no filtro ∩ as incluídas no dashboard. Sem filtro, entram todas as incluídas (`pretty.js:77486-77507`).
2. **Cache em memória por 5 minutos**, com chave = empresa + contas ordenadas + datas + nível + escopo (`pretty.js:77137-77175`). Só bundles `ready`, sem `pending` e sem erro de rate limit vão para o cache. O cache é limpo quando muda a empresa, ao editar e ao alternar a inclusão de uma conta.
3. **Deduplicação:** requisições idênticas em voo compartilham a mesma promise.
4. **Pré-carga:** depois que o nível ativo carrega, os outros dois níveis são buscados em silêncio após 2 s.
5. **Atualizar manual:**
   - cooldown de **30 s** ("Aguarde 30 segundos…");
   - força `force_refresh=1` no nível atual e nos níveis já carregados;
   - também recarrega a lista de contas.
6. **Rate limit da Meta:**
   - se o bundle vier vazio com erro de rate limit, usa o último bundle em cache (mesmo vencido) e avisa "Limite da Meta atingido…";
   - sem cache, mostra erro.
7. **Erros parciais:** se 1 conta falhar, mostra toast `"<conta>: <erro>"`; se forem várias, "N conta(s) com aviso…".
8. Relógio "Atualizado há X" re-renderiza a cada 15 s.
9. **Moeda de exibição:**
   - trocar a moeda grava `meta_ads_display_currency` na conta e recarrega todos os níveis carregados com `force_refresh`;
   - os valores são formatados com `Intl` na moeda escolhida.
10. Busca por nome: contém (case-insensitive) em nome, nome da campanha, nome do conjunto, rótulo da conta e ID.
11. Ao trocar de nível, os filtros voltam para `status=ACTIVE` e nome vazio.
12. **Reordenar colunas:** arrastar no desktop ou usar setas no mobile (detecta `pointer: coarse`), com "Restaurar ordem padrão". A ordem é persistida por empresa no `localStorage`, ignorando chaves obsoletas.

### 5.3 Gerenciador — escrita na Meta (`PATCH /meta_ads/structure_entities/:id`)
- **Toggle status:** envia `{ level, fb_ad_account_id, status: ACTIVE|PAUSED }`.
  - Só uma edição por vez (as outras linhas ficam desabilitadas).
  - Em sucesso: toast "Status atualizado na Meta.", invalida o cache e faz refresh forçado.
- **Editar nome:**
  - disponível em campanha e conjunto ("O nome é enviado diretamente para a Meta");
  - o nome vai com trim, e só é enviado se não estiver vazio;
  - em anúncio o modo é bloqueado [o modal desabilita para `level=ad`].
- **Editar orçamento:**
  - só para campanha e conjunto com `fb_ad_account_id`;
  - campos Diário e Vitalício, `number`, `min 0`, `step 0.01`, aceitando vírgula decimal;
  - campo vazio não é enviado;
  - pré-preenchido só quando o valor atual é > 0.
  - A unidade enviada é a moeda da conta (o backend converte para centavos [INFERIDO]).
- Resposta exige `success: true`; senão, erro "Não foi possível atualizar na Meta.".

### 5.4 Pixel
- CRUD completo. Create e update enviam `{ name, pixel_id, access_token, platform }`.
- A listagem nunca traz o token (vem mascarado). Só o GET individual com `include_access_token=true` traz o token, para preencher a edição.
- Excluir: `confirm()` → DELETE.
- Usado por: nó **Pixel** dos fluxos (`send_pixel_event`; ver 06):
  - validação no publish: exige `pixel_config_id` e `event_type` (`pretty.js:238776-238784`);
  - `item_value` é obrigatório (aceita variável, ex. `{preco}`);
  - `currency` é texto livre ou variável; vazia ou inválida no envio vira BRL;
  - `page_id` é opcional.
  - Envio pela **Conversions API** no servidor.

### 5.5 Atribuição de vendas
- Uma venda (`/sales`) com `source_id` = ID de um anúncio Meta é somada em `purchases_leona` / `purchase_value_leona` daquele anúncio, e por agregação no conjunto e na campanha [INFERIDO para a agregação].
- O `source_id` do contato vem do referral do anúncio Click-to-WhatsApp e é copiado para a venda pelo bloco "Venda aprovada" [INFERIDO]. Também pode ser editado à mão no modal da venda.
- **Dashboard de vendas (02):**
  - `GET /dashboard` com `ad_account_ids[]` e `meta_display_currency` devolve `sales.meta_spend` (+ `_brl`, `_usd`), `roas` (faturamento ÷ gasto Meta), `profit`, `expenses_total`, `expenses_breakdown` e `meta_errors[]`;
  - o card de gasto alterna entre Total, Meta Ads e Extras;
  - em rate limit com gasto 0, reaproveita o gasto do cache anterior (`pretty.js:85595-85622`, `85860-85880`, `80734-80740`).
- Despesas extras: `expense_rules` (`fixed` | `percent`), descritas no 02 (`pretty.js:79200-79222`).
- **UTMify:** cadastro de credencial. As vendas aprovadas no fluxo são enviadas à UTMify (API "envio de vendas"), que cuida da atribuição por UTM. O envio é feito pelo backend [INFERIDO].

### 5.6 Strings órfãs (existem no i18n, sem uso no código atual)
- Cards "Insights consolidados" (gasto, faturamento líquido, ROAS Leona, ROI, margem, lucro líquido, impostos DAS 6%).
- Gráfico "Impressões e investimento por dia".
- Paginação da listagem.
- Coluna **"Instância"**, que ligaria a campanha a uma conexão WhatsApp ("Escolha qual instância atende esta campanha").

Tudo isso está [NÃO VERIFICADO] como feature ativa (`pretty.js:16924`).

---

## 6. Endpoints da API

Base: cliente `xe` (JSON, autenticado). Respostas com `error` geram exceção.

| Método | Caminho | Payload / query | Resposta | Fonte |
|---|---|---|---|---|
| POST | `/meta_oauth/start` | `{ profile_id? }` | `{ oauth_url }` | (fonte: REA) `index.js:673:56988`; `pretty.js:272262` |
| GET | `/meta_profiles` | — | `meta_profile[]` | (fonte: REA) `index.js:673:57206`; `pretty.js:272271` |
| DELETE | `/meta_profiles/:id` | — | — | `pretty.js:272276` |
| POST | `/meta_profiles/:id/refresh_ad_accounts` | `{}` | `meta_profile` | `pretty.js:272280` |
| PUT | `/meta_ad_accounts/:id` | `{ meta_ad_account: { included_in_dashboard } }` | `meta_ad_account` | `pretty.js:272286` |
| GET | `/meta_ads/ad_accounts` | — | `{ ad_accounts: [] }` | (fonte: REA) `index.js:60:217040`; `pretty.js:76984` |
| GET | `/meta_ads/structure` | `level`, `status_filter`, `ad_account_ids[]` | estrutura (sem métricas?) [NÃO VERIFICADO: sem chamador encontrado] | `pretty.js:76990-77002` |
| GET | `/meta_ads/structure_bundle` | `status_filter` (default `active`), `start_date`, `end_date` (YYYY-MM-DD), `async=1`, `date_preset?`, `meta_display_currency?`, `level?`, `ad_account_ids[]`, `force_refresh=1?` | envelope §3.5. Na 2ª chamada (fallback), vai sem `force_refresh`. | `pretty.js:77003-77075` |
| PATCH | `/meta_ads/structure_entities/:entityId` | `{ level, fb_ad_account_id, status?, daily_budget?, lifetime_budget?, name? }` | `{ success: true, ... }` | `pretty.js:77119-77140` |
| GET | `/pixel_configs` | — | `{ pixel_configs: [] }` | (fonte: REA) `index.js:374:254491`; `pretty.js:225685` |
| GET | `/pixel_configs/:id` | `?include_access_token=true` opcional | `pixel_config` | `pretty.js:225690` |
| POST | `/pixel_configs` | `{ pixel_config: { name, pixel_id, access_token, platform } }` | `pixel_config` | (fonte: REA) `index.js:374:254896`; `pretty.js:225700` |
| PUT | `/pixel_configs/:id` | `{ pixel_config: {...} }` | `pixel_config` | `pretty.js:225708` |
| DELETE | `/pixel_configs/:id` | — | — | `pretty.js:225714` |
| GET | `/utmify_integrations` | — | `{ utmify_integrations: [] }` | (fonte: REA) `index.js:85:226531`; `pretty.js:103393` |
| POST | `/utmify_integrations` | `{ utmify_integration: { company_name, integration_token } }` | objeto com `id` | (fonte: REA) `index.js:85:226667`; `pretty.js:103398` |
| PUT | `/utmify_integrations/:id` | idem (token vazio = manter) | objeto | `pretty.js:103405` |
| DELETE | `/utmify_integrations/:id` | — | — | `pretty.js:103414` |
| PUT | `/accounts/:id` | `{ account: { meta_ads_display_currency } }` | conta | `pretty.js:34665`, `77674` |
| GET | `/dashboard` | `ad_account_ids[]`, `meta_display_currency`, `force_refresh`, … (ver 02) | `sales.meta_spend…` | `pretty.js:85595-85622` |
| POST | `/whatsapp_embedded_signup/exchange_code` **[REQUER WABA]** | `{ code, waba_id, phone_number_id, business_id, connection_name?, is_coexistence }` | `{ connection, job_id }` | `pretty.js:134567-134583` |

Query params de callback (não são endpoints): `meta_oauth`, `meta_message` (fonte: REA, classificados como `l.get` / `F.delete`).

Backend a implementar (Marketing API, Graph):
- `GET /{ad_account}/campaigns|adsets|ads` com `effective_status`, budgets e objective;
- `GET /insights` com `time_range`, `level`, ações `purchase`/`onsite_conversion.messaging_conversation_started_7d`, `link_click` e `impressions`;
- `POST /{entity}` com `status`, `name` e `daily_budget`/`lifetime_budget` (em centavos).
- Escopos `ads_read` e `ads_management` (citados em `pretty.js:16160-16163`). [INFERIDO]

---

## 7. Eventos realtime

| Canal | Params de assinatura | Payload | Comportamento | Ref |
|---|---|---|---|---|
| `MetaStructureBundleChannel` | `{ ad_account_ids[], start_date, end_date, date_preset ("" se ausente), status_filter, level ("" se ausente) }` | envelope completo (§3.5) | Assina **antes** do GET. Aceita só payloads com os 3 arrays. Substitui o bundle atual se for "melhor" (regras abaixo). Espera até **90 s** enquanto o status for pendente (`loading`/`partial`/`refreshing` ou `leona_metrics_status=pending`). Se o socket não estiver conectado e ainda houver pendência, faz um GET de polling final. Cancela a assinatura no `finally`. | `pretty.js:77003-77118` |

Regras de "melhor" (`shouldReplaceBundle`):
- não troca um bundle pronto por um pendente;
- troca sempre se o novo estiver pronto ou se o atual estiver `refreshing`;
- entre dois pendentes, fica com o que tiver mais linhas ou maior `targets_done`.

Sem outros eventos realtime específicos do módulo. Perfis e pixels usam só REST. O realtime do dashboard é tratado no 02/21.

---

## 8. Permissões

| Chave | Rótulo (modal de permissões) | Dica | Default |
|---|---|---|---|
| `facebook.campaigns` | Gerenciador | Campanhas, gastos e resultados no Meta Ads | só owner/admin |
| `facebook.pixel` | Pixel | Cadastro e gestão do pixel | só owner/admin |
| `facebook.profiles` | Perfis e contas | Perfis Meta e contas de anúncio vinculadas | só owner/admin |

Fonte: `pretty.js:36210-36222`, `17171` (grupo "Facebook / Meta").

- Membros comuns não recebem essas permissões por padrão; o owner pode concedê-las no modal de permissões.
- Se `current_account.permissions` vier preenchido, ele prevalece sobre o default por papel.
- Dentro de **Perfis e contas**, as ações de escrita (conectar, reconectar, atualizar lista, remover e marcar contas) exigem, além de `facebook.profiles`, papel **owner/admin** na conta ou `user.role === "admin"` (admin global) (`pretty.js:272335-272338`). Membro com permissão vê os perfis em modo leitura.
- O Pixel não tem checagem extra de papel no front, só `facebook.pixel` [o backend pode restringir: NÃO VERIFICADO].
- O Gerenciador não tem checagem extra de papel para editar ou pausar no front [NÃO VERIFICADO no backend].
- `dashboard.sales` inclui "Meta Ads" na dica (o gasto Meta no dashboard).

---

## 9. Integrações externas

| Integração | Uso | Requer WABA? |
|---|---|---|
| **Meta OAuth (Facebook Login web, redirect server-side)** | Conectar perfis. O app precisa de `META_APP_ID`, `META_APP_SECRET` e `META_OAUTH_REDIRECT_URI` no servidor (citados na mensagem de erro `pixels.metaOauthStartError`, `pretty.js:15798`). | Não |
| **Meta Marketing API (Graph)** | Contas de anúncio, estrutura, insights e edição de status, nome e orçamento | Não |
| **Meta Conversions API (CAPI)** | Envio de eventos Purchase/Lead do nó Pixel com `pixel_id` + token | Não, para eventos web/system |
| CAPI com `page_id` (evento de "business messaging", atribuição de conversa de anúncio CTWA) | O texto de ajuda diz que `page_id` "não é necessário para a API oficial (WhatsApp Cloud)" e "em conexões não oficiais pode ser exigido para eventos via WhatsApp" (`pretty.js:26193`, `pixelEditor.pageIdHelp`). Com Baileys, o `ctwa_clid` pode vir no `contextInfo` / `externalAdReply` das mensagens vindas de anúncio [INFERIDO], mas a atribuição oficial de conversões de mensagens da Meta pressupõe WABA. | **Parcial — [REQUER WABA]** para a atribuição oficial "business_messaging"; o evento CAPI comum funciona sem WABA |
| **Click-to-WhatsApp referral oficial** (`referral.source_id`, `source_url`, `ctwa_clid` no webhook da Cloud API) | Preenche os campos de anúncio do contato | **[REQUER WABA]** como fonte oficial. Com Baileys, extrair de `externalAdReply` (sourceId/sourceUrl/ctwaClid) [INFERIDO, não garantido] |
| **Facebook JS SDK** (`connect.facebook.net/en_US/sdk.js`, Graph `v25.0`) | Usado **apenas** no Embedded Signup do WhatsApp (`FB.login` com `config_id`; escuta `postMessage` `WA_EMBEDDED_SIGNUP` com `FINISH` ou `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`; exige HTTPS; espera até 15 s por `waba_id`/`phone_number_id`) (`pretty.js:134587-134760`) | **[REQUER WABA]** — fora do escopo do clone |
| Reconectar Meta / conexão WhatsApp Cloud no card de conexão | `onMetaReconnect`, `onWhatsappCloudConnect` (`pretty.js:147650-147660`) | **[REQUER WABA]** |
| Templates WhatsApp ("templates oficiais Meta por WABA", card das Configurações, `pretty.js:15486`) | — | **[REQUER WABA]** (ver 17) |
| **UTMify** | Envio de vendas aprovadas (atribuição por UTM). Doc pública citada na ajuda: `docs.utmify.com.br/envio-de-vendas`. | Não |

---

## 10. Lacunas

1. [NÃO VERIFICADO] Esquema exato da resposta de `/meta_ads/structure_bundle`, além dos campos lidos pelo front: estrutura de `errors`, presença de `targets_total` e campos de objetivo e posicionamento nas linhas.
2. [NÃO VERIFICADO] Unidade do orçamento no PATCH: o front manda decimal na moeda da conta; a conversão para centavos e o arredondamento são do backend.
3. [INFERIDO] Regra de agregação de `purchases_leona` / `purchase_value_leona` em conjunto e campanha (soma dos anúncios filhos?) e janela de datas da venda (`sold_at` dentro do período?).
4. [INFERIDO] Origem do `source_id` da venda: copiado automaticamente do contato no bloco "Venda aprovada" ou só manual. Também não está claro como o backend extrai o referral CTWA em conexões não oficiais (Baileys `externalAdReply`).
5. [NÃO VERIFICADO] Payload real enviado à CAPI (event_name `Purchase`/`Lead`, `action_source`, `user_data` com hash de telefone, `event_id`/dedupe), comportamento com `page_id` e se há retry ou log de eventos enviados. Não há tela de histórico de eventos.
6. [NÃO VERIFICADO] Escopos OAuth solicitados e callback (rota do backend, `state`, troca por token de longa duração, refresh automático antes de `token_expires_at`).
7. [NÃO VERIFICADO] Endpoint `GET /meta_ads/structure`: existe no serviço, mas nenhum chamador foi encontrado (provável legado).
8. [NÃO VERIFICADO] Features com strings i18n mas sem UI: cards de insights (ROI, margem, DAS 6%), gráfico diário, paginação, vínculo campanha ↔ instância WhatsApp, conta de anúncio no pixel e "conectar pixel via login Meta".
9. [NÃO VERIFICADO] Restrições de papel no backend para pausar/editar campanhas e CRUD de pixel.
10. [NÃO VERIFICADO] Política de cache e rate limit no servidor (o cliente tem cache de 5 min, cooldown de 30 s e espera realtime de 90 s; o servidor tem cache próprio, indicado por `force_refresh`).
11. [NÃO VERIFICADO] Conteúdo enviado à UTMify (campos da venda, UTMs vindos de onde: contato? link?) e o momento do envio.

---

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo nem ativado ou pausado.

- **Cabeçalho do módulo:**
  - Título "Facebook" e subtítulo "Meta Ads, pixel e perfis conectados".
  - Indicador "Atualizado há <tempo>" e botão "Atualizar".
  - Abas: Gerenciador | Pixel | Perfis e contas.
- **Gerenciador (/facebook/campaigns):**
  - Filtros:
    - Período: Hoje, Ontem, 7d, 30d, Mês, Personalizado.
    - Status (padrão "Ativo"), com as opções Todas, Pausado (conjunto), Arquivado, Pausado (campanha), Concluído, Excluído, Reprovado, Em processamento, Pausado, Pagamento pendente, Em análise, Pré-aprovado, Agendado, Com problemas.
    - "Todas as contas" (contas de anúncio).
    - Moeda (Meta), padrão "BRL · Real brasileiro".
  - Níveis: Campanhas | Conjuntos | Anúncios, com o contador "N campanhas".
  - Colunas, todas ordenáveis:
    - Campanhas, Status, Orçamento, Valor gasto.
    - Faturamento (Leona / Meta), Lucro (Leona / Meta), Compras (Leona / Pixel), ROAS (Leona / Meta): cada métrica compara o dado da plataforma com o da Meta.
    - Custo / compra (Meta), Conversas, Custo / lead, Cliques, Impressões.
  - Vazio: "Nada encontrado para os filtros ou a Meta não retornou itens."
- **Pixel (/facebook/pixel):**
  - Título "Pixels" e o texto "configure pixels para rastrear eventos e conversões em diferentes plataformas de anúncios". Botão "Novo Pixel".
  - Tabela: NOME, PLATAFORMA (ex. Facebook), CONTA DE ANÚNCIOS (placeholder literal "será implementado"), PIXEL ID e ACCESS TOKEN (os dois mascarados, com início e fim visíveis), AÇÕES.
- **Perfis e contas (/facebook/profiles):**
  - Título "Meta (Facebook/Instagram)" e botão "Conectar novo perfil". Um login por perfil; cada perfil traz suas contas de anúncio, e o usuário escolhe quais entram no dashboard.
  - Card de perfil: avatar, nome, status "Ativo", "N de M contas no dashboard".
  - Ações do card: "Atualizar lista", "Reconectar", "Remover".
  - Lista "Contas de anúncios": nome e `act_<id>`, com a seleção para o dashboard.
- **Ligação com o Dashboard:** o filtro "Todas as contas" do Dashboard usa as mesmas contas. Alterá-lo atualiza as vendas e o painel Facebook. Ver spec 02.
