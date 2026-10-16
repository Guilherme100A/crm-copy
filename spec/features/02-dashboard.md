# 02 — Dashboard (Vendas e Atendimento)

> Fonte: análise estática do bundle (`_bundle/pretty.js`) + tabela REA (`_rea/rea-endpoints.md`). Endpoints/rotas marcados "(fonte: REA)" constam na tabela do REA; os demais foram extraídos por grep (template strings, que o REA não lista).

## 1. Visão geral

Página inicial do app autenticado. Mostra saudação, resumo da operação (empresa ativa, leads acumulados, selo de faturamento acumulado), banners/anúncios administrativos, avisos de assinatura/trial e um painel de métricas com **duas abas**:

- **Vendas** (`dashboard.sales`): KPIs de faturamento/vendas/ROAS/lucro, gasto Meta Ads + despesas extras (regras de despesa), gráficos de vendas e histórico de vendas (CRUD de venda manual, emissão de NF, exportação CSV).
- **Atendimento** (`dashboard.support`): KPIs de leads novos/atendidos/finalizados/sem resposta/tempo de 1ª resposta, gráfico por período, heatmap dia×hora, tempo de resposta, leads por status por conexão, desempenho por atendente, atendimentos por departamento.

Filtros globais: período (presets + personalizado), conexões (multi), produtos (multi, só Vendas), contas de anúncio Meta (multi, só Vendas), moeda de exibição Meta, grupos de filtros salvos. Comparativo automático com o período anterior de mesma duração.

Contagem de features: **~42** (lista na seção 5).

## 2. Telas e rotas

| Rota | Componente | Permissão | Ref |
|---|---|---|---|
| `/welcome` (fonte: REA) | Página Dashboard (`Umt`) | `dashboard.sales` OU `dashboard.support` | pretty.js:86357, 40908 |
| `/` | Layout raiz; redirecionamento inicial para `/welcome` [INFERIDO] | — | pretty.js:282476 |

| Tela/modal | Descrição | Ref |
|---|---|---|
| Cabeçalho de boas-vindas | "Bom dia/Boa tarde/Boa noite, {nome}!" (<12h / <18h / demais) + linha "Operação {empresa} • Selo • {N} leads acumulados" | pretty.js:85703-85720, 86030-86120 |
| Selo de faturamento | Badge clicável → modal de níveis (ver spec 15) | pretty.js:83221-83360 |
| Banners e anúncios | Do bootstrap; tipos info/warning/error/success; banner fechável | pretty.js:83889-84000 |
| Aviso de assinatura | past_due, canceled, beta migration, inactive etc. | pretty.js:85309 |
| Aviso de trial | Se `subscription_status="trialing"` e `subscription_type="stripe"`; data de fim + "termina em breve" | pretty.js:86130-86175 |
| Barra de filtros (`Bmt`) | Abas, período, conexões, produtos, contas de anúncio, moeda, grupos, limpar, atualizar, despesas | pretty.js:84795-85304 |
| Modal "Taxas e despesas" (`Yut`) | CRUD de regras de despesa | pretty.js:79240-79617 |
| Modal grupo de filtro | Salvar/editar/excluir grupo | pretty.js:84062-84432 |
| Painel Vendas (`bmt`) | KPIs, gráficos, histórico | pretty.js:80633-83200 |
| Modal Nova/Editar venda | Formulário de venda manual | pretty.js:82700-83170 |
| Modal Emitir NF (`umt`) | Escolhe emissor e enfileira emissão | pretty.js:80278-80515 |
| Modal Exportação de vendas (`lmt`) | Progresso do job | pretty.js:79988-80227 |
| Painel Atendimento | `Elt` KPIs, `rit` período+heatmap, `oit` tempo de resposta, `Qct` leads por status, `Zct` por atendente, `sit` por departamento | pretty.js:74033, 72002, 72438, 75486, 75686, 72288 |

## 3. Modelo de dados / campos

### 3.1 Filtros (estado da página)

| Campo | Tipo | Obrig. | Default/validação | Ref |
|---|---|---|---|---|
| `start_date` | `yyyy-MM-dd` | sim | hoje no fuso `current_account.time_zone` | pretty.js:85677 |
| `end_date` | `yyyy-MM-dd` | sim | hoje | idem |
| `connection_ids` | int[] | não | vazio = todas; normaliza para inteiros >0 sem duplicatas | pretty.js:75451 |
| `product_ids` | int[] | não | só aba Vendas | pretty.js:85995 |
| `ad_account_ids` | int[] | não | só contas com `included_in_dashboard=true` | pretty.js:86210 |
| `meta_display_currency` | ISO 4217 | não | conta ou "BRL"; alterar **persiste na conta** | pretty.js:85960 |
| `force_refresh` | bool | não | true em "Atualizar dados"/troca de conta | pretty.js:86190 |
| `include_attendance` | bool | não | false se sem aba Atendimento ou período > 92 dias | pretty.js:85791 |
| `include_response_time` | bool | não | false na chamada do período anterior | pretty.js:85810 |

Serialização: 1 id → `connection_id=N`/`product_id=N`; 2+ → `connection_ids[]`/`product_ids[]` (pretty.js:75467).

Presets (pretty.js:84751): `today`, `yesterday`, `7d` (hoje−6..hoje), `30d` (hoje−29..hoje), `this_month` (dia 1..hoje), `custom` (De/Até).

### 3.2 `GET /dashboard` → `sales` (pretty.js:85648-85676)

| Campo | Tipo | Significado (hint da UI) |
|---|---|---|
| `new_leads` | int | Novos contatos que iniciaram conversa no período |
| `revenue` | number | Faturamento das vendas no período |
| `avg_ticket` | number | Valor médio por venda [INFERIDO revenue/sales_count] |
| `sales_count` | int | Quantidade de vendas |
| `time_granularity` | `hour`/`day`/semana | Granularidade dos gráficos (pretty.js:80594) |
| `sales_over_time[]` | `{bucket_start, revenue, sales_count}` | Série temporal |
| `sales_by_instance[]` | `{instance_name, instance_number, sales_count}` | Por conexão |
| `revenue_by_instance[]` | `{instance_name, instance_number, total_revenue}` | Faturamento por conexão |
| `sales_by_hour[]` | `{hour, sales_count}` | Hora do dia 0-23 |
| `sales_by_product[]` | `{product_id, product_name, sales_count, …}` [INFERIDO] | Produto nulo = "Sem produto" |
| `sales_by_state[]` | `{state, sales_count}` | UF |
| `meta_spend`, `meta_spend_brl`, `meta_spend_usd` | number | Gasto Meta (moeda exibição/BRL/USD) |
| `meta_errors[]` | `{error}` | Erros por conta de anúncio (rate limit detectado) |
| `meta_display_currency`, `meta_suggested_display_currency` | string | Moeda usada/sugerida |
| `meta_fx_available`, `meta_fx_as_of` | bool, datetime | Câmbio |
| `expenses_total` | number | Total de despesas das regras |
| `expenses_breakdown[]` | `{rule_id, name, kind, period, percent_base, value}` | Detalhe por regra |
| `profit` | number | Receita − gasto Meta − despesas |
| `roas` | number | Faturamento ÷ gasto Meta |
| `conversion_rate` | number % | % de leads convertidos em vendas [INFERIDO sales_count/new_leads] |
| `selected_ad_accounts[]` | — | Contas consideradas |

### 3.3 `GET /dashboard` → `attendance` (pretty.js:85634-85647)

| Campo | Tipo | Significado |
|---|---|---|
| `new_leads` | int | Chats **abertos** no período |
| `attended_leads` | int | Desses, com atendente |
| `resolved_leads` | int | Desses, finalizados |
| `unanswered_chats` | int | Abertos sem nenhuma mensagem humana (robô/agente IA não contam); tendência invertida |
| `response_time_seconds` | int/null | Média até a 1ª mensagem humana; chats sem resposta humana ficam fora |
| `first_reply_since` | date/null | Data desde quando a métrica existe |
| `attendance_over_time[]` | série [INFERIDO `{bucket_start,count}`] | Hora de abertura do chat; soma = leads novos |
| `attendance_by_weekday_hour[]` | [INFERIDO `{weekday,hour,count}`] | Heatmap no fuso da conta; destaca pico(s) |
| `attendance_by_hour[]` | — | Não usado na UI [NÃO VERIFICADO] |
| `response_time_over_time[]` | série | Tempo médio de 1ª resposta |
| `leads_by_status_chart[]` | por conexão: `new_leads, attended_leads, resolved_leads` | Barras agrupadas |
| `leads_by_user[]` | `{user_id, user_name, answered_chats, attending_chats, resolved_chats, average_response_seconds}` | "Atendidos"/tempo = 1ªs respostas escritas por ele; "Em atendimento"/"Resolvidos" = chats atribuídos a ele agora (pretty.js:75686) |
| `attendance_by_department[]` | `{department_id, department_name, color, chat_count}` | null = "Sem departamento" (pretty.js:72288) |

### 3.4 `GET /dashboard/bootstrap` (pretty.js:85735-85760)

| Campo | Uso |
|---|---|
| `products.products[]` | Opções de produto |
| `connections[]` | Opções de conexão (exclusão agendada → sufixo "(Excluída)" / "(Excluída · downgrade)") |
| `dashboard_filter_groups[]` | Grupos salvos |
| `ad_accounts.ad_accounts[]` | `{id, name, fb_account_id, included_in_dashboard}` |
| `subscription` | `{subscription_status, subscriptions_enabled, subscription_type, subscription:{trial_ends_at, trial_ending_soon}}` |
| `announcements[]`, `banners[]` | Comunicação administrativa (spec 20) |
| `lifetime_revenue` | `{revenue_brl, revenue_display, display_currency, revenue_by_currency}` → selo (só com `dashboard.sales`) |

### 3.5 Regra de despesa `expense_rule` (pretty.js:79222-79330)

| Campo | Tipo | Obrig. | Validação/default |
|---|---|---|---|
| `name` | string | sim | trim não vazio |
| `kind` | `fixed` \| `percent` | sim | default `fixed` ("Fixo (R$)", "Percentual (%)") |
| `amount` | number | sim | aceita vírgula; ≥ 0 |
| `percent_base` | `revenue` \| `spend` \| `profit_pre` \| null | se percent | default `revenue`; null quando fixed (Faturamento / Gasto Meta / Lucro antes das taxas) |
| `period` | `day` \| `week` \| `month` | sim | default `month` |
| `active_from`, `active_to` | date \| null | não | vigência |

Erro: "Preencha nome e valor válidos." Item listado como "R$ X" ou "X% (base) · periodicidade".

### 3.6 Grupo de filtros `dashboard_filter_group` (pretty.js:84017-84432)

| Campo | Tipo | Regra |
|---|---|---|
| `name` | string | obrigatório; único por conta (trim + case-insensitive) |
| `connection_ids`, `product_ids`, `ad_account_ids` | int[] | o conjunto (escopo) também é único entre grupos |

Não guarda período nem moeda. Lista ordenada por nome (pt-BR).

### 3.7 Venda `sale` (pretty.js:79121-79197, 80675)

| Campo | Tipo | Obrig. | Default/obs. |
|---|---|---|---|
| `instance_name` | string | não | — |
| `instance_number` | string dígitos | não | ex. fictício "5500900000000" |
| `lead_number` | string dígitos | não | telefone do lead |
| `customer_name` | string | não | nome na NF |
| `amount` | number step 0.01 | sim [INFERIDO] | 0 |
| `currency` | ISO | sim | "BRL" (select pesquisável) |
| `sold_at` | `yyyy-MM-ddTHH:mm` | sim | agora |
| `source` | string | — | "manual" na UI; outras origens via integrações [INFERIDO] |
| `source_id` | string | não | ID do anúncio Meta (cruzamento venda↔anúncio) |
| `product_id` | int\|null | não | "Produto (opcional)" |
| `product_name`, `invoice_integration_id`, `invoice_emit_status`, `invoice_last_error` | leitura | — | — |

Tabela: Instância, Nº da Instância, Nº do Lead, Cliente, Produto, ID, Valor, Moeda, Source ID, Data, NF, Ações. Paginação 20 + "carregar mais" (`pagination.has_more`).

## 4. Estados e transições

- **Abas**: `sales` ↔ `attendance`; sem `dashboard.sales` força `attendance` (pretty.js:85703). Chave `tabMetaAds` existe mas não é usada aqui [NÃO VERIFICADO].
- **Carregamento**: skeleton → ok | erro ("Não foi possível carregar os números deste período." + "Tentar novamente") | refreshing. Rate limit Meta: usa cache local se houver, senão aviso.
- **NF da venda**: sem emissor → "Sem emissor"; `pending` "Enviando emissão…"; `succeeded` "Enviada ao emissor" (só HTTP 200, não é NF autorizada); `failed` "Falha na emissão" (+ retry). Botão emitir quando status ∉ {pending, succeeded} (pretty.js:80630).
- **Exportação de vendas**: idle → starting → processing (`rows_written/target_count`) → completed (`output_url`) | failed. Polling 2 s.
- **Tendência**: `{percent, direction up|down|neutral, isPositive}`; neutro se anterior=0 ou |Δ|<0,05%; invertido para métricas "menor é melhor" (pretty.js:73823).

## 5. Ações e regras de negócio (features)

1. Saudação por horário + nome (ou parte local do e-mail) + empresa ativa.
2. Contador de leads acumulados (`welcome_leads_count`), fallback "Será implementado".
3. Selo de faturamento acumulado: 6 níveis (R$ 50 mil, 100 mil, 250 mil, 500 mil, 1 mi, 2 mi), progresso para o próximo; BRL quando disponível, senão soma das moedas (pretty.js:83221-83330).
4. Banners fecháveis e anúncios tipados.
5. Alertas de assinatura e trial.
6. Abas condicionadas a permissões.
7. Período com presets e personalizado (fuso da conta).
8. Multi-conexão com busca e "{n} selecionados".
9. Multi-produto (Vendas).
10. Contas de anúncio com rascunho + Aplicar/Cancelar, Selecionar todas, Limpar, busca por nome/ID.
11. Moeda de exibição Meta salva na conta (invalida cache).
12. Limpar filtros.
13. Atualizar dados (force_refresh) + "Última atualização: {hora}".
14. Grupos de filtros: listar, aplicar, salvar, atualizar quando sujo ("Atualizar "{nome}"" / "Salvar como novo"), renomear, excluir; resumo "N conexões · N produtos · N contas".
15. Comparativo com período anterior de mesma duração (fim anterior = início−1 dia), só se intervalo ≤ 92 dias (pretty.js:73794-73822); atendimento do período anterior em modo resumo.
16. Cache em memória 5 min por chave conta|datas|filtros|moeda|modo (pretty.js:79073).
17. Descarte de respostas fora de ordem.
18. Troca de conta zera produto/contas e força refresh.
19. Atendimento limitado a 92 dias (pretty.js:75042).
20-27. KPIs Vendas: Leads novos, Faturamento, Vendas, ROAS (2 casas), Taxa de conversão, Ticket médio, Lucro (alerta se negativo), Gastos com seletor Total/Meta Ads/Extras.
28. "Taxas e despesas (detalhes)" por regra + total.
29. CRUD de regras de despesa.
30. "Vendas por período" (Valor/Qtd).
31. "Vendas por horário".
32. "Vendas por instância" (Top N + "Ver relatório completo (+N)", filtro de instâncias).
33. "Faturamento por instância".
34. "Vendas por estado".
35. "Performance dos produtos" com filtro.
36. Histórico de vendas: listar, nova venda manual, editar, excluir, exportar CSV assíncrono (bloqueia se 0), emitir/reemitir NF escolhendo emissor com token (auto-seleciona se único; link para `/invoice_integrations` se nenhum).
37. KPIs Atendimento: Leads novos/atendidos/finalizados, Sem resposta, Tempo de resposta (s / min / min s / h / h min), com tendência.
38. "Atendimentos no período" + heatmap dia×hora ("Pico: {dia} {hora} · {n} chats").
39. Tempo de resposta ao longo do tempo.
40. "Leads por status" por conexão.
41. "Desempenho por atendente": Lista/Tabela/Gráfico (pizza agrupa menores em "Outros"), ordenação por nome/atendidos/em atendimento/resolvidos/tempo.
42. "Atendimentos por departamento": Lista/Gráfico com cor do departamento.

i18n sem uso confirmado: conversões/valor por coluna Kanban, `kpiDrilldown.*` (status Novo/Contatado/Qualificado/Convertido/Perdido), satisfação 0-5, "Tempo para iniciar atendimento" [NÃO VERIFICADO].

## 6. Endpoints da API

| Método | Caminho | Payload / query | Ref |
|---|---|---|---|
| GET | `/dashboard/bootstrap` (fonte: REA) | — | pretty.js:85588 |
| GET | `/dashboard` | `start_date, end_date, connection_id\|connection_ids[], product_id\|product_ids[], ad_account_ids[], meta_display_currency, force_refresh, include_attendance, include_response_time` → `{sales, attendance}` | pretty.js:85594 |
| GET | `/account/lifetime_revenue` (fonte: REA) | — | pretty.js:34688 |
| GET/POST | `/dashboard_filter_groups` (fonte: REA) | POST `{dashboard_filter_group:{name, connection_ids, product_ids, ad_account_ids}}` | pretty.js:84018 |
| PATCH/DELETE | `/dashboard_filter_groups/:id` | idem | pretty.js:84031 |
| GET/POST | `/expense_rules` (fonte: REA) | POST `{expense_rule:{name, kind, amount, percent_base, period, active_from, active_to}}` | pretty.js:79199 |
| PUT/DELETE | `/expense_rules/:id` | idem | pretty.js:79210 |
| GET | `/sales` | `start_date, end_date, connection_id(s), instance_number, product_id(s), page, limit` → `{sales[], pagination}` | pretty.js:79122 |
| POST | `/sales` (fonte: REA) | `{sale:{…}}` | pretty.js:79141 |
| PATCH/DELETE | `/sales/:id` | `{sale:{…}}` | pretty.js:79147 |
| POST | `/sales/:id/reemit_invoice` | `{invoice_integration_id?}` | pretty.js:79157 |
| GET/POST | `/sales/exports` (fonte: REA) | POST filtros do histórico → `{id,status}` | pretty.js:79165 |
| GET | `/sales/exports/:id?t=<ts>` | → `{status, progress, row_count, output_url, error}` | pretty.js:79190 |
| GET | `/invoice_integrations` | emissores (`token_configured`, `name`, `company_name`) | pretty.js:80249 |
| PUT | conta | `{meta_ads_display_currency}` | pretty.js:85963 |

## 7. Eventos realtime

| Canal | Evento | Uso | Ref |
|---|---|---|---|
| `AccountNotificationsChannel` `{account_id}` | exportação de vendas (tipo [NÃO VERIFICADO]) | Atualiza modal de exportação | pretty.js:80227-80247 |

Métricas não são atualizadas por realtime.

## 8. Permissões

| Chave | Efeito |
|---|---|
| `dashboard.sales` | Aba Vendas, selo, filtros de produto/contas/moeda, despesas |
| `dashboard.support` | Aba Atendimento |
| nenhuma | `/welcome` bloqueada |

Owner/Admin têm ambas por padrão; Member não (pretty.js:36185-36230); customizável por membro.

## 9. Integrações externas

Meta Ads (gasto, contas, câmbio, rate limit); emissores de NF; origens externas de venda [INFERIDO].

## 10. Lacunas

- [INFERIDO] Fórmulas de `avg_ticket`, `conversion_rate`, `profit` e rateio de despesas por período (backend).
- [NÃO VERIFICADO] Formato dos itens das séries de atendimento e de `sales_by_product`.
- [NÃO VERIFICADO] `type` do evento realtime de exportação de vendas.
- [NÃO VERIFICADO] Features só em i18n: drill-down de KPI, CSAT, conversões por coluna.
- [INFERIDO] `new_leads` tem bases diferentes nas abas (contatos novos vs chats abertos).

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo. Os modais foram abertos e fechados com Escape/Cancelar.

- **Cabeçalho:** saudação conforme a hora do dia, com emoji, e linha "Operação <empresa> • N leads acumulados". Botão "Trilha do Predador" (ver spec 15). Banner promocional que pode ser fechado.
- **Abas:** Vendas | Atendimento.
- **Filtros da aba Vendas:**
  - Período: Hoje, Ontem, Últimos 7 dias, Últimos 30 dias, Este mês, Personalizado.
  - "Todas as conexões" e "Todos os produtos" (seleção múltipla).
  - "Todas as contas": popover "Contas de anúncios" com busca, Selecionar todas / Limpar, itens "nome · act_<id>", e Cancelar / Aplicar. O texto avisa que a escolha atualiza as vendas e o painel Facebook.
  - Moeda: combobox com a lista ISO 4217 completa no formato "COD · Nome", padrão BRL.
  - Ícones: Limpar filtros, Salvar grupo de filtro (modal com "Nome do grupo" e o resumo dos filtros), Atualizar dados, Configurar taxas e despesas.
- **Modal "Taxas e despesas":**
  - Nova regra: Nome, Tipo (ex. "Fixo (R$)"), Valor (R$), Periodicidade (ex. "Por mês"), Vigência inicial, Vigência final, botão "Adicionar".
  - Lista "Regras cadastradas".
- **KPIs da aba Vendas:**
  - Cards: Leads novos, Faturamento, Vendas, ROAS, Taxa de Conversão, Ticket médio, Lucro, Gasto Meta (Ad).
  - Cada card mostra a variação em % e tem um ícone de info.
  - Botão "Filtrar" com Total | Meta Ads | Extras.
- **Gráficos da aba Vendas:**
  - Vendas por período, com toggle Valor/Qtd e eixo por hora quando o período é de 1 dia.
  - Vendas por horário.
  - Vendas por instância e Faturamento por instância.
  - Vendas por estado ("Desconhecido" quando não há UF).
  - Performance dos produtos, com toggle Valor/Qtd e filtro.
- **Histórico de vendas:**
  - Botões "Exportar CSV" e "Nova venda".
  - Colunas: INSTÂNCIA, Nº DA INSTÂNCIA, Nº DO LEAD, CLIENTE (NOME), PRODUTO, ID, VALOR, MOEDA, SOURCE ID, DATA, NF (ex. "Sem emissor"), AÇÕES.
  - Ações por linha: nota fiscal, editar, excluir.
  - Rolagem infinita, terminando em "Fim do histórico". Há vendas em várias moedas.
- **Modal "Nova venda":**
  - Campos: Instância, Número da instância, Número do lead, Cliente (nome) — "nome exibido na NF", Valor (default 0), Moeda (default BRL), Produto (opcional, "Sem produto"), Source ID, Data da venda (datetime, default agora).
  - Botões Cancelar / Salvar venda.
- **Aba Atendimento:**
  - Filtros: período e conexões.
  - KPIs: Leads novos, Leads atendidos, Leads finalizados, Tempo de resposta ("X h Y min"), Sem resposta.
  - Gráfico "Atendimentos no período".
  - Heatmap "Atendimentos por hora": dia da semana × hora 00–23, legenda Menos/Mais e "Pico de N chats".
  - Gráfico "Tempo de resposta": média da 1ª mensagem enviada por um atendente.
  - "Leads por status" por conexão: novos, atendidos e finalizados.
  - "Desempenho por atendente" (Tabela | Gráfico) com as colunas Atendente, Atendidos, Em atendimento, Resolvidos e Tempo de resposta.
- **Mobile:** barra inferior com Início, Chats ao vivo, Kanban, Fluxos e Mais.
