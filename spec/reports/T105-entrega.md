# T105 — Meta: vendas internas × anúncios (CTWA) e ROAS — entrega do Operário

STATUS: DONE
Tempo: ~7 min (00:11 → 00:18) + montagem ~9 min (00:19 → 00:28), 2026-10-17

## Arquivos alterados
- `packages/core/src/meta-ads/sales-join/join.ts` (novo): função pura `joinInternalSales`, `applyInternalMetrics`, `roasOf` e `hasSourceId`.
- `packages/core/src/meta-ads/sales-join/service.ts` (novo): `InternalSalesService` (consulta + cruzamento + ligação), `SalesJoin`, `InternalSalesError` e `INTERNAL_SALE_STATUSES`.
- `packages/core/src/meta-ads/sales-join/index.ts` (novo): barrel.
- `packages/core/src/meta-ads/sales-join/join.unit.test.ts` (novo): 8 testes puros.
- `packages/core/src/meta-ads/sales-join/service.db.unit.test.ts` (novo): 6 testes com Postgres real, Redis real e FakeMetaGraph.
- `packages/core/src/meta-ads/structure/service.ts` (T101, liberado, só aditivo): opção `internalSales?: SalesJoin` em `MetaBundleServiceOptions` e chamada no fim do `build`, antes do `ready`.
- `packages/core/src/meta-ads/structure/metrics.ts` (T101, liberado, só aditivo): campo opcional `roas_internal?: number | null` em `MetaRowMetrics`.
- `packages/core/src/index.ts` (compartilhado, só aditivo): `export * from './meta-ads/sales-join/index'`.
- Montagem (liberada pelo Orquestrador, só aditivo):
  - `apps/api/src/routes/meta-structure/index.ts`: `internalSales: new InternalSalesService({ db, fx: deps.metaFx? })`, a mesma cotação do bundle da rota;
  - `apps/api/src/routes/meta-entities/index.ts`: `internalSales: new InternalSalesService({ db })` no bundle das mutações. Esse bundle usa o fx padrão (`META_FX_RATES`), e o cruzamento usa o mesmo. A linha `bundles:` foi alterada (era uma linha só), sem mudar o resto;
  - `apps/worker/src/jobs/meta-ads/index.ts`: `internalSales: configured.internalSales ?? new InternalSalesService({ db, fx: configured.fx? })` em `metaBundleService()`.
- `apps/worker/src/boot/production-meta-sales.db.unit.test.ts` (novo): montagem como produção (`startProductionWorker` + `createProductionApiDeps`, FakeMetaGraph).
  - O bundle `async=1`, montado pelo job `meta-sync` do worker, traz `purchases_leona`, `purchase_value_leona(_display)` e `roas_internal` nos 3 níveis.
  - Depois, `force_refresh=1` síncrono (montado na rota da API) enxerga uma venda nova.

## Verify
- Resultado: exit 0.
- Comando: `node spec/verify/verify.mjs T105 --role operario --base 9bd202b`.
- Passaram typecheck, lint e test (afetados) de api, worker e core, todas as regras `FORBIDDEN` e o escopo (12 arquivos).

## Contrato público (para o Tester)

### Função pura (sem banco)
```ts
joinInternalSales(rows: JoinRows, aggregates: InternalSaleAggregate[], opts: { displayCurrency: string; fx: FxRate }): JoinResult
```
- Tipos de entrada:
  - `JoinRows = { campaign: BundleRow[]; adset: BundleRow[]; ad: BundleRow[] }`;
  - `InternalSaleAggregate = { sourceId: string; currency: string; count: number; amountCents: number }`.
- Saída `JoinResult`:
  - `ad`, `adset` e `campaign` são `Map<id, InternalMetrics>`;
  - `totals = { purchases_internal, purchase_value_internal, meta_spend_display, roas_internal }`, com ROAS ponderado;
  - `warnings: string[]`.
- `InternalMetrics` tem 4 campos:
  - `purchases_internal: number`;
  - `purchase_value_internal: number`, na moeda de exibição;
  - `purchase_value_internal_account: number`, na moeda da conta de anúncio da linha;
  - `roas_internal: number | null`.
- Regras da função:
  - todo anúncio de `rows.ad` aparece no resultado, com 0 quando não tem venda;
  - conjunto e campanha recebem a soma dos anúncios com o mesmo `adset_id`/`campaign_id`. Se o nível não tem anúncio, vem 0;
  - ROAS de cada nível = valor ÷ `metrics.meta_spend_display` da própria linha, com 2 casas.
- `roasOf(value, spend)`: null se o valor for nulo ou se o gasto for ≤ 0, nulo ou não finito.
- `hasSourceId(s)`: falso para null, vazio ou só espaços.
- `applyInternalMetrics(rows, result)` grava em cada linha:
  - `purchases_leona` ← `purchases_internal`;
  - `purchase_value_leona` ← `purchase_value_internal_account` (moeda da conta, como `meta_spend`);
  - `purchase_value_leona_display` ← `purchase_value_internal` (moeda de exibição);
  - `roas_internal`.

### Serviço (Postgres)
- Construtor: `new InternalSalesService({ db, fx? })`. O `fx` padrão é `fxRatesFromEnv()`.
- Métodos:
  - `aggregates({ companyId, since, until, adIds, timeZone? })` → `InternalSaleAggregate[]`, agrupado por (`source_id`, moeda);
  - `join(companyId, { since, until, displayCurrency, timeZone? }, rows)` → `JoinResult`;
  - `apply(companyId, { since, until, displayCurrency }, rows)` → `{ warnings }`. Grava nas linhas; é a implementação de `SalesJoin`.
- Filtros da consulta:
  - `company_id`;
  - `status in ('approved')`;
  - período `sold_at >= (since::date)::timestamp at time zone tz` e `< (until+1)::timestamp at time zone tz`;
  - `source_id = any(adIds)`, com comparação exata.
  - O fuso vem de `crm.companies.time_zone`, salvo se `timeZone` for passado.
- Erros: `InternalSalesError` com `field` igual a `since`, `until`, `time_zone` ou `company`. Cobre data inválida (inclui 2026-02-30), `since > until`, fuso inválido e empresa inexistente. Nunca há default silencioso.

### Bundle
- Uso: `new MetaBundleService({ ..., internalSales: new InternalSalesService({ db, fx }) })`.
- Efeito no `GET /api/meta/structure-bundle`: as linhas dos 3 níveis vêm com `purchases_leona`, `purchase_value_leona(_display)` e `roas_internal`.
- Os avisos do cruzamento entram em `warnings`. Se o cruzamento falhar, o bundle sai `ready` com o aviso `internal_sales_failed`, as métricas ficam null e o erro vai para o logger.
- Sem a opção, o comportamento é o da T101: `_leona` null e `roas_internal` ausente.

## Como montar cada AC
- **AC-T105-01 (soma por anúncio e período no fuso):**
  - `BundleRow` à mão (ad `id: '111'`) + agregados, ou vendas em `crm.sales` com `source_id = <ad id>`;
  - empresa `America/Sao_Paulo`, venda `sold_at = 2026-10-11T02:30Z` (23:30 local do dia 10);
  - `since = until = 2026-10-10` faz a venda entrar. Na mesma venda numa empresa `UTC`, ela só entra no dia 11;
  - bordas: 03:00Z do dia 10 entra; 02:59Z fica fora; 03:00Z do dia 11 fica fora;
  - vendas `refunded`, `chargeback` e `pending` ficam fora.
- **AC-T105-02 (agregados):** conjunto = Σ anúncios com aquele `adset_id`; campanha = Σ anúncios com aquele `campaign_id`. Contagem e valor batem exatamente com a soma dos valores de anúncio já arredondados. Campanha sem anúncios = 0.
- **AC-T105-03 (ROAS):** gasto `meta_spend_display` 0, negativo ou null dá ROAS null. Exemplo com gasto: 125,50 ÷ 150 = 0.84.
- **AC-T105-04 (sem `source_id`):** `source_id` null, `''` ou `'   '` não entra em nenhum anúncio. Ids com espaço ou prefixo (`' 111'`, `'0111'`) também não casam, porque a comparação é exata.

## Notas
1. **Ligação no bundle:** feita no core (opção a) e **montada** nos três pontos que constroem `MetaBundleService`: as rotas `meta-structure` e `meta-entities` da API e o job `meta-sync` do worker. Não há mais pendência de montagem. A prova está em `apps/worker/src/boot/production-meta-sales.db.unit.test.ts`.
2. **Mapeamento de nomes:** a função devolve `purchases_internal` e `purchase_value_internal` (nomes do AC). A ligação preenche `purchases_leona` ← `purchases_internal`, `purchase_value_leona` ← valor na moeda da conta e `purchase_value_leona_display` ← `purchase_value_internal` (exibição). Campo novo, com marca neutra: `roas_internal`.
3. **Status:** entram só vendas `approved` (`INTERNAL_SALE_STATUSES`). `refunded`, `chargeback` e `pending` ficam fora.
4. **Moeda e cotação:**
   - as vendas estão em centavos, na moeda da venda;
   - conversão por `FxRate` para a moeda de exibição (`BundleParams.displayCurrency`) e para a moeda da conta da linha;
   - venda sem cotação conta em `purchases_internal`, mas fica fora do valor, com aviso `fx_rate_missing:<FROM>-><TO>` para cada par que faltou (exibição e conta).
   - O ROAS usa `meta_spend_display`. Se esse gasto for nulo (falta cotação da conta), o ROAS fica null.
5. **Índice sugerido:** `crm.sales (company_id, source_id, sold_at) where status = 'approved'`. Precisa de `packages/db/src/schema/crm/sales.ts`, que está fora dos Paths. Hoje a consulta usa `sales_company_sold_idx` e filtra `source_id = any(...)`.
6. **Cache:** as métricas internas entram no cache de 5 min do bundle e no "último pronto" de 24 h. Uma venda nova aparece depois de até 5 min, ou na hora com `force_refresh`.
7. **Filtro "ativos":** com `status_filter=active`, anúncios pausados não vêm da Graph. As vendas deles não somam no conjunto nem na campanha, coerente com o AC-02 (soma dos anúncios listados).
8. **Duplicatas:** a pendência T73 (`external_id` bruto) continua de pé. Venda duplicada conta duas vezes.
9. **Para a T106:** usar `purchases_leona`, `purchase_value_leona_display` e `roas_internal` nas colunas `purchases`, `revenue_pair` e `roas_pair`. O ROAS ponderado dos totais é `Σ purchase_value_leona_display ÷ Σ meta_spend_display` (ou use `totals` de `join`).
