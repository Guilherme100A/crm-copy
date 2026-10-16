# 09 — Webhooks de entrada e Credenciais MCP

> Fonte: `_bundle/pretty.js` (i18n pt-BR do namespace `settings.webhooks`, JSON em pretty.js:16172; `settings.mcpCredentials` em pretty.js:16174) mais a tabela do REA. **(fonte: REA)** = presente na tabela do REA. Exemplos fictícios.

## 1. Visão geral

**Webhooks de entrada** permitem que sistemas externos (n8n, Postman, checkout, formulário) façam `POST` de um JSON numa URL pública única por webhook. O app então:
1. identifica ou cria o **lead/contato** a partir de campos mapeados do payload (nome, telefone, e-mail e campos personalizados);
2. aplica **etiquetas** (adicionar/remover);
3. executa **ações de Kanban** (criar/mover ou remover card, com valor);
4. opcionalmente **dispara um fluxo** por uma conexão, que pode ser resolvida dinamicamente pelo payload, filtrado por **condições**;
5. registra cada requisição num **histórico** com etapas de processamento.

O mapeamento é visual: o usuário "escuta" uma requisição de exemplo em tempo real e arrasta caminhos da árvore JSON para os campos de destino. Textos literais (ex.: "+55") viram segmentos concatenados.

**Credenciais MCP** permitem que clientes de IA externos (Claude, Cursor, n8n) acessem a conta via Model Context Protocol, com token estático Bearer ou OAuth.

Contagem aproximada: **~35 features** (webhooks ~27, MCP ~8).

## 2. Telas e rotas

| Rota | Descrição | Ref |
|---|---|---|
| `/settings/inbound-webhooks` (fonte: REA) | Lista: busca por nome; colunas Nome (ordenável), Status (Ativo/Inativo), Conexão, Disparos no mês e Ações (Editar/Excluir); barra "Consumo: X / Y" | pretty.js:122319, 117810-118060 |
| `/settings/inbound-webhooks/new` (fonte: REA) | Criar: nome, conexão opcional, ativo. "Salvar e continuar" leva para a edição | pretty.js:122320, 118544 |
| `/settings/inbound-webhooks/:id/edit` (fonte: REA) | Abas **Configuração** (URL, escuta de exemplo, árvore JSON, mapeamento, etiquetas, Kanban, conexão e disparo de fluxo, condições) e **Histórico** | pretty.js:122321, 121900-122090 |
| `/settings/mcp-credentials` (fonte: REA) → redireciona para `/settings?tab=mcp_credentials` | Servidor MCP: URL, instruções de autenticação e tabela de credenciais | pretty.js:122323, 116070-116140 |

## 3. Modelo de dados / campos

### 3.1 InboundWebhook

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| id | int | | | |
| account_id | int | | Se o usuário trocar de conta, a página volta para a lista | pretty.js:121921 |
| name | string | sim | trim não vazio ("Informe o nome do webhook"). Editável inline | |
| connection_id | int\|null | não | Na edição, é derivado do número informado (match único pelos 8 últimos dígitos). Se o valor for variável, fica null | pretty.js:122040 |
| active | bool | | default true na criação. Switch no cabeçalho | |
| public_token | string | | token público da URL | pretty.js:121931 |
| public_receive_url | string | | **URL (POST)** exibida e copiável | |
| ingestor_receive | bool | | recepção por ingestor dedicado [INFERIDO] | |
| last_inbound_webhook_request | {raw_body} | | último payload, base da árvore JSON | |
| request_stats | {total, processed, failed, pending, skipped, retention_max} | | retention_max default 1000 | pretty.js:121430 |
| config | objeto WebhookConfig | | ver 3.2 | |

### 3.2 WebhookConfig (montado em pretty.js:121877-121898)

| Campo | Tipo | Regra |
|---|---|---|
| field_paths.full_name | Segment[] | obrigatório no processamento (senão `missing_required_fields`) |
| field_paths.phone | Segment[] | obrigatório. Ex.: segmento literal "+55" seguido do caminho do número |
| field_paths.email | Segment[] | opcional |
| custom_field_mappings[] | {field_key, segments[]} | field_key de campo cadastrado (seletor) ou nome interno digitado (ex.: `cpf`). Só entram linhas com chave e segmentos |
| add_tags[] / remove_tags[] | string[] (nomes) | picker com busca e "Criar etiqueta". Só aplica se houver conexão resolvida e conectada |
| kanban_actions[] | {action, crm_id, crm_column_id, value} | action `create_kanban_card` (coluna obrigatória; cria ou move) ou `remove_kanban_card` (coluna opcional: sem coluna remove de qualquer etapa). value aceita número ou variável. Exige conexão conectada |
| trigger_flow | bool | "Disparar fluxo". Aviso: substitui o fluxo em andamento do lead |
| flow_id | int\|null | obrigatório se trigger_flow |
| connection_value | string | "Número que dispara": número (match pelos 8 últimos dígitos, ignorando espaço, traço, barra e +) ou variável `{caminho.do.campo}`. Obrigatório se trigger_flow ("Informe o número da instância ou uma variável") |
| connection_source / connection_path | legado | lidos para compatibilidade: `payload` + caminho → `{caminho}` (pretty.js:119089-119110) |
| trigger_conditions | {ruleType:"all"\|"any", conditions[]} | omitido se não houver regras ("dispara sempre") |

**Segment**: `{kind: "literal"|"path", value}`. "path" usa notação com pontos (ex.: `body.cliente.nome`). Os segmentos são concatenados na ordem.

**Condição de disparo** (pretty.js:119042-119075):
- `category: "system"`, `systemSubtype:"tag"`, `systemOperator: "equal"` (Possui) | `"different"` (Não possui), `tagName`.
- `category: "field"`, `fieldName` (`name`, `phone`, `email`), `fieldOperator`, `fieldValue`.
- `category: "custom_field"`, `fieldName` (campo personalizado), `fieldOperator`, `fieldValue`.
- Operadores: `equal`, `different`, `contains`, `not_contains`, `starts_with`, `has_value` (sem valor).

Feedback em tempo de edição do "Número que dispara": "Instância X · status", "Mais de uma instância com esse número. Não dispara", "Nenhuma instância com esse número", "Precisa de pelo menos 8 dígitos". Há uma lista de instâncias com telefone e uma lista de variáveis (paths do exemplo).

### 3.3 InboundWebhookRequest (histórico)

| Campo | Tipo | Notas |
|---|---|---|
| processing_status | enum | `pending` (Pendente), `processed` (Processado), `failed` (Falhou), `skipped` (Ignorado, duplicado) |
| raw_body | text | "Ver requisição formatada" (JSON pretty) e copiar |
| raw_body_truncated | bool | badge "Truncado ao persistir" |
| steps[] | {step, status, reason?} | step: `resolve_customer`, `identity_fields`, `custom_fields`, `tags`, `kanban`, `trigger_flow`, `resolve_connection`, `error`. status: `ok`, `failed`, `skipped` |
| error | código | `missing_required_fields`, `webhook_inactive`, `duplicate_payload` |
| reason | código | `no_connection`, `skipped_due_to_disconnected_connection`, `invalid_flow_config`, `unique_constraint` (e-mail ou telefone), `duplicate_payload`, `conditions_not_met`, `connection_not_resolved`, `labels_not_found:<lista>`, `kanban_apply_failed:<detalhe>` |
| created_at | datetime | |

Histórico limitado aos "até {max} recentes" (retention_max). Linha de stats: Total, processados, falhas, pendentes e ignorados.

### 3.4 McpCredential

| Campo | Tipo | Obrig. | Notas |
|---|---|---|---|
| id | int | | |
| name | string | sim | "Informe um nome". Ex. fictício: "Cursor notebook" |
| auth_type | enum | sim | `static` (token Bearer: Cursor, n8n) \| `oauth` (Claude.ai/Desktop) |
| status | enum | | `active` (com flag `expiring_soon` → "Expira em breve"), `connected` (com `connected_client_hint` → "Conectada · {client}"), `pending` (OAuth aguardando), `expired` |
| last_used_at | datetime | | "Nunca usado" |
| expires_at | datetime | | só para estático. OAuth mostra "-" |
| token | string | | retornado **uma única vez** na criação ("Copie o token agora") |

A resposta da listagem traz `mcp_credentials[]` e `mcp_endpoint_url` (URL única do servidor MCP da conta).

## 4. Estados e transições

- Webhook: `active` ⇄ inativo (switch). Requisições para um webhook inativo são registradas com o erro `webhook_inactive`.
- Escuta de exemplo: `idle` → `connecting` → `listening` (timeout de 90 s, `hZ = 9e4`, com contador "X min Y s") → recebe `sample_received` → `idle`. Pode ser cancelada. No timeout aparece o aviso "Tempo de espera esgotado".
- Requisição: `pending` → `processed` | `failed` | `skipped`.
- Credencial MCP: estático `active` → `expired` (por `expires_at`) | revogada (removida). OAuth `pending` → `connected` → revogada.

## 5. Ações e regras de negócio

1. **Criar**: `{name, connection_id|null, active, config:{}}`, depois redireciona para a edição com a dica "envie um POST de exemplo para liberar o mapeamento".
2. **Escutar exemplo**: assina o canal realtime do webhook e espera o POST real. Ao chegar, recarrega o webhook (árvore JSON a partir de `last_inbound_webhook_request.raw_body`). "Mapear próxima requisição" repete o ciclo. O mapeamento por clique ou arraste fica bloqueado até existir um exemplo. JSON inválido gera aviso.
3. **Mapear**: o usuário seleciona um campo de destino à direita e clica ou arrasta o path da árvore à esquerda. Texto digitado + Enter vira segmento literal. Arrays e objetos mostram até N itens ("… mais N itens").
4. **Salvar**: valida o nome; se `trigger_flow`, exige `connection_value`. Persiste nome, conexão, ativo e config completo.
5. **Processamento (backend, inferido pelas etapas)**: dedupe de payload idêntico (`duplicate_payload` → skipped) → resolver cliente por telefone/e-mail (cria ou atualiza; conflito de unicidade = falha) → identidade → campos personalizados → resolver conexão (fixa ou por variável, pelos 8 últimos dígitos; ambígua ou inexistente não dispara) → etiquetas → Kanban → avaliar condições (antes de cancelar o fluxo em andamento) → disparar fluxo (cancela o fluxo atual do lead).
6. **Consumo mensal**: a lista mostra "Disparos no mês" e uma barra "Consumo: usados / limite". No bundle os valores estão fixos (0 / 30000: `cI()=0`, `Cjt=3e4`), o que indica funcionalidade ainda stub [INFERIDO].
7. **Excluir**: confirmação "Excluir este webhook?".
8. **Partes ainda "em breve" na UI**: pré-visualização de valores mapeados e catálogo de campos cadastrados na sessão ("vai implementar").
9. **MCP**: criar (nome + tipo) mostra token + URL (estático, com instruções Cursor/n8n/Bearer) ou URL + passos de conector no Claude (OAuth; o status muda quando o cliente conecta). Revogar exige confirmação e invalida na hora. Header: `Authorization: Bearer <token>`. Boas práticas exibidas: uma credencial por cliente e revogar as que não são usadas.

## 6. Endpoints da API

### Webhooks (`wjt`, pretty.js:117575-117609)

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/inbound_webhooks` | → array | grep (endpoint em propriedade de classe; o REA lista só as rotas) |
| GET | `/inbound_webhooks/:id` | | grep |
| POST | `/inbound_webhooks` | `{inbound_webhook:{name, connection_id, active, config}}` | grep |
| PATCH | `/inbound_webhooks/:id` | `{inbound_webhook:{name, connection_id, active, config}}` | grep |
| DELETE | `/inbound_webhooks/:id` | | grep |
| GET | `/inbound_webhooks/:id/requests` | → array de requisições | grep |
| POST | `public_receive_url` (pública, fornecida pelo backend; formato com `public_token`) | JSON arbitrário do cliente | [NÃO VERIFICADO o caminho exato] |

Dependências: `GET /connections`, nomes de fluxo (`/flows/names`), etiquetas, CRMs/colunas e campos personalizados.

### MCP (`SNt`, pretty.js:115330-115348)

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/mcp_credentials` | → `{mcp_credentials[], mcp_endpoint_url}` | grep |
| POST | `/mcp_credentials` | `{mcp_credential:{name, auth_type}}` → `{mcp_credential, token, mcp_endpoint_url}` | grep |
| DELETE | `/mcp_credentials/:id` | revogar | grep |

## 7. Eventos realtime

- Canal **`InboundWebhookSamplesChannel`** com params `{webhook_id}` (pretty.js:121964-122000). Evento `{type:"sample_received", webhook_id, request:{raw_body}}`. Callbacks connected, disconnected e rejected (este último gera "Não foi possível iniciar escuta").
- MCP: sem realtime. O status OAuth é atualizado ao recarregar [INFERIDO].

## 8. Permissões

- Webhooks: `webhooks.view` (rota), `webhooks.edit`, `webhooks.delete` (padrão para owner/admin) (pretty.js:36208-36210, 40916).
- MCP: `settings.mcp.view` (pretty.js:40907).

## 9. Integrações externas

Qualquer emissor HTTP (n8n, Postman, plataformas de checkout ou formulários). Clientes MCP: Claude (OAuth, conector customizado), Cursor, n8n (MCP Client node). Exemplos de nomes citados na UI: "Webhook N8N Vendas".

## 10. Lacunas

- [NÃO VERIFICADO] Formato exato da URL pública de recepção, autenticação (só o token na URL?), limite de tamanho do corpo (há truncamento) e rate limit.
- [NÃO VERIFICADO] Política de dedupe (hash do corpo? janela de tempo?).
- [INFERIDO] Cota mensal de disparos por webhook (stub no front).
- [NÃO VERIFICADO] Lista de ferramentas MCP expostas (backend): a UI cita listar contatos, conexões e fluxos e "executar ações permitidas".
- [NÃO VERIFICADO] Validade padrão de `expires_at` do token estático.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Lista:** "Webhooks" (vários webhooks, cada um com sua conexão e mapeamento). Botão "Novo webhook". Barra "Consumo: N / 30.000" com %. Vazio: "Nenhum webhook cadastrado", botão "Criar webhook".
- **`/settings/inbound-webhooks/new`, passo 1 "Criar webhook":**
  - Nome do webhook.
  - Conexão: opcional, "Nenhuma" por padrão. Necessária para etiquetas, Kanban e disparo de fluxo; deve ser a mesma conexão do lead.
  - Botão "Salvar e continuar". O mapeamento vem nos passos seguintes, que não foram abertos.
