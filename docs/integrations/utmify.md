# UTMify: envio de vendas aprovadas e reembolsadas (T113)

O adapter UTMify implementa a porta `SalesTracker { pushSale(sale, attribution) }` (`packages/core/src/utmify/port.ts`). Ele é usado pelo bloco **"Venda aprovada"** (`register_approved_sale.utmify_integration_id`, gravado em `sales.utmify_integration_id`; nulo = "Não enviar para UTMify"). Quando a venda é aprovada ou passa a reembolsada, o job `utmify` envia o pedido à UTMify com a atribuição do contato.

O projeto não tem sandbox da UTMify. O adapter segue a documentação pública, e os testes rodam só contra o `FakeUtmify` local. **A API real nunca foi chamada**, nem para conferir a rota. A validação com uma credencial real fica com o usuário.

## Fontes (públicas)

- https://docs.utmify.com.br/envio-de-vendas — página "Envio de Vendas", citada na ajuda do produto de referência (11 §9). Traz o endpoint, o header de autenticação, todos os campos do corpo e quatro exemplos (PIX gerado, PIX pago, cartão pago, cartão reembolsado).
- https://docs.utmify.com.br/envio-de-vendas.md — a mesma página em Markdown.
- https://docs.utmify.com.br/llms.txt — índice da documentação: "Envio de Vendas", "Consulta de dados" e um `openapi.json`. O `openapi.json` (https://docs.utmify.com.br/api-reference/openapi.json) ainda é o exemplo padrão do Mintlify ("plants") e não descreve a API de pedidos.

## Configuração

| Variável          | Default                     | Uso                                                       |
| ----------------- | --------------------------- | --------------------------------------------------------- |
| `UTMIFY_API_URL`  | `https://api.utmify.com.br` | Base da API. Nos testes, aponte para o `FakeUtmify`       |
| `APP_NAME`        | —                           | Vira o `platform` do pedido em PascalCase (padrão `Crm`)  |
| `CREDENTIALS_KEY` | obrigatório                 | Cifra a credencial da integração (`token_enc`, AES-256-GCM) |

Na API, `createApp` aceita `utmifyIntegrations`, `utmifyEnv`, `utmifyFetch` e `credentialsCipher` como dependências injetáveis. No worker, use `configureUtmify({ db, env, publisher, cipher?, retryBaseMs?, notVisibleBaseMs? })`. A rota não chama a UTMify (não há "testar conexão"), então o harness E2E não sai para a rede por ela.

## Endpoint usado

### `POST {UTMIFY_API_URL}/api-credentials/orders`

- **Autenticação:** header `x-api-token` com a "Credencial de API" gerada no dashboard da UTMify. A credencial é segredo. Fica só cifrada no banco e é redigida (`[redacted]`) em toda mensagem de erro. Não aparece em DTO, `details`, `last_error`, auditoria, evento SSE nem log (AC-T113-04).
- **Corpo** (campos da doc). Formato de data: `"YYYY-MM-DD HH:MM:SS"` em UTC.

| Campo | O que o CRM envia |
| --- | --- |
| `orderId` | id da venda (`sales.id`). É o mesmo em todos os envios do pedido: reenviar com outro `status` atualiza o pedido, como nos exemplos de PIX gerado e PIX pago da doc. |
| `platform` | `APP_NAME` em PascalCase (a doc recomenda PascalCase) |
| `paymentMethod` | `pix` (**inferido**: a venda do CRM não guarda o meio de pagamento; os aceitos são `credit_card`, `boleto`, `pix`, `paypal` e `free_price`) |
| `status` | venda aprovada → `paid`; reembolsada → `refunded` |
| `createdAt` | `sold_at` da venda. A doc pede a mesma data em toda atualização de status. |
| `approvedDate` | `sold_at` da venda |
| `refundedAt` | `null` na aprovação; no reembolso, o momento em que o CRM detectou a mudança (`sale_utmify_events.requested_at`) |
| `customer` | `name` (nome da venda, depois o do contato, depois "Cliente"), `email` (do contato, ou `""`), `phone` (E.164 só com dígitos, ou `null`), `document: null` |
| `products` | um item: `id` = `public_id` do produto (ou o id da venda), `name` (ou "Venda"), `planId`/`planName` nulos, `quantity: 1`, `priceInCents` = valor da venda |
| `trackingParameters` | `utm_source`, `utm_medium`, `utm_campaign`, `utm_content` e `utm_term` do **último toque** do contato. `src` recebe o `source_id` (anúncio Meta) e `sck` o `ctwa_clid` (clique CTWA). |
| `commission` | `totalPriceInCents` e `userCommissionInCents` = valor da venda; `gatewayFeeInCents: 0`; `currency` só se a moeda não for BRL (a doc manda omitir BRL) |
| `isTest` | omitido. O adapter aceita `isTest: true` (valida sem gravar), mas o CRM não usa. |

- **Resposta:** a doc não publica códigos HTTP nem o corpo da resposta. Ela só diz que os campos inválidos voltam na resposta e cita o erro `API_CREDENTIAL_NOT_FOUND`. O adapter trata assim:
  - 2xx: aceito;
  - 401, 403 ou `API_CREDENTIAL_NOT_FOUND` no corpo: `unauthorized`;
  - 400 e 422: `validation`;
  - qualquer outro status, ou falha de rede: `upstream`.
- **Limites da doc:** aceita pedidos de até 7 dias e reembolsos/chargebacks de até 45 dias. Uma venda mais antiga deve ser recusada pela UTMify, e a recusa aparece como falha do envio.

## Atribuição: último toque

Decisão do Orquestrador: os `utm_*` vêm do **último toque** de `crm.contact_attribution` (`AttributionService.get(...).last_touch`, T73). O `source_id` e o `ctwa_clid` da própria venda têm prioridade. Depois vêm os do último toque e, por fim, os do contato. Venda sem contato ou contato sem atribuição: os campos vão `null` e o envio segue.

## Quando envia

| Gatilho | Status enviado |
| --- | --- |
| `sale.recorded` de venda `approved` com `utmify_integration_id` (bloco Venda aprovada, API ou fonte de venda) | `paid` |
| Venda de fonte de venda que passa de `pending` a `approved` (T73, `capiEnqueue`) | `paid` (o job confere a integração) |
| `sale.updated` do `SalesService` quando a venda passa a `refunded` (por `PATCH /api/sales/:id` ou por `record` repetido do webhook) | `refunded` |

- **Idempotência (AC-T113-02):** a tabela `sale_utmify_events` tem uma linha por (venda, status), e o jobId é `utmify-<saleId>-<approved|refunded>`. O mesmo evento nunca vai duas vezes. Uma aprovação atrasada que chega depois de o reembolso já ter sido enviado é descartada.
- **Falha (AC-T113-03):** o envio faz até 3 chamadas, com backoff de 10 s e depois 20 s. Depois disso, o status fica `failed`, com a mensagem em `last_error`. Ele é visível em `GET /api/sales/:id/utmify` e no `sale.updated` (`utmify_status`, `utmify_last_error`).
- **Venda ainda não visível:** acontece quando o job chega antes do commit do passo do fluxo. O job lança `SaleNotVisibleError` e repete em 2 s, 4 s… sem gastar chamada à UTMify.
- **Chargeback** (`chargedback` na UTMify) não é enviado: o escopo da T113 é aprovada e reembolsada.

## API do CRM

- `GET /api/utmify-integrations` → `{ utmify_integrations: [] }`. Com `?configured=1`, só as que têm credencial (para os seletores).
- `POST /api/utmify-integrations` com `{ utmify_integration: { company_name, integration_token? } }` (ou o corpo plano) → 201.
- `GET`, `PUT` e `PATCH /api/utmify-integrations/:id`. Token em branco mantém o atual.
- `GET /api/utmify-integrations/:id/usage` → `{ flows, in_use }`.
- `DELETE /api/utmify-integrations/:id`. Se um fluxo ativo usa a integração, responde 409 com aviso; `?force=1` exclui mesmo assim.
- `GET /api/sales/:id/utmify` → `{ utmify: { sale_id, utmify_integration_id, utmify_status, utmify_last_error, events: [{ sale_status, status, attempts, last_error, utmify_integration_id, requested_at, sent_at, updated_at }] } }`.
- `GET /api/sale-utmify?sale_ids=a,b` → `{ items: [...] }`.

## O que falta validar com uma credencial real

1. Os códigos HTTP e o corpo de sucesso e de erro (a doc não publica).
2. Se `email: ""` é aceito quando o contato não tem e-mail.
3. Se `paymentMethod: "pix"` é um padrão aceitável, ou se o bloco Venda aprovada deveria pedir o meio de pagamento.
4. Se `src`/`sck` são o lugar certo para o `source_id`/`ctwa_clid`, ou se a UTMify espera outro formato para cruzar com o anúncio.
