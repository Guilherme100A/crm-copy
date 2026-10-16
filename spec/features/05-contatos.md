# 05 — Contatos (customers)

> Fonte: bundle (`_bundle/pretty.js`) + REA (`_rea/rea-endpoints.md`). "(fonte: REA)" = presente na tabela do REA; demais via grep.

## 1. Visão geral

Base de contatos da conta (clientes/leads WhatsApp). Lista com scroll infinito, busca, filtros avançados (data de criação, etiquetas, etapas Kanban, campo personalizado), seleção em massa (inclusive "todos do filtro/da conta" com exclusões), criação com busca prévia de duplicados, edição, exclusão unitária e em massa assíncrona, exportação CSV assíncrona, importação CSV assíncrona com progresso em tempo real, importação de contatos do WhatsApp, abertura de chat a partir do contato e envio para disparo em massa. Campos personalizados são chave/valor livres por contato, com catálogo gerenciado em `/customer_custom_fields`.

Contagem de features: **~38**.

## 2. Telas e rotas

| Rota | Componente | Permissão | Ref |
|---|---|---|---|
| `/customers` (fonte: REA, rota `customers`) | Página Contatos (`m3t`) | `contacts.view` | pretty.js:156290, 154623 |
| `/customer_custom_fields` (fonte: REA) | Catálogo de campos personalizados | `settings.fields.view` | pretty.js:157361 |

| Tela/modal | Descrição | Ref |
|---|---|---|
| Cabeçalho | "Contatos" + "{n} contatos" (ou "{n}+ contatos" quando o total é desconhecido) + contadores "ativos"/"leads" (placeholders "Será implementado") | pretty.js:155481-155500 |
| Barra de ações | Filtros, Importar do WhatsApp (só se há conexão `connected`), Exportações recentes, Exportar CSV, Importar CSV, Novo Contato | pretty.js:155520-155600 |
| Busca | "Buscar contato..." com debounce 500 ms e botão limpar | pretty.js:155063-155067, 155600 |
| Selects Status/Origem | Todos os status/Ativo/Lead/Inativo; Todas as origens/WhatsApp/Facebook/Instagram/Site/Indicação — **não enviados à API** (cosméticos) [NÃO VERIFICADO no backend] | pretty.js:155500-155520 |
| Modal "Filtrar contatos" (`d3t`) | Data de criação (de/até), Etiquetas (multi + busca), Etapas do Kanban (agrupadas por quadro + busca), Campo personalizado (chave + valor opcional, busca parcial) | pretty.js:154221-154601 |
| Chips de filtros ativos (`qge`) | Remoção individual + "Limpar filtros" | pretty.js:154009-154218 |
| Tabela (`GTt`) | Checkbox, avatar (foto ou inicial), Nome completo (ordenável), Telefone, Etiquetas (até 3/2 + "+N"), Ações (Abrir Chat, Editar, Excluir); layout mobile em cards | pretty.js:149466-149976 |
| Barra de seleção em massa | "{n} selecionados", Excluir, Disparo em massa, Exportar, Limpar | pretty.js:155400-155480 |
| Fluxo "Novo contato" (`KTt`) | Passo 1: busca existentes (mín. 2 caracteres, debounce 450 ms, 15 resultados) → editar existente ou "Criar novo contato"; Passo 2: formulário | pretty.js:152228-152530 |
| Modal Contato (`VA`) | Formulário criar/editar | pretty.js:150948-152227 |
| Modal Abrir chat | Escolher conexão (busca por nome/telefone/status) | pretty.js:155390-155420, 156000+ |
| Modal Confirmar exportação (`s3t`) | Pergunta por modo + "Incluir campos personalizados" | pretty.js:153137-153239 |
| Modal Exportação em massa (`r3t`) | Progresso do job | pretty.js:152919-153136 |
| Painel "Exportações recentes" (`n3t`) | Últimas 3 exportações, tamanho, data, download | pretty.js:152660-152918 |
| Modal Exclusão em massa (`i3t`) | Preparação de manifesto + progresso | pretty.js:153289-153579 |
| Modal Importar CSV | Passo configure (baixar modelo, etiquetas padrão, selecionar CSV) → confirm (arquivo + etiquetas padrão) | pretty.js:156080-156250 |
| Modal Importação em massa (`l3t`) | Progresso, contadores, avisos e erros por linha | pretty.js:153580-153976 |
| Confirmação Importar do WhatsApp | "Tem certeza…" | pretty.js:155950 |

## 3. Modelo de dados / campos

### 3.1 Contato (`customer`) — formulário (pretty.js:150948-151240)

| Campo | Tipo | Obrig. | Validação/default |
|---|---|---|---|
| `id` | int | — | — |
| `full_name` | string | **sim** | não vazio após trim |
| `phone_number` | string | **sim** | Seletor de país (default BR) + dígitos. BR: 10-11 dígitos ("DDD + número"); outros: 6-15; mínimo 8. Enviado em E.164 (`+{DDI}{número}`, normalizado por lib de telefone). Exceção: identificadores não-telefone (`…@lid` ou padrão `XX.ENT.xxxx`/`XX.xxxx`) são aceitos como estão em modo "ID" |
| `email` | string \| null | não | vazio → null |
| `state` | UF (2 letras) | não | select com 27 UFs |
| `city` | string | não | select dependente da UF (lista embutida de municípios por UF, pretty.js:150308-150876); limpa se não pertence à nova UF |
| `zip` | string 8 dígitos | não | máscara `00000-000`; enviado sem hífen |
| `label_ids` | int[] | não | multi-select de etiquetas da conta |
| `labels` | `{id,name,color}[]` | leitura | — |
| `custom_fields` | objeto `{chave: valor}` | não | linhas Nome/Valor livres; linhas com nome vazio descartadas |
| `ctwa_clid` | string | não | só edição ("Click ID do anúncio") |
| `source_id` | string | não | só edição ("ID da origem") |
| `source_url` | url | não | só edição |
| `media_url`, `thumbnail_url` | url | não | só edição (preservados) |
| `profile_picture_url` | url | leitura | avatar |
| `created_at` | datetime | leitura | filtro |

Botão salvar desabilitado enquanto inválido. Em modo "dual" (criação via fluxo de busca) há "Salvar contato" e "Salvar e abrir conversa".

### 3.2 Campo personalizado (catálogo) (pretty.js:91176-91235, 100845-100870, 16843-16922)

| Campo | Tipo | Regra |
|---|---|---|
| `key` | string | obrigatório, 2-255 chars, convertido para minúsculas; imutável após criado ("O nome do campo não pode ser alterado") |
| `description` | string | editável |
| `example_value` | string | leitura |

Abas: **Customizados** (criados manualmente ou automaticamente quando um contato recebe uma chave nova) e **Sistema (BOT)** (somente leitura, não excluíveis): `full_name`, `first_name`, `phone_number`, `hora` (HH:mm), `data` (dd/MM), `dia` (dia da semana), `response_type` (MIME da última resposta), `response_erro` (erro da última requisição HTTP). Tipos exibidos: Texto, Media, Variável.

### 3.3 Filtros de listagem (pretty.js:149226-149263, 153989-154008)

| Parâmetro | Tipo | Obs. |
|---|---|---|
| `page`, `limit` | int | 20 por página na lista |
| `search` | string | nome/telefone/e-mail [INFERIDO]; termos só numéricos com < 4 dígitos são ignorados (pretty.js:153989) |
| `label_ids[]` | int[] | "Contatos que possuem a etiqueta no contato ou em algum chat" |
| `crm_column_ids[]` | int[] | contatos com card em qualquer etapa selecionada |
| `created_at_from`, `created_at_to` | date | — |
| `custom_field_key`, `custom_field_value` | string | valor opcional, busca parcial |
| `skip_total_count` | bool | enviado quando há filtros ativos (contagem pode ficar desconhecida → "N+") |
| `compact` | bool | resposta enxuta (busca do fluxo de criação) |

Resposta: `{customers[], pagination:{current_page, total_pages, total_count|null, per_page, has_more}}`.

### 3.4 Seleção em massa (pretty.js:149404-149438, 152613-152634)

Estado: `isAllFromBaseSelected` + `selectedIds` + `excludedIds`. Modos derivados:
- `ids` — ids explícitos;
- `all_except` — todos do filtro atual (ou da conta, sem filtros) menos `excludedIds`;
- `filtered` — sem seleção: exporta o filtro atual.

Contagem efetiva = total do filtro − excluídos | nº selecionados | total do filtro. Shift+clique seleciona intervalo. Opções "Todos do filtro ({n})" / "Todos da conta ({n})".

### 3.5 Job de exportação (pretty.js:149284-149313, 152660-153136)
Payload: `{search, labels, label_ids, crm_column_ids, created_at_from, created_at_to, mode: ids|all_except|filtered, include_custom_fields, customer_ids, except_ids, fields}`. Status: `{id, status: processing|completed|failed, progress:{rows_written,target_count}, row_count, output_url, file_size, started_at, finished_at, created_at, error}`. Arquivo `customers_export_{id}.csv`.

### 3.6 Job de importação (pretty.js:149314-149335, 152573-152611, 153580-153976)
Envio multipart: `file` (.csv), `mode` (default `upsert`), `create_missing_labels` (default true), `default_label_ids[]` + `default_label_ids_json`. Progresso: `{phase (ex. preparing_labels, syncing labels), total|target_count, processed|rows_processed, created, updated, skipped, errors, labels_created[]}`; resultado com avisos agrupados ("{msg} ({n}x)") e erros por linha ("Linha {n}: {erro}", agrupados com exemplos de linhas, até 8 grupos).

Modelo CSV: arquivo estático `/modelo_importacao_contatos.csv` servido pelo front (colunas [NÃO VERIFICADO] — arquivo não está no bundle JS).

### 3.7 Job de exclusão em massa (pretty.js:149357-149380, 153240-153300)
Front monta manifesto JSON `{version:1, mode:"all_except", filters:{search,label_ids,crm_column_ids,created_at_from,created_at_to,custom_field_key,custom_field_value}, except_ids}` ou `{version:1, mode:"ids", filters:{}, ids}` e envia como arquivo `customers-bulk-delete-{ts}.json` (multipart `manifest`). Status: `{status, deleted_count, target_count, progress}`.

## 4. Estados e transições

- **Jobs (export/import/bulk delete)**: `processing` → `completed` | `failed`. Import tem fase visual `starting` → (`preparing_labels`) → `processing` → (sincronizando etiquetas) → `completed`/`failed`.
- **Bulk delete UI**: preparing (montando manifesto, % de 10→100) → uploading → processing (contatos somem gradualmente) → completed/failed.
- **Exportações recentes**: ordenadas com `processing` primeiro, depois por data desc; mantém 3 (`RI=3`); a mais antiga "sai da lista na próxima exportação".
- **Status de chat criado a partir do contato**: `waiting`.
- **Status/Origem do contato** (`active/lead/inactive`; WhatsApp/Facebook/Instagram/Site/Indicação): apenas UI [NÃO VERIFICADO].

## 5. Ações e regras de negócio (features)

1. Listar contatos com scroll infinito (IntersectionObserver, 20/página, dedup por id).
2. Busca com debounce 500 ms (ignora números curtos < 4 dígitos).
3. Filtro por data de criação.
4. Filtro por etiquetas (contato ou chats do contato).
5. Filtro por etapas Kanban (lista CRMs e colunas; erro de permissão tratado).
6. Filtro por campo personalizado (chave + valor parcial).
7. Chips de filtros ativos e limpar.
8. Ordenação por nome (local).
9. Seleção individual, intervalo (Shift), visíveis, todos do filtro, todos da conta, com exclusões.
10. Criar contato com busca prévia de duplicados (nome/telefone/e-mail) e opção de editar o existente.
11. Criar e abrir conversa.
12. Editar contato (inclui dados de anúncio CTWA).
13. Excluir contato (confirm).
14. Exclusão em massa assíncrona (remove contatos, chats e mensagens vinculados; irreversível; aviso de quantos serão mantidos).
15. Exportar CSV assíncrono (modos ids/all_except/filtered; opcional campos personalizados).
16. Painel de exportações recentes com download.
17. Polling de exportação a cada 30 s + realtime; de exclusão em massa a cada 10 s + realtime; de importação a cada 2 s + realtime.
18. Importar CSV (modelo para download, etiquetas padrão aplicadas a linhas sem etiqueta; etiquetas do CSV têm prioridade e são criadas se faltarem; upsert).
19. Relatório final da importação: criados/atualizados/ignorados/erros, avisos e erros por linha.
20. Importar contatos do WhatsApp da primeira conexão `connected`; usa endpoint conforme provedor (`z_api` → Z-API; demais → uazapi); resultado "{importados} importados, {atualizados} atualizados, {ignorados} ignorados" + avisos.
21. Abrir chat: exige `chat.view`; se 1 conexão cria direto, senão modal para escolher (pré-seleciona a primeira `connected`); etiquetas do contato são copiadas para o chat.
22. Enviar seleção para Disparo em massa (`/mass-dispatches` com estado: seleção, filtros, contagem estimada).
23. Troca de conta reseta filtros/seleção e recarrega.
24. Etiquetas: atribuir no formulário; exibir com cor (contraste ajustado no tema escuro).
25. Cidades por UF embutidas.
26. Telefone internacional com seletor de país e detecção de DDI ao editar.
27. Catálogo de campos: listar customizados e de sistema, buscar, criar (chave minúscula), editar descrição.
28-38. Mensagens/estados vazios, contadores no cabeçalho, layout mobile, tooltips, etc. (UI).

**Bloqueio de contato**: não existe na página de Contatos; é feito pelo chat (`POST /chats/:id/block {block: bool}`, permissão `chat.block`) (pretty.js:34722). **Histórico** do contato: não há tela de histórico em Contatos [NÃO VERIFICADO — histórico vive nos chats].

## 6. Endpoints da API

| Método | Caminho | Payload | Ref |
|---|---|---|---|
| GET | `/customers` | ver 3.3 | pretty.js:149227-149263 |
| POST | `/customers` (fonte: REA) | `{customer:{full_name, phone_number, email, label_ids, custom_fields, city?, state?, zip?}}` | pretty.js:149264 |
| GET | `/customers/:id` | — | pretty.js:149276 |
| PUT | `/customers/:id` | `{customer:{… + ctwa_clid, source_url, source_id, media_url, thumbnail_url}}` | pretty.js:149270 |
| DELETE | `/customers/:id` | — | pretty.js:149282 |
| DELETE | `/customers/bulk_destroy` | `search, label_ids[], except_ids[]` (legado síncrono) | pretty.js:149350 |
| POST | `/customers/bulk_deletes` | multipart `manifest` (JSON) → `{id}` | pretty.js:149364 |
| GET | `/customers/bulk_deletes/:id?t=<ts>` | status | pretty.js:149372 |
| GET | `/customers/exports` (fonte: REA) | → `{exports[]}` | pretty.js:149286 |
| POST | `/customers/exports` (fonte: REA) | ver 3.5 | pretty.js:149291 |
| GET | `/customers/exports/:id?t=<ts>` | status | pretty.js:149307 |
| POST | `/customers/imports` | multipart ver 3.6 → `{id}` | pretty.js:149314 |
| GET | `/customers/imports/:id?t=<ts>` | status | pretty.js:149329 |
| POST | `/customers/import_from_uazapi` (fonte: REA) | `{}` → `{imported_count, updated_count, skipped_count, errors[]}` | pretty.js:149336 |
| POST | `/customers/import_from_z_api` (fonte: REA) | `{}` → idem | pretty.js:149342 |
| GET | `/customers/custom_fields?keys_only=true` (fonte: REA) | → `{custom_fields:[{key}]}` | pretty.js:91178 |
| GET | `/customers/custom_fields` (fonte: REA) | → `{custom_fields:[{key, description, example_value}]}` | pretty.js:91188 |
| POST | `/customers/custom_fields` (fonte: REA) | `{key, description}` | pretty.js:91211 |
| PATCH | `/customers/custom_fields/:key/description` | `{description}` | pretty.js:91205 |
| GET | `/customers/bot_fields` (fonte: REA) | → `{bot_fields:[{key, description}]}` | pretty.js:91226 |
| GET | `/connections/for_picker` (fonte: REA) | conexões p/ abrir chat/importar (fallback `/chats/filter_options`) | REA |
| POST | `/chats` (fonte: REA) | `{customer_id, connection_id, status:"waiting"}` | pretty.js:155380 |
| GET | `/crms` (fonte: REA) | etapas p/ filtro | — |
| GET | `/labels` | etiquetas | — |

## 7. Eventos realtime

| Canal | `type` | Payload | Ref |
|---|---|---|---|
| `AccountNotificationsChannel` `{account_id}` | `customers_export` | `{account_id, export}` | pretty.js:152531-152551 |
| idem | `customers_bulk_delete` | `{account_id, bulk_delete}` | pretty.js:152552-152572 |
| idem | `customers_import` | `{account_id, import:{id, progress}}` | pretty.js:152573-152611 |
| `ChatsChannel` | `customer_updated` | atualização de contato refletida no chat [INFERIDO] | pretty.js:157484 |

## 8. Permissões

| Chave | Hint |
|---|---|
| `contacts.view` | "Lista e busca contatos" — exigida para `/customers` (e `/mass-dispatches`) |
| `contacts.edit` | "Cadastra, importa e altera dados" |
| `contacts.delete` | "Remove contatos da base" |
| `settings.fields.view` | Acesso ao catálogo de campos |
| `chat.view` | Necessária para "Abrir Chat" |
| `chat.block` | Bloqueio (no chat) |

A página não oculta botões por `contacts.edit/delete` — enforcement no backend [INFERIDO]. Filtro por etapas Kanban requer `kanban.view`.

## 9. Integrações externas

- Provedores WhatsApp não oficiais **uazapi** e **Z-API** (importação de contatos; sincronização de etiquetas).
- Meta Click-to-WhatsApp (`ctwa_clid`, `source_id`, `source_url`, mídia do anúncio). [INSTÁVEL NO BAILEYS] (no Baileys o contexto do anúncio vem em `contextInfo.externalAdReply` da 1ª mensagem; `ctwa_clid` nem sempre presente)

## 10. Lacunas

- [NÃO VERIFICADO] Colunas do CSV modelo (`/modelo_importacao_contatos.csv`) e limites de tamanho/linhas da importação.
- [NÃO VERIFICADO] Opção "Sincronizar etiquetas no WhatsApp"/seleção de instâncias na importação: textos existem, mas o serviço atual só envia `file, mode, create_missing_labels, default_label_ids`.
- [NÃO VERIFICADO] Filtros Status/Origem e contadores "ativos"/"leads" (placeholders).
- [INFERIDO] Campos pesquisados por `search` e unicidade de telefone por conta (upsert por telefone).
- [NÃO VERIFICADO] Existência de bloqueio/histórico no nível do contato (só via chat).

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Atribuição Click-to-WhatsApp (`ctwa_clid`, `source_id`, `source_url`, mídia do anúncio) | [INSTÁVEL NO BAILEYS] | Ler `contextInfo.externalAdReply` / `conversionSource` da primeira mensagem; tratar `ctwa_clid` como opcional |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Cabeçalho:** "Contatos" com o contador "N contatos". Os contadores "ativos" e "leads" aparecem literalmente como "Será implementado" (placeholder confirmado ao vivo).
- **Barra de ações:** Filtros, Importar do WhatsApp, Recentes, Exportar CSV, Importar CSV, Novo Contato. Selects "Todos os status" e "Todas as origens".
- **Tabela:** colunas Nome Completo, TELEFONE, ETIQUETAS (chips), AÇÕES. Avatar com iniciais.
- **Painel Filtros (inline):**
  - Criado a partir de / Criado até (datas).
  - Campo personalizado (select) + Valor (desabilitado até escolher o campo).
  - Etiquetas: chips com busca, com o texto "Contatos que possuem a etiqueta no contato ou em algum chat."
  - Etapas do Kanban (vazio: "Nenhum quadro Kanban com etapas nesta conta.").
  - Botões Aplicar filtros / Limpar filtros.
- **Exportações recentes:** mostra as 3 mais recentes; a mais antiga sai da lista ao exportar de novo. Vazio: "Nenhuma exportação recente."
- **Modal "Importar contatos via CSV":**
  - Etiquetas padrão (opcional), aplicadas quando a linha do CSV não tiver etiquetas; as do CSV têm prioridade.
  - "Baixar planilha modelo" e "Selecionar CSV para importar" (aceita .csv).
  - Texto: as etiquetas ficam no contato e são copiadas para a conversa ao abrir chat.
- **Modal "Novo contato":** primeiro uma busca de contatos existentes ("Digite para buscar contatos existentes"), depois "Criar novo contato", e Cancelar.
- **Modal "Exportar contatos":** "Exportar N contatos do filtro atual?", checkbox "Incluir campos personalizados (arquivo maior e mais lento)", nota de que roda em segundo plano com progresso no modal, Cancelar / Exportar.
