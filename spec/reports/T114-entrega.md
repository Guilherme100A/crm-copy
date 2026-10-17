# T114 — Entrega do Operário (UI: pagamentos, NF, UTMify e editores dos blocos Pagamento e Venda aprovada)

- **Status:** DONE · branch `task/T114` · base `e72438e`
- **Verify:** exit 0 — `node spec/verify/verify.mjs T114 --role operario --base e72438e` (typecheck, lint, test, i18n:check, build, regras FORBIDDEN e escopo com 31 arquivos; APROVADO 01:43)
- **Tempo:** 01:23 → 01:43 (2026-10-17). Inclui o harness e a conferência no navegador (desktop 1366 e mobile 390).
- **Zenith:** fora de escopo (SPEC 10.1 nº 13). Não há card, modal, OAuth nem gateway Zenith na UI. O editor do bloco oferece só a XPag.

## Arquivos
| Arquivo | O quê |
|---|---|
| `apps/web/src/features/settings-payments/{api,rules,catalog}.ts` | API (pagamentos XPag, NF, UTMify, listas dos blocos com `denied` em 403/404), validações replicadas do core, mapeamento DTO → card e as entradas do catálogo |
| `apps/web/src/features/settings-payments/{modal-kit,payment-modal,token-modal,invoice-modal,utmify-modal}.tsx` | Modais do hub: chave XPag (criar/editar/testar/excluir) e Notasy/UTMify (criar/editar/excluir com `?force=1`) |
| `apps/web/src/features/settings-payments/settings-payments.unit.test.ts` | AC-T114-01/02 |
| `apps/web/src/features/flow-editor/node-editors/payment/{index.ts,payment-rules.ts,payment-editor.tsx,payment.unit.test.ts}` | Editor do bloco Pagamento (AC-T114-03) |
| `apps/web/src/features/flow-editor/node-editors/sales/{index.ts,sales-rules.ts,approved-sale-editor.tsx,sales.unit.test.ts}` | Editor do bloco Venda aprovada (AC-T114-04), grupo próprio no glob |
| `apps/web/src/features/sale-invoice/{api,logic,realtime}.ts`, `invoice-cells.tsx`, `sale-history-slot.tsx`, `sale-invoice.unit.test.ts` | Colunas "Nota fiscal" e "UTMify" e ação "Reemitir nota" no histórico da T87 (AC-T114-05) |
| `apps/web/src/i18n/{pt-BR,en,es}/settings-payments.json` | Textos nas 3 línguas (hub, modais, editores e histórico) |
| `apps/web/src/features/integrations/catalog.ts` | **compartilhado, +4 linhas aditivas:** import, `...SALES_CATALOG`, `...SALES_RECORD_SOURCES` |
| `scripts/e2e/api.ts` | **liberado, +7 linhas aditivas:** fakes locais (ver "Harness") |
| `integrations.unit.test.ts`, `history.unit.test.ts`, `messaging.unit.test.ts` | **ajuste mínimo:** eles travavam o estado anterior à T114 (Vendas vazia, histórico sem slot, `payment` sem editor) |

## Decisões
- **Catálogo (AC-01):** os ids são `xpag` e `notasy` (Vendas) e `utmify` (Rastreamento). Ativo = `secret_configured` / `token_configured`, e o card mostra só a dica (`…abcd`). Pagamentos listam `GET /api/payment-integrations?gateway=xpag`. A busca e o contador vêm do hub da T59.
- **Modal XPag (AC-02):** o gateway fica fixo e desabilitado. As validações do cliente são iguais às do servidor ("Informe um nome com pelo menos 2 caracteres.", Client ID e Client Secret obrigatórios na criação). Um 422 do servidor (`details.fields[0].path`) aparece no campo; outro erro aparece em `payment-key-error`.
  - O segredo usa `type=password` com botão mostrar/ocultar. Na edição o campo fica vazio, com a dica como placeholder; em branco mantém o segredo (o PATCH não leva `client_secret`).
  - Na edição, os campos só aparecem depois do `GET /:id`, porque o Client ID vem de lá.
  - "Testar conexão" existe só na edição: resultado em `payment-key-test-result` (`data-ok`) e toast `payments-test-ok` ou `payments-test-fail`. A URL do webhook aparece em modo leitura.
  - Excluir: o servidor não aceita `force` para pagamentos, então um 409 só lista os fluxos.
- **NF e UTMify:** o mesmo modal (`token-modal.tsx`). Na criação o token é obrigatório (ref 19 §3.2). Na edição, em branco mantém o atual. Excluir com 409 mostra o `details.warning` do servidor e os fluxos, mais "Excluir mesmo assim" (`?force=1`).
- **Bloco Pagamento (AC-03):** a matriz da XPag foi replicada de `XPAG_SUPPORT`: BRL PIX; MXN SPEI/OXXO; COP NEQUI/BREB; ARS BANK_TRANSFER.
  - Trocar a moeda leva ao 1º método válido. Trocar o gateway desmarca a chave.
  - Campos do pagador por método:
    - PIX e SPEI: nome e documento;
    - OXXO: nome e e-mail;
    - COP: celular;
    - ARS: nome, documento e tipo (CUIT/CUIL/DNI).
  - Ao trocar de método, os campos que somem são apagados e os que aparecem recebem `{full_name}` / `{phone_number}`.
  - "Chave sem valor" só existe em BRL e em MXN SPEI. Em ARS aparece "em breve"; em COP e OXXO, "exige valor fixo".
  - Regras locais (bloqueiam o autosave com erro no campo): OXXO de MX$10 a MX$10.000; COP mínimo COP$10.000; celular colombiano; nome obrigatório em ARS; gateway fora da lista (ex.: `zenith` legado) fica inválido.
  - Com uma chave só no gateway, ela já vem escolhida.
- **Saídas:** o canvas (T45) desenha `charge_created`, `payment_approved` e `Falha` (o handle `failure` é a saída "error" de `handles.ts`). Os rótulos do canvas são os ids crus de `handleLabel`; os rótulos traduzidos ("Cobrança gerada", "Pagamento aprovado", "Erro") estão no resumo `ne-outputs` do editor. Para trocar o rótulo no canvas, seria preciso mexer em `flow-editor/canvas/**` (T45, fora dos Paths).
- **Bloco Venda aprovada (AC-04):** o editor fica no grupo `node-editors/sales/` (só `import type` do registry).
  - Produto: `GET /api/products`, valor = `public_id`. A opção "+ Criar novo produto…" (valor `__new__`, só com `settings.products.edit`) abre o `ProductDialog` da T90 e já seleciona o produto criado.
  - Templates com o padrão do comprovante.
  - Emissor de NF: lista de `/api/invoice-integrations`; a opção vazia "Não emitir nota automaticamente" grava `null`.
  - UTMify: `/api/utmify-integrations?configured=1`; "Não enviar para UTMify" grava `null`.
  - Push: título e corpo com seletor de variável, mais os botões `{produto.nome}`, `{venda.valor}`, `{venda.moeda}`, `{venda.cliente}` (acrescentam ao corpo).
- **Histórico (AC-05):** o slot da T87 (`sale-history-slot.tsx`) traz:
  - colunas `nf` e `utmify`;
  - a ação `reemit-invoice`, só com `sales.edit` e só quando `can_reemit`.
  - O status vem em lote: um `GET /api/sale-invoices?sale_ids=` / `GET /api/sale-utmify?sale_ids=` por instante, com até 200 ids.
  - **Emissor do "Reemitir":**
    - se a venda já tem emissor (`invoice_integration_id` ou `note_issuer_id`), o corpo vai vazio;
    - se a conta tem 1 emissor, vai direto com ele;
    - com vários, abre o diálogo `sale-invoice-reemit-dialog`;
    - sem lista (sem permissão), vai sem id e o servidor responde.
  - Depois do 202: toast `sale-invoice-reemitted` ("Emissão reenfileirada" + "Aguarde alguns segundos e atualize a lista."), o status vira "Enviando emissão…" e o botão some.
  - O `sale.updated` é registrado ao carregar o slot, que entra pelo glob eager do histórico. Como o SSE pode ter aberto antes (lição T53), o status `pending` também é reconsultado a cada 4 s.

## Testids (contrato com o Tester)
**Hub** (T59): `integrations-catalog-{xpag|notasy|utmify}`, `integrations-catalog-configure-<id>`, `integrations-record-<id>`, `-status-<id>` (`data-status=active|inactive`), `-edit-<id>`, `-delete-<id>`. No mobile, a aba é aberta por `settings-tab-select`.

**Modal XPag** (prefixo `payment-key`):
- `payment-key-editor` (`data-mode=create|edit`).
- Campos: `-gateway` (disabled), `-label`, `-client-id`, `-client-secret` (+ `-client-secret-toggle`), `-webhook-url` (edição).
- Erros: `-label-error`, `-client-id-error`, `-client-secret-error`, `-error` (geral).
- Teste de conexão: `-test`, `-test-result` (`data-ok`), `-last-test`.
- Botões: `-save`, `-cancel`.
- Exclusão: `payment-key-delete`, `-delete-confirm`, `-delete-cancel`, `-delete-in-use`, `-delete-flow-<id>`, `-delete-error`.
- Toasts: `payments-saved`, `payments-deleted`, `payments-test-ok`, `payments-test-fail`.

**Modal NF / UTMify** (prefixo `invoice` / `utmify`):
- `<p>-editor`, `<p>-company-name`, `<p>-token` (+ `-toggle`), `<p>-company-name-error`, `<p>-token-error`, `<p>-error`, `<p>-save`, `<p>-cancel`.
- Exclusão: `<p>-delete`, `-delete-confirm`, `-delete-force`, `-delete-in-use`, `-delete-flow-<id>`.
- Toasts: `<p>-saved`, `<p>-deleted`.

**Bloco Pagamento:**
- Container: `ne-payment` (`data-gateway`, `data-currency`, `data-method`).
- Seletores (cada opção tem testid próprio):
  - `ne-pay-gateway` (opções `ne-pay-gateway-option-<g>`);
  - `ne-pay-key` (`ne-pay-key-option-<id>`);
  - `ne-pay-currency` (`ne-pay-currency-option-<C>`);
  - `ne-pay-method` (`ne-pay-method-option-<M>`).
- Valor e "chave sem valor": `ne-pay-open-amount`, `ne-pay-open-unavailable`, `ne-pay-open-notice`, `ne-pay-amount`.
- Pagador (dentro de `ne-pay-payer`): `ne-pay-name`, `ne-pay-email`, `ne-pay-phone`, `ne-pay-document`, `ne-pay-document-type`.
- Escuta: `ne-pay-ttl-value`, `ne-pay-ttl-unit`.
- Avisos de chave: `ne-pay-keys-empty`, `ne-pay-keys-denied`.
- Saídas: `ne-outputs` com `ne-output-output:charge_created`, `ne-output-output:payment_approved`, `ne-output-failure`.
- Kit da T57: erros `ne-error-<campo>` e estado `ne-status`.

**Bloco Venda aprovada:**
- Container: `ne-approved-sale`.
- Produto: `ne-sale-product` (opções `ne-sale-product-option-<public_id>` e `ne-sale-product-new`); avisos `ne-sale-products-empty`, `ne-sale-products-denied`. "Criar novo produto" abre o modal `products-editor` (T90).
- Templates: `ne-sale-amount`, `ne-sale-currency`, `ne-sale-customer`.
- Emissor de NF: `ne-sale-issuer` (`ne-sale-issuer-option-<id>`; valor `''` = não emitir).
- UTMify: `ne-sale-utmify` (`ne-sale-utmify-option-<id>`).
- Push: `ne-sale-push-title`, `ne-sale-push-body`, `ne-sale-push-var-<variável>`.

**Histórico:**
- Células da T87: `dashboard-history-item-nf-<saleId>` e `dashboard-history-item-utmify-<saleId>`.
- Status da nota: `sale-invoice-status-<saleId>` (`data-status=pending|succeeded|failed|none`), `sale-invoice-error-<saleId>`, `sale-invoice-number-<saleId>`, `sale-invoice-pdf-<saleId>`.
- UTMify: `sale-utmify-status-<saleId>`.
- Reemissão: `sale-invoice-reemit-<saleId>`; diálogo `sale-invoice-reemit-dialog`, `-issuer`, `-confirm`, `-cancel`.
- Toasts: `sale-invoice-reemitted`, `sale-invoice-reemit-error`.

## Harness (E2E, sem rede)
- `scripts/e2e/api.ts` sobe `FakeXPag`, `FakeNotasy` e `FakeUtmify` locais e aponta `XPAG_API_URL`, `NOTASY_API_URL` e `UTMIFY_API_URL` para eles (os serviços leem `process.env` a cada chamada). São só linhas novas antes do `createApp`; nenhuma linha de outra tarefa foi editada.
- Credenciais aceitas pelos fakes:
  - XPag: Client ID `xpag-e2e` + Client Secret `xpag-e2e-secret` → "Conexão validada com sucesso.". Outra credencial → "Falha na conexão: Credencial recusada pela XPag (invalid_credentials)".
  - Notasy: token `notasy-e2e`.
  - UTMify: token `utmify-e2e`.
- A fila `invoices` não roda no worker do harness. Depois do "Reemitir", a venda fica em `pending` ("Enviando emissão…"), o que basta para o AC.
- Massa: crie a venda como owner (`POST /api/sales {sale:{amount_cents,currency,sold_at,customer_name}}`). Sem emissor na venda e com 1 emissor na conta, o "Reemitir" vai direto. Sem nenhum emissor, o servidor responde 422 e a UI mostra o toast de erro: crie o emissor antes.
- Fluxo com os blocos: `POST /api/flows` + `PUT /api/flows/:id/definition` com nós `payment` e `approved_sale` com `actions: []`; o editor completa os defaults (padrão `tests/acceptance/T57/support.ts`).

## Conferido no navegador (harness deste worktree; Playwright)
- **Hub:** sem card Zenith. Erro de nome curto.
- **XPag:** segredo mascarado. Testar conexão falha com a credencial errada e passa depois de trocar o segredo. Na edição o Client ID vem preenchido e o segredo vazio.
- **Notasy e UTMify:** criados pelos modais. A busca "notasy" acha o card. Excluir UTMify funciona.
- **Bloco Pagamento:**
  - moedas `[BRL, MXN, COP, ARS]`; métodos MXN `[SPEI, OXXO]`; e-mail só no OXXO; OXXO 5 → "Mínimo MX$10" e `blocked`;
  - COP mostra o celular;
  - a chave única já vem escolhida;
  - o canvas mostra as 3 saídas;
  - a config salva bate com o que foi escolhido.
- **Venda aprovada:** "+ Criar novo produto…" cria o produto e já o seleciona; emissor, UTMify e push são salvos.
- **Histórico:** "Sem emissor" → "Reemitir nota" → toast "Emissão reenfileirada" → "Enviando emissão…" e o botão some. No mobile 390 em pt-BR, en e es: `scrollWidth == clientWidth == 390`, também no hub. Nenhum erro de console.

## Pendências / para outras tarefas
- **E2E da T59 (`tests/acceptance/T59/ai-integrations.e2e.ts` ~linhas 336/341):** o teste espera `integrations-empty-category` em Vendas e em Rastreamento, que agora têm cards (efeito esperado do AC-T114-01). Ele precisa de ajuste pelo Tester. Não toquei em `tests/**`.
- **Rótulos traduzidos das saídas no canvas:** hoje o canvas mostra `charge_created` / `payment_approved` (ids crus). Traduzir exige `flow-editor/canvas/**` (T45).
- **Zenith:** fora de escopo. Se voltar, faltam o gateway no editor (matriz §4.6 em minúsculas), o card, o OAuth e o callback `/integrations/zenith/callback` (fica em `routes/integrations/**` e concorre com `LEGACY_REDIRECTS`).
- **Worker do harness:** não processa a fila `invoices` nem a `utmify`. Para E2E de "Enviada ao emissor" seria preciso `configureInvoices`/`configureUtmify` no harness (fora do AC).
- **Realtime `sale.updated`:** se o SSE abriu antes de o slot carregar, o evento não chega a esta aba. Cobri isso com nova consulta a cada 4 s enquanto o status for `pending`. Uma solução geral (registrar tipos depois de abrir a conexão) seria em `lib/realtime.ts`.
- **Notasy/UTMify sem token:** a UI exige o token na criação (ref 19 §3.2); a API aceita sem. Para testar um card "Inativo", crie pela API sem `integration_token`.
