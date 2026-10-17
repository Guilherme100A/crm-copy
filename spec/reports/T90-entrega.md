# T90 — UI fontes de venda e produtos · entrega do operário

```text
DONE T90 operario
STATUS: DONE
Verify: 0 (node spec/verify/verify.mjs T90 --role operario --base f3d19ba — APROVADO 23:49, 20 arquivos no escopo)
```

Tempo: início 23:34 (2026-10-16), fim 23:50 (~16 min).

## Arquivos alterados
- `apps/web/src/features/settings-products/` (novo): `rules.ts`, `api.ts`, `product-dialog.tsx`, `tab.tsx`, `settings-products.unit.test.ts`
- `apps/web/src/features/settings-sale-sources/` (novo): `rules.ts`, `api.ts`, `ui.tsx`, `tab.tsx`, `detail.tsx`, `events.tsx`, `settings-sale-sources.unit.test.ts`
- `apps/web/src/i18n/{pt-BR,en,es}/settings-products.json` e `settings-sale-sources.json` (novos)
- `apps/web/src/features/settings/tabs.ts` (compartilhado, +3 linhas aditivas): abas `products` e `sale_sources`, grupo `integrations`
- `scripts/e2e/api.ts` (liberado, +4 linhas aditivas): `configureInboundSales({ db, publisher, logger })` no worker in-process do harness

## Onde ficam as telas
- Produtos: `/settings?tab=products` (permissão `settings.products.view`; editar/excluir pedem `settings.products.edit|delete`).
- Fontes de venda: `/settings?tab=sale_sources` (permissão `settings.integrations.view`; editar, testar, rotacionar e reprocessar pedem `settings.integrations.edit`; excluir pede `.delete`).
- O detalhe da fonte abre no **estado local** da aba (não muda a URL; recarregar volta para a lista). Para abrir: clique em `sale-sources-item-name-<id>` ou `sale-sources-item-edit-<id>`. Nenhum search param novo (nada de `?status=`).
- Mobile (< 1024 px): selecione a aba pelo `settings-tab-select` → `settings-tab-option-products` / `settings-tab-option-sale_sources`.

## Testids

### Produtos (prefixo `products`)
| O quê | testid |
|---|---|
| Página | `page-products` |
| Novo | `products-new` |
| Busca (servidor, debounce de 300 ms) | `products-search` |
| Tabela (desktop) / cartões (mobile) | `products-table` / `products-cards` |
| Linha/cartão | `products-item-<id>` |
| Células | `products-item-name-<id>`, `products-item-currency-<id>`, `products-item-min-<id>`, `products-item-max-<id>`, `products-item-fallback-<id>`, `products-item-id-<id>` (id interno) |
| Editar / excluir | `products-item-edit-<id>` / `products-item-delete-<id>` |
| Confirmação de exclusão | `products-confirm`, `products-confirm-ok`, `products-confirm-cancel` |
| Vazio | `products-empty` (sem busca: "Nenhum produto cadastrado."; com busca: "Nenhum produto encontrado.") |
| Modal | `products-editor`, `products-save`, `products-cancel`, erro geral `products-error` |
| Campos | `products-name`, `products-currency` (`<select>`, valor = código ISO, rótulo "BRL · Real brasileiro"), `products-min`, `products-max`, `products-fallback` (aceitam "12,50") |
| Erros por campo | `products-name-error`, `products-currency-error`, `products-min-error`, `products-max-error`, `products-fallback-error` |
| Ajuda da regra de preço | `products-price-help`; simulador `products-simulate` → `products-simulate-result` (`data-cents` = valor usado) |

Mensagens (pt-BR), iguais às do servidor: "O nome precisa ter de 2 a 255 caracteres", "Moeda ISO 4217 inválida", "O preço máximo deve ser maior ou igual ao mínimo" (em `products-max-error`), "O valor padrão deve ser maior que zero" (em `products-fallback-error`). Valor mal formatado: "Informe um valor válido (ex.: 12,50)". A validação do cliente bloqueia o envio; se o servidor devolver 422 `details.fields`, a mensagem dele aparece no campo correspondente.

### Fontes de venda: lista (prefixo `sale-sources`)
| O quê | testid |
|---|---|
| Página | `page-sale-sources` |
| Nova | `sale-sources-new` |
| Tabela / cartões | `sale-sources-table` / `sale-sources-cards`; linha `sale-sources-item-<id>` |
| Células | `sale-sources-item-name-<id>` (botão: abre o detalhe), `sale-sources-item-active-<id>` (`data-active`), `sale-sources-item-hmac-<id>` (`data-configured`) |
| Abrir / excluir | `sale-sources-item-edit-<id>` / `sale-sources-item-delete-<id>` |
| Confirmação de exclusão | `sale-sources-delete-confirm`, `-confirm-ok`, `-confirm-cancel` |
| Vazio | `sale-sources-empty` |
| Modal de criação | `sale-sources-editor`, `sale-sources-create-name`, `sale-sources-create-name-error`, `sale-sources-create-hmac` (checkbox, marcado por padrão), `sale-sources-save`, `sale-sources-cancel`, `sale-sources-error` |

Ao criar, a fonte já vem com um mapeamento inicial (`external_id=$.id`, `status=$.status`, `amount=$.amount`, `phone=$.customer.phone`) e o detalhe abre direto.

### Fontes de venda: detalhe
| O quê | testid |
|---|---|
| Container / voltar | `sale-sources-detail` / `sale-sources-back` |
| Título / salvar tudo | `sale-sources-detail-name` / `sale-sources-save` (nome, ativa, unidade, mapeamento e mapa de status), erro `sale-sources-save-error`, toast `sale-sources-saved` |
| Dados gerais | `sale-sources-name` (+ `sale-sources-name-error`), `sale-sources-amount-unit` (`decimal`/`cents`), `sale-sources-active` |
| URL | seção `sale-sources-url-section`, `sale-sources-url` (input readonly com `public_url`), `sale-sources-url-copy` (toast `sale-sources-url-copied`) |
| Rotacionar token | `sale-sources-rotate` → `sale-sources-rotate-confirm` (dialog), `sale-sources-rotate-secret` (checkbox "gerar também novo segredo", marcado), `sale-sources-rotate-confirm-ok`, `sale-sources-rotate-confirm-cancel`; toast `sale-sources-rotated` |
| Segredo | seção `sale-sources-secret-section`, `sale-sources-secret-status` (`data-configured`), quadro único `sale-sources-secret-reveal` com `sale-sources-secret` (valor, 64 hex) + `sale-sources-secret-copy` (toast `sale-sources-secret-copied`), `sale-sources-secret-signature` (HMAC da amostra colada), `sale-sources-secret-hide` |
| Trocar/remover segredo | `sale-sources-secret-generate` (sem segredo: gera direto; com segredo: pede confirmação), `sale-sources-secret-remove`; dialog `sale-sources-secret-confirm`, `-confirm-ok`, `-confirm-cancel` |
| Mapeamento | seção `sale-sources-mapping`; `sale-sources-map-<campo>` para os 17 campos do `SaleEvent`; erro `sale-sources-map-error-<campo>` (obrigatório vazio / JSONPath inválido) |
| Produto (id interno) | `sale-sources-product-helper`, `sale-sources-product-select` (option value = `products.id`), `sale-sources-product-id` + `sale-sources-product-id-copy` |
| Mapa de status | seção `sale-sources-status-map`, `sale-sources-status-add`, `sale-sources-status-raw-<i>`, `sale-sources-status-value-<i>`, `sale-sources-status-remove-<i>` |
| Amostra | seção `sale-sources-sample-section`, `sale-sources-sample` (textarea), erro `sale-sources-sample-error` (JSON inválido, no cliente ou 422 do servidor), `sale-sources-sample-target` (campo a preencher), árvore `sale-sources-json-tree` com folhas `sale-sources-json-node-<JSONPath>` (ex.: `sale-sources-json-node-$.customer.phone`) |
| Testar (dry-run com o rascunho atual, não salvo) | `sale-sources-test` → `sale-sources-test-result` (`data-ok="true|false"`) |
| Resultado ok | `sale-sources-test-event` (JSON do `SaleEvent`), `sale-sources-test-event-external_id`, `-status` (`data-status`), `-amount` (`data-cents`), `-phone`, `-product` (nome do produto quando o id bate) |
| Resultado com falha | `sale-sources-test-missing`, `sale-sources-test-missing-<campo>`, `sale-sources-test-errors`; erro HTTP `sale-sources-test-error` |

### Log de eventos (prefixo `sale-events`)
| O quê | testid |
|---|---|
| Seção | `sale-events` |
| Filtro de status | `sale-events-filter` (`<select>`: `""`, `pending`, `processed`, `failed`; filtra no servidor, estado local) |
| Total / atualizar | `sale-events-total` / `sale-events-refresh` |
| Lista / item | `sale-events-list` / `sale-events-item-<id>` (`data-status`) |
| Campos do item | `sale-events-item-status-<id>`, `sale-events-item-error-<id>`, `sale-events-item-toggle-<id>` → `sale-events-item-detail-<id>` (tentativas, campos faltando, `SaleEvent`, `sale-events-item-body-<id>`) |
| Reprocessar | `sale-events-item-replay-<id>` (toast `sale-events-replayed`) |
| Vazio | `sale-events-empty` ("Nenhum evento recebido." / com filtro: "Nenhum evento com este status.") |
| Paginação (20 por página) | `sale-events-prev`, `sale-events-page`, `sale-events-next` |

Atualização: sem realtime. A lista refaz a busca a cada 2 s enquanto houver `pending` na página e por até 30 s depois de um replay. Com o filtro `failed`, o evento reprocessado some enquanto está pendente e volta quando falha de novo.

## Como gerar eventos de venda no harness (AC-T90-03)
O harness agora processa os eventos (`configureInboundSales` em `scripts/e2e/api.ts`), então `processed` e `failed` são reais e não precisam de `page.route`.
1. Como owner, crie a fonte pela UI ou pela API: `POST /api/sale-sources { name, mapping: { external_id: '$.id', status: '$.status', amount: '$.amount', phone: '$.customer.phone' } }`. Sem `hmac_secret`, nenhuma assinatura é exigida.
2. A URL de recebimento é o `public_url`/`token` do DTO. No harness, o `public_url` usa `API_PUBLIC_URL` (`http://localhost:3000`), que não é a porta do harness: envie para `<api_url do test-results/e2e-server.json>/api/hooks/sales/<token>`.
3. Processado: `POST` com `{"id":"ord-1","status":"paid","amount":"199,90","customer":{"phone":"+5511999990001"}}` → 202 e o evento vira `processed` em cerca de 1 s.
4. Falha: o mesmo corpo sem `customer.phone` → 202 e o evento vira `failed` com `error = missing_path:$.customer.phone`.
5. Com segredo: envie o header `x-signature` = HMAC-SHA256 hex do corpo cru com o segredo. O segredo é o valor de `sale-sources-secret`, ou o que você mandou em `hmac_secret`. A UI mostra a assinatura da amostra colada em `sale-sources-secret-signature`. Sem assinatura, o recebimento responde 401.
6. Reprocessar: `sale-events-item-replay-<id>` → 202. O evento passa por `pending` e o processador relê o mapeamento atual. Se o mapeamento continuar sem telefone, ele volta a `failed` com `attempts` = 2. Se o phone for corrigido no mapeamento e salvo, vira `processed`.
7. Rotação: a URL antiga passa a responder 404.

Tudo isso rodou no meu smoke com Playwright contra o harness deste worktree (desktop 1366 px e mobile 390 px): erros de faixa e fallback, criação, cópia da URL e do segredo (clipboard conferido), assinatura igual ao HMAC do Node, dry-run com `amount_cents=19990` e produto resolvido pelo id interno, eventos reais `processed`/`failed`, filtro, replay (`failed` com `attempts=2`), rotação (URL antiga 404 e segredo novo) e `scrollWidth == clientWidth == 390` na lista de produtos, na lista de fontes e no detalhe com o log aberto.

## Notas
- **Segredo HMAC (AC-T90-02):** a UI gera um segredo de 32 bytes aleatórios (`crypto.getRandomValues`, 64 hex) e o envia em `hmac_secret` ao criar (checkbox marcado por padrão), em "Gerar novo segredo" e na rotação do token (checkbox marcado por padrão). O segredo aparece uma única vez, com botão de copiar; ao sair do detalhe, some e passa a aparecer só "Segredo configurado". A API aceitou o segredo do cliente, então o fallback (token como segredo) não foi necessário.
- **Rota/aba:** duas abas no hub (`products`, `sale_sources`), grupo Integrações, uma linha cada em `tabs.ts`. O detalhe da fonte fica em estado local. Nenhum arquivo em `routes/`, nenhum search param novo, nada em `catalog.ts` (categoria Vendas fica para a T114).
- **E2E dos eventos:** `configureInboundSales` foi ligado no harness sem `capiEnqueue`, para que nada saia para a Meta. Isso dispensa o `page.route` em `/events`.
- **`/products` legado:** não mexi. Existe em `ROUTE_PERMISSIONS`, mas não há redirect para `/settings?tab=products`. Se o Orquestrador quiser o redirect, a mudança é em `app/access.ts`, fora dos Paths.
- **Produto no mapeamento:** o seletor oferece o **id interno** (`products.id`) e o mostra para copiar. O JSONPath não aceita literal, então a plataforma precisa enviar esse id no campo mapeado em `product_id`. No dry-run, o `product_id` resolvido mostra o nome do produto.
- **Reuso pela T114:** `features/settings-products/product-dialog.tsx` exporta `ProductDialog({ initial, onClose, onSaved })`, que invalida `PRODUCTS_KEY` e chama `onSaved` com o produto gravado. `rules.ts` exporta `validateProduct`, `parseMoney`, `toProductInput`, `resolvePrice`, `currencyLabel` etc., todas com teste unitário.
- **Reuso de kit:** importo `features/settings-quick-replies/kit.tsx` (só leitura): DataList, FormDialog, Field, usePerms, serverMessage. Os rótulos comuns do kit (Salvar/Cancelar/Editar) vêm do i18n `settings-quick-replies`.
- **Pendências para outras tarefas:**
  - redirect `/products` → `/settings?tab=products` (access.ts, se desejado);
  - cards de vendas no catálogo de integrações (T114);
  - NF/UTMify nas vendas de fonte de venda (T112/T113, já listadas no STATUS);
  - o `public_url` usa `API_PUBLIC_URL`, que no harness aponta para `localhost:3000` (só informativo para o Tester).
