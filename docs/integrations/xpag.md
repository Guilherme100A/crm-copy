# XPag: pagamentos ao lead (T109)

O adapter XPag implementa a porta `PaymentGateway` (`packages/core/src/payments/port`). É a cobrança **ao lead**, feita dentro do fluxo pelo bloco Pagamento (T111). A assinatura do SaaS é outra coisa: ela usa a `BillingProvider` e continua fora deste módulo.

Fizemos o adapter só pela documentação pública. O projeto não tem sandbox da XPag e os testes rodam contra o `FakeXPag` local. Falta validar com uma chave real (fica com o usuário).

## Fontes (documentação pública)

- https://xpag.global/en/ (produto)
- https://xpag.global/docs (visão geral; base `https://api.xpag.global`)
- https://xpag.global/docs/authentication
- https://xpag.global/docs/cashin
- https://xpag.global/docs/transactions
- https://xpag.global/docs/webhooks
- https://xpag.global/docs/balance
- https://xpag.global/docs/errors
- https://xpag.global/docs/sandbox (só referência; os testes não usam)
- https://xpag.global/llms-full.txt (documentação consolidada)

## Configuração

| Variável         | Default                    | Uso                                                                  |
| ---------------- | -------------------------- | -------------------------------------------------------------------- |
| `XPAG_API_URL`   | `https://api.xpag.global`  | Base da API. Nos testes, aponte para o `FakeXPag`                    |
| `API_PUBLIC_URL` | `http://localhost:3000`    | Base pública da API, usada para derivar o `webhook_url`              |
| `CREDENTIALS_KEY`| obrigatório                | Cifra o `client_secret` e o `webhook_secret` (`credentialsCipher`)   |

Na API, `createApp` aceita `paymentsEnv`, `paymentsFetch`, `paymentIntegrations` e `credentialsCipher` como dependências injetáveis.

## Endpoints usados

| Chamada                                  | Uso                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `GET /balance`                           | `testConnection()`. Não tem efeito colateral e valida a credencial |
| `POST /cashin`                           | `createCharge()`                                                  |
| `GET /consult-transaction?transaction_id=` | Consulta do status real, de reserva se o webhook falhar (T111)  |

**Autenticação:** headers `X-Client-Id` e `X-Client-Secret` em toda chamada. A doc também aceita Basic `base64(id:secret)`, mas o adapter não usa.

**Erros:** o corpo vem como `{ ok: false, error, error_code }`. HTTP 401, `invalid_credentials` e `missing_credentials` viram `PaymentGatewayError('unauthorized')`. `amount_below_min` e `amount_above_limit` viram `'validation'`. O resto vira `'upstream'`. As mensagens nunca levam o segredo (são redigidas).

## Matriz moeda × método (§4.6) e corpo do `POST /cashin`

O `amount` é decimal na unidade da moeda (`123.45`); o CRM guarda centavos (`amount_cents`). Sem `amount`, a cobrança é uma "chave sem valor".

| Moeda | Método no CRM   | Corpo enviado                                                        | Saída normalizada                                                                 |
| ----- | --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| BRL   | `PIX`           | `currency`, `amount?`, `name?`, `document?`                          | `payment_code` = `copyPaste`; `qr_image_url` = `qr_img` (ou `qr_url` na chave sem valor) |
| MXN   | `SPEI`          | `currency`, `amount?`, `name?`, `document?` (sem `method`)           | `payment_code` = `clabe`; `bank_info` com `bank_name`, `beneficiary`, `account` e `reference` |
| MXN   | `OXXO`          | `method: 'OXXO'`, `amount` (MX$10–10.000), `payerData{name,email}?`  | `payment_code` = `payee_data.reference`; `qr_image_url` = `barcode`; `expires_at` = +12 dias |
| COP   | `NEQUI`, `BREB` | `method`, `amount` (≥ COP$10.000), `phone?` (10 dígitos começando com 3) | `payment_code` = `copy_paste`; `qr_image_url` = `qr_url`; `checkout_url`; `bank_info.reference` = `breb_key`; `expires_at` = `expire_minutes` |
| ARS   | `BANK_TRANSFER` | `method`, `amount`, `name` (obrigatório), `document` + `document_type` (`CUIT` por padrão) | `payment_code` = `payee_data.accountNumber`; `bank_info` com `bank_name` e `beneficiary` |

Todos os corpos levam também `description?`, `external_id?` (idempotência) e `webhook_url` (veja abaixo).

**Validação feita antes de chamar a XPag** (`validateXPagCharge`):

- Moeda ou método fora da matriz → `validation`.
- Valor não inteiro ou ≤ 0 → `validation`.
- OXXO fora de MX$10–10.000 → `validation`.
- COP abaixo de COP$10.000 → `validation`.
- Celular COP inválido → `validation`. O prefixo `57` é removido.
- ARS sem `name` → `validation`.
- COP e OXXO sem valor → `validation`.
- **ARS "chave sem valor" → `coming_soon` ("em breve")**.

## Webhook e assinatura (decisão do CRM)

A XPag manda um POST para o `webhook_url` informado em **cada** cashin; não há cadastro no painel. O payload documentado é este:

```json
{ "type": "cashin", "status": "confirmed", "amount": 123.45, "fee": 1.23, "currency": "BRL",
  "request_number": "pr_...", "transaction_id": "pr_...", "e2e": "E...", "provider": "XPag",
  "updated_at": "2025-11-24 12:00:00" }
```

Os status documentados são `confirmed`, `completed`, `med`, `med_closed` e `failed`. A conciliação deve usar `e2e`, que é único por pagamento.

**A documentação pública NÃO define assinatura, HMAC, header de verificação nem lista de IPs** (https://xpag.global/docs/webhooks). Na falta disso, o CRM autentica o webhook com um token por integração:

1. Ao criar a integração, o CRM gera um `webhook_secret` aleatório de 32 bytes. Ele fica guardado cifrado e nunca sai pela API.
2. O `webhook_url` exposto no DTO não carrega segredo: `<API_PUBLIC_URL>/api/hooks/payments/xpag/<integration_id>`.
3. No `POST /cashin`, o adapter envia `webhook_url = <webhook_url>?token=<webhook_secret>`.
4. A rota de hooks (T111) repassa o `token` da query no header `x-webhook-token` ao chamar `parseWebhook(rawBody, headers)`. O ideal é ela não logar a query string.
5. `parseWebhook` compara o token em tempo constante. Se o token estiver ausente ou não bater, lança `PaymentGatewayError('invalid_signature')` e não devolve nenhum evento.

Se a XPag passar a assinar os webhooks, troque a verificação no `parseWebhook` sem mudar a porta.

**Mapeamento para `PaymentEvent`.** Só eventos `type: 'cashin'` são considerados. Os de cash out são ignorados.

| Status XPag                                           | Evento             |
| ----------------------------------------------------- | ------------------ |
| `confirmed`, `completed`                              | `payment.approved` |
| `failed`                                              | `payment.failed`   |
| `expired` (aparece na consulta de transação)          | `payment.expired`  |
| `med_closed` com resultado de devolução [INFERIDO]    | `payment.refunded` |
| `med` aberto, `pending`                               | nenhum evento      |

Nos campos do evento, `amount_cents` = `round(amount × 100)`. `paid_at` vem do `updated_at`; como a doc não informa fuso, o valor é lido como UTC [INFERIDO].

## API do CRM

A permissão é `settings.integrations.view|edit|delete`. O corpo pode vir plano ou no envelope `{ payment_integration: {...} }`.

- `GET /api/payment-integrations[?gateway=xpag]` → `{ items }`
- `POST /api/payment-integrations` com `{ label, gateway, client_id, client_secret }` → 201 `{ integration }`
- `GET /api/payment-integrations/:id` → `{ integration }`
- `PUT` ou `PATCH /api/payment-integrations/:id` → `{ integration }`
  - Com `client_secret` vazio, o segredo atual é mantido.
  - Mudar o `gateway` → 422.
- `DELETE /api/payment-integrations/:id` → `{ ok: true }`
  - Se a integração for usada por um bloco Pagamento de fluxo **ativo**, a resposta é 409 com `details.flows`.
- `POST /api/payment-integrations/:id/test-connection` → `{ ok: true }` ou `{ ok: false, error }`

O DTO tem estes campos: `id`, `label`, `gateway`, `client_id`, `secret_configured`, `secret_hint` (`…abcd`), `webhook_url`, `zenith_oauth`, `last_tested_at`, `last_test_ok`, `created_at` e `updated_at`. Nunca inclui `client_secret` nem `webhook_secret`.

## Testes

- O `FakeXPag` (`@crm/core`) sobe um servidor HTTP local com `GET /balance`, `POST /cashin` e `GET /consult-transaction`. Ele recusa credencial errada com 401.
- `fake.webhookFor(txId, { status })` devolve `{ url, rawBody, headers }` com o token que veio no cashin.
- Nunca usar a API real da XPag nos testes.
