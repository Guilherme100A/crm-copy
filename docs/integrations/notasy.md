# Notasy: emissão de NF na venda aprovada (T112)

O adapter Notasy implementa a porta `InvoiceIssuer` (`packages/core/src/invoicing/port.ts`). Ele é usado pelo bloco **"Venda aprovada"** (`register_approved_sale.note_issuer_id`): quando o fluxo registra a venda aprovada, o job `invoices` envia a venda para o emissor.

O projeto não tem sandbox da Notasy. O adapter foi feito só pelo que a Notasy publica, e os testes rodam contra o `FakeNotasy` local. Falta validar com um token real (fica com o usuário).

## Fontes (públicas)

- https://notasy.com.br/ — produto. Diz que há "API documentada pra emitir nota direto da sua aplicação", mas não traz link para ela.
- https://faq.notasy.com.br/ — central de ajuda (conteúdo em `https://faq.notasy.com.br/api/documents`). A categoria "TI / Integrações" ("Documentação técnica de API e Webhooks") não tem artigo público. Os artigos "Configuração de Integração com Gateway/Checkout e Configuração Padrão" e "Como funciona a integração com plataformas do cliente?" mandam falar com o suporte para usar a integração "API".
- https://api-notasy.com.br/integrations — catálogo público das integrações (JSON). A conexão nativa de CRMs como este vem com `has_native_connection: true` e `native_connection_is_token_only: true`: o cliente informa só o **"Token de integração"**. Também existe a integração genérica `api` (credencial `email`).
- https://app.notasy.com.br/ — app (Nuxt). O componente público `EndpointUrl`, da tela da integração, mostra que cada integração recebe vendas em `<api>/integrations/endpoint/<token>`. O "Token de integração" exibido é o trecho depois de `/integrations/endpoint/`. Isso bate com o texto do produto de referência: "O token aparece no painel Notasy ao criar a integração com a API."
- https://app.notasy.com.br/webhooks/documentacao — documentação dos webhooks de **saída** da Notasy (página do app; conteúdo no bundle público `documentacao.*.js`).

## Configuração

| Variável          | Default                     | Uso                                                 |
| ----------------- | --------------------------- | --------------------------------------------------- |
| `NOTASY_API_URL`  | `https://api-notasy.com.br` | Base da API. Nos testes, aponte para o `FakeNotasy` |
| `CREDENTIALS_KEY` | obrigatório                 | Cifra o token do emissor (`token_enc`, AES-256-GCM) |

Na API, `createApp` aceita `invoiceIntegrations`, `invoicesEnv`, `invoicesFetch`, `invoicesEnqueue` e `credentialsCipher` como dependências injetáveis. No worker, `configureInvoices({ db, env, publisher, cipher?, retryBaseMs?, notVisibleBaseMs? })`.

## Endpoint usado

### Envio da venda — `POST {NOTASY_API_URL}/integrations/endpoint/{token}`

- **Autenticação:** o próprio token no caminho, sem header de autenticação. O token é segredo: fica só cifrado no banco e é redigido (`[redacted]`) em toda mensagem de erro. Não aparece em DTO, `details`, auditoria nem log.
- **Token colado como URL:** se o usuário colar o endpoint inteiro do painel, o CRM guarda só o trecho depois de `/integrations/endpoint/` (`normalizeNotasyToken`).
- **Corpo (INFERIDO):** o formato do JSON não é público. O tutorial da integração (`webhookTutorial`) só aparece para quem está logado. O CRM envia:

```json
{
  "event": "sale.approved",
  "id": "<sale_id>",
  "external_sale_id": "<external_id da venda ou sale_id>",
  "status": "approved",
  "created_at": "<sold_at ISO 8601>",
  "currency": "BRL",
  "total": 9700,
  "customer": { "name": "…", "email": "…", "phone": "+55…", "address": { "state": "…", "city": "…", "zip_code": "…" } },
  "products": [{ "id": "<product_public_id>", "name": "…", "quantity": 1, "price": 9700 }]
}
```

Os valores vão em **centavos**, como nos webhooks da Notasy (`value: 19790`).

- **Resposta:** qualquer HTTP 2xx = `succeeded`. Isso só quer dizer que o emissor aceitou o envio, não que a NF foi autorizada (19 §4.2). O CRM lê, se vierem, `data.id` (vira o `external_id`), `data.*_invoice.number` e `danfse_file`/`danfe_file` (vira o `pdf_url`).
- **Erros:** 401/403/404 → `unauthorized` ("Notasy recusou o token da integração"); 400/422 → `validation`; outros códigos ou rede → `upstream`. Em todos os casos, `last_error` guarda a mensagem já sem o token.

## Webhook de saída da Notasy (documentado, ainda não consumido)

A Notasy pode avisar a autorização, o cancelamento ou a falha da nota (fonte: `/webhooks/documentacao`):

- `POST` para a URL cadastrada, com os headers `Content-Type: application/json`, `User-Agent: Notasy-Webhooks`, `X-Notasy-Event` (igual ao `type` do corpo) e `X-Notasy-Event-Id` (igual ao `id` do corpo).
- **Assinatura:** o header `X-Notasy-Signature` traz o HMAC-SHA256 do **corpo cru**, em hexadecimal, com o segredo do webhook. Compare em tempo constante e use o corpo exatamente como chegou.
- **Eventos:** `service_invoice.transmitted|canceled|failed` e `product_invoice.transmitted|canceled|failed`.
- **Corpo:** `{ id, type, created_at, test, data: { service_invoice | product_invoice: { id, status (transmitted|canceled|rejected|unexpected_error), error_message, number, value (centavos), danfse_file, xml_file, external_sale_id, invoice_data, integration, integrations_connection } } }`.
- Há retentativas automáticas e reenvio manual pelo histórico. Use o `id` do evento para descartar entregas repetidas.

A T112 não recebe esse webhook: o AC só exige o status "enviada ao emissor". Ficou como pendência. Daria para casar o evento com a venda pelo `external_sale_id` e preencher `number`/`pdf_url` com a NF autorizada.

## Fluxo no CRM

1. O bloco "Venda aprovada" grava a venda com `note_issuer_id`. O `sale.recorded` passa pelo `invoiceSalePublisher`, encadeado no publisher das vendas depois do `capiSalePublisher`, que enfileira `invoices` com jobId `invoice-<saleId>-1`.
2. O job `invoices` cria a linha em `sale_invoices` com `pending` e publica `sale.updated`. Depois chama o emissor:
   - aceito → `succeeded` + `sale.updated`;
   - recusado → tenta de novo com backoff (10 s, 20 s); na 3ª falha → `failed` com `last_error` + `sale.updated`.
3. Emissor sem token, excluído ou de outra empresa → `failed` com "Emissor não configurado".
4. Venda ainda não visível (o job chegou antes do commit do passo) → `SaleNotVisibleError`. Tenta de novo em 2 s, 4 s… e não conta como tentativa no emissor.
5. `POST /api/sales/:id/reemit-invoice { invoice_integration_id? }` é aceito quando o status não é `pending` nem `succeeded`. Ele zera as tentativas, incrementa a geração e enfileira `invoice-<saleId>-<n>`. Um job de geração antiga é ignorado.
