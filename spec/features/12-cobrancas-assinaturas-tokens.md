# 12 — Cobranças, Assinaturas e Tokens

> Fonte: análise estática clean-room de `_bundle/pretty.js` (pretty-print de `_bundle/index.js`) + tabela REA `_rea/rea-endpoints.md`.
> `pretty.js:N` = linha no arquivo pretty-printed. `index.js:L:C` = posição no bundle minificado reportada pelo REA, marcada "(fonte: REA)".
> O REA só captura caminhos literais (`xe.get("/x")`) e `path:` de rotas. Os métodos dos serviços `/billing` e `/leona_ai` usam template literal (`${this.endpoint}/...`) e **não aparecem** na tabela REA — foram extraídos por leitura do bundle.
> Dinheiro trafega em **centavos** (`*_cents`); tokens como string decimal (`*_units`).

---

## 1. Visão geral

Três trilhos de cobrança independentes:

| Trilho | O que cobra | Gateway | Onde |
|---|---|---|---|
| **Assinatura "Leona"** (atual) | Mensalidade recorrente **por instância** (1 instância = 1 conexão WhatsApp), preço por faixa de quantidade | **Pagar.me** (cartão tokenizado no navegador + Pix) no Brasil; **Paddle** (checkout hospedado) no exterior | `/billing` quando `subscription_type === "leona"` (pretty.js:253305) |
| **Assinatura legada** (`stripe` / `custom`) | Slots de conexão "Starter" e "Pro" | **Stripe** (Checkout, Customer Portal, faturas, Pix sobre fatura, reembolsos); "custom" = cobrança manual negociada via WhatsApp | `/billing` quando tipo ≠ `leona` (pretty.js:252906+) |
| **Tokens Leona** (créditos de IA, pré-pagos) | Compra avulsa de "tokens Leona"; saldo por **conta** | Pagar.me (Pix/cartão, BRL) ou Paddle (internacional, mín. R$ 4,00) | Modal "Tokens Leona da conta" (sidebar), card em `/billing`, painel Leona AI |

Há ainda um CRUD de **Planos** (`/plans`) com limites (conexões, atendentes, fluxos, remarketing, relatórios), aparentemente legado/administrativo e não ligado ao preço da assinatura Leona (§3.9, §10).

Contas legadas são migradas para o trilho Leona: em "Regularizar"/"Assinar" numa conta `stripe`/`custom`, o front chama `POST /billing/migrate_to_leona` e leva a `/billing?regularize=1` (pretty.js:41252-41310).

Features documentadas: **~62** (numeradas em §5 + telas/enums).

---

## 2. Telas e rotas

| Rota | Componente | Descrição | Guard | Ref |
|---|---|---|---|---|
| `/billing` | `Vta` → `Uta` se conta Leona | "Cobrança e Assinatura" (breadcrumb "Assinatura") | `billing.view` | pretty.js:256449; (fonte: REA) `billing` index.js:658:112245; `/billing` index.js:658:99383 e index.js:658:107809 |
| `/billing/invoices` | `Wta` | Histórico de faturas (legado), paginado, filtros | `billing.view` (prefixo) | pretty.js:256450; (fonte: REA) index.js:658:112284 |
| `/billing/refunds` | `Gta` | Reembolsos (legado), paginado, filtros | `billing.view` (prefixo) | pretty.js:256451; (fonte: REA) index.js:658:112332 |
| `/plans` | `C3t` → `w3t` | CRUD de planos | [NÃO VERIFICADO] (sem prefixo na tabela de permissões) | pretty.js:157130-157131; (fonte: REA) `plans` index.js:184:89508 |
| `?regularize=1` | — | Abre "Regularizar" (se past_due) ou "Assinar" (sem assinatura/cancelada/inativa) | — | pretty.js:41297, 251130-251158 |
| `?start=1` | — | Abre "Assinar agora" | — | 251150 |
| `?purchase=1` | — | Abre "Comprar mais instâncias" (ou "Assinar" se não ativa/past_due) | — | 251151-251156 |
| `?success=true` / `?canceled=true` | — | Retorno do checkout Stripe legado; success → toast "Assinatura ativada com sucesso!" | — | 253010-253022, 136580 |
| `?leona_ai_resume=<id>` | — | Retorno de compra de tokens feita dentro de sessão Leona AI; front guarda pendência em `sessionStorage` e retoma a sessão | — | 40322-40345 |

Breadcrumbs (`breadcrumbs.segments`): billing "Assinatura", invoices "Faturas", refunds "Reembolsos" (pretty.js:22392-22394, 255516, 256098). Menu lateral: seção "management", item `/billing`, permissão `billing.view` (pretty.js:46375-46380).

Componentes globais ligados a cobrança:
- **Modal de inadimplência** (`RBe`) no layout autenticado: chama `GET /billing/subscription`; se assinaturas habilitadas e `subscription_status === "past_due"`, abre "Assinatura em atraso" + "Regularizar assinatura". Não roda para usuário `support` (pretty.js:47145-47170, 41347-41440).
- **Banner de aviso** (`Bme`, namespace `settings.subscriptionWarning`) no Dashboard (86127) e em Conexões (137769) (pretty.js:85308-85470).
- **Chip de saldo de tokens** na sidebar (`sHe`): "N tokens Leona", barra "% usados", destaque se baixo/esgotado; clique abre modal (pretty.js:45875-45920).
- **Modal "Tokens Leona da conta"** (`wBe`) provido em todo o layout (pretty.js:40794-40900).
- **Modal de quantidade Starter/Pro** (legado) em Conexões (pretty.js:136500-136600).
- **Modal "Trocar instâncias do downgrade"** em Conexões (pretty.js:137660-137690).

---

## 3. Modelo de dados / campos

### 3.1 `GET /billing/subscription` — conta Leona
Consumido por `Uta` (pretty.js:250867-252906).

| Campo | Tipo | Obrig. | Observação | Ref |
|---|---|---|---|---|
| `subscription_type` | `leona`\|`stripe`\|`custom` | sim | escolhe UI | 252986 |
| `subscriptions_enabled` | bool | sim | false = conta Beta/Teste | 41255 |
| `past_due` | bool | sim | habilita "Regularizar" | 250932 |
| `can_renew_now` | bool | — | renovação antecipada (só BR, active/past_due, sem past_due) | 250934 |
| `billing_country` | `BR`\|`INTL` | — | Pagar.me vs Paddle | 250915 |
| `account.id` | int | sim | "ID da conta" copiável; canal realtime | 251906 |
| `account.holder` | string | — | "Titular" | 251932 |
| `account.email` | string | — | "E-mail" | 251942 |
| `subscription` | objeto\|null | — | abaixo | |
| `invoices[]` | lista §3.4 | sim | | 252072 |
| `tokens.used_in_cycle` | number | — | uso no ciclo (barra) | 250320 |
| `tokens.last_topup.amount` | number | — | "Última recarga" | 250323 |

`subscription` (Leona):

| Campo | Tipo | Observação | Ref |
|---|---|---|---|
| `status` | enum §4.1 | | 250933 |
| `instances_contracted` | int | pagas | 250937 |
| `instances_in_use` | int | "X / Y em uso"; Livres = contratadas − em uso | 250939-250943 |
| `pending_instances` | int\|null | quantidade agendada p/ renovação | 250959 |
| `monthly_total_cents` | int | valor mensal | Uta |
| `scheduled_monthly_total_cents` | int\|null | "Renovação: R$…" se diferente | Uta |
| `current_period_start` / `current_period_end` | data ISO | fim = "Próximo vencimento" | 250948 |
| `since` | data ISO | "Cliente ativo desde" (mês/ano) | Uta |
| `currency` | `BRL`\|`USD` | default BRL | 250917 |
| `collection_method` | `card`\|`manual`\|`paddle` | exibe "Bandeira •••• 1234" / "Pix" / "Cartão internacional" | 250978-250984 |
| `payment_method.brand` / `.last4` | string | cartão salvo | 250978 |
| `will_cancel` / `cancel_at_period_end` | bool | badge "CANCELANDO" | 250955 |
| `will_cancel_at` | data ISO | data efetiva | 251410 |

### 3.2 `GET /billing/config`
| Campo | Tipo | Observação | Ref |
|---|---|---|---|
| `catalog_by_country.{BR,INTL}` | objeto | fallback `catalog` | 250920 |
| `catalog.currency` | `BRL`\|`USD` | | 250921 |
| `catalog.instance_pricing.tiers[]` | `{max_instances:int\|null, unit_price_cents:int}` | faixas | 250922 |
| `pagarme.public_key` | string | chave pública; front exige prefixo `pk_` | 250990-250996 |
| `pagarme.token_api_base_url` | URL | API de tokenização | 250998 |

Faixas padrão do front (fallback quando o catálogo não traz tiers) (pretty.js:249862-249866):

| Total de instâncias | Preço unitário/mês |
|---|---|
| 1 | R$ 127,00 |
| 2–3 | R$ 99,00 |
| 4+ | R$ 79,00 |

Regra: o preço da faixa vale para **todas** as instâncias: total = qtd × unit(qtd) (pretty.js:249878-249891).

### 3.3 Formulários de pagamento Leona
Cartão (`a5`, pretty.js:250561-250640) — enviado **direto ao gateway** para tokenização:

| Campo | Tipo | Obrig. | Validação | Ref |
|---|---|---|---|---|
| `number` | dígitos | sim | máx 19, espaços removidos | 250567-250574 |
| `holder_name` | texto | sim | — | 250579 |
| `exp_month` | 2 dígitos | sim | 01–12 ("Informe o mês de validade com 2 dígitos (01–12).") | 250985-250988 |
| `exp_year` | 2 dígitos (AA) | sim | exatamente 2; vira 20AA | 250989 |
| `cvv` | 3–4 dígitos | sim | máx 4 | 250618 |

Documento/endereço (`I2`, pretty.js:250675-250830):

| Campo | Obrig. | Validação | Ref |
|---|---|---|---|
| `document` (CPF/CNPJ) | sim em BR (pix, cartão novo, cartão salvo) | máscara CPF/CNPJ automática; 11 ou 14 dígitos ("Informe um CPF ou CNPJ válido."); sem dígito verificador | 250642-250653, 251090-251095 |
| `address.zip_code` (CEP) | sim se CNPJ | 8 dígitos, máscara 00000-000; completa rua/bairro/cidade/UF via ViaCEP | 250654-250674 |
| `address.street`, `.number`, `.neighborhood`, `.city` | sim se CNPJ | não vazios | 251098 |
| `address.complement` | não | — | |
| `address.state` (UF) | sim se CNPJ | 2 letras maiúsculas | 251103 |

Endereço só aparece com 14 dígitos; erro geral "Informe o endereço completo da empresa."
"País de cobrança": Brasil (`BR`) / Exterior (`INTL`). "Forma de pagamento" (BR): Cartão | Pix. `payment_method` interno: `credit_card` | `pix` | `saved_card` | `paddle`.
Motivo de cancelamento: textarea obrigatória, **mínimo 50 caracteres**, contador "Faltam N caracteres (mínimo 50)" (pretty.js:250843, 250962, 251396-251402).

### 3.4 Fatura Leona (`invoices[]`)
| Campo | Coluna | Ref |
|---|---|---|
| `id` | chave | 252126 |
| `number` | "Fatura" | 252089 |
| `date` | "Data" | 252093 |
| `description` | "Descrição" | 252097 |
| `amount_cents` | "Valor" (BRL) | 252102 |
| `status` | "Status" §4.3 | 252107 |
| `pdf_url` | "Baixar PDF" (nova aba) | 252113 |
Vazio: "Nenhuma fatura ainda". Botões: "Reembolsos" → `/billing/refunds`, "Ver todas" → `/billing/invoices`.

### 3.5 `GET /billing/subscription` — conta legada
Campos (pretty.js:252906-255292): `subscription_type`, `subscription_status` (§4.2), `subscriptions_enabled`, `has_active_subscription`, `subscription_current_period_end`, `trial_started_at`, `trial_ends_at`, `trial_ending_soon`, `starter_slots_total/available`, `starter_connections_count`, `pro_slots_total/available`, `pro_connections_count`, `custom_subscription_expiring_soon`, `beta_migration_required`, `beta_migration_warning`, `days_until_beta_migration_deadline`, `can_migrate_to_leona`, e `subscription` com `items[]` (`quantity`, `price.interval` month|year, `price.product.name/description`, `formatted_item_amount`), `current_period_start/end`, `cancel_at_period_end`, `cancel_at`, `canceled_at`, `cancellation_reason`, `will_cancel`, `grace_period_end`, `retry_count`, `currency`.

### 3.6 Fatura legada (`GET /billing/invoices`)
Campos: `id`, `created` (Data), `formatted_amount_due`/`formatted_amount_paid` (Valor, já formatado), `amount_paid`, `currency`, `status` (§4.4), `due_date` (Vencimento), `hosted_invoice_url` ("Ver fatura"), `invoice_pdf` ("Baixar PDF"), `decline_code` e `next_payment_attempt` (bloco "Problema com Pagamento") (pretty.js:255292-255470, 254440-254460).
Paginação `{current_page, limit:25, total_count, has_more, total_pages}`; filtros status (Todos/paid/open/draft/uncollectible/void), data inicial, data final; limpar filtros.

### 3.7 Pix sobre fatura legada
`POST /billing/invoices/:id/generate_pix {tax_id}` (CPF 11 / CNPJ 14; "Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido."). Resposta: `br_code` (copia-e-cola), `br_code_base` (imagem do QR) [INFERIDO], `expires_at` ("Expira em: …"), `stripe_invoice_id` (pretty.js:253140-253150, 255416-255430).

### 3.8 Reembolso (`GET /billing/refunds`)
| Campo | Coluna |
|---|---|
| `id` | chave |
| `refunded_at` | Data |
| `formatted_amount` | Valor |
| `status` | Status §4.5 |
| `reason` | Motivo §4.6 ou "-" |
| `description` | Descrição (opcional) |
(pretty.js:255972-256447). Paginação 25, filtros status/datas. Só leitura — **sem solicitação de reembolso pelo cliente**.

### 3.9 Plano (`/plans`)
Formulário (pretty.js:156323-156800):

| Campo | Tipo | Obrig. | Default/validação |
|---|---|---|---|
| `name` | texto | sim | "" |
| `description` | texto | não | "" |
| `connections_limit` | número | — | 0, min 0 |
| `agents_limit` | número | — | 0, min 0 ("atendentes") |
| `flows_limit` | número | — | 0, min 0 |
| `remarketing_limit` | número | — | 0, min 0 ("em breve") |
| `reports_level` | select | — | `basic` Básico \| `advanced` Avançado \| `premium` Premium |
| `price` | decimal R$ | — | 0, step 0.01 |
| `billing_cycle` | select | — | `monthly` Mensal \| `annual` Anual |
| `messaging_enabled` | checkbox | — | true ("Disparo de mensagens") |
| `priority_support` | checkbox | — | false ("Suporte prioritário") |
| `plan_extras[]` | `{id,name,value}` | — | "Recursos extras" (nome + preço adicional R$); remoção via `plan_extras_attributes[]._destroy` |
Lista: busca com debounce 400 ms, página de 20, cards com limites/extras/preço/"Criado em"; vazio "Nenhum plano encontrado".

### 3.10 Carteira de tokens (`GET /leona_ai/wallet` → `wallet`)
| Campo | Tipo | Uso | Ref |
|---|---|---|---|
| `account_id` | int | descartada se ≠ conta atual | 36701 |
| `balance_units` | string decimal | saldo; pode ser **negativo** (overrun) | 36673-36700 |
| `low_balance_threshold` | string | baixo = 0 < saldo ≤ limiar | 36689-36693 |
| `status` | enum (`exhausted`…) | esgotado = exhausted ou saldo ≤ 0 | 36696 |
| `lifetime_credited_units` | string | total creditado | 45829 |
| `lifetime_spent_units` | string | total gasto ("X de Y usados", "% usados", "<1% usados") | 45830-45860 |
| `auto_recharge.status` | `active`… | se ativo, mostra "Desativar autorrecarga" | 40804 |
Formato: ≥1M "1.2M", ≥10k "12k", senão inteiro (36673-36688). Atualiza no mount, ao focar a janela e em `visibilitychange` (36740-36760).

### 3.11 Cotação (`GET /leona_ai/packages` → `quote`)
Defaults do front (pretty.js:40549-40560): `tokens_per_brl` "1000.0000" (1.000 tokens = R$ 1,00), `min_tokens` 1.000, `max_tokens` 10.000.000, `step_tokens` 1.000, `currency` BRL. UI: slider + campo "Tokens" (inicial 10.000) + "Você paga" (tokens ÷ tokens_per_brl); ao sair do campo arredonda ao múltiplo do passo e limita a [min,max] (40565-40590).

---

## 4. Estados e transições

### 4.1 Assinatura Leona (`subscription.status`)
Enum confirmado no select do admin (pretty.js:266045-266200):

| Valor | Badge |
|---|---|
| `active` | ATIVA |
| `past_due` | INADIMPLENTE |
| `canceled` | CANCELADA |
| `inactive` | CANCELADA / sem assinatura |
| flag `will_cancel` | CANCELANDO (prioridade) |
(pretty.js:250955-250960)

Transições: sem assinatura/inactive/canceled → **Assinar** → active (Pix aguarda confirmação); active → **Renovar** antecipado (BR, `can_renew_now`); active → vencimento sem pagamento → past_due (backend) → **Regularizar** → active; past_due + 5 dias após vencimento → números desconectados (texto, 41275-41283) → [INFERIDO] canceled; active/past_due → **Cancelar** → CANCELANDO → fim do período → canceled; CANCELANDO → **Reverter** → active; active → **Alterar plano na renovação** → `pending_instances` aplicado na renovação (downgrade marca conexões excedentes, ajuste às 02:00).

### 4.2 Assinatura legada (`subscription_status`)
| Valor | Rótulo |
|---|---|
| `active` | Ativa |
| `past_due` | Pagamento Atrasado |
| `paused` | Suspensa |
| `canceled` | Cancelada |
| `trialing` | Período de Teste |
| `inactive` | Inativa |
| `incomplete`, `unpaid` | sem rótulo; tratados como atraso |
(pretty.js:253028-253042, 253085). Tipos: `leona`, `stripe`, `custom` (+ derivado `unknown`) (41252-41257).

### 4.3 Fatura Leona
`paid` Paga · `open` Aberta · `pending` Pendente · `failed` Falhou · `void` Cancelada (pretty.js:249843-249860).

### 4.4 Fatura legada
`paid` Paga · `open` Aberta · `draft` Rascunho · `uncollectible` Não Cobrável · `void` Anulada (pretty.js:253058-253072). "Fatura em aberto" = existe open ou draft.

### 4.5 Reembolso
`succeeded` Concluído · `pending` Pendente · `failed` Falhou · `canceled` Cancelado · `requires_action` Requer ação (pretty.js:256054-256066).

### 4.6 Motivo de reembolso
`duplicate` Duplicado · `fraudulent` Fraudulento · `requested_by_customer` Solicitado pelo cliente (pretty.js:256068-256078).

### 4.7 Sessão de checkout Leona
`GET /billing/checkout_sessions/:id` → `status` (`completed` é o único testado); polling a cada 4 s com QR aberto. Respostas de start/settle/renew/purchase: `completed`, `awaiting_payment`, `checkout_url`, `pix_qr_code`, `pix_qr_code_url`, `session_id` (pretty.js:250847-250866, 251065-251080).

### 4.8 Notificações de cobrança (`RBe`, campo `type`)
| `type` | Título | Ação primária |
|---|---|---|
| `payment_failed` | Pagamento Pendente | Regularizar Pagamento |
| `subscription_canceling` | Assinatura Cancelada | Reverter Cancelamento (se `can_revert`) |
| `subscription_canceled` | Assinatura Cancelada | Ver Assinatura |
| `subscription_canceled_immediately` | Assinatura Cancelada | Assinar Agora |
| `custom_subscription_past_due` / `subscription_past_due` | Assinatura em atraso | Regularizar assinatura |
Campos: `message`, `action_url`, `action_label`, `can_revert`, `account_id`, `timestamp` (pretty.js:41390-41430). Hoje só `subscription_past_due` é gerado pelo front (47155-47165); demais [INFERIDO] vinham do backend.

### 4.9 Banner `subscriptionWarning`
Variações: vencendo em breve (custom, N dias); pagamento atrasado; cancelada por falha de pagamento (em N dias / hoje / já desconectadas); custom cancelada; cancelada genérica (N dias / hoje / em breve); migração beta (N dias / em breve); inativa; padrão "Problema com a assinatura". Botões: Ver cobrança, Regularizar pagamento, Criar nova assinatura, Assinar agora, Ver detalhes (pretty.js:17120-17160, 85308-85470). Stripe cancelado: prazo = `canceled_at` + 7 dias (253048-253056).

### 4.10 Códigos de erro de tokens
`insufficient_balance`, `no_balance`, `billing_failed`, `rate_limited`, `session_not_active`/`resume_not_ready`/`session_not_paused`, `checkout_not_configured`, `invalid_tokens`, `paddle_minimum_amount`. Sessão Leona AI vira `paused_for_payment` quando mensagem termina em `interrupted_payment` (pretty.js:197645-197660, 198380-198384).

---

## 5. Ações e regras de negócio

### 5.1 Assinatura Leona
1. **Carregar**: `GET /billing/subscription` + `GET /billing/config` em paralelo (250895-250905).
2. **Assinar agora**: stepper de quantidade (mín 1), país, forma de pagamento. BR: tokeniza cartão se cartão → `POST /billing/subscription/start`. INTL: `payment_method: paddle` → abre `checkout_url` em nova aba ("Pop-up bloqueado…" se bloquear) (251262-251290).
3. **Comprar mais instâncias**: mostra "Instâncias hoje", "Após a compra", "Cobrança proporcional agora (R$ · N de M dias)", "Novo valor mensal". **Proration** = (total(atual+adicional) − total(atual)) × dias_restantes/dias_do_ciclo, arredondado (249892-249920). Com cartão salvo usa `saved_card`; alternativas "Trocar cartão"/"Pagar com Pix". `completed` → "Instâncias adicionadas com sucesso."; `awaiting_payment` → instâncias liberadas após confirmação (251294-251345).
4. **Renovar assinatura** (`can_renew_now`): banner com vencimento; Pix ou cartão salvo; comprar instâncias não substitui renovação (251195-251225).
5. **Regularizar** (past_due): quantidade = contratadas; `POST /billing/subscription/settle` (BR ou Paddle) (251226-251260).
6. **Alterar plano na renovação**: nova quantidade, **sem cobrança agora**, vale no próximo vencimento; downgrade exige desconectar excedentes; igual = manter/cancelar agendamento. Desabilitado se cancelando ou past_due com instâncias (251347-251357).
7. **Trocar/Adicionar cartão**: tokeniza → `POST /billing/payment_method`; "Cartão atualizado com sucesso."; só BR, não Paddle, assinatura active/past_due (251359-251378).
8. **Cancelar assinatura**: modal de retenção + motivo ≥ 50 chars → `POST /billing/subscription/cancel` → "Cancelamento agendado… ativa até dd/mm/aaaa" (251393-251412).
9. **Reverter cancelamento**: `POST /billing/revert_cancellation` (251380-251392).
10. **Pagamento Pix**: QR + "Pix copia e cola" (Copiar/Copiado) + "Aguardando confirmação do pagamento…"; confirma via realtime `leona_billing_paid` ou polling 4 s → "Pagamento confirmado." **Pix não habilita renovação automática** (251040-251080).
11. **Copiar ID da conta** ("ID copiado!" por 2 s).
12. **Falar com Suporte**: link externo de suporte por WhatsApp.
13. Card "Informações da conta": ID, Titular, E-mail, Recorrência (fixo "Mensal"), Próximo vencimento, País de cobrança.
14. Card "Instâncias": em uso/contratadas/livres, preço por instância/mês, "cada instância é uma conexão de WhatsApp".
15. Card de assinatura: valor mensal, "Renovação: R$…" se agendado, cliente desde, próximo vencimento, forma de pagamento.
16. Avisos inline: downgrade programado (N instâncias, data), cancelamento agendado.

### 5.2 Assinatura legada
17. **Gerenciar assinatura**: se `stripe`/`custom`, migra (`POST /billing/migrate_to_leona`) e abre fluxo Leona com `?start|purchase|regularize=1` (252931-252950); senão abre WhatsApp.
18. **Pagar fatura em aberto (portal)**: `POST /billing/portal {return_url}` → redireciona (253100-253112).
19. **Pix sobre fatura**: CPF/CNPJ → generate_pix → QR, copia-e-cola, expiração; polling 10 s até `paid` → "Pagamento confirmado!" (252990-253005, 253130-253160).
20. **Comprar Starter/Pro** (Conexões): ≥ 1 Starter ou Pro; preço com debounce 500 ms (`calculate_add_instances_price`); com assinatura → `POST /billing/checkout {starter_quantity, pro_quantity, add_to_existing:true}`; sem → checkout hospedado com success/cancel URL; bloqueado em carência pós-cancelamento (136520-136595).
21. Seções: Status da Assinatura, Valor (itens, quantidade, "Preço Escalonável", Mensal/Anual), Período de Faturamento Atual, Período de Teste (início/fim, "terminando em breve"), Slots Starter/Pro (contratadas, criadas, em uso), Faturas Recentes (5), "Problema com Pagamento" (motivo, tentativas, próxima tentativa, vencimento), "Assinatura será cancelada" (data, motivo), "Cancelada – Período de Carência" (até `grace_period_end`, sem compras), banner de instabilidade do gateway legado, "Solicite sua assinatura custom" (WhatsApp).
22. **Conta Beta/Teste** (`subscriptions_enabled=false`): assinatura desabilitada; limite de N conexões.

### 5.3 Faturas e reembolsos
23. Faturas: lista paginada, filtros, ações por linha: Pix (se open), Ver fatura, Baixar PDF.
24. Reembolsos: lista paginada, filtros; só leitura.
25. Trocar de conta reseta filtros e recarrega.

### 5.4 Downgrade de conexões
26. Excedentes recebem "Downgrade pendente"/"Downgrade programado (data/hora)"; desconexão no ajuste das 02:00.
27. Dono troca 1:1 a instância marcada → `POST /billing/swap_pending_downgrade_connection` → "Troca realizada com sucesso…" (137665-137690; textos em 16636).
28. Excluída por downgrade: badge "Excluída · downgrade"; remoção definitiva por job de retenção.
29. Excluir conexão com assinatura ativa = marcada para desassinatura; exclusão definitiva no fim do período.
30. Sem assinatura ativa: "Nova Conexão" desabilitado.

### 5.5 Tokens Leona
31. Ver saldo: chip, modal, card em /billing ("disponíveis", barra do ciclo, "Última recarga", "+ Adicionar tokens").
32. **Comprar**: botão "Pix ou cartão" (`provider: pagarme`) ou "Paddle (internacional)" (`provider: paddle`; mínimo R$ 4,00 validado no front) → `POST /leona_ai/checkout` → abre `checkout_url` em nova aba (40616-40650).
33. Saldo por conta (todas as instâncias), separado do plano; token Leona ≠ token do provedor.
34. **Autorrecarga mensal**: texto diz que só vale se a compra for no cartão (Pix não ativa). Ativação [NÃO VERIFICADO]. **Desativar**: `DELETE /leona_ai/auto_recharge` (36575-36580, 40810-40818, 250470-250480).
35. **Overrun**: saldo pode ficar negativo; aviso "usou N tokens além do saldo (overrun permitido)"; teto `max_overrun_units` no admin (260020-260050).
36. Débito por turno na Leona AI: "−N tokens neste turno" (209725).
37. Consumidores: Leona AI (assistente do builder), tradução de fluxo (`GET /flow_translations/wallet`, 116748; (fonte: REA) index.js:118:73808), tradução de mensagens do chat (`POST /chats/:id/translations` → `insufficient_balance`, 35005-35016), criação assistida de agentes (estimativa de tokens, 32417-32418, 278217).
38. Sem saldo: sessão pausada ("Pausa por tokens Leona"), erro "Sem tokens Leona suficientes para continuar."
39. Usuário `support` não vê carteira (36131, 40880).

### 5.6 Admin (referência)
40. Tokens: crédito manual por conta (`POST /admin/leona_ai/wallets/:id/adjustments {amount_units, note}`), uso por conta/usuário, wallets negativos, reembolso de evento de uso (`POST /admin/leona_ai/usage_events/:id/refund {note}`), cost logs.
41. Precificação: `usd_brl_rate` (default 5.40), `tokens_per_brl` (1000), `rounding_mode` ceil|floor|round; billing configs `provider_key`, `model_key`, `operation` (default text_generation), `billing_type` (default tokens), `markup` (default 3), `pricing` (JSON) (259463-259520).
42. Pacotes: `GET/POST /admin/leona_ai/packages`, `PATCH /:id` (sem compra por pacote na UI cliente).
43. Assinatura Leona por conta: `GET/PATCH /admin/accounts/:id/billing_subscription {unit_price_cents, instances_contracted, pending_instances, status, current_period_end}` (256792-256803, 266030-266040).
44. Assinatura custom: add/remove instâncias (com proration), mudar vencimento, ativar, cancelar, migrar custom/Leona (256700-256790).

---

## 6. Endpoints da API

### 6.1 Cobrança (cliente) — serviço `/billing` (pretty.js:41069-41245)
| Método | Caminho | Payload/query | Resposta | Ref |
|---|---|---|---|---|
| GET | `/billing/subscription` | — | §3.1/§3.5 | 41096 |
| GET | `/billing/config` | — | §3.2 | 41185 |
| POST | `/billing/subscription/start` | `{quantity, payment_method, card_token?, billing_country, document?, address?}` | sessão §4.7 | 41213 |
| POST | `/billing/subscription/settle` | `{payment_method, quantity, card_token?, billing_country, document?, address?}` | idem | 41208 |
| POST | `/billing/subscription/renew` | `{payment_method, card_token?, document?, address?}` | idem | 41203 |
| POST | `/billing/instances/purchase` | `{quantity, payment_method, card_token?, billing_country, document?, address?}` | `{completed?, awaiting_payment?, checkout_url?, pix_*?}` | 41218 |
| POST | `/billing/subscription/change` | `{quantity}` | — | 41223 |
| POST | `/billing/subscription/cancel` | `{feedback}` | — | 41230 |
| POST | `/billing/revert_cancellation` | `{}` | — | 41151 |
| POST | `/billing/payment_method` | `{card_token, document, address?}` | — | 41237 |
| GET | `/billing/checkout_sessions/:id` | — | `{status}` | 41197 |
| POST | `/billing/migrate_to_leona` | `{}` | `{success}` | 41191 |
| POST | `/billing/swap_pending_downgrade_connection` | `{from_connection_id, to_connection_id}` | `{success:true}` | 41242 |
| POST | `/billing/checkout` (legado) | `{success_url?, cancel_url?, starter_quantity?, pro_quantity?, add_to_existing?}` | `{url}` / `{success}` | 41071-41088 |
| POST | `/billing/portal` (legado) | `{return_url?}` | `{url}` | 41089 |
| GET | `/billing/invoices` | `page, limit, status (repetível), start_date, end_date` | `{invoices[], pagination}` | 41101 |
| GET | `/billing/refunds` | idem | `{refunds[], pagination}` | 41119 |
| POST | `/billing/invoices/:id/generate_pix` | `{tax_id?}` | `{br_code, br_code_base, expires_at, stripe_invoice_id}` | 41169 |
| GET | `/billing/calculate_add_instances_price` | `starter_quantity, pro_quantity` | preço | 41155 |
| GET | `/billing/proration` | `connection_type` | proration | 41137 (sem chamador) |

Nenhum destes aparece no REA (template literal). Rotas de página estão no REA (§2).

### 6.2 Tokens — serviço `/leona_ai` (pretty.js:36553-36580)
| Método | Caminho | Payload | Resposta |
|---|---|---|---|
| GET | `/leona_ai/wallet` | — | `{wallet}` |
| GET | `/leona_ai/packages` | — | `{quote}` |
| POST | `/leona_ai/checkout` | `{tokens, session_id?, return_url?, provider?: pagarme\|paddle}` | `{checkout_url}` |
| DELETE | `/leona_ai/auto_recharge` | — | `{wallet}` |
| GET | `/flow_translations/wallet` | — | wallet do tradutor — (fonte: REA) index.js:118:73808 |

### 6.3 Planos (pretty.js:156291-156322)
| Método | Caminho | Payload |
|---|---|---|
| GET | `/plans?page&limit&search` | → `{plans[], pagination}` ou array |
| POST | `/plans` | `{plan:{…, plan_extras_attributes[]}}` — (fonte: REA) index.js:184:74749 |
| PUT | `/plans/:id` | `{plan:{…}}` |
| DELETE | `/plans/:id` | — |

### 6.4 Admin (referência)
`/admin/leona_ai/settings` GET/PATCH ((fonte: REA) index.js:658:160531 / 160733); `/admin/leona_ai/secrets` GET/POST ((fonte: REA) index.js:658:160935 / 161413) + PATCH `/:name`; `/admin/leona_ai/packages` GET/POST ((fonte: REA) index.js:658:161626 / 161762) + PATCH `/:id`; `/admin/leona_ai/billing_configs` POST ((fonte: REA) index.js:658:158850), GET com query, PATCH `/:id`; `/admin/flow_translations/billing_configs` GET ((fonte: REA) index.js:658:190458); `/admin/leona_ai/usage`, `/cost_logs`, `/usage_events/:id[/refund]`, `/wallets/:id[/adjustments]`; `/admin/accounts/:id/billing_subscription` GET/PATCH; `/admin/accounts/:id/custom_subscriptions/{add_instances, remove_instances, update_due_date, activate, cancel, calculate_add_proration, calculate_remove_proration}`; `/admin/accounts/:id/migrate_to_{custom,leona}` (pretty.js:256700-256803, 258680-258820).

### 6.5 Chamadas externas diretas do navegador
| Método | URL | Uso | Ref |
|---|---|---|---|
| POST | `{token_api_base_url}/tokens?appId={public_key}` body `{type:"card", card:{number, holder_name, exp_month, exp_year(AAAA), cvv, holder_document?}}` | tokenização de cartão (retorna `id`/`token`) | 250528-250558 |
| GET | `https://viacep.com.br/ws/{cep}/json/` | autopreenchimento de endereço | 250660-250674 |

---

## 7. Eventos realtime

ActionCable, canal `AccountNotificationsChannel` `{account_id}`:

| `type` | Efeito | Ref |
|---|---|---|
| `leona_billing_paid` | fecha QR Pix, "Pagamento confirmado.", recarrega assinatura em silêncio | 251055-251064 |

Stream da Leona AI: ação `wallet` atualiza saldo; `interrupted_payment` → sessão `paused_for_payment` (198380-198387).
Polling: sessão de checkout (4 s), faturas legado (10 s com modal Pix aberto), carteira ao focar a aba.
Não há eventos de `subscription_updated`/`wallet_updated`/bloqueio no front — [NÃO VERIFICADO] no backend.

---

## 8. Permissões

- `billing.view` ("Ver cobranças" — plano, faturas e status), grupo "Cobranças" (pretty.js:17171, 36221).
- Guard por prefixo `/billing` (inclui invoices/refunds) (40926); item de menu idem (46379). Sem permissão → "Sem permissão".
- `owner` e `admin` têm todas as permissões (36224).
- Transferência de propriedade diz que só o proprietário gerencia assinatura/faturamento/exclusão → [INFERIDO] ações de escrita restritas ao owner no backend; o front só checa `billing.view`.
- Troca de instância do downgrade: só o dono (tooltip).
- `role === "support"`: sem carteira e sem modal de inadimplência.
- Não é possível desativar conta com assinatura ativa (18705).
- `/plans`: sem regra no front — [NÃO VERIFICADO].

---

## 9. Integrações externas

| Integração | Uso |
|---|---|
| Pagar.me | Assinatura Leona BR (cartão tokenizado no client + Pix) e tokens ("Pix ou cartão") |
| Paddle | Checkout internacional (assinatura INTL e tokens, mín. R$ 4,00) |
| Stripe | Trilho legado: checkout, portal, faturas/PDF, Pix sobre fatura, reembolsos |
| ViaCEP | Endereço por CEP |
| WhatsApp (link) | Suporte, cobrança/sócio, assinatura custom, pedido de mais conexões (mensagens pré-preenchidas) |

---

## 10. Lacunas

1. [NÃO VERIFICADO] **Ativação da autorrecarga**: chaves de UI existem nas traduções, mas nenhum código as usa e o checkout de tokens não tem campo para isso. Limiar/valor/pacote desconhecidos; só "desativar" existe.
2. [NÃO VERIFICADO] **Extrato de tokens** para o cliente: não há endpoint de histórico; só `used_in_cycle`, `last_topup`, `lifetime_*`. Tipos de transação (crédito, débito, ajuste, reembolso, overrun) só aparecem no admin.
3. [INFERIDO] **Bloqueio por inadimplência**: não há guard de rota que bloqueie o app; só modal/banners e regra textual "números desconectados 5 dias após o vencimento" / "conexões deletadas" após cancelamento (feito por job no backend). Limites de plano só aparecem como "sem assinatura → não cria conexão" e limite em conta Beta.
4. [NÃO VERIFICADO] Relação entre **Planos** (`/plans`) e cobrança real — nenhum código de cobrança usa esses limites.
5. [NÃO VERIFICADO] Preços reais por país/faixa (`/billing/config`); só os defaults do front (R$ 127/99/79) são conhecidos; preço INTL em USD desconhecido.
6. [NÃO VERIFICADO] Enums completos de `wallet.status` (só `exhausted`) e `auto_recharge.status` (só `active`).
7. [NÃO VERIFICADO] Formato de `calculate_add_instances_price`, `proration`, `pix_qr_code_url`; flag "Pro indisponível".
8. [INFERIDO] Renovação automática cobra o cartão salvo no vencimento; Pix exige ação manual todo mês.
9. [NÃO VERIFICADO] Nota fiscal da própria assinatura — sem UI.

---

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **/billing, card "Assinatura" com selo de status (ex. ATIVA):**
  - Texto: cobrança mensal recorrente por instância contratada.
  - Valor/mês, INSTÂNCIAS CONTRATADAS, CLIENTE ATIVO DESDE (mês/ano), PRÓXIMO VENCIMENTO, FORMA DE PAGAMENTO (ex. Pix) com "Adicionar cartão".
- **Bloco "Instâncias":**
  - "usadas / contratadas em uso", CONTRATADAS, LIVRES.
  - Preço unitário por instância/mês; cada instância é uma conexão de WhatsApp. Observado: R$ 99,00 por instância/mês.
  - Ações: "+ Comprar mais instâncias", "Alterar plano na renovação", "Cancelar assinatura".
- **Bloco "Tokens Leona":** disponíveis, USADOS, ÚLTIMA RECARGA. Compra avulsa válida para a conta inteira, separada da assinatura. Botão "+ Adicionar tokens".
- **Informações da conta:** ID da conta, Titular, E-mail, Recorrência.
- **Sub-rotas:** `billing/invoices` (Faturas: Filtros; colunas DATA, VALOR, STATUS ex. "Paga", VENCIMENTO, AÇÕES) e `billing/refunds` (Reembolsos: Filtros; vazio "Nenhum reembolso encontrado").
- **Rota `plans`:** "Planos" com "Novo Plano"/"Criar Plano" e vazio "Nenhum plano encontrado". Parece ser cadastro de planos do próprio cliente (para cobrança de clientes dele), não os planos da Leona [INFERIDO].
