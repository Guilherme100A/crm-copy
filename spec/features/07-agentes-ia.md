# 07 — Agentes de IA, Integrações de IA e Leona AI

> Fonte: análise estática do bundle (`_bundle/pretty.js`) e tabela do REA (`_rea/rea-endpoints.md`, rea-agents 6.5.0). Endpoints/rotas marcados **(fonte: REA)** aparecem na tabela do REA. Os demais vêm de grep no bundle; em geral são template literals que o REA não resolve. Nenhum dado real foi copiado. Exemplos são fictícios.

## 1. Visão geral

O módulo tem três subsistemas que usam a mesma carteira de **tokens Leona** (créditos de IA pré-pagos da conta):

1. **Agentes de IA** (`/agentes`): atendentes autônomos de WhatsApp. São configurados por formulário (identidade, objetivo, personalidade, regras), por um prompt gerado ou editado à mão, por **habilidades** (ações que o agente executa, como disparar fluxo, etiquetar ou transferir para humano), por **conhecimento** (site, PDF, texto, FAQ, fluxo), por **coleta de dados** (campos do contato que o agente preenche), por **arquivos enviáveis** e por **configurações** (buffer, áudio TTS, visão, limites, motor e ação quando o saldo acaba). Um agente entra numa conversa por um **nó de fluxo** "Agente IA" (ativar/desativar). Tem chat de teste, publicar/pausar, duplicar e excluir. Há três formas de criar: em branco, a partir de modelo pronto ou "Criar com IA" (assistido, consome tokens).
2. **Vozes** (aba "Vozes" em `/agentes`): clonagem de voz da conta, feita a partir de 1 a 3 áudios. A voz fica "pendente" até o usuário escolher manter ou descartar. Vozes mantidas podem ser usadas em qualquer agente da conta. O provedor de TTS parece ser o Fish Audio (`fish_voice_id`, `flow_translation_fish_api_key`) [INFERIDO].
3. **Integrações de IA** (`/integrations/ai`): chaves próprias de provedor (OpenAI, Gemini, OpenRouter, ElevenLabs), usadas pelos **blocos de IA dos fluxos** (não pelos agentes, que usam o motor da plataforma).
4. **Leona AI** (`/leona_ai`): copiloto de chat no canvas do construtor de fluxos. Constrói e edita o fluxo em tempo real a partir de pedidos em texto, voz ou anexo. Funciona por sessões por fluxo, cobra tokens por turno e pausa quando o saldo acaba ("paused_for_payment"), com retomada. Também gerencia a carteira (saldo, pacotes, checkout, recarga automática) e o histórico de uso.

Contagem aproximada: **~55 features**.

## 2. Telas e rotas

| Rota | Componente / descrição | Ref |
|---|---|---|
| `/agentes` (fonte: REA) | Lista de agentes, com abas "Agentes" e "Vozes", filtro por status, busca, cota, botões "Novo", "Modelos" e "Criar com IA" | pretty.js:282430, 278181 |
| `/agentes/novo` (fonte: REA) | Editor em modo criação (agente não salvo; ações que exigem id ficam bloqueadas com "Salva o agente pra usar isso") | pretty.js:282431 |
| `/agentes/:id` (fonte: REA) | Editor do agente, com abas Foto, Instruções, Habilidades, Conhecimento, Coleta de dados e Configurações. Tem painel "Teste ao vivo", botões Publicar/Pausar e Histórico (auditoria) | pretty.js:282432, 280112-280420 |
| `/integrations/ai` (fonte: REA) | Lista e CRUD de chaves de provedor de IA | pretty.js:157351 |
| Painel Leona AI (dentro do editor de fluxo `/flows/:id`) | Drawer de chat com sessões por fluxo, seletor de esforço e composer com voz e anexos | pretty.js:209230+, 36553 |
| `/settings?tab=leona_ai_usage_history` | Histórico de uso de tokens Leona AI por sessão | pretty.js:117162 |
| Modal "tokens Leona" (global, chip no menu lateral) | Saldo, compra de pacotes, recarga automática | pretty.js:45831-45900 |

Permissão de rota: `/agentes` exige `flows.view`; `/integrations/ai` exige `settings.mcp.view` (pretty.js:40912, 40931).

Navegação pós-criação: criar redireciona para `/agentes/{id}`. A criação assistida redireciona com `state.warning` e `state.review=true`, o que exibe o banner "Deixei um começo. Olha antes de publicar." (pretty.js:278427).

## 3. Modelo de dados / campos

### 3.1 AiAgent (objeto padrão em pretty.js:279222-279251)

| Campo | Tipo | Obrig. | Default / validação | Notas |
|---|---|---|---|---|
| id | int | — | 0 = não salvo | |
| name | string | sim | "Leo" | Editável inline no cabeçalho |
| role | string | não | "" | "Função (aparece só pra você)" |
| avatar_key | string | não | "leo-2" | Avatares pré-definidos `leo-1`…`leo-10` (pretty.js:162835) |
| avatar_url | string\|null | não | null | Upload JPEG/PNG/WebP até 5 MB (`upload_avatar`) |
| status | enum | — | `draft` | `draft`, `active`, `paused` |
| primary_goal | enum | sim | `sell` | `sell`, `schedule`, `answer`, `qualify` |
| purpose | text | não | "" | "O que ele faz", com botão "Ajustar com a Leona" |
| audience | text | não | "" | "Quem é o cliente" |
| personality | enum | sim | `seller` | `seller`, `support`, `consultative`, `casual` |
| example_messages | text | não | "" | "3 mensagens do jeito que você falaria" (multilinha) |
| business_rules | text | não | "" | |
| never_talk_about | text | não | "" | |
| use_emojis | bool | — | true | Com moderação, no máximo 1 por mensagem |
| generated_prompt | text | não | "" | Gerado por `generate_prompt` ou editado à mão |
| last_generated_prompt | text | — | "" | Usado no "Desfazer edição" |
| prompt_edited | bool | — | false | Badge "Gerado pela Leona" ou "Editado à mão" |
| locked_blocks | array | — | [] | Blocos de prompt travados pela plataforma ("Travado", não editáveis) |
| settings | objeto AgentSettings | sim | ver 3.2 | |
| skills | AgentSkill[] | — | [] | |
| knowledge_sources | KnowledgeSource[] | — | [] | Gerido por endpoints próprios |
| collection_fields | CollectionField[] | — | 5 padrões | ver 3.5 |
| sendable_media | Media[] | — | [] | Até 8 arquivos de até 8 MB |
| audits | array | — | [] | Aba "Histórico" com alterações |
| test_turns | array | — | [] | Turnos do chat de teste persistidos |
| skills_count, linked_flows_count | int | — | 0 | Exibidos no card |
| referenced_by_flows | array | — | [] | Fluxos cujo nó "Agente IA" aponta para o agente. Muda a mensagem do diálogo de exclusão |
| metrics | {conversations_30d, goal_rate, human_rate} | — | zeros | Card: "conversas", "objetivo", "humano" |
| updated_at | datetime | — | | |

Payload de save (`create`/`update`) com os campos: name, role, avatar_key, purpose, primary_goal, audience, personality, example_messages, business_rules, never_talk_about, use_emojis, generated_prompt, prompt_edited, settings, skills, collection_fields (pretty.js:280225-280243).

### 3.2 AgentSettings (defaults em pretty.js:279155-279185)

| Campo | Tipo | Default | Rótulo / regra |
|---|---|---|---|
| buffer_enabled | bool | true | "Buffer de mensagens": junta mensagens picadas e responde de uma vez |
| buffer_seconds | int | 5 | Cada mensagem nova reinicia a contagem |
| split_messages | bool | true | "Quebrar em mensagens curtas", com "digitando..." entre os blocos |
| audio_choice_enabled | bool | true | "Deixar ele decidir se manda áudio" |
| audio_min_words | int | 40 | [INFERIDO] mínimo de palavras para virar áudio |
| audio_guidance | text | "" | "Orientação de quando usar áudio". Vazio = sempre texto |
| audio_voice | string | "" | Voz TTS ("" = padrão da plataforma, ou voz da conta) |
| audio_max_per_conversation | int | 3 | |
| understand_audio | bool | true | "Ouvir áudio do cliente" (transcreve) |
| understand_image | bool | true | "Ver imagem do cliente" (vídeo não entra) |
| understand_receipt | bool | true | Ler comprovante de pagamento [INFERIDO pelo nome] |
| validate_receipt_pix_key | bool | false | Validar chave Pix do comprovante |
| expected_pix_key | string | "" | |
| validate_receipt_recipient | bool | false | Validar nome do favorecido |
| expected_recipient_name | string | "" | |
| source_flow_id / source_label_id | int\|null | null | Origem usada na criação assistida |
| sign_name | bool | false | "Assinar o nome do agente" na 1ª mensagem |
| business_hours_only | bool | false | "Só responder no horário comercial". Fora dele, avisa e deixa na fila |
| pause_on_human | bool | true | "Desligar quando um humano assumir" (mensagem humana pelo app ou pelo WhatsApp. Mudança de status ou transferência sozinhas não desligam) |
| stall_limit_enabled | bool | true | "Parar depois de respostas sem avanço" e transferir para humano |
| stall_limit | int | 12 | nº de respostas sem avanço |
| engine | enum | `balanced` | `economy`, `balanced`, `advanced`. O modelo real não é exibido |
| no_balance_action | enum | `none` | `none`, `flow`, `notify` [INFERIDO: valores `flow`/`notify` pelas chaves i18n noBalanceFlow/noBalanceNotify] |
| no_balance_flow_id | int\|null | null | |
| no_balance_notify_name / _phone / _country_code / _message | string | "", "", "55", "" | Igual ao bloco de notificação do fluxo |

Regra fixa da plataforma, que não pode ser desligada: mensagens com link, preço, chave Pix, código, endereço ou lista nunca viram áudio. Custo informado na UI: cerca de 18 tokens por áudio de 15 s.

### 3.3 AgentSkill (habilidade)

| Campo | Tipo | Regra |
|---|---|---|
| enabled | bool | switch por habilidade |
| when_text | text | "Quando". Aviso "muito vaga" se tiver menos de 4 palavras (pretty.js:281057) |
| action_type | enum | `trigger_flow`, `transfer_human`, `apply_label`, `fill_field`, `close_conversation`, `compose_message` |
| action_params | objeto | `trigger_flow`: `{flow_id, return_to_agent:bool}`. `apply_label`: `{mode:"add"\|"remove", tags:[], label_id}`. Demais tipos: `{}` |
| schedule_mode | enum | `now` (neste turno), `on_date` (na data que o lead disser), `if_silent` (se não responder) |
| silence_amount | int | default 1 (para `if_silent`) |
| silence_unit | enum | `hours`, `days` (default `days`) |

`compose_message`: o texto é escrito pela IA na hora do envio e não é gravado agora. `if_silent`: é cancelado se o lead escrever antes. `on_date`: o agendamento se mantém mesmo se a conversa continuar. Rótulos "avisa o cliente/transfere calado" e "com/sem despedida" existem no i18n, mas não aparecem como params no editor [NÃO VERIFICADO].

### 3.4 KnowledgeSource

| Campo | Tipo | Notas |
|---|---|---|
| id | int | |
| kind | enum | `site`, `pdf`, `text`, `file`, `faq`, `flow` |
| slot | enum | `site`, `pdf`, `text`, `faq`, `flow` (o tipo `file` é normalizado para pdf ou text pela extensão, pretty.js:279257) |
| url / title / body / filename / flow_id / items[{q,a}] | | conforme o tipo |
| status | enum | `pending` ("lendo"), `ready` ("pronto"), `failed` ("falhou") |
| pages_count / questions_count | int | "páginas lidas", "N perguntas" |
| error_message | string | códigos abaixo |

Limites por slot (`mb`, pretty.js:279252): site 1, pdf 2, text 2, faq 10, flow 1. Arquivo de até 8 MB. PDF aceita `.pdf`; texto aceita `.txt,.md,.csv`.
Códigos de erro: generic, too_large, unsupported_file, file_missing, empty, empty_pdf, encrypted_pdf, unreadable_pdf, not_pdf, knowledge_limit, pdf_limit, text_limit, faq_limit, faq_item_required, text_required, text_too_long, site_unreachable, empty_site, flow_missing, url_required, unsupported_kind.

### 3.5 CollectionField (coleta de dados)

`{key, label, variable:"{key}", enabled, position}`. Os padrões (pretty.js:279186) são nome, cidade, produto (ligados) e email, recompra (desligados). O agente grava o dado no campo do contato se ele aparecer na conversa ("Guarda em {variavel}"). O agente também lê etiqueta, campo e compra existentes do contato.

### 3.6 Media enviável

Upload multipart `file` + `title` ("Nome do arquivo", ex.: "tabela de preço"). O agente envia quando o cliente pede. Máximo de 8 arquivos de 8 MB. Remoção por `asset_id`.

### 3.7 Voz da conta

Criação: `name`, `language` (`pt`, `en`, `es`, `hi`), `audios[]` (1 a 3 arquivos MP3/WAV/OGG/M4A/AAC/WEBM/FLAC, gravados no navegador ou anexados). Estados: pendente (ouvir, então manter ou descartar) e mantida ("Disponível nos agentes"). Excluir uma voz remove a voz de todos os agentes, que voltam para a voz padrão. Listagem paginada (`page`, `limit`, padrão 10). Prévia de voz do catálogo e da conta consome saldo (erro "Sem saldo para ouvir essa voz").

### 3.8 AiIntegration (`/integrations/ai`)

| Campo | Tipo | Obrig. | Validação |
|---|---|---|---|
| provider | enum | sim | `gpt` (OpenAI), `gemini`, `openrouter`, `elevenlabs` |
| key_name | string | sim | mínimo de 2 caracteres |
| integration_token | string (segredo) | sim na criação | Na edição, deixar em branco mantém a chave atual |

A listagem mostra nome, provedor e token mascarado [INFERIDO]. Excluir avisa que os blocos de IA dos fluxos que usam a chave vão falhar.

### 3.9 Leona AI

- **Wallet**: `balance_units`, `lifetime_credited_units`, `lifetime_spent_units`, recarga automática (ativa ou não) [INFERIDO: campos exatos de auto-recharge].
- **Quote/pacotes**: `packages` → `quote` (slider de tokens → preço).
- **Session**: `id`, `flow_id`, `title`, `reasoning_effort` (`fast`, `balanced`, `max`; persistido em localStorage `leona_ai_reasoning_effort`, pretty.js:208763), `status` (`active`, `paused_for_payment`, `archived`).
- **Message**: `role` (`user`, `assistant`), `content`, `client_message_id`, `attachments[{asset_id,url,content_type,filename,kind,byte_size}]`, `continue_turn`.
- **Usage history**: por sessão, com data, sessão, fluxo, status, tokens usados e nº de turnos (eventos). Inclui uso de "Agente IA".

## 4. Estados e transições

**Agente**: `draft` → (Publicar) → `active` ⇄ (Pausar/Publicar) `paused`. Filtros da lista: Todos, Ativos, Rascunhos, Pausados. O nó de fluxo só lista agentes publicados ("Escolhe um agente publicado").

**Fonte de conhecimento**: `pending` → `ready` | `failed`. "Ler de novo" (reindex) volta para `pending`.

**Run de criação a partir de fluxo/etiqueta**: `queued` → `running` → `completed` (com `agent_id`, `warning`) | `failed` (com `error_message` = código). O front faz polling a cada 1,2 s (pretty.js:278418-278447). Estágios exibidos: extract ("Lendo o conhecimento"), transcribe ("Transcrevendo áudios"), compose ("Montando o agente"), persist ("Salvando"). Warnings: site_unread, empty_flow, empty_chats, empty_knowledge.

**Voz**: pendente → mantida (keep) | descartada (delete).

**Sessão Leona AI**: `active` → `paused_for_payment` (saldo acabou no meio do trabalho) → (recarga + "Continuar de onde paramos", `resume`) → `active`. A opção "Só quero conversar" faz `resume` com `chat_only`. Também `active` → `archived` (archive) → reopen.

**Atividade do turno Leona AI** (rótulos): reading_flow, planning, creating_blocks, wiring, updating, layout, media_audio, media_image, web_search, web_extractor, code_interpreter, waiting_you, paused_payment, working, done, work_limit.

## 5. Ações e regras de negócio

1. **Cota de agentes**: cada instância (conexão) comprada libera 2 agentes. A UI mostra "{used} de {limit} agentes · {per_instance} por instância comprada". Criar acima do limite retorna o código `limit_reached` e abre o modal "Limite de agentes" (pretty.js:278175, 32617).
2. **Criar em branco** (`POST /ai_agents {}`) ou abrir o editor em `/agentes/novo` e salvar (`POST /ai_agents` com o payload completo).
3. **Modelos prontos**: `sales` (vendas), `support` (suporte), `recovery` (recuperação de carrinho). Sem fonte, o modelo entra pronto (grátis). Com fluxo e/ou etiqueta, roda uma montagem adaptada que cobra tokens (`create_from_flow_runs` com `template`).
4. **Criar com IA (assistido)**: com a fonte "Link do site", envia `pitch` (o que você vende, com ditado por voz opcional via `/ai_agents/transcriptions`, que consome tokens) e `site_url`. Com a fonte "Conhecimento interno", usa um fluxo e/ou uma etiqueta (lê conversas recentes da etiqueta), mais um texto extra opcional e a voz dos áudios. Antes, faz uma estimativa (`estimate_from_flow` → tokens, chats, áudios, `enough`, `available`). Bloqueia se o saldo for insuficiente. Só pode haver uma montagem por vez (`create_in_progress`/"busy").
5. **Gerar prompt** (`generate_prompt`): gera a partir do formulário. Se o usuário editou à mão, pede confirmação antes de sobrescrever. "Desfazer edição" restaura `last_generated_prompt`.
6. **Teste ao vivo** (`test_messages`): envia `text` e um `draft` com os campos atuais não salvos. A resposta traz `blocks`, `skills_fired`, `fields_filled`, `audio`, `trace` e `charged_tokens`. Existe um teto diário de teste (`eval_cap`) que não debita o saldo da conta. Sem saldo, retorna `no_balance`. "Limpar conversa" (DELETE) zera o teste sem mudar o cadastro.
7. **Publicar/Pausar**: alterna conforme o status atual (pretty.js:280409-280413).
8. **Duplicar / Excluir**: a exclusão avisa se há fluxos ligados ("Os fluxos que apontam pra ele ficam sem agente").
9. **Handoff para humano**: (a) habilidade `transfer_human`; (b) `pause_on_human`, quando um humano envia mensagem; (c) `stall_limit` respostas sem avanço; (d) no nó de fluxo "Agente IA", modo `deactivate` devolve a conversa ao fluxo. Habilidade `trigger_flow` com `return_to_agent` volta ao agente no fim do fluxo.
10. **Saldo acabou com agente ativo**: o agente para de responder e executa `no_balance_action` (nada, disparar fluxo ou notificar alguém por WhatsApp).
11. **Nó de fluxo "Agente IA"**: `action_type: "control_ai_agent"`, config `{mode: "activate"|"deactivate", agent_id, agent_name, avatar_key, avatar_url}` (pretty.js:210710-210718).
12. **Leona AI**: exige o fluxo salvo ("Salve o fluxo para conversar com a Leona"). Exige permissão de edição do fluxo. Rate limit existe. Os turnos debitam tokens ("−N tokens neste turno") e é permitido overrun ("usou N tokens além do saldo"). Retomada após pagamento: o checkout recebe `return_url` com o parâmetro `?leona_ai_resume=<sessionId>`. Se o parâmetro não sobreviver ao redirect, o id fica em sessionStorage `leona_ai_resume_pending` e a sessão é retomada ao voltar (pretty.js:40322-40360). Compra por `provider` (Pagar.me para Pix/cartão BR ou Paddle internacional, mínimo de R$ 4,00).

## 6. Endpoints da API

### Agentes (`eQt`, pretty.js:210556-210705)

| Método | Caminho | Payload / resposta | Fonte |
|---|---|---|---|
| GET | `/ai_agents` | → `{agents[], quota, wallet_units}` | REA |
| GET | `/ai_agents/names` | → `{agents:[{id,name,avatar_key,avatar_url}]}` (nó de fluxo) | REA |
| GET | `/ai_agents/:id` | → `{agent}` | grep |
| POST | `/ai_agents` | `{}` (em branco) \| payload completo \| `{template}` \| `{pitch, site_url}` → `{agent}` | REA |
| PATCH | `/ai_agents/:id` | payload de save → `{agent}` | grep |
| DELETE | `/ai_agents/:id` | | grep |
| POST | `/ai_agents/:id/duplicate` | | grep |
| POST | `/ai_agents/:id/publish` \| `/pause` | → `{agent}` | grep |
| POST | `/ai_agents/:id/generate_prompt` | → `{agent}` | grep |
| POST (multipart) | `/ai_agents/:id/upload_avatar` | `avatar` | grep |
| POST (multipart) | `/ai_agents/:id/upload_media` | `file`, `title?` | grep |
| DELETE | `/ai_agents/:id/destroy_media?asset_id=` | | grep |
| POST | `/ai_agents/:id/test_messages` | `{text, draft}` | grep |
| DELETE | `/ai_agents/:id/test_messages` | reset | grep |
| POST | `/ai_agents/:id/knowledge_sources` | JSON `{kind:"site",url}` \| `{kind:"faq",items:[{q,a}],replace?}` \| `{kind:"flow",flow_id}` \| `{kind:"text",title?,body}`, ou multipart `kind`+`file` | grep |
| POST | `/ai_agents/:id/knowledge_sources/:sid/reindex` | | grep |
| DELETE | `/ai_agents/:id/knowledge_sources/:sid` | | grep |
| POST | `/ai_agents/estimate_from_flow` | `{flow_id?, label_id?}` | REA |
| POST | `/ai_agents/create_from_flow_runs` | `{flow_id?, label_id?, pitch?, audio_voice?, template?}` → `{run}` | REA |
| GET | `/ai_agents/create_from_flow_runs/:id` | → `{run}` | grep |
| POST (multipart) | `/ai_agents/transcriptions` | `file` (ditado) → `{text}` | grep |
| GET | `/ai_agents/voices[?page&limit]` | lista de vozes | grep |
| POST | `/ai_agents/voices/catalog_preview` | `{voice_id}` | REA |
| POST (multipart) | `/ai_agents/voices` | `name`, `language`, `audios[]` | grep |
| POST | `/ai_agents/voices/:id/preview` \| `/keep` | | grep |
| DELETE | `/ai_agents/voices/:id` | descartar/excluir | grep |

Erros: o corpo traz `error` ou `errorData.error` como código (`limit_reached`, `no_balance`, `eval_cap`, `billing_failed`, `create_in_progress`, `label_not_found`, `flow_not_found`, `invalid_audio`, `request_failed`) e, às vezes, `quota` (pretty.js:210545).

### Integrações de IA (`Nbt`, pretty.js:103419-103453)

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/ai_integrations` | → `{ai_integrations[]}` | REA |
| POST | `/ai_integrations` | `{ai_integration:{provider,key_name,integration_token}}` | REA |
| PUT | `/ai_integrations/:id` | `{ai_integration:{...}}` | grep |
| DELETE | `/ai_integrations/:id` | | grep |
| GET | `/ai_integrations/openrouter_models` | → `{models[]}` | REA |
| GET | `/ai_integrations/:id/voices` | vozes ElevenLabs da chave | grep |

### Leona AI (`dDe`, pretty.js:36553-36665)

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/leona_ai/wallet` | → `{wallet}` | grep |
| GET | `/leona_ai/packages` | → `{quote}` | grep |
| POST | `/leona_ai/checkout` | `{tokens, session_id?, return_url?, provider?}` | grep |
| DELETE | `/leona_ai/auto_recharge` | cancela a recarga automática → `{wallet}` | grep |
| GET | `/leona_ai/sessions[?flow_id=]` | | grep |
| GET/PATCH | `/leona_ai/sessions/:id` | PATCH `{reasoning_effort?, title?}` | grep |
| POST | `/leona_ai/sessions` | `{flow_id?, title?, reasoning_effort?}` | grep |
| POST | `/leona_ai/sessions/:id/archive` \| `/reopen` | | grep |
| POST | `/leona_ai/sessions/:id/resume` | `{chat_only?}` | grep |
| GET/POST | `/leona_ai/sessions/:id/messages` | POST `{content, client_message_id?, attachments?, continue_turn?}` | grep |
| POST (multipart) | `/leona_ai/sessions/:id/attachments` | `file` → `{attachment}` | grep |
| POST (multipart) | `/leona_ai/sessions/:id/transcriptions` | `file` → `{text}` | grep |
| GET | `/leona_ai/usage_history` | → `{sessions[]}` | grep |

Admin (fora do escopo do cliente, apenas referência): `/admin/leona_ai/settings` (GET/PATCH), `/admin/leona_ai/secrets` (GET/POST), `/admin/leona_ai/packages` (GET/POST), `/admin/leona_ai/billing_configs` (POST) (fonte: REA).

## 7. Eventos realtime

- Canal `LeonaAISessionChannel` com params `{session_id}` (pretty.js:208893-208910). Eventos (reducer em pretty.js:198317): `session`, `thinking`, `reading_flow`, `activity`, `assistant_delta` (streaming de texto), `message_completed`, `wallet`, `error`. Quando o canvas é alterado, o front mostra o toast "Canvas atualizado".
- Agentes: nenhum canal ActionCable. Usa polling (runs a cada 1,2 s) [NÃO VERIFICADO se o status de knowledge source chega por realtime].

## 8. Permissões

- `/agentes` → `flows.view`. Editar presumivelmente `flows.edit` [INFERIDO].
- `/integrations/ai` → `settings.mcp.view`. Recurso `ai_integration` mapeado para `settings.mcp.view` (pretty.js:36311).
- Leona AI: exige permissão de edição do fluxo (erro `noPermission`). O chip de carteira fica oculto para usuários de suporte/impersonação (`du(n)`) [INFERIDO].

## 9. Integrações externas

- Motor LLM da plataforma (modelo oculto, 3 níveis de "engine").
- TTS e clonagem de voz: Fish Audio [INFERIDO]. ElevenLabs via chave própria (blocos de fluxo).
- OpenAI, Google Gemini e OpenRouter (lista de modelos) via chaves do cliente.
- Pagamento de tokens: Pagar.me (Pix/cartão) e Paddle.
- Leona AI: ferramentas de busca web, extração de páginas, interpretador de código, geração de imagem e áudio (rótulos de atividade).

## 10. Lacunas

- [NÃO VERIFICADO] Schema exato de `run`, `quota` e da resposta de `test_messages` (`trace`).
- [INFERIDO] Valores `flow`/`notify` de `no_balance_action`; significado de `audio_min_words` e `understand_receipt` (validação de comprovante Pix).
- [NÃO VERIFICADO] Se há params de `transfer_human` (avisar cliente) e de `close_conversation` (despedida). Os rótulos existem, mas o editor não os usa.
- [NÃO VERIFICADO] Como o agente é vinculado à conexão: apenas via nó de fluxo? Não foi visto vínculo direto agente↔conexão.
- [NÃO VERIFICADO] Preço por token, pacotes e regras de recarga automática (backend).
- [NÃO VERIFICADO] Conteúdo dos prompts de sistema e dos `locked_blocks` (backend).
- [INFERIDO] Provedor TTS Fish Audio.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- Título "Agentes de IA" com o subtítulo (atendente de WhatsApp que tira dúvidas e dispara fluxos). Botões Modelos, Criar com IA, Novo agente. Abas Agentes | Vozes.
- Estado vazio: "Nenhum agente ainda" com o botão "Criar o primeiro agente". Os modais de criação não foram abertos, porque podem criar o agente ou consumir tokens.
