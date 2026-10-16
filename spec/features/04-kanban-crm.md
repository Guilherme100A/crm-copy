# 04 — Kanban / CRMs

> Fonte: bundle (`_bundle/pretty.js`) + REA (`_rea/rea-endpoints.md`). "(fonte: REA)" = presente na tabela do REA; demais via grep (template strings).

## 1. Visão geral

Funis de venda visuais. Cada conta tem N **CRMs** (chamados "Kanbans" na UI). Cada CRM tem **colunas** (etapas do funil, ordenadas, com cor e flag de "coluna de conversão") e **cards**. Um card representa um **chat** (conversa WhatsApp) dentro do funil — o card é criado escolhendo um chat existente que ainda não tem card naquele CRM. Cards e colunas são arrastáveis (drag & drop). Há filtros de cards, estatísticas do funil (taxa de conversão por etapa, valores) e exportação CSV assíncrona.

Contagem de features: **~30**.

## 2. Telas e rotas

| Rota | Componente | Permissão | Ref |
|---|---|---|---|
| `/crms` (fonte: REA) | Lista de Kanbans (`xAt`→`gAt`) | `kanban.view` | pretty.js:133761, 132878 |
| `/crms/:id` (fonte: REA) | Quadro Kanban (`vAt`) | `kanban.view` | pretty.js:133762, 133220 |

| Tela/modal | Descrição | Ref |
|---|---|---|
| Lista: visão geral | 4 indicadores: Quadros, Cards no pipeline, Valor no pipeline, Conversão média | pretty.js:132905-132930 |
| Lista: grade de cards de Kanban (`Kkt`) | Por CRM: nome, "{n} colunas", mini-funil colorido com nomes das etapas, métricas (cards, valor total, convertidos, % conversão com barra), "Atualizado {data}", botões editar/excluir, tile "Novo quadro" | pretty.js:123276-123560 |
| Lista: busca | "Buscar kanban..." (filtro local por nome, case-insensitive); ordenação por `updated_at` desc | pretty.js:132930-132940 |
| Modal Novo/Editar Kanban (`Ykt`) | Campo nome + pré-visualização com 3 colunas exemplo (Novo, Qualificação, Ganho) | pretty.js:123561-123709 |
| Modal Excluir Kanban | Confirmação nomeada | i18n `listDeleteConfirmNamed` |
| Quadro: cabeçalho | Breadcrumb CRMs › nome; botões Filtros, Ver/Ocultar estatísticas, Exportar leads em planilha, Adicionar coluna | pretty.js:133430-133540 |
| Quadro: painel de filtros | Responsável (desabilitado "Será implementado"), Etapa, Atualizado de/até, Aplicar/Limpar, Etiquetas (toggle chips; aplica na hora) | pretty.js:133560-133700 |
| Quadro: estatísticas (`hAt`) | Funil com etapas, totais | pretty.js:132479-132878 |
| Quadro: board (`pAt`) | Colunas horizontais arrastáveis + cards arrastáveis + scroll horizontal com barra de navegação | pretty.js:132067-132471 |
| Coluna (`cAt`) | Cabeçalho com cor, contador, valor somado, menu de ações, lista de cards com "Carregar mais", "Arraste cards aqui", botão "Adicionar card" | pretty.js:131056-131446 |
| Card (`lAt`) | Avatar (foto ou inicial), badge de não lidas (9+), nome do cliente, telefone formatado, etiquetas (placeholder "Será implementado"), prévia da última mensagem, valor monetário (se >0), botão deletar | pretty.js:130932-131056 |
| Modal Nova/Editar coluna (`jge`) | Nome, cor (Automático + 8 cores), marcar como conversão, pré-visualização | pretty.js:131460-131662 |
| Modal Criar cartão (`dAt`) | Busca de chats disponíveis paginada, seleção de 1 chat | pretty.js:131663-132030 |

## 3. Modelo de dados / campos

### 3.1 CRM (`crm`)

| Campo | Tipo | Obrig. | Validação/default | Ref |
|---|---|---|---|---|
| `id` | int | — | — | — |
| `name` | string | sim | input `required`, trim | pretty.js:123566-123620 |
| `crm_columns[]` | CrmColumn[] | — | ordenadas por `position` | pretty.js:123273 |
| `quantity_of_columns` | int | leitura | — | pretty.js:123420 |
| `summary` | `{total_cards, total_value, conversion_count, conversion_rate}` | leitura | default zeros | pretty.js:123257-123272 |
| `updated_at` | datetime | leitura | — | — |

Ao criar, o backend gera colunas padrão ("As colunas padrão já vêm prontas") — nomes reais [NÃO VERIFICADO]; a prévia mostra Novo / Qualificação / Ganho.

### 3.2 Coluna (`crm_column`)

| Campo | Tipo | Obrig. | Validação/default | Ref |
|---|---|---|---|---|
| `id` | int | — | — | — |
| `name` | string | sim | `required`, trim | pretty.js:131470-131530 |
| `position` | int (0-based) | — | definido pelo servidor/ordem; reordenação via `move` | — |
| `accent_color` | string `#RRGGBB` \| null | não | null = "Automático" (cor da paleta por posição: `paleta[position % 8]`) ; validação `^#[0-9A-Fa-f]{6}$` | pretty.js:131446-131459, 123244 |
| `conversion_goal` | bool | não | default false; "Esta coluna será considerada uma conversão nos relatórios" | idem |

Paleta de cores nomeadas (pretty.js:123234-123243): teal "Verde-água" `#0d9488`, ember "Terracota" `#c2410c`, indigo "Índigo" `#4f46e5`, amber "Âmbar" `#d97706`, rose "Rosa" `#e11d48`, ocean "Oceano" `#0284c7`, olive "Oliva" `#4d7c0f`, slate "Ardósia" `#475569`. Paleta automática (por posição) é ligeiramente diferente (pretty.js:123224).

### 3.3 Card (`crm_card`)

| Campo | Tipo | Obs. | Ref |
|---|---|---|---|
| `id` | int | — | — |
| `crm_id` | int | — | pretty.js:164231 |
| `crm_column_id` | int | coluna atual | — |
| `position` | int | ordem na coluna | — |
| `chat_id` | int | chat vinculado (obrigatório na criação) | pretty.js:131759 |
| `status` | `waiting`/`attending`/`resolved` | status do chat; usado ao abrir o chat | pretty.js:132355 |
| `customer_name` | string | — | pretty.js:130995 |
| `customer_phone` | string | formatado BR `(DD) 9XXXX-XXXX` / `(DD) XXXX-XXXX` | pretty.js:130923-130931 |
| `customer_avatar` | url | fallback = inicial | — |
| `unread_count` | int | badge (máx "9+") | — |
| `last_message_preview` | string | — | — |
| `value` | number | valor monetário do lead; mostrado se >0; somado no total da coluna | pretty.js:130940, 132385 |
| etiquetas | — | exibidas como "Será implementado" | pretty.js:131018-131026 |

Payload de criação: `{crm_card:{chat_id}, crm_column_id}`. Edição de `value`/outros campos via `PUT /crms/:id/crm_cards/:card_id {crm_card}` existe no serviço mas sem tela no Kanban [NÃO VERIFICADO onde é usada — provavelmente no painel do chat ou automações].

### 3.4 Resposta paginada de cards
`GET /crms/:id/crm_cards` → `{crm_cards[], meta:{page, total_pages, total_count, total_value}}` (pretty.js:120164-120172, 132140-132150). O quadro pede **20 por coluna** (`per_page=20`) com uma requisição por coluna em paralelo; "Carregar mais" pede a próxima página daquela coluna. O serviço também tem "todas as páginas" com 120 por página.

### 3.5 Chats disponíveis para card
`GET /crms/:id/crm_cards/available_chats?page&per_page=20&search` → `{chats[{id, customer_name, customer_phone, status, unread_count, last_message_preview}], meta:{page,total_pages}}`. Busca por nome, telefone ou mensagem (debounce [INFERIDO ~300 ms]); exclui chats que já têm card neste CRM ("Todos os chats já possuem cartões neste CRM").

### 3.6 Estatísticas (calculadas no front, `yAt` pretty.js:133170-133219)

Entrada: `columnTotals` (total_count de cada coluna) e `columnValues` (total_value de cada coluna), já respeitando filtros.

- `total_cards` = Σ cards de todas as colunas.
- Por etapa (ordenada por position): `count` = **acumulado** (cards desta etapa + de todas as etapas posteriores — modelo de funil); `conversion_rate_from_previous` = count/count_anterior×100 (1 casa); `wave_progress_percent` = count/total×100; `total_value` da própria coluna.
- `conversion_count` = Σ cards (não acumulados) das colunas com `conversion_goal`.
- `conversion_rate` = conversion_count/total×100 (2 casas).
- `totals`: Total de Leads, Taxa de Conversão Geral, Total de Compras (= conversion_count), Faturamento Total (= Σ valores das etapas de conversão).
- Lista (`/crms`): "Conversão média" = Σ convertidos / Σ cards × 100 de todos os quadros (pretty.js:132915-132928).

Endpoint `GET /crms/:id/conversion_stats` existe no serviço mas não é chamado pela UI atual [NÃO VERIFICADO].

## 4. Estados e transições

- **Status do chat no card** (rótulos): `waiting` "Aguardando", `attending` "Atendendo", `resolved` "Resolvido".
- **Coluna**: normal ↔ conversão (toggle pelo menu "Marcar como conversão"/"Remover marcação conversão" → PUT com `conversion_goal` invertido).
- **Card**: move entre colunas (qualquer coluna → qualquer coluna, sem regras de transição no front).
- **Exportação**: idle → iniciada (`{id}`) → polling 2 s em `export_status` → `completed` (baixa `output_url` como `leads-crm-{id}.csv`) | `failed` (`error`).
- **Quadro**: carregando → ok | CRM inexistente/sem acesso → toast de erro e redireciona para `/crms` ("CRM não encontrado").

## 5. Ações e regras de negócio (features)

1. Listar Kanbans com resumo (cards, valor, convertidos, % conversão) e mini-funil.
2. Indicadores agregados da lista (quadros, cards, valor em BRL sem casas, conversão média).
3. Buscar Kanban por nome (local).
4. Criar Kanban (só nome; colunas padrão criadas no backend).
5. Renomear Kanban.
6. Excluir Kanban (confirmação; irreversível).
7. Abrir quadro.
8. Criar coluna (nome, cor, conversão) — anexada ao fim.
9. Editar coluna (renomear, cor, conversão).
10. Excluir coluna (confirmação "Todos os cartões serão perdidos"); posições recompactadas 0..n-1 no front.
11. Alternar coluna de conversão pelo menu.
12. Reordenar colunas por drag horizontal → `PATCH move {position: novo_índice}`; rollback em erro.
13. Mover card por drag (dentro da coluna ou entre colunas) → `PATCH move` com `{new_column_id, before_card_id}` (se houver card na posição destino) ou `{new_column_id, new_position}`; atualização otimista de contadores e valores das colunas; em erro recarrega o quadro.
14. Mover card também pelo painel do chat (select de etapa → `PATCH move {new_column_id}`) (pretty.js:164190-164245).
15. Criar card a partir de um chat (modal de busca, paginação "Carregar mais chats").
16. Excluir card.
17. Clicar no card abre o chat correspondente (`navigateToChat(chat_id, status)`).
18. Paginação por coluna (20) com "Carregar mais".
19. Contador por coluna = `total_count` do servidor; soma de valores por coluna.
20. Filtro por etapa (carrega só aquela coluna).
21. Filtro por data de atualização (de/até).
22. Filtro por etiquetas (qualquer uma; OR).
23. Filtro por responsável — UI presente mas desabilitada ("Será implementado").
24. Limpar filtros.
25. Estatísticas do funil (ver 3.6) com mostrar/ocultar.
26. Exportar leads em planilha (CSV assíncrono, respeita filtros).
27. Cores automáticas por posição.
28. Menu da coluna: "Gerenciar automações" e "Ocultar coluna" aparecem com "Será implementado" (não funcionais) (pretty.js:131220-131280).
29. Integração com outros módulos: webhooks de entrada e fluxos têm ação `create_kanban_card {crm_id, crm_column_id, value}` (pretty.js:120500-120530, 230810-230900); chat pode ser associado a um CRM (`PATCH /chats/:id/update_crm {crm_id}`) e listas de chats filtram por `crm_id`.
30. Contatos podem ser filtrados por etapas Kanban (`crm_column_ids`) — ver spec 05.

## 6. Endpoints da API

| Método | Caminho | Payload | Ref |
|---|---|---|---|
| GET | `/crms` (fonte: REA) | — | pretty.js:120100 |
| POST | `/crms` (fonte: REA) | `{crm:{name}}` | pretty.js:120110 |
| GET | `/crms/:id` | → CRM com `crm_columns` | pretty.js:120105 |
| PUT | `/crms/:id` | `{crm:{name}}` | pretty.js:120115 |
| DELETE | `/crms/:id` | — | pretty.js:120120 |
| GET | `/crms/:id/crm_columns` | — | pretty.js:120124 |
| GET | `/crms/:id/crm_columns/:col` | — | pretty.js:120129 |
| POST | `/crms/:id/crm_columns` | `{crm_column:{name, conversion_goal, accent_color}}` | pretty.js:120134 |
| PUT | `/crms/:id/crm_columns/:col` | idem | pretty.js:120139 |
| DELETE | `/crms/:id/crm_columns/:col` | — | pretty.js:120144 |
| PATCH | `/crms/:id/crm_columns/:col/move` | `{position}` | pretty.js:120148 |
| GET | `/crms/:id/crm_cards` | `crm_column_id, updated_from, updated_to, label_ids[], page, per_page` | pretty.js:120153-120172 |
| GET | `/crms/:id/crm_cards/export` | mesmos filtros; download síncrono (Bearer) — legado | pretty.js:120188 |
| POST | `/crms/:id/crm_cards/export_async` | `{crm_column_id?, updated_from?, updated_to?, label_ids?}` → `{id}` | pretty.js:120209 |
| GET | `/crms/:id/crm_cards/export_status/:job?t=<ts>` | → `{status, output_url, error}` | pretty.js:120220 |
| GET | `/crms/:id/crm_cards/:card` | — | pretty.js:120228 |
| POST | `/crms/:id/crm_cards` | `{crm_card:{chat_id}, crm_column_id}` | pretty.js:120233 |
| PUT | `/crms/:id/crm_cards/:card` | `{crm_card:{…}}` | pretty.js:120241 |
| DELETE | `/crms/:id/crm_cards/:card` | — | pretty.js:120246 |
| PATCH | `/crms/:id/crm_cards/:card/move` | `{new_column_id, before_card_id}` ou `{new_column_id, new_position}` | pretty.js:120250 |
| GET | `/crms/:id/crm_cards/available_chats` | `page, per_page, search` | pretty.js:120255 |
| GET | `/crms/:id/conversion_stats` | — | pretty.js:120267 |
| PATCH | `/chats/:id/update_crm` | `{crm_id}` | pretty.js:34882 |
| GET | `/labels` | etiquetas para o filtro [rota GET via serviço `Xn.getLabels`] | REA lista `/labels` (POST) |

## 7. Eventos realtime

Nenhuma assinatura ActionCable na tela de Kanban (não há `bn.subscribe` em pretty.js:120090-133770). O quadro só atualiza por ação do usuário/recarga. [INFERIDO] Mudanças de cards feitas por outros usuários/automações não aparecem em tempo real.

## 8. Permissões

| Chave | Hint oficial |
|---|---|
| `kanban.view` | "Vê boards e cards, sem mover nem alterar" — exigida para `/crms*` |
| `kanban.edit` | "Move cards, cria colunas e edita valores" |
| `kanban.delete` | "Apaga cards e colunas do funil" |

A UI do Kanban **não** esconde botões por `kanban.edit/delete` (nenhuma checagem no componente) — enforcement no backend [INFERIDO].

## 9. Integrações externas

Nenhuma direta. Cards dependem de chats WhatsApp. Ações automáticas de criação de card via webhooks de entrada e fluxos.

## 10. Lacunas

- [NÃO VERIFICADO] Nomes/quantidade das colunas padrão criadas com o CRM.
- [NÃO VERIFICADO] Onde `value` do card é editado (sem tela no Kanban; provável painel do chat/automação).
- [NÃO VERIFICADO] Uso de `conversion_stats` e do export síncrono.
- [INFERIDO] Regras de backend ao excluir coluna (cards apagados) e ao excluir chat/contato (card removido).
- Automações de coluna, ocultar coluna, filtro por responsável e etiquetas no card: placeholders "Será implementado".

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- Título "Kanbans" e subtítulo de pipeline de vendas e gestão visual, com o botão "Novo Kanban".
- Estado vazio: "Nenhum Kanban criado", com um texto de convite e o botão "Novo Kanban". A conta observada não tinha quadros, então colunas e cards não foram vistos ao vivo.
