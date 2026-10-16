# KPIs do dashboard de vendas (T55)

As fórmulas abaixo foram **fechadas** por decisão do usuário. O código delas fica em `packages/core/src/dashboard/sales/calc.ts`, e o serviço em `packages/core/src/dashboard/sales/service.ts`. Todo dinheiro é tratado em centavos inteiros (`*_cents`).

## Período e fuso

- `start_date` e `end_date` usam o formato `YYYY-MM-DD` e são **inclusivos**, no fuso da empresa (`companies.time_zone`; o padrão é `America/Sao_Paulo`).
  - Sem as datas, vale o dia de hoje no fuso.
  - O intervalo máximo é de 366 dias.
- Uma venda entra no período quando `crm.sales.status = 'approved'` e o `sold_at` cai em `[início 00:00, fim + 1 dia 00:00)` no fuso.
- **Filtros:** `connection_ids` filtra `sales.connection_id`, e `product_ids` filtra `sales.product_id`.
- **Período anterior:** tem a mesma quantidade de dias e termina no dia anterior ao início.
- **Granularidade:** `hour` quando o intervalo é de 1 dia (24 buckets locais `YYYY-MM-DDTHH:00`); `day` nos demais casos (um bucket `YYYY-MM-DD` por dia). Os buckets vazios aparecem com zero.

## Bases

| Base | Definição |
|---|---|
| `revenue_cents` | Soma de `amount_cents` das vendas do período, em todas as moedas. O detalhe por moeda fica em `revenue_by_currency` |
| `sales_count` | Quantidade de vendas do período |
| `new_leads` | Contatos cuja **primeira** mensagem recebida (`messages.direction = 'inbound'`, no instante `coalesce(sent_at, created_at)`) cai no período. Com `connection_ids`, só contam os chats dessas conexões. O filtro de produto não afeta este número |
| `spend_cents` | Gasto Meta da porta `AdSpendProvider.getSpend(...)`. O padrão é 0; a T101 registra a implementação com `registerAdSpendProvider` |

## Fórmulas

| KPI | Fórmula | Nulo quando |
|---|---|---|
| `avg_ticket_cents` (ticket médio) | `round(revenue_cents ÷ sales_count)` | `sales_count = 0` |
| `conversion_rate` (conversão) | `sales_count ÷ new_leads`, como fração (0,25 = 25%) | `new_leads = 0` |
| `roas` | `revenue_cents ÷ spend_cents` | `spend_cents = 0` |
| `profit_pre_fees_cents` (lucro antes das taxas) | `revenue_cents − spend_cents` | — |
| `expenses_cents` (despesas) | soma das regras vigentes (abaixo) | — |
| `profit_cents` (lucro) | `profit_pre_fees_cents − expenses_cents` | — |

## Regras de despesa (02 §3.5)

Para cada regra de `crm.expense_rules`, calcula-se o **overlap**: a quantidade de dias em comum entre o intervalo pedido e a vigência da regra.

- A vigência vai de `active_from` a `active_to`, inclusivos. Um extremo nulo significa vigência aberta daquele lado.
- Regras sem overlap ficam de fora.

O valor de cada regra é calculado assim:

- **`fixed`:** `amount_cents × overlap ÷ dias do período`, com `day` = 1, `week` = 7 e `month` = 30.
- **`percent`:** `base × percent ÷ 100 × (overlap ÷ dias do intervalo)`, sendo:
  - `percent = 10` significa 10%;
  - a base é `revenue` (faturamento), `spend` (gasto Meta) ou `profit_pre` (lucro antes das taxas);
  - um `profit_pre` negativo vira 0.

Cada regra é arredondada para centavos (`Math.round`) antes da soma. O detalhe por regra sai em `expenses_breakdown`.

**Exemplo:** de 01/06 a 30/06 (30 dias), com faturamento de R$ 600,00 e gasto de R$ 200,00:

- uma regra fixa mensal de R$ 300,00 dá 30000 × 30 ÷ 30 = **30000**;
- uma regra de 10% sobre o faturamento dá 60000 × 0,10 = **6000**.

O resultado é `expenses_cents` = 36000, `profit_pre_fees_cents` = 40000 e `profit_cents` = 4000.

## Tendência

Para cada KPI, `delta = (atual − anterior) ÷ |anterior|`.

- A tendência é `neutral` quando o valor anterior é 0 ou nulo (nesse caso `delta_pct` é nulo) ou quando `|delta| < 0,0005` (0,05%).
- Nos demais casos é `up` ou `down`, com `delta_pct = delta × 100` arredondado em 2 casas.

## Cache

O bloco calculado fica no Redis por 5 minutos. A chave combina empresa, datas, fuso, conexões e produtos (ordenados). Uma chamada com `force_refresh=1` recalcula e regrava a chave. A resposta traz `cached` e `computed_at`.

## Marcos de faturamento (`computeMilestone`)

O faturamento acumulado considera todas as vendas aprovadas. Usa o valor em BRL quando existe; senão, a soma das moedas sem conversão.

Os níveis são estes:

| Nível | Nome | Mínimo |
|---|---|---|
| 1 | Primeira Marca | R$ 50 mil |
| 2 | Tração | R$ 100 mil |
| 3 | Escala | R$ 250 mil |
| 4 | Expansão | R$ 500 mil |
| 5 | Clube do Milhão | R$ 1 milhão |
| 6 | Referência no Mercado | R$ 2 milhões |

O progresso até o próximo nível é `(faturamento − mínimo atual) ÷ (mínimo do próximo − mínimo atual) × 100`, limitado a 0–100.

- Sem nível, o mínimo atual é 0.
- No nível máximo, o progresso é 100 e `max_reached` vale `true`.
- Os textos estão em pt-BR, en-US e es-ES.
