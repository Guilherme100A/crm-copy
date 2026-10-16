# 19 — Integrações

> Fonte: engenharia reversa clean-room do bundle `_bundle/pretty.js` (versão pretty-printed de `_bundle/index.js`) + tabela REA `_rea/rea-endpoints.md` (rea-agents@6.5.0, análise AST estática). Referências `pretty.js:N` apontam para a linha no arquivo pretty-printed; `index.js:L:C` são posições do REA no bundle minificado. Nenhum código foi copiado: o texto descreve comportamento. Rótulos curtos de UI estão em pt-BR como aparecem nas traduções embutidas.
>
> Módulos relacionados (detalhados em outros arquivos): UTMify (arquivo 11), builder de fluxos (bloco Pagamento e bloco Venda aprovada, citados aqui só pelo vínculo com integrações), Webhooks de entrada (`/webhooks`), Vendas/Dashboard (histórico de vendas e reemissão de NF), MCP (credenciais).

---

## 1. Visão geral

O módulo "Integrações" é um **hub/catálogo** dentro de Configurações (`/settings?tab=integrations`) que reúne 4 categorias de integrações por conta (tenant):

| Categoria (id interno `cat`) | Rótulo pt-BR | Provedores suportados no bundle |
|---|---|---|
| `notas` | Notas Fiscais | **Notasy** (único emissor de NF) |
| `rastreio` | Rastreamento | **UTMify** (ver arquivo 11) |
| `pagamentos` | Pagamentos | **Leona Pay** (nativo, destacado), **XPag**, **Zenith Global** |
| `ia` | Inteligência Artificial | **OpenAI (GPT)**, **Google Gemini**, **OpenRouter**, **ElevenLabs** |

Mais a aba "Todas" (`todas`). Fonte: categorias `pretty.js:106574-106575`, catálogo `pretty.js:106576-106705`, rótulos `pretty.js:15868-15934`.

Relacionados no mesmo grupo "Integrações" do hub de Configurações: **Produtos** (`/products` / `tab=products`) e **MCP** (`tab=mcp_credentials`) — `pretty.js:117336-117340`.

**Importante — o que NÃO existe no bundle:** não há integração com plataformas de infoproduto/e-commerce (Kiwify, Hotmart, Eduzz, Monetizze, Braip, PerfectPay, Ticto, Yampi, CartPanda, Shopify, Appmax), nem gateways Mercado Pago/Asaas/Stripe (por tenant), nem emissores eNotas/NFe.io/Focus. Contagem de ocorrências = 0 para todos esses termos. Recebimento de vendas de sistemas externos é feito pelo módulo genérico **Webhooks de entrada** (mapeamento de payload JSON → lead/etiquetas/Kanban/disparo de fluxo), não por conectores nativos. "Pagar.me" e "Stripe" aparecem apenas no painel de superadmin/billing da própria plataforma (ver §9).

Papel de cada integração no produto:
- **Pagamentos**: credenciais ("chaves") usadas pelo **bloco Pagamento** do builder de fluxos (`create_payment_charge`) para gerar cobranças (PIX, boleto, SPEI, OXXO, PSE, Nequi etc.) e continuar o fluxo quando o pagamento é aprovado (via webhook do gateway, processado no backend).
- **Emissor de NF (Notasy)**: usado pelo **bloco "Venda aprovada"** (`register_approved_sale`) para disparar emissão de nota automaticamente quando o fluxo registra uma venda.
- **UTMify**: também consumido pelo bloco "Venda aprovada" para enviar a venda (detalhe no arquivo 11).
- **IA**: chaves reutilizáveis nos blocos de IA dos fluxos (OpenAI/Gemini/OpenRouter) e voz (ElevenLabs).
- **Produtos**: catálogo com faixa de preço e fallback, usado pelo bloco "Venda aprovada" e por filtros de vendas.

---

## 2. Telas e rotas

### 2.1 Rotas (fonte: REA + `pretty.js:157330-157360`)

| Rota | Comportamento | Fonte |
|---|---|---|
| `/integrations` | Redirect (replace) → `/settings?tab=integrations` | REA `index.js:184:93113`; `pretty.js:157331` |
| `/integrations/nf-issuer` | Redirect → `/settings?tab=integrations` (rota legada) | REA `index.js:184:93199`; `pretty.js:157335` |
| `/integrations/utmify` | Redirect → `/settings?tab=integrations` (detalhe no arquivo 11) | REA `index.js:184:93295`; `pretty.js:157339` |
| `/integrations/payments` | Redirect → `/settings?tab=integrations` | REA `index.js:184:93388`; `pretty.js:157343` |
| `/integrations/leonapay/callback` | Página de retorno OAuth Leona Pay (componente `_3t`) | REA `index.js:184:93483`; `pretty.js:157140-157190` |
| `/integrations/zenith/callback` | Página de retorno OAuth Zenith (componente `E3t`) | REA `index.js:184:93546`; `pretty.js:157192-157246` |
| `/integrations/zenith/connect` | Página de início de conexão iniciada **a partir do painel Zenith** (componente `P3t`) | REA `index.js:184:93607`; `pretty.js:157247-157328` |
| `/integrations/ai` | Redirect → `/settings?tab=integrations` | REA `index.js:184:93667`; `pretty.js:157351` |
| `/invoice_integrations` | Redirect → `/settings?tab=integrations` | REA `index.js:184:93756`; `pretty.js:157355` |
| `/products` | Página de Produtos (componente `Zpe`, via `k3t`) | REA `index.js:184:89673`; `pretty.js:157138-157139` |

Query params do hub: `tab=integrations` e `cat=<todas|notas|rastreio|pagamentos|ia>` (valor inválido → `todas`; `pretty.js:106940-106942`, `107279-107284`). Trocar de aba de categoria atualiza `cat` com `replace` e limpa a busca.

### 2.2 Tela "Integrações" (hub) — `y0t`, `pretty.js:107141`

- Título "Integrações", subtítulo "Conecte emissores de NF, rastreamento de vendas e outros serviços à sua conta." (`pretty.js:15868-15872`).
- Campo de busca "Buscar integração…" — busca normalizada (sem acentos, minúsculas) em título, descrição, nome do provedor e rótulo da categoria (`pretty.js:106934-106939`, `106960-106976`).
- Abas de categoria (tablist acessível com setas ←/→) com **contador de integrações ativas** por aba (`pretty.js:106983-107032`).
- Seções:
  - **Destaques** ("A integração nativa da Leona") — itens do catálogo marcados `recommended` (só Leona Pay).
  - **Ativas** ("Conectadas na sua conta") — registros existentes da conta com `isActive` verdadeiro.
  - **Disponíveis** ("Prontas para conectar") — demais itens do catálogo.
  (`pretty.js:15881-15888`, `107258-107275`)
- Card de integração (`HQ`, `pretty.js:107033-107139`): logo (imagem em `/integrations/<id>.png` ou SVG inline para IA; fallback em iniciais "LP", "NT", "UT", "OA", "GM", "EL", "OR", "XP", "ZW"), badge de categoria (catálogo) ou status "Ativo"/"Inativo" (registro), título, descrição, botões "Editar"/"Excluir" (registro) ou "Configurar" (catálogo) ou chip "Em breve" (catálogo `coming-soon` — nenhum item atual usa). Itens destacados ganham borda/anel e etiqueta "Novidade" (`nativeBadge`).
- Estados vazios: "Nenhum resultado encontrado" / "Nenhum resultado para "{{term}}"…" / "Nenhuma integração ativa em {{category}}…" / "Nenhuma integração em "{{category}}"" (`pretty.js:15893-15901`).
- Ao trocar de conta (seletor de empresa), recarrega tudo e limpa a busca (`pretty.js:107211-107213`).

Carregamento: em paralelo `GET /invoice_integrations`, `GET /utmify_integrations`, `GET /ai_integrations`, `GET /payment_integrations`; e separadamente `GET /leona_pay/oauth/link` (falha → lista vazia, silencioso) (`pretty.js:107178-107210`).

### 2.3 Catálogo (itens fixos) — `p0t`, `pretty.js:106576-106705`

| id | Categoria | Título pt-BR | Descrição curta | Abre modal | Extras |
|---|---|---|---|---|---|
| `leonapay` | pagamentos | Leona Pay | Recebimento BR/MX/LatAm | payments → modal Leona Pay | `featured`, `recommended` |
| `notasy` | notas | Notasy NF-e | Emissão automatizada de NF-e de vendas | invoice | — |
| `utmify` | rastreio | UTMify | Rastreamento/atribuição | utmify | — |
| `openai` | ia | OpenAI GPT | IA generativa p/ chatbots/fluxos | ai (`gpt`) | — |
| `xpag` | pagamentos | XPag | PIX (BRL), API LATAM, API Cripto (USDT) | payments (`xpag`) | — |
| `gemini` | ia | Google Gemini | Modelos multimodais | ai (`gemini`) | — |
| `elevenlabs` | ia | ElevenLabs | Síntese de voz para áudio nos fluxos | ai (`elevenlabs`) | — |
| `openrouter` | ia | OpenRouter | Uma chave para vários modelos | ai (`openrouter`) | — |
| `zenith` | pagamentos | Zenith Global | Métodos locais multi-país/multi-moeda | payments (`zenith`) | — |

Rótulos: `pretty.js:15902-15928`.

### 2.4 Cards de registros ativos (montagem `g0t`, `pretty.js:106747-106926`)

| Origem | Título do card | Subtítulo | Ativo quando |
|---|---|---|---|
| invoice_integration | `company_name` | `name` ou nome do provedor ("Notasy") | `token_configured` |
| utmify_integration | `company_name` | "UTMify" | `token_configured` |
| ai_integration | `key_name` | nome do provedor (OpenAI/Gemini/OpenRouter/ElevenLabs) | `token_configured` |
| payment_integration | `label` | nome do gateway; se Leona Pay e houver e-mail vinculado: "Conta vinculada: {{email}} · {secret_hint}" | `secret_configured` |
| vínculo Leona Pay (OAuth link) | "Leona Pay" | e-mail vinculado / nome da empresa / mensagem de status (ver §4.4) | sempre ativo |

Cards Leona Pay (payment_integration com gateway leonapay e cards de vínculo) são ordenados primeiro e recebem badge "Novidade".

### 2.5 Modais

| Modal | Gatilho | Ref |
|---|---|---|
| Emissor de NF (Notasy) — "Novo emissor"/"Editar emissor" | Configurar Notasy / Editar card NF | i18n `pretty.js:16106-16131` |
| UTMify | ver arquivo 11 | `pretty.js:16057-16079` |
| Integração de IA — "Nova integração: IA"/"Atualizar integração" | Configurar OpenAI/Gemini/ElevenLabs/OpenRouter | `pretty.js:16004-16032`; código ~`104240-104530` |
| Confirmação de remoção de IA (modal com bullets de impacto) | Excluir card IA | `pretty.js:15966-15981`, ~`108030` |
| Chave de pagamento (XPag/Zenith) — "Nova chave de pagamento"/"Atualizar chave" (`Ubt`) | Configurar XPag/Zenith ou Editar | `pretty.js:104549-104990`; i18n `17568-17623` |
| Leona Pay (wizard multi-etapas) | Configurar Leona Pay / Editar card Leona Pay | `pretty.js:105138-106000`; i18n `17450-17567` |
| Desvincular Leona Pay (confirmação) | Excluir card de vínculo Leona Pay | i18n `pretty.js:17540-17552` |
| Produto — "Novo produto"/"Editar produto" (`Jpe`) | Página Produtos | `pretty.js:108088-108230`; i18n `15841-15867` |

### 2.6 Página Produtos — `Zpe`, `pretty.js:108628`

Lista em tabela com colunas: Nome, Moeda, ID (público), Preço mín., Preço máx., Valor padrão, Ações (`pretty.js:15831-15837`). Busca "Buscar por nome…" (filtro client-side por substring case-insensitive, `pretty.js:108639`). Botões "Novo produto"/"Cadastrar produto"; Editar; Excluir com `window.confirm("Tem certeza que deseja excluir este produto?")`. Estados vazios "Nenhum produto cadastrado" / "Nenhum produto encontrado".

---

## 3. Modelo de dados / campos

### 3.1 `payment_integration` (chave de pagamento) — serviço `jbt`/`Bh`, `pretty.js:103455-103501`

| Campo | Tipo | Obrigatório | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | — | gerado | |
| `label` ("Nome amigável" / "Nome da integração") | string | sim | trim, ≥ 2 caracteres ("Informe um nome com pelo menos 2 caracteres.") | `pretty.js:104588-104592`, `105602` |
| `gateway` | enum `leonapay` \| `xpag` \| `zenith` | sim | default no modal genérico `xpag`; **não editável** após criar (select desabilitado) | `pretty.js:104555`, `104724-104726` |
| `client_id` | string | sim (XPag/Zenith manual) | XPag: "Client ID"; Zenith: rotulado "X-API-Key" (placeholder sugere prefixo público `zp_pub_…`). Leona Pay: preenchido automaticamente com os 16 primeiros caracteres da chave | `pretty.js:104593-104595`, `105621` |
| `client_secret` | string (write-only) | sim na criação (XPag/Zenith manual); opcional na edição (em branco = manter) | XPag: "Client Secret"; Zenith: "X-API-Secret" (prefixo `zp_sec_…`); Leona Pay: a própria chave de API, validada por regex (ver §5.3). "Gravado cifrado. Nunca é exibido por completo após salvar." | `pretty.js:104596-104599`, `17582-17585` |
| `secret_configured` | bool (read) | — | define "Ativo" no card e se Leona Pay aparece no bloco Pagamento | `pretty.js:106866`, `237010` |
| `secret_hint` | string (read) | — | sufixo/máscara da chave exibido no card | `pretty.js:106860` |
| `zenith_oauth` | bool (read) | — | true quando criada via OAuth Zenith: esconde campos de chave e mostra "Conectada por OAuth. As chaves ficam só no servidor, cifradas." + botão "Rotacionar credencial" | `pretty.js:104572`, `17606-17611` |
| `zenith_webhook_url` | string (read) | — | URL de webhook gerada pelo backend, exibida readonly na edição de Zenith: "Registrada automaticamente na Zenith ao conectar. Usada para confirmar pagamento aprovado." | `pretty.js:104650`, `17588-17590` |
| `leonapay_link_id` | int (read/write) | — | id do vínculo OAuth Leona Pay ao qual a chave pertence (enviado como `link_id`) | `pretty.js:107381`, `105623` |
| `leonapay_linked_email` | string (read) | — | e-mail da conta Leona Pay vinculada | `pretty.js:106853-106857` |
| `business_id` | string (write) | não | empresa Leona Pay selecionada (se só houver uma, enviada automaticamente) | `pretty.js:105622` |

Payload: `{ payment_integration: {...} }` (create/update). Update envia `label`, `client_id`, `gateway` e `client_secret` só se não-vazio (`pretty.js:107424-107432`).

### 3.2 `invoice_integration` (emissor de NF) — serviço `dmt`/`Lb`, `pretty.js:80248-80277`

| Campo | Tipo | Obrigatório | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | — | | |
| `provider` | enum, único valor `notasy` | sim (fixo na criação) | constante | `pretty.js:103502`, `107376` |
| `company_name` ("Nome da empresa") | string | sim | ≥ 2 caracteres | `pretty.js:16110-16114` |
| `integration_token` ("Token da integração") | string write-only | sim na criação; edição em branco = manter | campo senha com mostrar/ocultar; "O token aparece no painel Notasy ao criar a integração com a API." | `pretty.js:16117-16126` |
| `name` | string (read) | — | nome exibido no subtítulo se existir [INFERIDO: nome do provedor/integração vindo do backend] | `pretty.js:106794` |
| `token_configured` | bool (read) | — | status Ativo/Inativo | `pretty.js:106797` |

Tabela de listagem (legado): Empresa, Provedor, Token, Ações (`pretty.js:16097-16101`).

### 3.3 `ai_integration` — serviço `Nbt`/`Mp`, `pretty.js:103416-103453`

| Campo | Tipo | Obrigatório | Validação / default | Ref |
|---|---|---|---|---|
| `provider` | enum `gpt` \| `gemini` \| `openrouter` \| `elevenlabs` | sim | default `gpt`; enviado só na criação | `pretty.js:104271-104280`, `107405` |
| `key_name` ("Nome da chave") | string | sim | ≥ 2 caracteres; placeholder "Ex.: Produção, Fluxo vendas" | `pretty.js:104289-104292` |
| `integration_token` ("Chave da API") | string write-only | sim na criação; edição em branco = manter | link "Como obter a chave" para a página de chaves do provedor | `pretty.js:104293-104295`, `16013-16027` |
| `token_configured` | bool (read) | — | status | `pretty.js:106836` |

Endpoints auxiliares: lista de modelos OpenRouter (`GET /ai_integrations/openrouter_models` → `models[]`) e vozes ElevenLabs por integração (`GET /ai_integrations/:id/voices` → array ou `{voices: []}`), consumidos pelos editores de nós de IA/áudio (`pretty.js:215516`, `229303`).

### 3.4 `utmify_integration` — ver arquivo 11

Campos: `company_name` (≥ 2), `integration_token` (write-only), `token_configured` (`pretty.js:16057-16079`, `103391-103415`).

### 3.5 `product` — serviço `Plt`/`Qh`, `pretty.js:74302-74320`; modal `Jpe` `pretty.js:108088`

| Campo | Tipo | Obrigatório | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | — | | |
| `public_id` | string (read) | — | exibido na coluna "ID"; referenciado pelo bloco Venda aprovada (`product_public_id`) | `pretty.js:15833`, `235424` |
| `name` | string | sim | trim; 2–255 caracteres | `pretty.js:108139-108145` |
| `currency_code` | ISO 4217 | sim | default `BRL`; precisa estar na lista de ~160 códigos ISO (AED…ZWG, inclui XCG/ZWG/SLE) | `pretty.js:74143-74302`, `108167-108168` |
| `price_min` | decimal | sim | aceita vírgula decimal; ≥ 0 | `pretty.js:108146-108156` |
| `price_max` | decimal | sim | ≥ 0 e ≥ `price_min` ("O preço máximo deve ser maior ou igual ao mínimo") | idem |
| `price_fallback` ("Valor padrão (fallback)") | decimal | sim | **> 0** ("O valor padrão deve ser maior que zero"); "Usado quando não houver outro valor definido." | idem |

Nomes de moeda exibidos via `Intl.DisplayNames` no idioma da UI ("BRL · Real brasileiro"). Não há vínculo direto produto ↔ gateway/oferta: o vínculo acontece no fluxo (bloco Venda aprovada escolhe o produto; bloco Pagamento escolhe a chave). **Não existe tipo de produto** (físico/digital/assinatura) no bundle.

### 3.6 Vínculo Leona Pay (OAuth link) — leitura normalizada `readStatus`, `pretty.js:105088-105128`

| Campo (API → front) | Tipo | Valores |
|---|---|---|
| `id` | int | id do vínculo (obrigatório; sem `id`/`email` o registro é descartado) |
| `email` | string | e-mail da conta Leona Pay |
| `company` | enum | `missing` \| `review` \| `verified` \| (outro → `unknown`) |
| `key_prefix` | string \| null | prefixo da chave existente no Leona Pay |
| `key_environment` | enum \| null | `PRODUCTION` \| `SANDBOX` |
| `local_key` | bool | se a chave secreta já está salva nesta conta Leona |
| `business_id` / `business_ids[]` | string(s) | empresas vinculadas |
| `business_name` | string | nome da empresa |
| `companies[]` | lista | `{id, name, status: verified\|review\|incomplete, key_prefix, ready: bool}` |

Resposta de `GET /leona_pay/oauth/link`: `{ linked: bool, links?: [...] }` ou formato legado com um único vínculo no topo (`email`). Não vinculado → lista vazia.

### 3.7 Cadastro de conta Leona Pay (wizard "Criar conta") — `pretty.js:105470-105525`

| Campo | Validação |
|---|---|
| Nome completo | ≥ 3 caracteres |
| E-mail | usado para `send_code` |
| CPF | exatamente 11 dígitos (só números) |
| Telefone | ≥ 10 dígitos |
| Nascimento | obrigatório (seletor de data customizado, placeholder dd/mm/aaaa) |
| Senha | 12–128 caracteres; medidor de força Fraca/Razoável/Boa/Forte (força 4 = ≥16 chars + maiúsc/minúsc + dígito) |
| Repetir senha | igual à senha |
| Código do e-mail | código enviado por `send_code` |
| Aceite jurídico | checkbox obrigatório (Termos de uso + Política de privacidade, abrem em nova aba; versão obtida de `/leona_pay/registration/legal`) |

Payload `complete`: `{ name, email, cpf, phone, birthDate, password, code, legalAcceptance: { accepted: true, version } }`. Resposta: `{ user: { id, email }, continue_url }`. A `continue_url` só é seguida se passar por whitelist estrita (HTTPS, host do painel cliente Leona Pay, path de "conectar/entrar" específico, sem query/credenciais, fragmento no formato de token `xxx.yyy`; localhost permitido em dev) — `pretty.js:105019-105037`.

### 3.8 Bloco Pagamento do fluxo (consumidor das chaves) — config `create_payment_charge`, `pretty.js:236500-236525`

| Campo | Default | Observação |
|---|---|---|
| `gateway` | `leonapay` | `leonapay` \| `xpag` \| `zenith` (nó dedicado "leonapay" força `leonapay`) |
| `payment_integration_id` | null | filtrado pelas chaves do gateway; Leona Pay só lista chaves com `secret_configured`; se houver 1 só, auto-seleciona |
| `currency` | `BRL` | ver matriz §4.6 |
| `method` | `PIX` | ver matriz §4.6 |
| `amount` | `100,00` | aceita variável `{...}`; parse vírgula/ponto |
| `open_amount` | false | "Chave sem valor" (lead paga o que quiser; valor depois em `{gateway.value}`) |
| `name` | `{full_name}` | |
| `email`, `document`, `document_type`, `bank_code` | "" | condicionais por gateway/moeda |
| `address_street/number/district/city/state/postal_code` | "" | endereço do boleto (Leona Pay BRL BOLETO) |
| `phone` | `{phone_number}` | |
| `listener_ttl_value` / `listener_ttl_unit` | 2 / `days` | "ESCUTAR PAGAMENTO POR": por quanto tempo a confirmação ainda interrompe o contato (minutos/horas/dias) |

Saídas do nó: `charge_created` ("Cobrança gerada"), `payment_approved` ("Pagamento aprovado"), `error` ("Erro") — `pretty.js:196674-196682`, `214320-214329`, i18n `26421-26423`.

Variáveis expostas após a cobrança (não vão para o lead): ID da transação, URL de checkout, código de pagamento (PIX copia-e-cola / CLABE / CVU-CBU / voucher OXXO / EMV Bre-B / URL PSE / payload CoDi), llave Bre-B, URL do QR (imagem), banco e beneficiário, valor pago, código de erro (`pretty.js:26431-26460`).

### 3.9 Bloco Venda aprovada (consumidor de NF/UTMify/produtos) — config `register_approved_sale`, `pretty.js:235423-235432`

| Campo | Default | Observação |
|---|---|---|
| `product_public_id` | "" | produto do catálogo; opção "+ Criar novo produto…" inline |
| `amount_template` | `{comprovante.valor}` | valor fora da faixa do produto → usa `price_fallback` |
| `currency_template` | `{comprovante.currency}` | vazio/variável vazia → moeda do produto |
| `customer_name_template` | `{comprovante.nome_pagador}` | vazio → nome completo do contato |
| `note_issuer_id` | null | id de `invoice_integration`; null = "Não emitir nota automaticamente" |
| `utmify_integration_id` | null | null = "Não enviar para UTMify" |
| `push_title_template` / `push_body_template` | "" | push no app; variáveis `{produto.nome}`, `{venda.valor}`, `{venda.moeda}`, `{venda.cliente}` |

i18n `pretty.js:25845-25897`.

---

## 4. Estados e transições

### 4.1 Status de card de integração
- `Ativo` (`statusActive`) — credencial/token configurado (`token_configured` / `secret_configured`).
- `Inativo` (`statusInactive`) — registro sem credencial.
- Catálogo: sem status, mostra categoria; `Em breve` para itens `coming-soon` (nenhum atualmente).

### 4.2 Status de emissão de NF da venda — `invoice_emit_status` (`pretty.js:80318`, `80631`, `81059`; i18n `16924`)

| Valor | Rótulo pt-BR |
|---|---|
| `pending` | Enviando emissão… |
| `succeeded` | Enviada ao emissor |
| `failed` | Falha na emissão |
| (nulo/sem emissor) | Sem emissor |

Nota de UI: o status **não** significa NF autorizada; só confirma que o evento foi aceito pelo emissor (HTTP 200). Campo auxiliar `invoice_last_error`. Reemissão permitida quando status ≠ `pending` e ≠ `succeeded` ("Tentar reemitir"; título muda para "retry" quando `failed`).

### 4.3 Status de empresa Leona Pay (`companies[].status`)
`verified` "Verificada" · `review` "Em análise" · `incomplete` "Cadastro incompleto" (qualquer outro valor vira `incomplete`). Flag `ready` = "Pronta" (chave gerada e salva). Só empresa `verified` pode ser selecionada ("Essa empresa ainda não está verificada. A chave sai depois da verificação.").

### 4.4 Estado do vínculo Leona Pay (mensagem do card, `h0t`, `pretty.js:106724-106745`) — ordem de precedência
1. Há empresas e nenhuma pronta → "Escolha a empresa, mesmo que seja uma só…" (needsChoice)
2. Chave local + mais de uma empresa vinculada → "Empresas vinculadas: {{names}}. No bloco, escolha qual delas cobra."
3. Chave local → "Chave pronta nesta conta. No bloco de pagamento, ela já pode cobrar."
4. `company = missing` → "Conta vinculada. Falta configurar a empresa no Leona Pay."
5. `company = review` → "…A empresa está em análise. A chave sai depois da verificação."
6. Existe `key_prefix` → "Já existe a chave {{prefix}}••••••••. Cole ela, ou rotacione se não tiver o segredo."
7. `company = verified` → "Conta vinculada. Gere a chave no painel e cole aqui."
8. senão → "Conta vinculada. Abra para colar a chave."
Se houver empresas pendentes e já houver chave local, descrição extra "Ainda tem empresa deste login pra conectar."

Ambiente da chave: `PRODUCTION` | `SANDBOX` (prefixos `leonapay_live_` / `leonapay_test_`).

### 4.5 Etapas do wizard Leona Pay (`d`: `choose` → `signup` | `connect`, `pretty.js:105383`, `105673-105690`)
- `choose`: "Criar conta" (cria, vincula e abre cadastro da empresa) | "Já tenho conta" (inicia OAuth; só vincula se a empresa já estiver configurada) | link "Inserir chave manualmente".
- `signup`: formulário §3.7 → "Enviar código" → "Criar conta no Leona Pay" → (redireciona para `continue_url` validada **ou** vai para `connect`).
- `connect`: nome da integração + chave de API; lista de empresas (Usar esta empresa / Remover); botões "Abrir o painel Leona Pay", "Abrir chaves no Leona Pay", "Abrir a empresa no Leona Pay", "Rotacionar chave", "Trocar conta" / "Vincular esta conta".
- Badge do vínculo: "Vinculada" / "Sem vínculo".

### 4.6 Matriz gateway × moeda × método (bloco Pagamento, `pretty.js:236527-236660`)

**Leona Pay** — moedas no seletor: BRL, MXN (`zne`). Métodos por moeda (tabela `Yw` também prevê COP/ARS/USD/VES/EUR):

| Moeda | Métodos |
|---|---|
| BRL | PIX, BOLETO |
| MXN | SPEI, OXXO |
| COP | PSE, NEQUI, BREB, BANK_TRANSFER |
| ARS | BANK_TRANSFER |
| USD | BANK_TRANSFER, CASH |
| VES | PAGOMOVIL, BANK_TRANSFER |
| EUR | MBWAY |

Tipos de documento por moeda: COP {CC, NIT, CE, TI}; ARS {CUIT, CUIL, DNI}; USD {RUC, CI, PAS}; VES {CI, RIF}. Regras de limpeza ao salvar: SPEI remove nome/e-mail/telefone/documento; PIX remove telefone/tipo de documento e documento vazio. SPEI com valor fixo mostra aviso de estorno se o lead pagar valor diferente; SPEI sem valor gera CLABE fixa.

**XPag** — moedas BRL, MXN, ARS, COP (`Fne`). Métodos: MXN → SPEI/OXXO; COP → NEQUI / BREB (Bre-B QR). BRL → PIX [INFERIDO]. Regras: ARS não suporta "chave sem valor" ("em breve"); OXXO de MX$10 a MX$10.000; COP mínimo COP$10.000 e celular colombiano (10 dígitos começando com 3); documento CUIT opcional em ARS.

**Zenith** — moedas BRL, COP, MXN, PEN, ARS, INR, PHP (`One`). Métodos (default por moeda em negrito):

| Moeda | Métodos | Expiração exibida |
|---|---|---|
| BRL | **pix** | até 30 min (exige nome real, e-mail, CPF/CNPJ) |
| COP | **pse**, bre-b-llave, nequi | 15 min |
| MXN | **oxxo**, spei, codi | 24–48h |
| PEN | **yape**, plin, bank-transfer, cash | até 1h |
| ARS | **bank-transfer** (CVU/CBU) | até 30 min |
| INR | **upi** | 10 min |
| PHP | **gcash**, maya | 15 min |

Telefones: Nequi exige celular colombiano; GCash/Maya celular filipino (10 dígitos começando com 9). "A instrução de pagamento chega na resposta — não depende de webhook"; confirmação de pagamento (BRL/ARS/OXXO etc.) "só no webhook".

### 4.7 Estados de callback OAuth
- Leona Pay (`_3t`): chave de sessão por `state` com valores `inflight` → `done` (ou removida em erro) para evitar troca duplicada do `code` (StrictMode/refresh). Sem `code`/`state` ou com `error` → erro.
- Zenith (`E3t`): `code`+`state` → troca; ou query `zenith_oauth=success|error` (backend já trocou e redirecionou); `error` → erro; nada → erro.

---

## 5. Ações e regras de negócio

### 5.1 Hub
1. **Configurar** (catálogo) abre o modal pela `modalKind`: invoice / utmify / ai (com provedor pré-selecionado) / payments (com gateway pré-selecionado; `leonapay` abre o wizard Leona Pay em vez do modal genérico) — `pretty.js:107300-107318`.
2. **Editar** registro: abre o modal correspondente com dados; para chave Leona Pay abre o wizard no modo edição com o `leonapay_link_id`.
3. **Excluir**:
   - NF: `confirm("Remover este emissor? O fluxo «Venda aprovada» não poderá mais usá-lo.")`.
   - UTMify: confirm análogo.
   - Pagamento: `confirm("Remover esta chave? Blocos de Pagamento que a usam deixarão de funcionar.")`.
   - IA: modal de confirmação com bullets (blocos de IA vão falhar; fluxos em andamento podem parar; será necessário cadastrar outra chave).
   - Vínculo Leona Pay: modal "Desvincular o Leona Pay?" — bullets: o vínculo some aqui **e no Leona Pay**; dá para vincular de novo; a chave de API continua no painel Leona Pay.
4. Após qualquer salvar/excluir: notificação toast + recarga completa.
5. Segredos/tokens nunca são exibidos após salvos; edição com campo vazio mantém o valor atual (backend só recebe o campo se preenchido).

### 5.2 XPag / Zenith (modal de chave)
- Validação: label ≥ 2; client_id obrigatório (exceto Zenith OAuth); client_secret obrigatório só na criação (exceto Zenith OAuth).
- **Testar conexão** (só em edição): `POST /payment_integrations/:id/test_connection` → `{ ok, error? }`; toast "Conexão validada com sucesso." ou erro.
- **Zenith "Conectar com Zenith"** (só na criação): chama `POST /zenith_oauth/start` com `label` opcional → recebe `oauth_url` → redireciona o navegador. Volta em `/integrations/zenith/callback` → `POST /zenith_oauth/exchange {code, state}` → redireciona para `/settings?tab=integrations&cat=pagamentos` com toast. A troca do código acontece no servidor.
- **Zenith "Rotacionar credencial"** (integrações OAuth): `POST /payment_integrations/:id/rotate_credentials`.
- **Zenith connect iniciado pelo parceiro** (`/integrations/zenith/connect?installation_id=…&label=…`): ao montar chama automaticamente `zenith_oauth/start` com `label` e `installation_id` e redireciona; em erro mostra mensagem e botão "Conectar com Zenith" para tentar de novo.
- Webhook Zenith: URL gerada pelo backend e **registrada automaticamente na Zenith** ao conectar; usada para confirmar pagamento aprovado (exibida readonly).

### 5.3 Leona Pay
- Integração "nativa" (gateway da própria empresa Leona) — destacada, badge "Novidade".
- Três caminhos: (a) **criar conta** dentro do app (cadastro com código por e-mail + aceite jurídico versionado); (b) **vincular conta existente via OAuth** (`POST /leona_pay/oauth/start {link_id?}` → `oauth_url` → callback `/integrations/leonapay/callback` → `POST /leona_pay/oauth/exchange {code,state}` → retorna e-mail); (c) **colar chave manualmente**.
- Formato de chave aceito: prefixo `leonapay_live_` ou `leonapay_test_` (ou prefixo legado `onp_live_/onp_test_`) seguido de ≥ 20 caracteres `[A-Za-z0-9_-]` (`pretty.js:105145`). Exemplo fictício: `leonapay_test_XXXXXXXXXXXXXXXXXXXXXXXX`.
- **Multi-vínculo e multi-empresa**: uma conta Leona pode ter vários vínculos (links) e, em cada um, várias empresas. Selecionar empresa (`POST /leona_pay/oauth/business {link_id, business_id}`) gera a chave na hora e a deixa pronta nesta conta ("{{name}} conectada. A chave já está nesta conta."). Remover empresa: `DELETE /leona_pay/oauth/business?link_id=&business_id=`. Só empresas `verified` e ainda não `ready`; uma operação por vez.
- No bloco Pagamento, quando há mais de uma empresa, escolhe-se qual cobra; se a chave existe só remotamente (`key_prefix` sem segredo local): aviso "A chave {{prefix}} existe no Leona Pay, mas o segredo não está salvo nesta conta…".
- Rotação de chave: "No painel, gerar de novo revoga a anterior. Cole aqui só a chave nova."
- Desvincular: `DELETE /leona_pay/oauth/link?link_id=` (remove o vínculo também do lado Leona Pay).

### 5.4 Emissão de NF (Notasy)
- Único provedor: `notasy`. Cadastro: nome da empresa + token.
- **Quando emite**: quando um fluxo executa o bloco **"Venda aprovada"** com `note_issuer_id` apontando para um emissor com token válido — "o sistema dispara a emissão assim que este nó registrar a venda". Não há regra por status de pagamento de gateway externo no front; o gatilho é o registro da venda aprovada pelo fluxo (que pode vir após `payment_approved` do bloco Pagamento, comprovante validado por IA, webhook etc.).
- Resultado por venda em `invoice_emit_status` (§4.2). Reemissão manual pela lista de vendas: `POST /sales/:id/reemit_invoice { invoice_integration_id? }` (permite escolher outro emissor) — "Emissão reenfileirada. Aguarde alguns segundos e atualize a lista." (processamento assíncrono em fila).

### 5.5 Mapeamento evento de pagamento → ações
No front **não há** tela de "regras por evento de gateway" (aprovado/reembolsado/chargeback → etiqueta/etapa). O mapeamento é feito pelo **fluxo**:
- Bloco Pagamento: `charge_created` → ramo para enviar instruções (código PIX, link, QR); `payment_approved` → ramo de pós-pagamento (aplicar etiqueta, mover Kanban, Venda aprovada → NF/UTMify/push, etc., com os blocos normais do builder); `error` → ramo de erro. A escuta da confirmação dura `listener_ttl` (default 2 dias) e "interrompe o contato" quando chega.
- Para sistemas externos (checkouts de terceiros), o equivalente é o módulo **Webhooks de entrada**: identifica/cria lead, campos personalizados, adicionar/remover etiquetas, ações de Kanban (adicionar/mover/remover card, valor de meta), disparar fluxo com condições (etiqueta possui/não possui, campo igual/diferente/contém/não contém/começa com/tem valor) — i18n `pretty.js:16190` (JSON).

### 5.6 IA
- Chaves reutilizáveis por provedor; a mesma conta pode ter várias chaves por provedor (nome livre).
- Provedor não muda após criado [INFERIDO: só `key_name`/token são enviados no update, `pretty.js:107395-107399`].
- Remover chave em uso quebra blocos de IA (aviso explícito).

### 5.7 Produtos
- CRUD simples; exclusão com confirm nativo. Regra de preço usada pela venda: valor resolvido fora de [`price_min`, `price_max`] → usa `price_fallback`.

---

## 6. Endpoints da API

Cliente HTTP `xe` (base da API do app). "(fonte: REA)" = presente em `_rea/rea-endpoints.md`; endpoints com template literal (`/:id`) não aparecem na tabela REA e foram obtidos por grep.

### Pagamentos
| Método | Caminho | Payload / resposta | Fonte |
|---|---|---|---|
| GET | `/payment_integrations[?gateway=<g>]` | → `{ payment_integrations: [] }` | grep `pretty.js:103459` (REA lista só o POST) |
| POST | `/payment_integrations` | `{ payment_integration: { label, gateway, client_id, client_secret, business_id?, link_id? } }` → registro com `id` | (fonte: REA) `index.js:85:228394`; `pretty.js:103464` |
| PUT | `/payment_integrations/:id` | `{ payment_integration: { label, client_id, gateway, client_secret? } }` | grep `pretty.js:103473` |
| DELETE | `/payment_integrations/:id` | — | grep `pretty.js:103482` |
| POST | `/payment_integrations/:id/test_connection` | `{}` → `{ ok: bool, error? }` | grep `pretty.js:103486` |
| POST | `/payment_integrations/:id/rotate_credentials` | `{}` → registro atualizado (Zenith) | grep `pretty.js:103492` |
| POST | `/zenith_oauth/start` | `{ label?, installation_id? }` → `{ oauth_url }` | (fonte: REA) `index.js:88:19778`; `pretty.js:104537` |
| POST | `/zenith_oauth/exchange` | `{ code, state }` | (fonte: REA) `index.js:88:19976`; `pretty.js:104543` |
| POST | `/leona_pay/oauth/start` | `{ link_id? }` → `{ oauth_url }` | (fonte: REA) `index.js:88:29313`; `pretty.js:105047` |
| POST | `/leona_pay/oauth/exchange` | `{ code, state }` → `{ email }` | (fonte: REA) `index.js:88:29529`; `pretty.js:105053` |
| GET | `/leona_pay/oauth/link` | → `{ linked, links[] }` (ver §3.6) | (fonte: REA) `index.js:88:29673`; `pretty.js:105058` |
| DELETE | `/leona_pay/oauth/link?link_id=` | — | grep `pretty.js:105133` |
| POST | `/leona_pay/oauth/business` | `{ link_id, business_id }` → status do vínculo | (fonte: REA) `index.js:88:29905`; `pretty.js:105072` |
| DELETE | `/leona_pay/oauth/business?link_id=&business_id=` | → status do vínculo | grep `pretty.js:105083` |
| GET | `/leona_pay/registration/legal` | → `{ version }` | (fonte: REA) `index.js:88:28191`; `pretty.js:105000` |
| POST | `/leona_pay/registration/send_code` | `{ email }` | (fonte: REA) `index.js:88:28380`; `pretty.js:105007` |
| POST | `/leona_pay/registration/complete` | ver §3.7 → `{ user, continue_url }` | (fonte: REA) `index.js:88:28503`; `pretty.js:105011` |

### Emissores de NF
| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/invoice_integrations` | → `{ invoice_integrations: [] }` | (fonte: REA) `index.js:63:13089`; `pretty.js:80250` |
| POST | `/invoice_integrations` | `{ invoice_integration: { provider: "notasy", company_name, integration_token } }` | (fonte: REA) `index.js:63:13227` |
| PUT | `/invoice_integrations/:id` | `{ invoice_integration: { company_name, integration_token? } }` | grep `pretty.js:80264` |
| DELETE | `/invoice_integrations/:id` | — | grep `pretty.js:80273` |
| POST | `/sales/:id/reemit_invoice` | `{ invoice_integration_id? }` → venda atualizada | grep `pretty.js:79162` |

### IA
| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/ai_integrations` | → `{ ai_integrations: [] }` | (fonte: REA) `index.js:85:227209` |
| POST | `/ai_integrations` | `{ ai_integration: { provider, key_name, integration_token } }` | (fonte: REA) `index.js:85:227337` |
| PUT | `/ai_integrations/:id` | `{ ai_integration: { key_name, integration_token? } }` | grep `pretty.js:103433` |
| DELETE | `/ai_integrations/:id` | — | grep `pretty.js:103440` |
| GET | `/ai_integrations/openrouter_models` | → `{ models: [] }` | (fonte: REA) `index.js:85:227847` |
| GET | `/ai_integrations/:id/voices` | → `[]` ou `{ voices: [] }` (ElevenLabs) | grep `pretty.js:103449` |

### UTMify (ver arquivo 11)
GET/POST `/utmify_integrations` (fonte: REA `index.js:85:226531`, `index.js:85:226667`); PUT/DELETE `/utmify_integrations/:id` (grep `pretty.js:103405-103413`). Payload `{ utmify_integration: { company_name, integration_token } }`.

### Produtos
| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/products` | → `{ products: [] }` | (fonte: REA) `index.js:60:164876` |
| POST | `/products` | `{ product: { name, currency_code, price_min, price_max, price_fallback } }` | (fonte: REA) `index.js:60:164990` |
| PUT | `/products/:id` | `{ product: {...} }` | grep `pretty.js:74316` |
| DELETE | `/products/:id` | — | grep `pretty.js:74319` |

Relacionado: `GET /sales` aceita filtros `product_id`/`product_ids` (`pretty.js:79133`).

Fora de escopo mas homônimo: `POST /integrations/test_request` (fonte: REA `index.js:389:23583`; `pretty.js:228143`) é o "testar requisição" do nó HTTP/Integração do builder (`request_method`, `request_url`, `request_headers`, `request_body`), não do hub.

---

## 7. Eventos realtime

- **Nenhum canal ActionCable específico** do hub de integrações, chaves de pagamento, NF ou produtos foi encontrado. O hub recarrega por requisição após cada ação e ao trocar de conta.
- `AccountNotificationsChannel` (`{ account_id }`) é usado por exportações de vendas (`type: "sales_export"`, `pretty.js:80241`) e outros jobs; não carrega eventos de integração.
- Confirmação de pagamento (webhooks XPag/Zenith/Leona Pay) é processada no backend em filas dedicadas — o painel de superadmin "ingestor" lista as filas `xpag_webhooks`, `zenith_webhooks`, `leonapay_webhooks` e `inbound_webhooks` (`pretty.js:31063-31066`) — e repercute no fluxo (saída `payment_approved`), não via evento no front. [INFERIDO]

---

## 8. Permissões

- Chaves de permissão por seção de Configurações: `settings.<seção>.view|edit|delete`, com seções `integrations`, `products`, `mcp` entre outras (`pretty.js:36102-36122`).
- Card/aba "Integrações" exige `settings.integrations.view`; "Produtos" exige `settings.products.view`; MCP `settings.mcp.view` (`pretty.js:117283-117306`, `117542-117547`).
- Rótulos no modal de permissões: área "Integrações" — "NF, UTMify, pagamentos e similares"; "Produtos" — "Catálogo de produtos da conta"; ações Visualizar/Editar/Excluir (i18n `pretty.js:17171`). Só o proprietário define permissões; proprietário tem acesso total.
- [NÃO VERIFICADO] Não foi encontrado no front uso de `settings.integrations.edit/delete` ou `settings.products.edit/delete` para esconder botões dentro do hub/página — a aplicação de edit/delete provavelmente é feita no backend (resposta de erro exibida no toast).

---

## 9. Integrações externas

| Serviço | Tipo | Autenticação | Uso |
|---|---|---|---|
| Leona Pay | Gateway de pagamento próprio (BR/MX/LatAm) | OAuth 2 (code + state, troca no servidor) **ou** chave de API (`leonapay_live_/test_`); cadastro de conta via API de registro; links para painel cliente e documentos jurídicos externos | Bloco Pagamento |
| XPag | Gateway (PIX BRL, LATAM, cripto USDT) | Client ID + Client Secret | Bloco Pagamento |
| Zenith Global | Gateway multi-país (BR, CO, MX, PE, AR, IN, PH) | OAuth (inclusive iniciado pelo painel do parceiro com `installation_id`) **ou** X-API-Key + X-API-Secret; webhook registrado automaticamente | Bloco Pagamento |
| Notasy | Emissor de NF-e | Token da integração | Bloco Venda aprovada → emissão |
| UTMify | Rastreamento de vendas | Credencial de API | Bloco Venda aprovada (arquivo 11) |
| OpenAI | LLM | API key | Blocos de IA |
| Google Gemini | LLM | API key | Blocos de IA |
| OpenRouter | Agregador de LLMs | API key; lista de modelos via backend | Blocos de IA |
| ElevenLabs | TTS/voz | API key; lista de vozes via backend | Áudio IA nos fluxos |
| QuickChart [INFERIDO] | Geração de imagem de QR | — | URL do QR Bre-B/Zenith nas variáveis |

Plataforma (não por tenant, painel superadmin): chaves Pagar.me (secret/public/webhook secret HMAC, evento `order.paid`) para a cobrança do próprio SaaS e compra de créditos; chaves de serviços internos de IA (Qwen/DashScope, Groq, Fish Audio, Kie, Lara etc.) — `pretty.js:29795-29866`. Não fazem parte do módulo de Integrações do cliente.

---

## 10. Lacunas

- [NÃO VERIFICADO] Formato exato da URL de webhook gerada para XPag e Leona Pay — o front só exibe a URL para Zenith (`zenith_webhook_url`). Para XPag/Leona Pay o registro do webhook é presumivelmente automático no backend.
- [NÃO VERIFICADO] Lista completa de eventos aceitos dos gateways (o front só conhece "cobrança gerada", "pagamento aprovado" e "erro"). Não há enum de reembolso/chargeback/boleto vencido/carrinho abandonado no front para gateways; nem tela de mapeamento evento→ação fora do builder/webhooks.
- [INFERIDO] Métodos XPag em BRL (PIX) e o comportamento de "API Cripto (USDT)" — a descrição do catálogo menciona USDT, mas nenhuma moeda/método cripto aparece no bloco Pagamento.
- [NÃO VERIFICADO] Chaves i18n `zenithConnectAuthorize/Authorizing/Ready/Return/MissingReturnUrl` existem (fluxo "Autorizar vínculo" e "Voltar para a Zenith"), mas o componente atual `/integrations/zenith/connect` só faz redirect automático; essas strings parecem de uma versão anterior ou de fluxo não roteado.
- [NÃO VERIFICADO] Campo `name` em `invoice_integration` (fonte do valor) e se há outros provedores de NF no backend (o front só tem `notasy`).
- [NÃO VERIFICADO] Enforcement de `settings.integrations.edit/delete` e `settings.products.edit/delete`.
- [INFERIDO] Ambiente SANDBOX × PRODUCTION Leona Pay: o front só lê `key_environment`; não há seletor de ambiente.
- [NÃO VERIFICADO] Tipos/limites de moeda do produto vs. moedas aceitas pelos gateways — produto aceita ~160 ISO; gateways restringem (BRL/MXN/ARS/COP/PEN/INR/PHP…).
- [INFERIDO] Itens "coming-soon" do catálogo: lógica existe mas nenhum item atual usa.

Contagem aproximada de features documentadas: ~48 (hub/catálogo/busca/abas/contadores; 9 itens de catálogo; CRUD de 5 tipos de integração; teste de conexão; rotação Zenith; OAuth Zenith ×2 entradas; OAuth Leona Pay; cadastro Leona Pay; seleção/remoção de empresa; desvincular; validação de chave; CRUD de produtos; matriz gateway×moeda×método; saídas do bloco Pagamento; bloco Venda aprovada com NF/UTMify/push; status e reemissão de NF; permissões).

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Integrações (/settings?tab=integrations):** filtros por categoria com contadores: Todas, Notas Fiscais, Rastreamento, Pagamentos, Inteligência Artificial.
  - Seção DESTAQUES com o gateway nativo da plataforma (selo NOVIDADE, categoria PAGAMENTOS, "Receba no Brasil, no México e na América Latina", botão Configurar).
  - Seção "ATIVAS N" (conectadas na conta), com cards nome + provedor (ex. um gateway de pagamento de terceiros).
- **Produtos:** "Novo produto", busca. Tabela NOME, MOEDA (BRL, MXN...), ID (UUID), PREÇO MÍN., PREÇO MÁX., VALOR PADRÃO, AÇÕES.
- **Ferramentas MCP:** "Como usar?", "Nova credencial".
  - Card "Servidor MCP" com a URL. Cursor e n8n usam token estático + Bearer; Claude usa OAuth (basta colar a URL). Exemplo de header Authorization: Bearer.
  - Tabela de credenciais: NOME, TIPO (OAuth/Token), STATUS (ex. "Conectada · <cliente>"), ÚLTIMO USO, EXPIRA EM, AÇÕES.
