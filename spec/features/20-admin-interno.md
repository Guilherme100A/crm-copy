# 20 — Admin interno (backoffice da plataforma)

> Fonte: leitura estática do bundle (`_bundle/pretty.js`) + tabela REA (`_rea/rea-endpoints.md`). Endpoints marcados com "(fonte: REA)" aparecem na tabela do REA (strings estáticas); os de caminho dinâmico (com `:id`) vieram de grep no bundle, porque o REA só registra literais. Nada foi observado no app real.

## 1. Visão geral

Painel de backoffice **só para operadores da plataforma** (usuário com `user.role === "admin"`, papel global da plataforma, diferente do papel `admin` dentro de uma empresa). Fica numa rota só, `/admin`, organizada em 12 seções escolhidas por `?tab=<id>`. Ele cobre:

- **Plataforma**: métricas de vendas, usuários globais, empresas (assinaturas, limites, migrações de billing), avisos (pop-ups/comunicados) e banners da home.
- **Infraestrutura**: servidores WhatsApp (Uazapi), saúde dos serviços (workers/Sidekiq, web, ingestor, cable, RDS, Supabase, Redis, ALB, custos AWS) e logs de webhooks recebidos.
- **Produto**: cota global de disparos em massa, Leona AI (preços por modelo, segredos de provedores, carteira de créditos, uso), tradutor de fluxos (idiomas, runs, reembolsos, configurações) e precisão da validação de comprovante Pix.

Quase todas as telas de infraestrutura são somente leitura ("Só visualização · atualizado às HH:MM"). As escritas ficam em usuários, empresas, servidores, avisos, banners e configurações de produto.

## 2. Telas e rotas

| Rota | Componente | Observação | Ref |
|---|---|---|---|
| `/admin` (fonte: REA) | `Kna` | Guard `fHe`: sem usuário → `/login`; `role !== "admin"` → `/welcome` | pretty.js:270971, 47364-47370 |
| `/admin?tab=<id>` | — | Um `tab` inválido ou ausente vira `overview` (com replace) | pretty.js:266697-266712, 267768 |

O link "Admin" aparece no menu lateral (seção `management`) só para `role === "admin"` (pretty.js:46454-46461). Em `/admin`, o layout usa o mesmo "hub" lateral recolhível de `/settings` (pretty.js:47110).

### Seções (abas), na ordem do menu, por grupo (pretty.js:266713-266747; rótulos pt-BR em pretty.js:30965-31016)

| Grupo | id | Rótulo | Descrição curta |
|---|---|---|---|
| Plataforma | `overview` | Visão geral | Vendas e métricas do período |
| Plataforma | `users` | Usuários | Contas de acesso da plataforma |
| Plataforma | `accounts` | Empresas | Contas, assinaturas e limites |
| Plataforma | `announcements` | Avisos | Comunicados para os clientes |
| Plataforma | `banners` | Banners | Banners da home do dashboard |
| Infraestrutura | `servers` | Servidores | Instâncias WhatsApp e vagas |
| Infraestrutura | `infrastructure` | Infraestrutura | Saúde da plataforma e dos serviços |
| Infraestrutura | `webhooks` | Webhooks | Logs de ingestão |
| Produto | `mass_dispatch` | Disparos em massa | Cota global por número pago |
| Produto | `leona_ai` | Leona AI | Tokens, preços e carteira |
| Produto | `flow_translator` | Tradutor de fluxo | Idiomas, runs e margem |
| Produto | `receipt_validation` | Comprovante | Similaridade na validação |

Quando você troca de aba, as buscas e paginações das abas de lista são zeradas (pretty.js:267850-267875). As buscas usam debounce de 450 ms (pretty.js:267813-267848).

### Subabas de `infrastructure` (pretty.js:264001-264044)
`workers` (Sidekiq), `web`, `ingestor`, `cable`, `database` (rótulo "Banco de dados (padrão)", RDS), `supabase` ("Banco de dados (webhooks)"), `redis` (subabas Sidekiq / Webhook / Fluxos), `alb` ("Load balancer"), `costs` ("Custos AWS").

### Subseções de `leona_ai` (pretty.js:259989-260515)
`credit` (carteira e ajuste de créditos), `secrets` (chaves de provedores), `billing` (preço por modelo e câmbio), `settings` (limites do agente) e `usage` (uso e margem).

### Subseções de `flow_translator` (pretty.js:260700-261400)
`overview`, `runs`, `usage`, `locales` e `settings`.

## 3. Modelo de dados / campos

### 3.1 Usuário da plataforma (aba `users`; modal `daa`, pretty.js:256851-257100)
| Campo | Tipo | Obrigatório | Validação / default | Ref |
|---|---|---|---|---|
| name | string | sim | não pode ser vazio ("Nome é obrigatório") | 256933 |
| email | string | sim | regex `\S+@\S+\.\S+`; **não pode ser editado** depois de criado | 256934-256937, 257013 |
| personal_whatsapp | string | não | aparece como "Não informado" quando vazio | 256921 |
| password | string | sim ao criar; opcional ao editar | mínimo de 6 caracteres | 256938-256942 |
| password_confirmation | string | quando há senha | igual a `password` | 256943-256947 |
| role | enum | sim | default `client_employee` | 256863 |

A lista mostra Nome, Email, WhatsApp, Perfil, Criado em e Ações (ver empresas, editar). É paginada com 20 por página e tem busca "por nome ou email" (pretty.js:267880-267895, 268309+).

"Ver empresas do usuário" abre um modal com as empresas vinculadas (`account_name`, `account_id`, `role` owner/admin/member, `role_label`). Quando não há vínculo, mostra "Nenhuma empresa vinculada" (pretty.js:270400-270450).

### 3.2 Empresa (aba `accounts`)
Campos exibidos ou editados (pretty.js:269518-270300):
- `id`, `name`, `owner_email`, `users_count`, `created_at`, `mass_dispatch_quota` (coluna "Disparos").
- `stripe_subscription_id`: edição inline, placeholder `sub_...`. Enter salva, Escape cancela.
- `guru_account_id`: id da conta no provedor de pagamento Guru.
- `inbox_limits` {`waiting`, `attending`, `resolved`}: limites de inbox, exibidos como "x/y/z" e editáveis inline (pretty.js:266560-266690).
- `subscriptions_enabled` (bool) e `has_active_subscription` (bool).
- `subscription_type` (enum, §4) e flags calculadas pelo servidor: `can_migrate_to_custom`, `can_migrate_to_leona`, `leona_migration_instances`, `starter_slots_total`, `pro_slots_total`, `migration_total_amount`, `migration_currency`.

Colunas: Nome, Email do Dono, ID Assinatura Stripe, ID Guru, Usuários, Disparos, Inbox, Status, Tipo, Criado em, "Assinatura / migração".

### 3.3 Assinatura custom/Guru (modal "Gerenciar Assinatura", pretty.js:265600-266428)
- `status`, `current_period_end` (vencimento) e `grace_period_end`.
- Ações em subseções: `add_instances` / `remove_instances` (`starter_quantity`, `pro_quantity`, com prévia de pró-rata), `update_due_date` (data ≥ hoje, ou atalho "mesmo dia no próximo mês"), `manage_status` (ativar/cancelar), `guru_integration` (`guru_account_id`) e `leona_billing`.

### 3.4 Assinatura de billing Leona (subseção `leona_billing`, pretty.js:266017+)
| Campo | Tipo | Observação |
|---|---|---|
| unit_price_cents | int (o formulário mostra em R$) | "Valor por instância (R$)" |
| instances_contracted | int | Instâncias contratadas |
| pending_instances | int | Instâncias pendentes, que valem na renovação |
| status | enum | ver §4 |
| current_period_end | date | Próximo vencimento |

Regra: alterar o preço só vale na próxima cobrança MIT (recorrente, iniciada pelo comerciante). Não há cobrança imediata. A tela mostra uma prévia do total mensal.

### 3.5 Servidor (aba `servers`; modal, pretty.js:257470-257720)
| Campo | Tipo | Obrigatório | Validação |
|---|---|---|---|
| name | string | sim | mínimo de 2 caracteres |
| url | string (URL) | sim | precisa ser uma URL válida |
| admin_token | string (segredo) | sim ao criar | mínimo de 10 caracteres; na edição só muda se for digitado de novo |
| ignore_in_rotation | bool | não | default false; badge "Ignorado na rotação" |

Campos de leitura por servidor: `uazapi_server_status` (`running` = verde, outro valor = vermelho, vazio = desconhecido), `connections_count`, `connected_connections_count`, `uazapi_connected_count`, `uazapi_disconnected_count`, `available_slots` ("Vagas") e `created_at`.

Contadores globais (`counts`, componente `Taa`, pretty.js:257886): `uazapi_connected`, `official_connected` [REQUER WABA], `uazapi_total` e `official_total` [REQUER WABA] (Uazapi = WhatsApp não oficial; official = API oficial da Meta).

### 3.6 Aviso / Announcement (pretty.js:266960-267300)
| Campo | Tipo | Obrigatório | Default |
|---|---|---|---|
| title | string | sim | — |
| message | texto | sim | — |
| image_url | string | não | upload de jpeg/png/jpg/webp via `/media/upload` |
| url | string | não | link opcional |
| announcement_type | enum (§4) | sim | `info` [INFERIDO] |
| priority | int | — | 0 |
| expires_at | date | não | — |
| active | bool | — | true |

### 3.7 Banner da home (pretty.js:267380-267630)
Campos: `title` ("Nome interno do banner"), `image_url` (obrigatório, enviado por upload), `url` (link opcional), `active` (default true), `priority` (default 0) e `expires_at` (opcional). O botão de salvar fica desabilitado enquanto não houver imagem.

### 3.8 Disparos em massa (aba `mass_dispatch`; `Raa`, pretty.js:258248-258640)
- Global: `per_instance_limit` ("Limite por número (ciclo)"). O cliente usa 500 quando a API não responde (pretty.js:258012). Alterar o valor "afeta novas quotas e recalcula a base das atuais".
- Por empresa, no ciclo atual (seletor de empresa com busca): `used`, `limit`, `remaining`, `billable_slots` ("Números"), `per_instance_limit` ("Base"), `pro_rata_bonus`, `bonus_limit` ("Bônus admin"), `period_starts_at` e `period_ends_at`.
- Ação "Aplicar bônus": soma `bonus_delta` extras ao limite do ciclo atual sem mexer no limite global.

### 3.9 Leona AI (aba `leona_ai`; serviço `$aa`, pretty.js:258690-258820)
- **Billing config** (preço por modelo): `provider_key`, `model_key`, `operation` (ex.: `text_generation`), `billing_type` (ex.: `tokens`), `markup`, `pricing` (JSON livre, validado com parse), `version` e `active`. Cada alteração cria uma nova versão, e há histórico (`?history=1`).
- **Câmbio global**: `usd_brl_rate`, `tokens_per_brl` e `rounding_mode` (`ceil` | `floor`).
- **Segredos** (só escrita, mostrados mascarados, com opção "gerar" e copiar o valor gerado). Grupos (pretty.js:258648-258683):
  - `leona`: chaves de Qwen, OpenAI, Groq, Fish (TTS) e geração de imagem.
  - `flow_translation`: Luna, ElevenLabs, Groq, Fish, Kie, Google e Lara (id + secret).
  - `payments`: chave secreta e pública da Pagar.me e o segredo do webhook. A URL do webhook Pagar.me aparece com botão de copiar.
- **Settings do agente**: `max_attachment_bytes`, `max_tool_rounds`, `max_overrun_units` e `default_model_key`.
- **Carteira de créditos** por empresa: `balance_units`, ajuste por `amount_units` (pode ser negativo [INFERIDO]) e `note` opcional.
- **Uso** (filtros `from`, `to`, `account_id`, `provider_key`, `model_key`, `operation`): totais de custo em BRL, cobrado em BRL, margem em BRL e tokens cobrados. Também mostra:
  - quebras por empresa e por usuário;
  - carteiras negativas;
  - cobranças recentes. O detalhe de cada evento traz `provider_cost_usd`, `exchange_rate` (fonte e data), `provider_cost_brl`, `markup`, `charged_brl`, `charged_tokens`, `billing_config_id/version`, `status` e o payload bruto do provedor. O evento pode ser reembolsado com nota.
- **Pacotes de créditos**: os endpoints existem (`packages`), mas nenhuma tela foi encontrada [NÃO VERIFICADO].

### 3.10 Tradutor de fluxo (aba `flow_translator`; pretty.js:260515-261400)
- **Locale**: `code`, `label`, `language`, `currency`, `style_prompt`, `voice_id` e `active`. Pode ser criado, editado, desativado (DELETE) ou reativado.
- **Run**: `account_name/id`, `user_email`, `source_flow_name/id`, `result_flow_name/id`, `locale_label/code`, `status`, `stage`, `reserved_tokens`, `charged_tokens` e `released_tokens`. Pode ser reembolsado.
- **Evento de uso**: `provider_key`, `model_key`, `usage_type`, `provider_cost_usd`, `charged_brl` e `refunded`. Pode ser reembolsado.
- **Settings tipados** (pretty.js:260646-260661):

| Tipo | Chaves |
|---|---|
| boolean | `enabled`, `voice_clone_enabled`, `one_active_run_per_flow` |
| number | `luna_batch_max_chars`, `luna_batch_max_units`, `chars_per_token`, `max_parallel_audio`, `max_parallel_image`, `max_text_units_per_run`, `max_audio_per_run`, `max_image_per_run`, `max_active_runs_per_account` |
| text (decimal) | `output_expansion`, `estimate_safety_margin` |

- **Billing configs e segredos**: equivalentes aos da Leona AI, mas restritos à tradução.

### 3.11 Validação de comprovante (aba `receipt_validation`; `Gaa`, pretty.js:261405-261470)
- `pix_key_similarity_percent`: "Precisão mínima — Chave Pix (%)".
- `name_similarity_percent`: "Precisão mínima — Nome do recebedor (%)".

### 3.12 Visão geral (aba `overview`; `Maa` + `hna`, pretty.js:257785, 264622)
- Filtro de período com `start_date` e `end_date`. O default é os últimos 7 dias, e há um botão para voltar a esse padrão.
- Cards: Faturamento no período (`formatted_period_revenue`), Vendas / novas assinaturas (`period_sales`), Novos clientes (`new_customers`) e Reembolsos (`formatted_period_refunds_amount`, `period_refunds_count`).
- Gráfico de vendas (`sales_chart_data`).
- Botão "Esconder/Mostrar valores" para mascarar os valores monetários na tela.
- Valores em centavos, formatados em BRL.

### 3.13 Logs de webhook (aba `webhooks`; `fna`, pretty.js:264050-264620)
- Filtros: `instance_id`, `request_id`, `chatid`, `event` e `from`/`to` (datetime). Atalhos de 1 h, 6 h (default) e 24 h.
- Valores de `event`: `messages`, `connection`, `messages_update`, `call`.
- Linhas: `received_at`, `connection_name`, `instance_id`, `account_name`, `event`, `chatid` e `request_id`.
- Paginação por cursor (`has_more`, `next_cursor`, botão "Carregar mais").
- O detalhe mostra o payload JSON.
- Indicador "conectado/desconectado" vem de `/admin/webhook_logs/health`.

### 3.14 Saúde da infraestrutura (somente leitura)
| Subaba | Métricas exibidas | Ref |
|---|---|---|
| Workers / Sidekiq | máquinas, threads (total, ocupadas, ociosas), quiet, filas (tamanho, latência, pausada), jobs enfileirados, retry e dead | pretty.js:261470-261800 |
| Web / Ingestor / Cable | CPU e memória por máquina e da frota, máquinas pendentes ou não saudáveis | componente `d5`, pretty.js:262300+ |
| Ingestor | filas do pipeline de webhooks (meta [REQUER WABA] (fila `meta_webhooks`, webhooks oficiais da Cloud API [INFERIDO]), xpag, leonapay, zenith, inbound), buffer ligado/desligado e URL pública | idem |
| Database / RDS | métricas do banco | — |
| Supabase | tabela de logs de webhooks (reader/writer), tamanho, partições, fallback | — |
| Redis | três instâncias (sidekiq, webhook_buffer, flow_execution): memória, escritas, falhas, chaves e hit rate | — |
| ALB | janela de 30 s, 1 min, 5 min ou 10 min; requisições, latência, 2xx, erros de aplicação, conexões, ELB 4xx/5xx; recortes web, ingestor e cable | — |
| Custos AWS | mês anterior, mês até a data, previsão (com faixa lower/upper), previsão do próximo mês e quebra por serviço | — |

## 4. Estados e transições (enums)

| Enum | Valores → rótulo pt-BR | Ref |
|---|---|---|
| `user.role` (plataforma) | `client` Cliente · `client_employee` Funcionário · `admin` Administrador · `support` Suporte | pretty.js:256809-256843 |
| Badge do papel | admin = warning · client_employee = info · support = success · client = neutral | 256845-256852 |
| `subscription_type` | `stripe` Stripe · `custom` Custom / Guru · `leona` Leona | 266487-266491 |
| Status da empresa (derivado) | assinatura ativa → "✓ Assinatura Ativa"; habilitada sem assinatura → "Aguardando Assinatura"; desabilitada → "Beta/Teste Grátis" | 270940-270950 |
| Status da assinatura custom | `active` Ativa · `canceled` Cancelada · `inactive` Inativa · `past_due` Atrasada | 265600+ |
| `announcement_type` | `info` Info (Informação geral) · `warning` Aviso (Alerta importante) · `error` Erro (Problema crítico) · `success` Sucesso (Confirmação positiva) | 266965-266975, 268240 |
| Status do run de tradução | `queued`, `running` (rótulo "Translating"), `completed`, `failed`, `canceled` | 26832-26838 (en) |
| Etapa (stage) do run | `copy`, `text`, `audio`, `image`, `pdf`, `media`, `settle` | 26839-26847 |
| Status de evento de uso | `refunded` (os demais valores [NÃO VERIFICADO]) | — |
| Inbox limits | `waiting` Aguardando · `attending` Atendendo · `resolved` Resolvidos | 266540 |
| Modo de arredondamento | `ceil`, `floor` | — |

Transições de billing de uma empresa:
- `stripe → custom`: ação "Migrar para Custom", liberada quando `can_migrate_to_custom`. Migra a assinatura Stripe e as instâncias Starter/Pro para assinatura custom. Antes, o admin precisa confirmar que o pagamento foi feito.
- `stripe|custom → leona`: ação "Migrar para Leona", liberada quando `can_migrate_to_leona`.
  - As instâncias Starter e Pro viram um pool único.
  - Status e vencimento são copiados da assinatura atual.
  - A cobrança antiga precisa ser pausada para não haver cobrança dupla.
  - O cliente precisa cadastrar cartão em `/billing` para a renovação MIT. A resposta traz `instances`.
- Troca manual de tipo pelo seletor "Tipo de assinatura (billing)", com confirmação.
- Assinatura custom: ativar; cancelar (7 dias de carência antes de desconectar as instâncias); mudar o vencimento.
- `subscriptions_enabled`: alterna entre habilitado e desabilitado. **Não pode ser desabilitado enquanto houver assinatura ativa.**

## 5. Ações e regras de negócio

1. Acesso exclusivo a `role === "admin"`. Qualquer outro usuário é redirecionado para `/welcome`.
2. Criar e editar usuários globais. O e-mail não pode ser editado. Não existe botão de excluir usuário (`deleteUser` existe no serviço, mas não é usado pela tela).
3. Listar as empresas de um usuário.
4. Empresas:
   - editar o ID da assinatura Stripe. Se o servidor responder `allow_force_update`, o admin confirma e reenvia com `force_update: true`; a sincronização acontece quando a assinatura existir na Stripe;
   - editar o ID Guru;
   - editar os limites de inbox;
   - habilitar ou desabilitar assinaturas;
   - trocar o tipo de assinatura;
   - migrar o billing;
   - gerenciar a assinatura custom (adicionar ou remover instâncias com pró-rata calculada antes, mudar vencimento, ativar, cancelar);
   - editar a assinatura de billing Leona.
5. Servidores: CRUD com `confirm` antes de excluir. A flag "ignorar na rotação" tira o servidor da distribuição de novas conexões [INFERIDO]. O admin vê as vagas disponíveis.
6. Avisos e banners: CRUD com busca e paginação (20 por página). Os itens ativos e não expirados aparecem para os clientes via `GET /announcements` e `GET /banners`; a ordenação por `priority` é [INFERIDO].
7. Disparos em massa: ajustar o limite global por número e dar bônus de cota por empresa no ciclo atual.
8. Leona AI:
   - versionar preços por provedor, modelo e operação;
   - ajustar o câmbio;
   - gravar segredos (cria ou atualiza conforme `configured`);
   - creditar ou debitar a carteira de uma empresa com nota;
   - reembolsar um evento de uso;
   - acompanhar a margem.
9. Tradutor: CRUD de idiomas, ajuste de limites e flags, reembolso de run ou evento, e preço e segredos próprios.
10. Comprovante: definir os percentuais mínimos de similaridade (chave Pix e nome do recebedor) usados na validação automática de comprovantes.
11. Infraestrutura e webhooks: somente leitura, com botão "Atualizar".

## 6. Endpoints da API

Base: `https://<api>/api/v1`, autenticação Bearer.

| Método | Caminho | Payload / query | Fonte |
|---|---|---|---|
| GET | `/users?page&limit&search` | — | REA (`/users`) + grep 256452 |
| GET | `/users/:id` | — | grep |
| POST | `/users` | `{user:{name,email,role,personal_whatsapp?,password,password_confirmation}}` | REA |
| PUT | `/users/:id` | idem, sem senha obrigatória | grep 256493 |
| DELETE | `/users/:id` | — (não usado na UI) | grep 256502 |
| GET | `/admin/users/:id/accounts` | — | grep 256669 |
| GET | `/admin/accounts?page&limit&search` | — | grep 256511 |
| PATCH | `/admin/accounts/:id/inbox_limits` | `{waiting,attending,resolved}` [INFERIDO] | grep 256518 |
| PATCH | `/admin/accounts/:id/subscription_type` | `{subscription_type}` | grep |
| PATCH | `/admin/accounts/:id/guru_account_id` | `{guru_account_id}` | grep |
| PATCH | `/admin/accounts/:id/subscriptions_enabled` | `{subscriptions_enabled}` | grep |
| PATCH | `/admin/accounts/:id/stripe_subscription_id` | `{stripe_subscription_id, force_update}` | grep |
| POST | `/admin/accounts/:id/custom_subscriptions/add_instances` | `{starter_quantity?, pro_quantity?}` | grep |
| DELETE | `/admin/accounts/:id/custom_subscriptions/remove_instances?starter_quantity&pro_quantity` | — | grep |
| PATCH | `/admin/accounts/:id/custom_subscriptions/update_due_date` | data de vencimento | grep |
| POST | `/admin/accounts/:id/custom_subscriptions/activate` / `cancel` | `{}` | grep |
| GET | `/admin/accounts/:id/custom_subscriptions/calculate_add_proration` / `calculate_remove_proration` | `?starter_quantity&pro_quantity` → `proration_info` | grep |
| POST | `/admin/accounts/:id/migrate_to_custom` / `migrate_to_leona` | `{}` | grep |
| GET / PATCH | `/admin/accounts/:id/billing_subscription` | campos de §3.4 | grep 256792 |
| GET / PATCH | `/admin/accounts/:id/mass_dispatch_quota` | PATCH `{bonus_delta}` | grep 258021 |
| GET / PATCH | `/admin/mass_dispatch_settings` | `{per_instance_limit}` | REA |
| GET | `/admin/statistics?start_date&end_date` | — | grep 256662 |
| GET / POST | `/admin/servers` | POST `{server:{name,url,admin_token,ignore_in_rotation}}` | REA |
| GET / PUT / DELETE | `/admin/servers/:id` | PUT `{server:{...}}` | grep |
| GET | `/admin/rds_health`, `/admin/web_health`, `/admin/cable_health`, `/admin/webhook_ingestor_health`, `/admin/supabase_webhook_logs_health`, `/admin/cost_overview`, `/admin/sidekiq_overview`, `/admin/webhook_logs/health` | — | REA |
| GET | `/admin/redis_health/sidekiq` / `webhook_buffer` / `flow_execution` | — | REA |
| GET | `/admin/alb_health?window_seconds` | — | grep 256581 |
| GET | `/admin/webhook_logs?instance_id&request_id&chatid&event&from&to&cursor…` | — | grep 256640 |
| GET | `/admin/webhook_logs/:request_id` | — | grep 256646 |
| GET / POST | `/admin/announcements` | `?search&page&limit` · POST `{announcement:{...}}` | REA |
| PATCH / DELETE | `/admin/announcements/:id` | `{announcement:{...}}` | grep 267660 |
| GET | `/announcements` (cliente: avisos visíveis) | — | REA |
| GET / POST | `/admin/banners` | `?search&page&limit` · POST `{banner:{...}}` | REA |
| PATCH / DELETE | `/admin/banners/:id` | `{banner:{...}}` | grep 267697 |
| GET | `/banners` (cliente) | — | REA |
| POST | `/media/upload` (multipart, imagem do aviso/banner) | — | grep 113215 |
| GET / POST | `/admin/leona_ai/billing_configs` | `?history&provider_key&model_key&operation` · POST com os campos de §3.9 | REA (POST) + grep |
| PATCH | `/admin/leona_ai/billing_configs/:id` | `{markup,billing_type,pricing,...}` | grep |
| GET | `/admin/leona_ai/usage_events/:id` | — | grep |
| POST | `/admin/leona_ai/usage_events/:id/refund` | `{note}` | grep |
| GET | `/admin/leona_ai/usage?from&to&account_id&provider_key&model_key&operation` | — | grep |
| GET | `/admin/leona_ai/cost_logs?account_id` | — | grep |
| GET / PATCH | `/admin/leona_ai/settings` | settings §3.9 + câmbio | REA |
| GET / POST | `/admin/leona_ai/secrets` | POST `{name, secret}` | REA |
| PATCH | `/admin/leona_ai/secrets/:name` | `{secret}` | grep |
| GET / POST | `/admin/leona_ai/packages` | — | REA |
| PATCH | `/admin/leona_ai/packages/:id` | — | grep |
| GET | `/admin/leona_ai/wallets/:account_id` | — | grep |
| POST | `/admin/leona_ai/wallets/:account_id/adjustments` | `{amount_units, note}` | grep 258812 |
| GET | `/admin/flow_translations/overview` / `usage` / `runs` (com filtros de data) | — | grep 260524-260548 |
| GET | `/admin/flow_translations/runs/:id` | — | grep |
| POST | `/admin/flow_translations/runs/:id/refund` | `{note?}` [INFERIDO] | grep |
| GET | `/admin/flow_translations/usage_events/:id` | — | grep |
| POST | `/admin/flow_translations/usage_events/:id/refund` | — | grep |
| GET / POST | `/admin/flow_translations/locales` | campos de locale | REA |
| PATCH / DELETE | `/admin/flow_translations/locales/:id` | DELETE = desativar | grep 260590 |
| GET / PATCH | `/admin/flow_translations/settings` | chaves de §3.10 | REA |
| GET | `/admin/flow_translations/secrets` | — | REA |
| PATCH | `/admin/flow_translations/secrets/:name` | — | grep |
| GET | `/admin/flow_translations/billing_configs` | — | REA |
| PATCH | `/admin/flow_translations/billing_configs/:id` | — | grep |
| GET / PATCH | `/admin/receipt_validation_settings` | `{pix_key_similarity_percent, name_similarity_percent}` | REA |

## 7. Eventos realtime

- Nenhuma assinatura ActionCable foi encontrada dentro do painel `/admin`. Todas as telas carregam por requisição HTTP sob demanda, com botão "Atualizar".
- `SupportNotificationsChannel` (`{user_id}`, pretty.js:270995) pertence ao fluxo do papel `support` (`/support/access`), documentado no módulo 01. Não faz parte do admin.

## 8. Permissões

- Guard de rota: `user.role === "admin"`, papel **global** da plataforma (pretty.js:47364). Não usa a matriz `settings.*` por empresa.
- Os papéis globais são `client`, `client_employee`, `admin` e `support`. O admin pode criar usuários de qualquer papel.
- Toda a autorização real fica no backend; o front só esconde a rota. Por isso, a reimplementação precisa proteger `/admin/*` no servidor [INFERIDO].

## 9. Integrações externas (visíveis pelo admin)

- **Stripe**: id de assinatura legada e sincronização.
- **Guru**: assinatura custom e `guru_account_id`, também exposto na API de integração (`billing_profile`).
- **Pagar.me**: chaves e URL de webhook do billing Leona.
- **Paddle**: citado no texto da migração.
- **Uazapi**: servidores WhatsApp não oficial.
- **Meta Cloud API**: contagem "official". [REQUER WABA]
- **AWS**: RDS, ALB, Cost Explorer, máquinas web/cable/ingestor.
- **Supabase**: tabela de logs de webhook.
- **Redis**: três instâncias.
- **Sidekiq**: workers.
- **Provedores de IA**: Qwen, OpenAI, Groq, Fish Audio, provedor de imagem, Luna, ElevenLabs, Kie, Google e Lara Translate.
- **Origens de webhooks de pagamento no ingestor**: xpag, leonapay e zenith.

## 10. Lacunas

- [NÃO VERIFICADO] Formato exato das respostas de saúde (`*_health`, `cost_overview`, `sidekiq_overview`). Só os campos usados na UI foram listados.
- [NÃO VERIFICADO] Os pacotes de créditos da Leona AI (`/admin/leona_ai/packages`) têm serviço, mas nenhuma tela foi achada. Campos desconhecidos.
- [INFERIDO] Payload exato de `inbox_limits`, de `update_due_date` (nome do campo de data) e do reembolso de run de tradução.
- [NÃO VERIFICADO] Regras de exibição dos avisos e banners para o cliente: frequência, dispensa, ordenação por prioridade, filtro por expiração.
- [INFERIDO] Semântica de `ignore_in_rotation` (servidor fora da distribuição de novas instâncias) e o significado de `available_slots`.
- [NÃO VERIFICADO] Rótulos pt-BR dos status de run de tradução (só a versão em inglês foi conferida) e o conjunto completo de status de eventos de uso e das carteiras.
- [NÃO VERIFICADO] Se existe auditoria (log de quem alterou o quê) no backend.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Contadores globais `official_connected` / `official_total` (servidores) | [REQUER WABA] | Remover; manter só contadores de sessões Baileys (conectadas/total por servidor) |
| Fila `meta_webhooks` no ingestor (webhooks oficiais da Cloud API) | [REQUER WABA] | Remover; eventos do Baileys chegam pelo socket (`messages.upsert`, `connection.update`), sem webhook da Meta |
| Integração "Meta Cloud API" (contagem official) | [REQUER WABA] | Não há; todas as conexões são Baileys |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo.

- Não verificado ao vivo: a conta usada tem papel de cliente e a área /admin não aparece no menu. Este spec vem só do bundle e do REA.
