# T87 — Entrega do Operário (UI dashboard: histórico, atendimento e marcos)

- **Status:** DONE · branch `task/T87` · base `0bb9d1a`
- **Verify:** exit 0 — `node spec/verify/verify.mjs T87 --role operario --base 0bb9d1a` (typecheck, lint, test, i18n:check, build, regras FORBIDDEN e escopo com 20 arquivos)
- **Tempo:** 23:51 → 00:07 (2026-10-16/17), ~16 min de relógio, contando o harness e a conferência no navegador.
- **Marcos:** já entregues pela T78 (`dashboard-milestone*`). Nenhum AC da T87 trata deles, então não foram refeitos.

## Arquivos
| Arquivo | O quê |
|---|---|
| `apps/web/src/features/dashboard/tabs.ts` | **aditivo (liberado):** `DashboardTabProps` ganhou os campos opcionais `period`, `timeZone`, `search`, `ready` e `renderFilters(bar)`. Tipo `DashboardFiltersSlot { computedAt, refreshing, onRefresh }`. O id do slot passou a ser `'attendance' \| 'history'` (`DashboardSlotId`). |
| `apps/web/src/features/dashboard/dashboard-page.tsx` | **aditivo (liberado):** importa de forma estática `dashboard-attendance/register` e `dashboard-history/register`. Calcula `period = periodOf(search, tz)`. Monta o slot `history` abaixo do `SalesPanel`. Passa ao Atendimento período, fuso, `ready` e `renderFilters`, que é a **mesma `FiltersBar` da T78** ligada ao "Atualizar" e à "Última atualização" do Atendimento. |
| `features/dashboard-attendance/{api,logic,attendance-panel,register}.ts(x)` + `attendance.unit.test.ts` | Aba Atendimento |
| `features/dashboard-history/{api,logic,slots,sale-modal,history-panel,register}.ts(x)` + `history.unit.test.ts` | Histórico de vendas, modal "Nova venda" e slots para a T114 |
| `i18n/{pt-BR,en,es}/dashboard-attendance.json`, `i18n/{pt-BR,en,es}/dashboard-history.json` | Textos nas 3 línguas |

## Decisões
- **Venda criada vai para o topo (AC-T87-01):** depois do 201, `prependSale` insere a venda no início da 1ª página do cache da lista, sem refetch. Se ela já estava em alguma página, é removida de lá antes (upsert). Isso vale mesmo quando o `sold_at` é antigo e a ordem do servidor a poria mais abaixo. A ordem real volta na próxima recarga completa da lista (staleTime 30 s, foco ou F5). `flattenSales` deduplica por id entre as páginas, porque a paginação é por deslocamento. O dashboard de vendas é invalidado (`dashboardKey`).
- **Exportar CSV:** o botão fica sempre desabilitado. O motivo aparece num texto visível (`dashboard-history-export-reason`, ligado por `aria-describedby`) e no atributo `data-reason`: com 0 linhas é `empty` ("Nenhuma venda para exportar."); com linhas é `soon` ("Exportação de vendas em breve."). Não há CSV gerado no cliente, como decidido pelo Orquestrador.
- **Limite de fatias:** `MAX_SLICES = 6` (exportado em `dashboard-attendance/logic.ts`). Acima dele, `groupSlices` mantém as 5 maiores e soma o resto numa fatia "Outros" (`key: 'others'`). Fatias com valor 0 saem antes. A mesma regra vale para a pizza de departamentos (AC-T87-03) e para a de atendentes (02 §5 nº 41).
- **92 dias (AC-T87-04):** `ATTENDANCE_MAX_DAYS = 92` foi replicado no cliente. Acima disso o painel mostra o aviso e **não chama a API** (no navegador: 0 requisições). Se o 422 chegar mesmo assim (`fields[].path === 'end_date'`), mostra o mesmo aviso. A consulta tem `retry: false`.
- **Filtros na aba Atendimento:** reuso da `FiltersBar` da T78, sem editar `filters-bar.tsx`, então os testids `dashboard-preset-*`, `dashboard-custom-*`, `dashboard-connections`, `dashboard-refresh` e `dashboard-last-updated` são os mesmos nas duas abas. O Atendimento usa só o período e as conexões. Os seletores de produtos e grupos continuam visíveis e não têm efeito nesta aba (limitação de não poder editar a barra).
- **Histórico segue os filtros do dashboard:** período, conexões e produtos vão para `GET /api/sales` com `skip_total=1`, 20 por página. Ordem do servidor: `sold_at desc, id desc`.
- **Tempos:** `45 s`, `5 min`, `5 min 30 s`, `2 h`, `2 h 15 min`; `null` vira `—`.
- **Ordenação por atendente:** colunas nome, atendidos, em atendimento, resolvidos e tempo. No primeiro clique, nome e tempo começam crescentes e os demais decrescentes. Clicar de novo inverte. Tempo nulo fica sempre no fim. O padrão é atendidos decrescente.
- **Data da venda:** o `datetime-local` é interpretado no **fuso da empresa** e enviado como ISO UTC (`zonedToIso`). O padrão do campo é "agora" nesse fuso.
- **Realtime `sale.recorded`:** não foi ligado ao histórico. Uma invalidação reordenaria a lista e tiraria do topo a venda recém-criada.

## Slot para a T114 (NF / "Reemitir")
Segue o mesmo padrão dos slots do chat da T69. A T114 cria `apps/web/src/features/sale-invoice/sale-history-slot.tsx` com:
```ts
import type { SaleHistorySlot } from '@/features/dashboard-history/slots' // só import type
export const saleHistorySlot: SaleHistorySlot = {
  columns: [{ id: 'nf', header: () => 'NF', cell: (sale) => <InvoiceStatus sale={sale} />, order: 1 }],
  actions: [{ id: 'reissue', render: (sale) => <ReissueButton sale={sale} /> }],
}
```
O histórico descobre o arquivo por `import.meta.glob('../*/sale-history-slot.tsx', { eager: true })`. Também existem `registerSaleColumn` e `registerSaleAction`. A célula da coluna recebe o testid `dashboard-history-item-<id da coluna>-<saleId>`. A coluna "Ações" só aparece quando há alguma ação registrada. Hoje não há coluna NF; o texto "Sem emissor" fica a cargo da T114.

## Testids (contrato com o Tester)
**Histórico** (aba Vendas, abaixo dos gráficos):
- `dashboard-history`, `dashboard-history-table`, `dashboard-history-loading`, `dashboard-history-empty`, `dashboard-history-empty-new`, `dashboard-history-error`, `dashboard-history-retry`
- Linha: `dashboard-history-item-${id}` (`<tr>`). Células: `dashboard-history-item-{instance-name|instance-number|lead-number|customer-name|product|id|amount|currency|source-id|sold-at}-${id}`
- Rolagem: `dashboard-history-sentinel`, `dashboard-history-loading-more`, `dashboard-history-more` (botão "Carregar mais", reserva da sentinela), `dashboard-history-end` ("Fim do histórico")
- `dashboard-history-export` (sempre `disabled`, com `data-reason` = `empty|soon`), `dashboard-history-export-reason`
- `dashboard-history-new` (só com `sales.edit`) e modal `dashboard-history-modal`
- Campos: `dashboard-history-form-{instance-name|instance-number|lead-number|customer-name|amount|currency|product|source-id|sold-at}`. Botões e erro: `dashboard-history-form-save`, `dashboard-history-form-cancel`, `dashboard-history-form-error`

**Atendimento** (dentro de `dashboard-attendance`, da T78):
- Estados: `attendance`, `attendance-loading`, `attendance-error`, `attendance-retry`, `attendance-range-warning` (`role=alert`)
- KPIs: `attendance-kpi-{new_leads|attended_leads|resolved_leads|response_time_seconds|unanswered_chats}`, com `-value` e `-trend` (`data-trend`, `data-good`)
- Gráficos: `attendance-chart-over-time`, `attendance-chart-response-time`, `attendance-chart-by-status`, cada um com `-empty` quando vazio
- Mapa de calor: `attendance-heatmap`; células `attendance-heat-cell-${weekday}-${hour}` (0 = domingo; `data-count`, `data-peak="true"` no pico); pico em `attendance-peak` ("Pico: terça 14h · 30 chats", com `data-weekday`, `data-hour` e `data-count`)
- Atendentes: `attendance-users`, `attendance-users-view` (`-table`/`-chart`, `data-value`), `attendance-users-table`, `attendance-users-sort-{name|answered|attending|resolved|time}` (o `th` tem `aria-sort`), linhas `attendance-user-item-${user_id|removed}` e células `attendance-user-item-{name|answered|attending|resolved|time}-${id}`, fatias `attendance-users-slice-${key}`
- Departamentos: `attendance-departments`, `attendance-departments-view` (`-chart` é o padrão, `-list`), fatias da legenda `attendance-department-slice-${department_id|none|others}` (`data-value`), itens da lista `attendance-department-item-${department_id|none}`

## Dados no harness (E2E)
- O seed não tem vendas. Crie como owner: `POST /api/sales {amount_cents, currency, sold_at, customer_name}`. **Cuidado com a meia-noite de São Paulo:** o histórico filtra pelo preset "Hoje" no fuso da empresa. Vendas com `sold_at = agora − N minutos` podem cair no dia anterior; use segundos de diferença ou o preset 7d. Com 25 vendas: 20 linhas, e depois de rolar até a sentinela, 25 linhas e "Fim do histórico".
- Atendimento com dados: intercepte `GET /api/dashboard/attendance` com `page.route`. Para AC-T87-03, use 8 departamentos: aparecem 5 fatias + `attendance-department-slice-others`.
- AC-T87-04: `/welcome?tab=attendance&preset=custom&start_date=2026-01-01&end_date=2026-06-30` mostra `attendance-range-warning` e nenhuma requisição ao atendimento.
- Conferido no navegador (vite preview do harness, desktop 1366 e mobile 390): sem erros de console e sem rolagem horizontal da página. No mobile, a tabela de atendentes e o mapa de calor rolam dentro do próprio card.

## Pendências / para outras tarefas
- **Exportação de vendas** (job `registerExportKind` de vendas no core/worker + modal de progresso) não existe. Quando existir, troque `exportState` e ligue o botão.
- **Editar/excluir venda** no histórico (as rotas `PATCH`/`DELETE /api/sales/:id` existem) não está nos ACs e ficou de fora.
- **T114:** coluna NF ("Sem emissor") e "Reemitir" pelo slot `sale-history-slot.tsx`.
- **KPIs de vendas logo depois de criar uma venda:** o `GET /api/dashboard` tem cache de 5 min no servidor (T55). A invalidação no cliente refaz a consulta, mas os números só mudam depois do cache ou com "Atualizar" (`force_refresh`).
- Produtos e grupos da `FiltersBar` aparecem na aba Atendimento sem efeito. Para escondê-los, a `FiltersBar` (T78) precisaria de uma prop de modo.
