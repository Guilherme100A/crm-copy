# 06 — Fluxos (builder visual de automação)

> Fonte: engenharia reversa clean-room do bundle `_bundle/pretty.js` (pretty-print do `index.js`) + tabela REA `_rea/rea-endpoints.md` (rea-agents 6.5.0).
> Itens marcados **(fonte: REA)** aparecem na tabela do REA; os demais vieram do grep no bundle (o REA não capturou URLs montadas com template literal, ex. `` `${this.endpoint}/${id}/activate` ``).
> Namespace i18n: `flows` (pt-BR em `pretty.js:25202–26541`; en ≈ `26542+`; es ≈ `27900+`). O sub-namespace `flows.nodeEditors` é um JSON embutido em `pretty.js:26193`.

---

## 1. Visão geral

O módulo Fluxos é um editor visual de automações conversacionais para WhatsApp. O usuário monta um grafo de **nós (blocos)** ligados por **conexões (arestas)** num canvas. Cada nó tem um `node_type` e uma lista ordenada de **ações** (`flow_node_action`, cada uma com `action_type` + `config` JSON). As arestas saem de **handles** nomeados (ex.: `success`, `failure`, `option-0`, `timeout`) e carregam `condition_type` + `condition_config`.

Pontos-chave:
- Editor baseado em **React Flow (pacote `reactflow`/xyflow; versão exata [NÃO VERIFICADO])**: mensagens de erro "[React Flow]" e classes `react-flow__*` em `pretty.js:190487–190554`; `nodeTypes` registrado em `pretty.js:241550`.
- Persistência **incremental (autosave por nó/conexão)**: criar/mover/editar nó e criar/excluir conexão chama a API imediatamente; há também botão "Salvar" e indicador "Salvo às" (`flows.editPage.savedAt`).
- Organização em **pastas** aninhadas com cores, reordenação por arrastar, busca e filtros.
- **Compartilhamento/importação** por código entre contas; **duplicar**; **copiar/colar nós** entre fluxos (mesma conta).
- **Simulador** local no editor (sem WhatsApp, sem salvar).
- **Tradução automática de fluxo** (cópia traduzida com texto/áudio/imagem/PDF, cobrada em créditos).
- **Execuções**: disparo manual a partir do chat, cancelamento, listagem de execuções ativas por chat.
- **Edição remota em tempo real** via canal `FlowsChannel` (inclui mutações feitas pelo assistente de IA via MCP).
- Gatilhos de início de fluxo **não ficam no fluxo**: ficam em **Fluxos padrões por conexão** (`connection_flow_configs`) — palavras-chave, boas-vindas, resposta padrão, conversa/atendimento finalizado (seção 3.8).

---

## 2. Telas e rotas

| Rota | Componente (bundle) | Propósito | Ref |
|---|---|---|---|
| `/flows` **(fonte: REA)** | `wea` | Lista de fluxos + pastas (cards/tabela), busca, filtros de status, ações por fluxo | `pretty.js:249794`, `245650` |
| `/flows?folder_id=N` | `wea` | Mesma tela posicionada dentro de uma pasta (breadcrumb) | `pretty.js:185465` |
| `/flows/new` **(fonte: REA)** | `XR` | Cria fluxo e abre editor (modo "new") | `pretty.js:249795`, `247489` |
| `/flows/:id/edit` **(fonte: REA)** | `XR` | Editor visual | `pretty.js:249796` |
| `/flows/:id` **(fonte: REA)** | `XR` | Mesmo editor (somente leitura se sem `flows.edit`) [INFERIDO] | `pretty.js:249797` |
| `/connection_flow_configs` **(fonte: REA)** | redirect | Redireciona para `/settings?tab=connection_flow_configs` (Fluxos padrões) | `pretty.js:249801` |
| `/settings?tab=connection_flow_configs` | Configurações › Fluxos padrões | Gatilhos por conexão (ver 3.8) | `pretty.js:117222` |
| `/settings?tab=flow_translator_history` | Configurações › Histórico de traduções | Lista de runs de tradução (reservado/usado/devolvido) | `pretty.js:117154`, `25470` |

### 2.1 Lista de fluxos (`/flows`)
- Cabeçalho: título "Fluxos", subtítulo, botões **Importar**, **Pasta** (nova pasta), **Novo fluxo**.
- Seções: **Pastas** (cards com cor, nº de fluxos e subpastas, menu Editar/Excluir) e **Fluxos de trabalho**.
- Visualização card (badge de status ATIVO/PAUSADO/RASCUNHO/ARQUIVADO, nº de blocos, "Hoje, HH:mm"/"Ontem, HH:mm") e tabela (colunas Nome, Status, Blocos, Atualizado, Ações; paginação "de–até de total").
- Busca "Buscar fluxos…" e filtro de status (Todos / Ativos / Pausados / Pastas) com Aplicar/Limpar.
- Navegação de pastas: árvore lateral (mobile: abrir/fechar), breadcrumb, "Voltar à pasta anterior", pasta raiz "Sem pasta".
- Drag & drop: reordenar fluxos ("Solte aqui para reordenar"), mover fluxo para pasta, mover pasta para outra pasta (bloqueia mover para subpasta própria).
- Menu "Mais opções" por fluxo (`flowDropdown`): Editar nome, Duplicar, Compartilhar, Ativar/Pausar/Reativar, Arquivar/Desarquivar, Remover da pasta, Traduzir, Excluir.
- Estado vazio: "Nenhum fluxo encontrado" + CTA "Criar Primeiro Fluxo".
- Cache: lista guardada em `sessionStorage["flows_list_cache"]` **(fonte: REA)** por 120 s; busca global usa `sessionStorage["flows_all_search_cache"]` (TTL 120 s, `pretty.js:187880–187905`).

### 2.2 Editor (`/flows/:id/edit`)
- Cabeçalho: título editável inline ("Clique para editar o título"), botões Ativar/Pausar/Arquivar, Salvar, indicador "Salvo às".
- Canvas React Flow: zoom 0.02–2, fitView padding 0.6, `panOnScroll` desligado, seleção por arrasto, multi-seleção com Shift, MiniMap, controles (Aumentar/Diminuir zoom, Ajustar visão, Redefinir visão) (`pretty.js:241924–241960`).
- Botão flutuante **Ferramentas** abre a paleta de blocos com busca "Buscar blocos…"; blocos são arrastados para o canvas (`dataTransfer "application/reactflow"`) (`pretty.js:242356–242600`).
- Painel **Propriedades** (`flowProperties`): configurações do nó (tipo, nome, descrição, posição) e do fluxo (nome, descrição, status, estatísticas: total de nós, conexões, execuções).
- Cabeçalho de cada nó: Editar, Copiar, Excluir (`nodeHeader`).
- Aresta selecionada mostra botão "Excluir conexão".
- **Simulador** (botão "Simular"): chat lateral de teste local (ver 5.6).
- Painel/assistente "Leona AI" pode ser aberto no editor (prop `isLeonaAiOpen`) e edita o grafo via MCP — mudanças chegam por realtime (seção 7). Detalhes do assistente: módulo de IA [referência cruzada].
- Atalhos: Ctrl/Cmd+C copia nós selecionados, Ctrl/Cmd+V cola, Delete/Backspace exclui seleção (com confirmação) (`pretty.js:241609–241650`). `deleteKeyCode` nativo do React Flow desativado.
- Modal de edição de nó ("Editar Mensagem", "Editar Condicional", …; `nodeEditModal`), um editor específico por tipo.

### 2.3 Telas auxiliares (modais)
| Modal | Campos / conteúdo |
|---|---|
| Nova/Editar Pasta | Nome da pasta (texto), Cor (azul, verde, roxo, laranja, vermelho, amarelo, cinza) |
| Excluir Fluxo | Pergunta + **impacto** (execuções ativas a cancelar, execuções históricas removidas, configs de fluxo padrão removidas, configs de horário comercial desativadas, referências em outros fluxos "fluxo (nó: X)") + nota de que mídias não são removidas |
| Excluir Pasta | Confirmação simples |
| Compartilhar Fluxo | Mostra código de compartilhamento com botão copiar; nota "cópia completa e independente" |
| Importar Fluxo(s) | Textarea; vários códigos separados por vírgula ou quebra de linha |
| Traduzir fluxo | Idioma, incluir Texto (sempre), Áudio (voz econômica/premium + seletor de voz), Imagem, PDF; estimativa de tokens e preço; Confirmar/Comprar créditos (seção 5.7) |
| Criar fluxo a partir da conversa | Seleção de mensagens no chat → gera fluxo (`generateFlow.*`, `pretty.js:186040`) |

---

## 3. Modelo de dados / campos

### 3.1 Flow
| Campo | Tipo | Obrig. | Validação / default | Origem |
|---|---|---|---|---|
| `id` | int | — | servidor | — |
| `name` | string | sim | default "Novo Fluxo"; nome único dentro da pasta (sufixo " 1", " 2"… ao criar) | `pretty.js:247956–247970` |
| `description` | string | não | default "Fluxo criado automaticamente" | `pretty.js:247980` |
| `status` | enum | sim | `active` \| `paused` \| `draft` \| `archived`; criado como `active` | `pretty.js:247982` |
| `active` | bool | sim | criado `true` | idem |
| `flow_folder_id` | int\|null | não | null = "Sem pasta" | `pretty.js:96030` |
| `position` | int | não | ordem dentro da pasta (reorder) | `pretty.js:96030–96039` |
| `account_id` | int | — | se ≠ conta atual, editor redireciona para `/flows` | `pretty.js:247550` |
| `nodes_count` | int | — | exibido como "N blocos" | `pretty.js:243987` |
| `created_at`, `updated_at` | datetime | — | ordenação secundária | — |

Ordenação da lista: `flow_folder_id`, depois `position`, depois `created_at` (`pretty.js:96030`).

`editor_bundle` (GET) retorna `{ flow, nodes[], connections[] }` — validado no cliente (`pretty.js:96097`).

### 3.2 FlowFolder
| Campo | Tipo | Obrig. | Notas |
|---|---|---|---|
| `name` | string | sim | "Nome da pasta" |
| `color` | enum | sim [INFERIDO] | blue, green, purple, orange, red, yellow, gray |
| `parent_folder_id` | int\|null | não | aninhamento ilimitado [INFERIDO]; mover para subpasta própria é bloqueado no cliente |
| contadores | int | — | nº de fluxos e subpastas no card |

### 3.3 FlowNode
| Campo | Tipo | Obrig. | Notas | Origem |
|---|---|---|---|---|
| `id` | int | — | cliente usa id temporário até persistir e faz swap | `pretty.js:249252–249266` |
| `name` | string | sim | label do bloco; default "Nó"; prefixo "Nó de " é removido na exibição | `pretty.js:249253`, `210975` |
| `node_type` | enum | sim | ver 3.5; default `message` | `pretty.js:249254` |
| `position` | `{x,y}` | sim | coordenadas no canvas; nó START inicial em (1200, 800) | `pretty.js:240246` |
| `description` | string | não | "Descrição opcional do nó" | — |
| `actions[]` | FlowNodeAction[] | — | ordenadas por `order` | — |

Regras: o fluxo nasce com um nó `start` ("Início"); START não aceita conexão de entrada (`pretty.js:240539`); é necessário ≥1 nó após o Início para salvar ("Adicione pelo menos um nó após o Início para salvar o fluxo").

### 3.4 FlowNodeAction
| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | — |
| `action_type` | enum | ver 3.6 |
| `order` | int | ordem dentro do nó (nó Mensagem tem várias ações sequenciais) |
| `config` | JSON | específico por `action_type` |

Campos transitórios que **nunca** são persistidos/copiados: `uploadedFile`, `fileObject`, `carousel_pending_image_uploads`, `kieai_veo_pending_uploads`, `kieai_reference_pending_upload(s)` (`pretty.js:239787`).

### 3.5 Tipos de nó (`node_type`) — catálogo completo

Registrados em `nodeTypes` (`pretty.js:241550`) e na paleta (`pretty.js:242389–242597`). Rótulos de `flows.tools.*`.

| # | `node_type` | Rótulo pt-BR | Categoria paleta | Ações geradas | Handles de saída |
|---|---|---|---|---|---|
| 1 | `start` | Início | — (automático) | — | `source` (única) |
| 2 | `message` | Mensagem | basic | `send_message`, `send_multi_media`, `send_file`, `send_sticker`, `send_contact`, `delay_between_messages` (várias, ordenadas) | `source` |
| 3 | `template` | Template WhatsApp [REQUER WABA] | basic (só se flag de recurso liberada — hoje sempre visível) | `send_template` | `template-btn-<payload>` (1 por botão Quick Reply), `template-other`, `template-timeout`, `template-delivery-failed` |
| 4 | `tags` | Etiquetas | automation | `add_tags` ou `remove_tags` | `source` |
| 5 | `pix` | Botão PIX [INSTÁVEL NO BAILEYS] (botão nativo pode não renderizar; usar texto com chave copia-e-cola) | automation | `send_pix_button` | `source` |
| 6 | `interactive_menu` | Menu (recomendado) [INSTÁVEL NO BAILEYS] (botões/listas nativos falham em parte dos aparelhos; fallback menu numerado em texto) | automation | `send_interactive_menu` (+ `save_user_data` opcional) | `option-<i>` por opção, `menu-other`, `timeout` (inatividade) |
| 7 | `menu` | Menu (legado) [INSTÁVEL NO BAILEYS] (lista nativa; fallback menu numerado) | não aparece na paleta (só fluxos antigos) | `send_option_list` (+ `save_user_data`) | `option-<i>`, `menu-other`, `timeout`; botão "Copiar para bloco Menu" migra para `interactive_menu` |
| 8 | `carousel` | Carrossel [INSTÁVEL NO BAILEYS] (mensagem interativa não oficial; risco de não exibir) | automation | `send_carousel` | `carousel-reply-<buttonId>` por botão REPLY, `carousel-fallback`, `carousel-timeout` |
| 9 | `wait_response` | Aguarda Resposta | automation | `send_message` (opcional) + `wait_for_response` + `save_user_data` (opcional) | `client-response`, `timeout` (oculto se espera indefinida) |
| 10 | `chat_controller` | Controlador de Chat | automation | `change_chat_status` | `source` |
| 11 | `notification` | Notificação | automation | `send_notification` | `source` |
| 12 | `condition` | Condicional | logic | `evaluate_condition` | `success` (atende), `failure` (não atende) |
| 13 | `distributor` | Distribuidor | logic | `distribute_contacts` | `output-<outputId>` (≥2) |
| 14 | `connection_flow` | Conexão de Fluxo | logic | `execute_flow` | nenhuma (termina e redireciona) |
| 15 | `pixel` | Pixel | automation | `send_pixel_event` | `source` |
| 16 | `smart_interval` | Intervalo Inteligente | automation | `smart_interval` | `source` |
| 17 | `department` | Departamento | automation | `set_department` | `source` |
| 18 | `integration` | Integração (HTTP) | automation | `make_http_request` | `success`, `failure` |
| 19 | `ai` | Bloco de IA | automation | `ai_call` | sem condicionais: `success`/`failure`; com condicionais/comprovante: `output-<key>` por saída + `failure` |
| 20 | `ai_agent` | Agente de IA | automation | `control_ai_agent` | [INFERIDO] `source` no modo "Remover"; no modo "Entregar" a conversa passa ao agente e o fluxo termina |
| 21 | `kanban` | Kanban | automation | `create_kanban_card` ou `remove_kanban_card` | `source` |
| 22 | `manipulator` | Manipulador | automation | `set_contact_custom_field` ou `set_created_at` | `source` |
| 23 | `kieai_integration` | Integração Kie.ai | automation | `kieai_generate` | `success`, `failure` |
| 24 | `approved_sale` | Venda aprovada | automation | `register_approved_sale` | `source` |
| 25 | `payment` | Pagamento | automation | `create_payment_charge` (gateway xpag/zenith) | `charge_created`, `payment_approved`, `error` |
| 26 | `leonapay` | Leona Pay | automation | `create_payment_charge` (gateway `leonapay`) | `charge_created`, `payment_approved`, `error` |
| 27 | `make_call` | Ligar [INSTÁVEL NO BAILEYS] (chamada só toca/rejeita; áudio na chamada não é confiável) | automation | `make_call` | `source` |

Tipos legados vistos apenas em rótulos de propriedades (`flowProperties.type*`): Pergunta, Mídia, Probabilidade, Agendamento, API Call — [NÃO VERIFICADO] se ainda existem no backend.

### 3.6 Tipos de ação (`action_type`) e `config`

Contagem de ocorrências no bundle confirma 37 action types (`grep action_type ===`).

#### Nó Mensagem (`message`) — `pretty.js:215600–215740`
| action_type | Campos de config | Default / validação |
|---|---|---|
| `send_message` | `message_text` (string, obrig. "Conteúdo da Mensagem *"), `typing_delay_seconds` (int; delay "digitando"), `vary_text_with_ai` (bool; "Variar Texto com IA"), `ai_integration_id` (chave GPT/Gemini usada para variar), `delete_on_label_enabled` (bool), `delete_on_label_id` / `delete_on_label_name` (etiqueta que, ao ser aplicada ao chat, apaga a mensagem no WhatsApp) | formatação WhatsApp: negrito, itálico, tachado, emojis, inserir variável |
| `send_multi_media` | `media_type` (`image`\|`video`\|`audio`), `media_source` (`file`\|`url`\|`ai` para áudio), `messages[]` (itens com url/arquivo, `caption`, `view_once`), `media_url`, `uazapi_video_type` (`video`=Normal \| `videoplay`=Autoplay \| `ptv`=Vídeo msg.), `audio_forward` (bool "Enviar como gravado", default true), `typing_delay_seconds` (delay "gravando"), velocidade de reprodução (prévia), `ai_audio_text`, `elevenlabs_voice_id`, `elevenlabs_model_id` (áudio gerado por IA) | Limites: imagem 2 MB (JPG/PNG/WebP/HEIC/HEIF), vídeo 20 MB (MP4/WebM/OGG/MOV/M4V), áudio 16 MB (MP3/OGG; na API oficial "gravado" exige OGG/Opus). `view_once` não disponível na API oficial |
| `send_file` | `file_name` (obrig.), `file_url`, `media_source` | máx. 30 MB; qualquer tipo (docs PDF/DOC/DOCX/TXT/XLS/XLSX recomendados) |
| `send_sticker` | `sticker_name` (obrig.), `sticker_url`, `media_source` | JPG/PNG/WebP, 2 MB |
| `send_contact` | `contact_name` (obrig.), `contact_phone` (obrig.) | aceita variáveis |
| `delay_between_messages` | `delay_seconds`, `delay_min_seconds`, `delay_max_seconds` | aleatório entre mín. e máx.; máx. 120 s (`pretty.js:215192`) |

Modelos de voz ElevenLabs no áudio IA: Eleven v3, Multilingual v2, Turbo v2.5, Flash v2.5. Requer integração ElevenLabs cadastrada.

Upload de mídia: `POST /flows/:id/flow_nodes/:nodeId/actions/:actionId/upload_media` (multipart `media_file`). Nó precisa estar salvo antes.

#### Template WhatsApp (`template`) — `pretty.js:240185`, `234956`
`send_template` [REQUER WABA]: `whatsapp_template_id` (obrig. [INFERIDO]), `template_name`, `variable_mappings[]`, `header_variable_mapping`, `body_parameters[]`, `header_parameter`, `button_payloads{}` (índice → payload; vira handle), `cta_buttons[]`, `timeout_value` (default 60), `timeout_unit` (default `minutes`). Seção opcional "Cobrança Pix (produto + pagamento)": nome do produto, imagem (HTTPS), beneficiário, chave/EMV, valor R$, referência. Somente API oficial (Meta).

#### Etiquetas (`tags`) — `pretty.js:220079`
`add_tags` / `remove_tags`: `action` (`add`\|`remove`), `tags[]` (nomes). Alternância "Adicionar/Remover etiquetas"; digitar + Enter cria etiqueta nova. Validação: ≥1 etiqueta.

#### Botão PIX (`pix`) — `pretty.js:220384–220420`
`send_pix_button`: `pix_key` (obrig.), `pix_type` (default `EVP`=Chave aleatória; também CPF/CNPJ/Telefone/E-mail — valida formato), `merchant_name` (destinatário; obrig. na API oficial; default "Pix"), `amount_reais` (obrig. na API oficial), `pix_body` (texto do card, só API oficial) [REQUER WABA], `header_image_url` (só http(s); só API oficial) [REQUER WABA].

#### Menu (`interactive_menu`) — `pretty.js:221700–221760`, `240025`
`send_interactive_menu`:
| Campo | Tipo | Notas |
|---|---|---|
| `menuType` | enum | `list` (Lista) \| `button` (Botões) \| `url` \| `call` (Chamada) [INSTÁVEL NO BAILEYS] (todos são interativos nativos) |
| `message` | string | obrig. |
| `buttonLabel` | string | obrig. em `list` ("Texto do Botão") |
| `footerText` | string | opcional |
| `imageButtonEnabled`, `imageButtonSource`, `imageButton` | bool/enum/string | só `button`; URL/base64; não enviada na API oficial |
| `options[]` | `{id, title, description, type?}` | `id` estável gerado (`option_<timestamp>`), `title` obrig.; em botões `type` ∈ REPLY/URL/COPY/CALL e o 2º campo vira URL/texto a copiar/telefone [INFERIDO]; COPY só funciona em template na API oficial [REQUER WABA] |
| `timeout_value`, `timeout_unit` | int/enum | 0 = padrão 2 dias; unidades seconds/minutes/hours/days; máx. 31 dias |
`save_user_data` (opcional): `field_name`, `save_empty: true` — salva a resposta do usuário num campo.
Validações: mensagem, ≥1 opção, todos os títulos.

#### Menu legado (`menu`)
`send_option_list` com a mesma estrutura de opções; exibe aviso de descontinuação e ação "Copiar para bloco Menu" (cria `interactive_menu` com mesma config e transfere as conexões).

#### Carrossel (`carousel`) — `pretty.js:233530–233600`
`send_carousel`:
| Campo | Default | Notas |
|---|---|---|
| `text` | "Escolha uma opção abaixo" | texto introdutório, obrig. |
| `delay` | 300 | ms antes do envio |
| `readchat`, `readmessages` | true | marcar chat/mensagens como lidos [INSTÁVEL NO BAILEYS] (best effort; depende da privacidade de leitura do número) |
| `gatilho.timeout_value` / `timeout_unit` | 0 / days | prazo para tocar num botão REPLY (0 = 2 dias, máx. 31 dias); legado `ttl_horas` 1–720 |
| `gatilho.fallback_unico` | true | fallback de texto livre uma vez por gatilho |
| `gatilho.desarma_em_bloco_terminal` | true | — |
| `carousel[]` (cartões, máx. 10) | — | `card_id`, `text` (obrig.), `media_kind` (só `image` válido; video/document geram erro), `media_source` (file\|url), `image`, `video`, `document`, `filename`, `buttons[]` (máx. 3: `{id, text, type: REPLY\|URL\|COPY\|CALL, payload}`) |
Regras: títulos REPLY únicos no bloco; cada cartão precisa de imagem (URL ou upload ≤20 MB JPEG/PNG/WebP/HEIC). Só conexões UAZAPI (não oficiais). Após envio o fluxo segue imediatamente por `carousel-fallback` e cliques são tratados enquanto o gatilho estiver ativo. Upload: `.../upload_carousel_media` (`media_file`, `card_index`, `media_field`).

#### Aguarda Resposta (`wait_response`) — `pretty.js:222560–222650`
`wait_for_response`: `wait_indefinitely` (bool, default false), `timeout_value` (default 1), `timeout_unit` (default `days`; seconds/minutes/hours/days; total ≤31 dias), `reply_to_lead_enabled` (responder citando a mensagem do lead), `reply_to_lead_next_messages_count` (1–5), `react_to_lead_check_enabled` + `react_to_lead_reaction_emoji` (default ✅) [INSTÁVEL NO BAILEYS] (reação suportada, sem garantia de entrega), `buffer_enabled` + `buffer_value` (1–300 s, default 30; agrupa mensagens do lead numa variável). Mensagem antes de aguardar → `send_message.message`; campo para salvar → `save_user_data.field_name`.

#### Controlador de Chat (`chat_controller`) — `pretty.js:223116`
`change_chat_status`: `chat_status` ∈ `Aguardando` \| `Atendimento` \| `Resolvidos` (valores em português; default Aguardando).

#### Notificação (`notification`) — `pretty.js:223251`
`send_notification`: `name` (obrig.), `phone` (obrig., sem DDI, validado), `country_code` (DDI do seletor), `message` (obrig.). Envia mensagem WhatsApp a um número interno (ex.: avisar equipe).

#### Condicional (`condition`) — `pretty.js:223697`, `224300–224530`
`evaluate_condition`: `ruleType` (`all` = E \| `any` = OU), `conditions[]`. Cada condição:
| category | Campos | Operadores |
|---|---|---|
| `system` / `tag` | `systemSubtype:"tag"`, `tagName`/id | igual, diferente |
| `system` / `weekday` | `weekday` (monday…sunday) | igual, diferente |
| `system` / `time` | `time` (0–23), `timeMinute` (0–59) | antes, durante(=igual legado), depois |
| `system` / `date` | `date` | antes, durante, depois |
| `system` / `message_window` [REQUER WABA] | — | `open` / `closed` (janela 24h; em conexão não oficial sempre aberta) |
| `attendance` | `attendanceStatus` ∈ waiting/in_progress/resolved | — |
| `attendant` | `user_ids[]` | "é um destes atendentes" |
| `field` | `fieldName` ∈ name/phone/email | texto: equal, different, contains, not_contains, starts_with, has_value, `type` (tipo da resposta: texto/áudio/imagem/vídeo/documento/sticker); número: greater_than, less_than, greater_or_equal, less_or_equal, numeric_equal |
| `custom_field` | `fieldName` (campo do contato) | mesmos operadores |
| `global_variable` | `fieldName` (`g_*`) | mesmos operadores |
Valor aceita variáveis `{...}`; números com vírgula ou ponto. Saída `success` = regra atendida; `failure` = "Caso não atenda a condição".

#### Distribuidor (`distributor`) — `pretty.js:225279`
`distribute_contacts`: `outputs[]` `{id ("output_N"), name ("Saída N"), quantity}`, toggles "Distribuir sempre para próximo" e "Prevenir repetição" (repetidos vão para a mesma saída anterior vs. próxima). Mín. 2 saídas. Contadores (`quantity`) são atualizados em tempo real pelo backend (`distributor_updated`).

#### Conexão de Fluxo (`connection_flow`) — `pretty.js:225585–225645`
`execute_flow`: `target_flow_id` (obrig.), `target_flow_name`. Seletor só lista fluxos com `status=active` e `active=true`. O nó encerra o fluxo atual e inicia o destino.

#### Pixel (`pixel`) — `pretty.js:226146–226252`
`send_pixel_event`: `tracking_type` (default "Facebook"), `pixel_config_id` (obrig., de Configurações → Pixels), `pixel_config_name`, `event_type` (`Compra` \| `Lead`), `item_value` (obrig. para Compra; aceita variável), `page_id` (opcional; não exigido na API oficial), `currency` (default BRL; ~16 moedas ou variável). Envia via Conversions API.

#### Intervalo Inteligente (`smart_interval`) — `pretty.js:240169`, `227090–227132`
`smart_interval`: `schedule_type` ∈ `time` (Intervalo) \| `date` (Data) \| `weekly` (Horários).
- `time`: `interval_value` (>0, default 1), `interval_unit` (minutes/hours/days; total ≤31 dias).
- `date`: `scheduled_date` (datetime local; não pode estar no passado).
- `weekly`: `weekly_schedule` = `{monday…sunday: {enabled, start_time "09:00", end_time "18:00"}}`; ≥1 dia ativo; fim > início. Ação "Copiar horários de funcionamento" importa de uma conexão (une faixas do mesmo dia).

#### Departamento (`department`) — `pretty.js:227773`
`set_department`: `department_id` (obrig.), `department_name`, `department_color`.

#### Integração HTTP (`integration`) — `pretty.js:228080–228110`
`make_http_request`: `request_method` (POST/PUT/GET), `request_url` (obrig.; aceita variáveis), `request_headers` (objeto JSON, opcional), `request_body` (JSON com aspas retas; números podem ir sem aspas), `response_fields[]` / `response_mapping{}` (nome do campo → caminho com notação de ponto, ex. `data.status` ou `0.status`). Botão "Testar requisição" mostra status e JSON e permite escolher campos. Variáveis geradas: `response.type`, `response.erro` + campos mapeados.

#### Bloco de IA (`ai`) — `pretty.js:229074`, `211390–211470`
`ai_call`:
| Campo | Default | Notas |
|---|---|---|
| `provider` | `gpt` | `gpt` \| `gemini` \| `openrouter` \| `leona_ai` (créditos da conta, sem chave); DeepSeek "em breve" |
| `api_key_source` | `manual` | `manual` (chave fixa ou `{g_variavel}`) \| integração cadastrada |
| `api_key`, `ai_integration_id` | — | — |
| `model` | gpt-5.4-mini | listas por provedor (GPT-4.1…GPT-6.x; Gemini 2.5/3.x; OpenRouter catálogo dinâmico c/ busca; modelos antigos gpt-4o são migrados) |
| `user_message` | `{last_user_message}` (placeholder) | mensagem enviada ao modelo |
| `system_prompt` | — | "Prompt de IA / Comportamento" |
| `response_variable` | `ai.response` | sempre salva também em `ai.response` |
| `fail_reason_variable` | `ai.fail.reason` | — |
| `auto_send_response` | true | envia resposta ao lead |
| `maintain_context` / `context_interactions` | false / 5 | máx. 20 |
| `understand_audio` / `understand_image` / `understand_pdf` | false | consomem mais tokens |
| `understand_receipt` | false | identifica comprovante; cria saída `comprovante` |
| `validate_receipt_pix_key` + `expected_pix_keys[]` | false | até 5 variações; saída `comprovante_pix_errada` |
| `validate_receipt_recipient` + `expected_recipient_names[]` | false | até 5; saída `comprovante_nome_errado` |
| `output_conditions[]` | — | até 10 `{prompt (≤200 chars), output_key}`; ordem = prioridade |
| `fallback_output_key` | `fallback` | "Saída padrão", obrig. quando há condicionais |
Handles: `output-<key>` para cada saída (comprovante primeiro, depois condicionais, padrão por último) + `failure` ("Falha (erro de IA)"). Sem condicionais: `success`/`failure`. Validação ao salvar: todos os nomes de saída preenchidos.

#### Agente de IA (`ai_agent`) — `pretty.js:238124–238163`
`control_ai_agent`: `mode` (`activate` = Entregar \| `deactivate` = Remover), `agent_id` (obrig. em activate; lista agentes da conta com status rascunho/ativo/pausado). Agentes são configurados no módulo Agentes de IA [ref. cruzada].

#### Kanban (`kanban`) — `pretty.js:230845–230900`
`create_kanban_card`: `crm_id` (obrig.), `crm_name`, `crm_column_id` (obrig.), `crm_column_name`, `crm_column_conversion_goal`, `value` (só se a coluna é meta de conversão; aceita variável). `remove_kanban_card`: `crm_id` (remove de qualquer etapa).

#### Manipulador (`manipulator`) — `pretty.js:231162–231290`
- `set_contact_custom_field`: `field_name` (obrig.; sugere campos já usados), `operation` (`set_value` \| `add` \| `subtract` \| `multiply` \| `divide`), `value_type` (`text` \| `number`), `value` (texto/variáveis ou operando). Operações matemáticas usam o valor atual (0 se vazio); divisão por zero gera erro.
- `set_created_at`: `operation` só `set_value`, `value` (data/hora "dd/MM/aaaa HH:mm:ss" fuso São Paulo ou ISO 8601, ou variáveis).

#### Integração Kie.ai (`kieai_integration`) — `pretty.js:231525–231990`
`kieai_generate`: `api_key` (obrig.), `generation_type` (`audio`\|`image`\|`music`\|`video`), `model`, `params{}`, `output_variable` (letras/números/ponto/underscore), `prompt_parallel_count` (imagem, 1–5, prompts paralelos).
| Tipo | Modelos | params |
|---|---|---|
| audio | ElevenLabs Multilíngue v2, Turbo 2.5 | `text` (obrig.), `voice` (Rachel/Adam/Bella/Antoni/Elli/Josh/custom + ID customizado), `stability` 0.5, `similarity_boost` 0.75, `style` 0, `speed` 1 |
| image | Nano Banana 2 / Pro, GPT Image 1.5, GPT Image 2, WAN 2.7 / Pro | `prompt` (obrig.), `image_input` ou `input_urls` (até 10 referências: upload/URL/variável), `aspect_ratio`, `resolution` (1K/2K/4K), `output_format` (png/jpg/jpeg), `quality` (low/medium/high), `nsfw_checker` |
| music | Suno V6 | `prompt`, `customMode`, `instrumental` (default true), `style`, `title` |
| video | Veo 3.1 Fast/Quality/Lite | `prompt` (obrig.), `resolution` (720p/1080p/4k), `aspect_ratio` (16:9/9:16/auto), `first_frame_url`, `last_frame_url` (exige primeiro) |
Variáveis geradas: `kie.ai.image_1…N`, `kie.ai.result_audio`, `kie.ai.result_music(_2)`, `kie.ai.result_video`, `kie.ai.status`, `kie.ai.erro`. Uploads: `.../upload_kieai_veo_media` (`frame_slot`), `.../upload_kieai_reference_media` (`reference_field`, `reference_index`).

#### Venda aprovada (`approved_sale`) — `pretty.js:235415–235440`
`register_approved_sale`: `product_public_id` (obrig.; pode criar produto inline), `amount_template` (default `{comprovante.valor}`), `currency_template` (default `{comprovante.currency}`; vazio = moeda do produto), `customer_name_template` (default `{comprovante.nome_pagador}`), `note_issuer_id` (emissor de nota fiscal, opcional), `utmify_integration_id` (opcional), `push_title_template`, `push_body_template` (variáveis `produto.nome`, `venda.valor`, `venda.moeda`, `venda.cliente`). Valores fora do intervalo do produto usam preço fallback.

#### Pagamento / Leona Pay (`payment`, `leonapay`) — `pretty.js:236495–236620`
`create_payment_charge`:
| Campo | Default | Notas |
|---|---|---|
| `gateway` | `leonapay` (nó leonapay) | `xpag` \| `zenith` \| `leonapay` |
| `payment_integration_id` | null | chave cadastrada em Integrações → Pagamentos (obrig.) |
| `currency` | BRL | BRL, MXN, ARS, COP, PEN, INR, PHP, USD, VES, EUR (conforme gateway) |
| `method` | PIX | Leona Pay: BRL PIX/BOLETO; MXN SPEI/OXXO; COP PSE/NEQUI/BREB/BANK_TRANSFER; ARS/USD BANK_TRANSFER; + Dinheiro, Pago Móvil, MB WAY. XPag: COP NEQUI/BREB, MXN SPEI/OXXO. Zenith: BRL pix; COP pse/bre-b-llave/nequi; MXN oxxo/spei/codi; PEN yape/plin/bank-transfer/cash; ARS bank-transfer; INR upi; PHP gcash/maya |
| `amount` | "100,00" | obrig.; limites: OXXO MX$10–10.000; COP mín. 10.000 |
| `open_amount` | false | "Chave sem valor" (lead paga quanto quiser) |
| `name`, `phone`, `email`, `document`, `document_type`, `bank_code` | `{full_name}`, `{phone_number}` | validações por país (ex. celular colombiano 10 dígitos iniciando em 3) |
| `address_*` (street, number, district, city, state, postal_code) | "" | boleto |
| `listener_ttl_value` / `listener_ttl_unit` | 2 / days | por quanto tempo uma confirmação ainda interrompe o contato |
Handles: `charge_created`, `payment_approved` (via webhook), `error`. Variáveis: `gateway.transaction_id`, `gateway.payment_link`, `gateway.payment_code`, `gateway.payment_llave`, `gateway.payment_qrcode`, `gateway.value`, `gateway.erro`, banco/beneficiário.

#### Ligar (`make_call`) — `pretty.js:236088–236157`
`make_call`: `call_duration` (1–15 s, default 8), áudio opcional (upload MP3/OGG/M4A ≤16 MB ou URL/variável; duração total = toque + áudio). Só UAZAPI; aviso de risco de bloqueio.

#### Outros action types citados
`apply_label`, `compose_message`, `send_template` (acima), `trigger_flow` (usado em "skills" de Agentes de IA, `pretty.js:281326` — ref. cruzada), `register_approved_sale` (acima). `apply_label`/`compose_message`: [NÃO VERIFICADO] (1 ocorrência cada; possivelmente de outro módulo).

### 3.7 FlowConnection (aresta)
| Campo | Tipo | Notas |
|---|---|---|
| `from_node_id`, `to_node_id` | int | — |
| `condition_type` | enum | `always`, `timeout_or_unknown`, `menu_option`, `menu_other`, `menu_timeout`, `carousel_button`, `carousel_fallback`, `carousel_timeout`, `template_button`, `template_other`, `template_timeout`, `template_delivery_failed` [REQUER WABA]; `carousel_*` e `menu_*` [INSTÁVEL NO BAILEYS] (dependem de mensagens interativas) |
| `condition_config` | JSON | `type`, `source_handle`, `option_index`/`option_id`/`option_title`/`option_description`, `response_type` (`client-response`/`timeout`/`menu-other`), `condition_result` (`success`/`failure`/`charge_created`/`payment_approved`/`error`), `output_id`/`output_name`/`output_quantity` (distribuidor), `output_key` (IA), `button_id`/`payload` (carrossel/template) |
Mapeamento handle ↔ condição: `pretty.js:239995–240023` (leitura) e `248370–248560` (gravação).
Regra: **cada handle de saída tem no máximo uma aresta**; conectar de novo substitui a anterior (cliente apaga e recria). Nó START não recebe arestas.

### 3.8 ConnectionFlowConfig (Fluxos padrões por conexão — gatilhos) — `pretty.js:101528–101570`, `101960–101990`, i18n `16636+`
| Campo | Tipo | Default | Significado |
|---|---|---|---|
| `connection_id` | int | — | conexão WhatsApp |
| `welcome_flow_id` | int\|null | null | Boas-vindas: novo contato, primeira mensagem |
| `default_response_flow_id` | int\|null | null | Resposta padrão: sem palavra-chave, após inatividade |
| `default_response_delay_hours` | int | 24 | horas de inatividade |
| `finished_conversation_flow_id` | int\|null | null | cliente reabre conversa concluída |
| `finished_attendance_flow_id` | int\|null | null | no momento em que atendimento é concluído |
| `keyword_triggers[]` | `{flow_id, rule_type (any/all), conditions[{keyword, match_type}]}` | [] | prioridade sobre os demais; `match_type` ∈ equals, contains (default), different, excludes, starts_with, ends_with |
Status do card: empty / incomplete / complete (nº de slots preenchidos dos 4). Bulk update aplica a várias conexões com sentinelas `__keep__` / `__clear__`. Detalhe completo no módulo de Configurações/Conexões.

### 3.9 Variáveis de template (`{...}`) — `pretty.js:91400–91530`
Sintaxe: chaves simples `{nome}` (ex.: `{first_name}`); globais `{g_nome}`; campos customizados pelo nome.
| Grupo | Variáveis |
|---|---|
| Contato | `full_name`, `first_name`, `phone_number`, `created_at` (dd/MM/aaaa HH:mm:ss SP), `email` [INFERIDO], campos customizados |
| Sistema | `attendant_name`, `user_email` (e-mail do owner, somente leitura), `instance_number`, `instance_name`, `hora` (HH:mm), `data` (dd/MM), `dia` (dia da semana), `saudacao` (Bom dia/Boa tarde/Boa noite), `last_user_message` |
| Resposta/integração | `response.type` (MIME da resposta), `response.erro` |
| IA | `ai.response`, `ai.fail.reason`, `ai.erro` |
| Comprovante | `comprovante.nome_recebedor`, `.nome_pagador`, `.valor`, `.currency`, `.banco`, `.data`, `.doc_pagador`, `.doc_recebedor`, `.chave_pix`, `.pix_valido`, `.pix_similaridade`, `.recebedor_valido`, `.recebedor_similaridade`, `.valido` |
| Gateway | `gateway.transaction_id`, `.payment_link`, `.payment_code`, `.payment_llave`, `.payment_qrcode`, `.value`, `.erro` |
| Anúncios (lead CTWA) [INSTÁVEL NO BAILEYS] (referral do anúncio nem sempre chega no protocolo Web) | `ctwa_clid`, `source_url`, `source_id`, `media_url`, `thumbnail_url` |
| Kie.ai | `kie.ai.*` (ver 3.6) |
| Venda (push) | `produto.nome`, `venda.valor`, `venda.moeda`, `venda.cliente` |
Aviso de colisão: "a variável X já está sendo usada em outro bloco".

---

## 4. Estados e transições

### 4.1 Status do fluxo
| Valor | Rótulo card | Rótulo propriedades |
|---|---|---|
| `active` | ATIVO | Ativo |
| `paused` | PAUSADO | Pausado |
| `draft` | RASCUNHO | Rascunho |
| `archived` | ARQUIVADO | Arquivado |
Transições: criar → `active`; Ativar (`/activate`) de paused/draft; Pausar (`/pause`); Arquivar (`/archive`); Desarquivar (`/unarchive`); "Reativar" no menu. O backend pode **pausar automaticamente** (evento `flow_status_updated` → aviso "Fluxo pausado automaticamente"). Falha de ativação retorna `details` {status, has_start_node, total_nodes, node_types} mostrados ao usuário.

### 4.2 Execução de fluxo
[INFERIDO] estados ativos/cancelados (`flow_execution_created`, `flow_execution_cancelled`). Esperas: wait_response, menu, carousel, template, smart_interval, payment listener.

### 4.3 Run de tradução
`queued` (Na fila) → `running` (Traduzindo) → `completed` (Concluído) \| `failed` (Falhou) \| `canceled` (Cancelado). Estágios: copy, text, audio, image, pdf, media, settle (Fechamento).

### 4.4 Simulador
`running` / `waiting` (kind: wait_response, menu, smart_interval, condition_choice, carousel, template, distributor, ai_choice, integration_choice, kieai_choice, payment_choice) / `finished`.

### 4.5 Unidades de tempo
seconds, minutes, hours, days; limite global de espera 744 h = 31 dias (`pretty.js:159909`).

---

## 5. Ações e regras de negócio

### 5.1 Lista
- **Novo fluxo**: gera nome único na pasta, cria com status active, abre editor (`pretty.js:247956–247995`).
- **Excluir fluxo**: primeiro GET `deletion_impact` → modal com impacto → DELETE. Excluir pasta: confirmação.
- **Duplicar**: POST duplicate; mantém na pasta atual.
- **Compartilhar**: GET share_code → modal com código copiável.
- **Importar**: 1 código → `{flow_id, share_code}`; vários → `{flow_ids, share_codes}`. Cópia independente.
- **Mover/reordenar**: drag & drop; `move_to_folder`, `remove_from_folder`, `reorder {position}`.
- Mensagens de sucesso/erro para cada ação (`flows.index.*`).

### 5.2 Editor — persistência
- Criar nó: POST `flow_nodes` com `{name, node_type, position, description}`; id temporário substituído pelo real; se o nó foi apagado antes de persistir, o cliente apaga no servidor.
- Ações do nó: `add_action`, PATCH `actions/:id`, DELETE; carrossel usa `?carousel_draft_sync=true`.
- Conexões: POST/PUT/DELETE `flow_connections`; se falhar parcialmente, aviso "N conexão(ões) não foram salvas".
- Validações ao salvar: ≥1 nó após Início; carrossel com texto introdutório e textos de cartões; IA com nomes de saída; erro genérico "Faltam informações obrigatórias no bloco" + mensagens específicas (`flows.validation.*`, ~80 regras — ver 3.6).
- Sem `flows.edit`: editor em modo somente leitura e mensagem "Você não tem permissão para editar fluxos".

### 5.3 Copiar/colar nós
- Clipboard dual: `localStorage["leona.flowClipboard.v1"]` + texto no clipboard do SO com prefixo `leona-flow-clipboard:v1:` e payload `{version:1, marker, accountId, sourceFlowId, copiedAt, nodes[{sourceNodeId, position, nodeType, name, description, actions}]}` (`pretty.js:239775–239990`).
- Colar chama `POST /flows/:id/paste_nodes {source_flow_id, nodes[{id, position}]}` (servidor clona nós e conexões internas); deslocamento +50/+50.
- Regras: fluxo/nó precisam estar salvos; bloqueia cópia de outra conta ("A cópia pertence a outra conta"); uma colagem por vez.

### 5.4 Excluir nó/conexão
Confirmação "Tem certeza que deseja excluir o nó X?" / "N nós?"; falha mantém o bloco.

### 5.5 Execução a partir do chat (ref. cruzada Chat)
- Dropdown de fluxos disparáveis (`GET /flows/names?triggerable_only=true`) → `POST /flows/:id/trigger {chat_id}`.
- Indicador de fluxos ativos no chat (`GET /chats/:id/active_flow_executions`) e botão "parar fluxo" (cancela todas via `POST /flow_executions/:id/cancel`).
- Dados de IA por execução: `GET /chats/:id/flow_executions_with_ai_data`.
- Por conexão: "Parar todos os fluxos ativos" (`GET` resumo + `POST /connections/:id/cancel_all_active_flow_executions`, exige digitar o nome da instância) — módulo Conexões.
- Gerar fluxo a partir de mensagens selecionadas: `POST /flows/from_conversation {chat_id, message_ids, name}`.

### 5.6 Simulador (`pretty.js:195770–197200`)
Teste local que percorre o grafo: mostra mensagens do bot, pede resposta do usuário em esperas, oferece quick replies por handle (ex.: "Simular timeout", opções do menu, Sucesso/Falha, saídas do distribuidor, saídas da IA, "Simular webhook (pagamento aprovado)"). Detecta: sem START, sem próximo passo, loop curto, caminho longo demais (para por segurança). Simula remoção de mensagens por etiqueta (`delete_on_label`). Nós não suportados exibem "ainda não é simulado. Seguindo." Nada é enviado nem salvo.

### 5.7 Tradução de fluxo
- Disponível se `flows.edit` e `GET /flow_translations/settings` → `enabled: true`.
- Escolher locale (`GET /flow_translation_locales`), incluir áudio (provider `fish` = econômica com voz escolhida em `GET /flow_translations/voices` ou clone da original; `eleven` = premium/dublagem), imagem, PDF (aviso de custo/precisão).
- Estimativa: `POST /flows/:id/translation_estimate {locale_code, include_audio, include_image, include_pdf, audio_provider}` → tokens e preço em R$ (breakdown texto/áudio/imagem/PDF).
- Confirmar: `POST /flows/:id/translations {…, audio_voice_id}`; créditos insuficientes → "Comprar créditos" (carteira `GET /flow_translations/wallet`).
- Progresso em segundo plano (evento realtime), banner com "Abrir cópia" / "Ver relatório" (erros: placeholder_mismatch, over_limit, validation_failed…; avisos: image_not_generated, missing_voice, currency_manual…). Valores em BRL de botões/PIX/venda não são convertidos automaticamente.
- Já existe cópia no idioma → aviso, confirmar cria outra.

---

## 6. Endpoints da API

Base: `https://apiaws.leonasolutions.io/api/v1` (`pretty.js:11470`). Wrapper `xe` (JSON); pastas usam `fetch` direto.

| Método | Caminho | Payload / params | Ref |
|---|---|---|---|
| GET | `/flows` | `?folder_id=` → `{flows, folders, meta}` | `96052` |
| GET | `/flows?all_flows=true` | todos (busca global, seletor de fluxo) | `96062` |
| GET | `/flows/names` | `?triggerable_only=true` → `{flows:[{id,name}]}` | `96069` |
| GET | `/flows/:id` | — | `96090` |
| GET | `/flows/:id/editor_bundle` | → `{flow, nodes, connections}` | `96101` |
| POST | `/flows` | `{flow:{name, description, active, status, flow_folder_id}}` | `96114` |
| POST | `/flows/from_conversation` | `{chat_id, message_ids, name}` | `96123` |
| PUT | `/flows/:id` | `{flow:{…}}` | `96133` |
| GET | `/flows/:id/deletion_impact` | → active_executions, total_executions, connection_flow_configs[], business_hour_configs[], referenced_by_flows[] | `96139` |
| DELETE | `/flows/:id` | — | `96145` |
| POST | `/flows/:id/activate` \| `/pause` \| `/archive` \| `/unarchive` | `{}` → `{flow}` | `96149–96182` |
| POST | `/flows/:id/duplicate` | `{}` → `{flow}` | `96167` |
| POST | `/flows/:id/paste_nodes` | `{source_flow_id, nodes[{id, position}]}` → `{nodes, connections}` | `96173` |
| GET/POST | `/flows/:id/flow_nodes` | `{flow_node:{name,node_type,position,description}}` | `96188–96199` |
| GET/PUT/DELETE | `/flows/:id/flow_nodes/:nodeId` | `{flow_node}`; GET retorna `actions` | `96201–96217` |
| POST | `/flows/:id/flow_nodes/:nodeId/add_action` | `{flow_node_action}`; `?carousel_draft_sync=true` | `96218` |
| PATCH/DELETE | `/flows/:id/flow_nodes/:nodeId/actions/:actionId` | `{flow_node_action}` | `96228–96243` |
| POST | `…/actions/:actionId/upload_media` | multipart `media_file` | `96396` |
| POST | `…/actions/:actionId/upload_carousel_media` | `media_file`, `card_index`, `media_field` | `96410` |
| POST | `…/actions/:actionId/upload_kieai_veo_media` | `media_file`, `frame_slot` | `96421` |
| POST | `…/actions/:actionId/upload_kieai_reference_media` | `media_file`, `reference_field`, `reference_index` | `96434` |
| GET/POST | `/flows/:id/flow_connections` | `{flow_connection:{from_node_id,to_node_id,condition_type,condition_config}}` | `96244–96255` |
| PUT/DELETE | `/flows/:id/flow_connections/:connId` | — | `96257–96267` |
| GET | `/flows/:id/executions` | — | `96269` |
| GET | `/flow_executions/:id` | — | `96274` |
| POST | `/flows/:id/trigger` | `{chat_id}` | `96280` |
| POST | `/flow_executions/:id/cancel` | `{}` → `{execution}` | `96286` |
| GET | `/chats/:id/active_flow_executions` | → `{executions}` | `96293` |
| GET | `/chats/:id/flow_executions_with_ai_data` | → `{executions}` | `96320` |
| POST | `/flows/:id/move_to_folder` | `{folder_id}` | `96346` |
| POST | `/flows/:id/remove_from_folder` | `{}` | `96354` |
| POST | `/flows/:id/reorder` | `{position}` | `96360` |
| GET | `/flows/:id/share_code` | — | `96366` |
| POST | `/flows/import` | `{flow_id, share_code}` ou `{flow_ids[], share_codes[]}` | `96372–96390` |
| GET | `/flow_folders` | `?parent_folder_id=` | `187735` |
| GET/PATCH/DELETE | `/flow_folders/:id` | `{flow_folder:{name,color,parent_folder_id}}` | `187768–187860` |
| POST | `/flow_folders` | `{flow_folder}` | `187783` |
| POST | `/flow_folders/:id/move_to_folder` | `{parent_folder_id}` | `187864` |
| GET | `/connection_flow_configs` **(fonte: REA)** | — | `101530` |
| GET/PATCH/DELETE | `/connection_flow_configs/:id` | `{connection_flow_config}` | `101535–101565` |
| POST | `/connection_flow_configs` **(fonte: REA)** | `{connection_flow_config}` | `101549` |
| POST | `/connection_flow_configs/bulk_update` **(fonte: REA)** | `{connection_ids[], connection_flow_config}` | `101557` |
| GET | `/flow_translations/voices` **(fonte: REA)** | — | `116733` |
| GET | `/flow_translation_locales` **(fonte: REA)** | — | `116738` |
| GET | `/flow_translations/settings` **(fonte: REA)** | → `{enabled}` | `116743` |
| GET | `/flow_translations/wallet` **(fonte: REA)** | — | `116748` |
| POST | `/flows/:id/translation_estimate` | `{locale_code, include_audio, include_image, include_pdf, audio_provider}` | `116754` |
| POST | `/flows/:id/translations` | idem + `audio_voice_id` | `116760` |
| GET | `/flows/:id/translations/:runId` | — | `116766` |
| GET | `/flow_translations/runs` **(fonte: REA)** | histórico | `116772` |
| GET/POST | `/admin/flow_translations/*` **(fonte: REA, parcial)** | overview, usage, runs (+refund), usage_events (+refund), locales CRUD, settings, secrets, billing_configs — módulo Admin | `260524–260640` |
| GET | `/admin/redis_health/flow_execution` **(fonte: REA)** | saúde da fila de execução — módulo Admin | `256598` |
| POST | `/ai_agents/estimate_from_flow`, `/ai_agents/create_from_flow_runs` **(fonte: REA)** | criar agente de IA a partir de fluxo — módulo Agentes de IA | — |

Endpoints auxiliares consumidos pelos editores de nó (ref. cruzada): etiquetas, departamentos, kanbans/colunas (CRM), pixels, produtos, integrações de IA/ElevenLabs/UTMify/emissores de nota/pagamentos, agentes de IA, usuários da conta, conexões (horários de funcionamento), templates WhatsApp, variáveis globais, campos customizados.

---

## 7. Eventos realtime (ActionCable)

| Canal | Params | Evento (`type`) | Efeito na UI | Ref |
|---|---|---|---|---|
| `FlowsChannel` | `{flow_id}` | `flow_status_updated` `{flow_id, status, active, message}` | atualiza status no editor + toast "Fluxo pausado automaticamente" | `247853` |
| `FlowsChannel` | `{flow_id}` | `distributor_updated` `{node_id, outputs}` | atualiza contadores das saídas do distribuidor | `247864` |
| `FlowsChannel` | `{flow_id}` | `flow_graph_updated` com `source:"mcp"` e `mutation` ∈ `reposition_node`, `reposition_nodes`, `update_flow` (name/description), `add_node` (+connections), `update_node`, `delete_node`, `add_connection`, `delete_connection` | aplica edições feitas pelo assistente IA/MCP no canvas sem recarregar; outras mutações → recarrega bundle | `247703–247850` |
| `ChatsChannel` | `{account_id}` | `flow_execution_created`, `flow_execution_cancelled` `{chat_id}` | recarrega fluxos ativos do chat (500 ms) | `183410–183425` |
| `AccountNotificationsChannel` | `{account_id}` | `flow_translation` `{account_id, run}` | atualiza progresso/conclusão da tradução | `244478` |

---

## 8. Permissões

| Permissão | Efeito | Ref |
|---|---|---|
| `flows.view` | acesso às rotas com prefixo `/flows` | `pretty.js:40912` |
| `flows.edit` | criar/editar/ativar/pausar/arquivar/duplicar/importar; sem ela o editor fica read-only; também condição para Traduzir | `pretty.js:245656`, `247483` |
| `flows.delete` | excluir fluxo/pasta | `pretty.js:36205` |
| `settings.dispatch.view` | acesso a `/connection_flow_configs` (Fluxos padrões) | `pretty.js:40933` |
Papéis: `owner` e `admin` recebem edit/delete por padrão; `member` só view (a menos que a conta defina permissões customizadas em `current_account.permissions`) (`pretty.js:36190–36230`). Bloco "Template WhatsApp" [REQUER WABA] depende de flag de build (`Kje`) que restringe a admins quando ligada — hoje desligada. Tradução requer `flow_translations/settings.enabled`.

---

## 9. Integrações externas

| Integração | Onde | Observação |
|---|---|---|
| WhatsApp UAZAPI (não oficial) | todos os envios; exclusivos: carrossel, ligação, visualização única, imagem em botões | carrossel, ligação e imagem em botões: [INSTÁVEL NO BAILEYS] |
| WhatsApp Cloud API (Meta) [REQUER WABA] | template HSM, PIX oficial (valor + recebedor obrigatórios), janela 24h | fora do escopo do clone |
| OpenAI (GPT), Google Gemini, OpenRouter, Leona AI (créditos) | Bloco de IA, variação de texto | chave manual, variável global ou integração cadastrada |
| ElevenLabs | áudio IA no nó Mensagem | integração cadastrada |
| Kie.ai (ElevenLabs, Nano Banana, GPT Image, WAN, Suno, Veo 3.1) | nó Kie.ai | chave API do cliente |
| Facebook Conversions API | nó Pixel | pixels configurados em Configurações |
| XPag, Zenith, Leona Pay | nó Pagamento / Leona Pay | webhook confirma pagamento |
| UTMify, emissores de nota fiscal | nó Venda aprovada | opcional |
| HTTP genérico | nó Integração | GET/POST/PUT, headers e body JSON |
| QuickChart | URL de QR (Bre-B/Zenith) | gerado pelo backend |
| Provedores de tradução/TTS ("fish" econômico, "eleven" premium) | Tradução de fluxo | — |

---

## 10. Lacunas

- [NÃO VERIFICADO] Semântica de execução no backend (ordem de ações, reentrada, concorrência de execuções por chat, o que acontece com fluxo pausado com execuções em andamento).
- [NÃO VERIFICADO] Estrutura completa de `messages[]` em `send_multi_media` (campos por mídia além de url/caption/view_once) e limites de `typing_delay_seconds`.
- [INFERIDO] Opções de botão no Menu interativo usam `type` + `description` como payload URL/COPY/CALL.
- [INFERIDO] Saídas do nó `ai_agent` (se continua pelo `source` no modo Remover; no modo Entregar o simulador encerra o fluxo).
- [NÃO VERIFICADO] Configuração do nó `start` ("Editar Início") — parece só nome/descrição; gatilhos ficam em connection_flow_configs.
- [NÃO VERIFICADO] Valores de `pix_type` além de `EVP` (CPF/CNPJ/telefone/e-mail — rótulos vistos, códigos não confirmados).
- [NÃO VERIFICADO] Payload de resposta de `executions` / `flow_executions/:id` (campos e status).
- [NÃO VERIFICADO] `apply_label` e `compose_message` (1 ocorrência cada; possivelmente de outro módulo).
- [REQUER WABA] [NÃO VERIFICADO] Detalhes do seletor de template Meta (`variable_mappings`, `header_variable_mapping`) — ver módulo de Templates WhatsApp.
- [INFERIDO] Lista de cores de pasta é enum fechado; formato salvo (nome vs. hex) não confirmado.
- O REA não listou endpoints montados com template literal (`/flows/:id/...`, `/flow_folders`, `/flow_executions`) nem `flows_all_search_cache`; esses vieram do grep.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Nó `template` / ação `send_template` (HSM, variáveis, botões Quick Reply/CTA, Pix no template) | [REQUER WABA] | Nó Mensagem com texto livre + variáveis; respostas tratadas por Aguarda Resposta/Condicional |
| Condições `template_button`, `template_other`, `template_timeout`, `template_delivery_failed` | [REQUER WABA] | `client-response` / `timeout` do Aguarda Resposta; falha via status de entrega do Baileys |
| Condição `message_window` (janela 24h) | [REQUER WABA] | Sem equivalente; no Baileys a janela está sempre aberta (avaliar sempre `open`) |
| Campos oficiais do Botão PIX (`pix_body`, `header_image_url`) | [REQUER WABA] | Texto com chave Pix copia-e-cola + imagem/QR como mídia |
| Botão COPY em template | [REQUER WABA] | Enviar o código como texto separado |
| Bloco "Template WhatsApp" na paleta, seletor de templates Meta, integração Cloud API | [REQUER WABA] | Ocultar no clone |
| Botão PIX (`pix`) | [INSTÁVEL NO BAILEYS] | Texto com chave + valor |
| Menu `interactive_menu` (list/button/url/call) e Menu legado, condições `menu_*` | [INSTÁVEL NO BAILEYS] | Menu numerado em texto ("1 - Opção") + Aguarda Resposta casando número/título |
| Carrossel (`carousel`, condições `carousel_*`), imagem em botões | [INSTÁVEL NO BAILEYS] | Sequência de imagens com legenda + menu numerado |
| Ligar (`make_call`) | [INSTÁVEL NO BAILEYS] | Chamada só para "tocar" (offer/terminate) ou áudio PTT em mensagem |
| Marcar como lido (`readchat`/`readmessages`) | [INSTÁVEL NO BAILEYS] | `readMessages` do Baileys (best effort) |
| Reação ao lead (`react_to_lead_*`) | [INSTÁVEL NO BAILEYS] | Mensagem `react` do Baileys (best effort) |
| Variáveis CTWA (`ctwa_clid` etc.) | [INSTÁVEL NO BAILEYS] | Ler `contextInfo.externalAdReply` quando presente; tratar como opcional |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Lista:** título "Fluxos" e o subtítulo de automações. Botões Novo fluxo, Pasta, Importar. Abas Todos | Ativos | Pausados. Painel PASTAS (ex. "Sem pasta").
- **Tabela:** NOME, STATUS (ATIVO/PAUSADO), BLOCOS (nº de nós), ATUALIZADO (data e hora).
- **"Novo fluxo" não abre formulário.** Cria o fluxo NA HORA com status ATIVO e nome único ("Novo Fluxo 1"), e abre `/flows/:id/edit`. Isso foi confirmado ao vivo, porque o scout criou um fluxo vazio sem querer; o incidente foi reportado ao usuário. A reimplementação deve considerar pedir o nome antes de criar, ou criar como rascunho/pausado.
- **Cabeçalho do editor** (visto de relance): nome do fluxo, LeonaAI, Pausar, Traduzir, Arquivar, Ferramentas, Simular.
