# 17 — Configurações de conteúdo (Respostas Rápidas, Templates WhatsApp, Variáveis Globais, Campos Personalizados, Etiquetas, Fluxos Padrões, Traduções de fluxo)

> Fonte: bundle `_bundle/pretty.js` (as linhas citadas são desse arquivo) e a tabela REA `_rea/rea-endpoints.md`. Os endpoints marcados com "(fonte: REA)" aparecem na tabela do REA. Os demais foram montados por template string no bundle e o REA não os capturou, então vieram do grep.
> Todos os exemplos de dados são fictícios.

## 1. Visão geral

Este módulo reúne os cadastros de "conteúdo reutilizável" de cada empresa (account). São usados no chat, nos fluxos (builder) e nos disparos:

| # | Submódulo | Para que serve |
|---|---|---|
| A | Respostas Rápidas (`quick_replies`) | O atendente digita um atalho no chat e dispara uma sequência de ações: texto, imagem, vídeo, áudio, documento ou sticker. |
| B | Templates WhatsApp (`whatsapp_templates`) [REQUER WABA] | Cria, sincroniza, visualiza, corrige/reenvia e exclui templates oficiais da Meta, por WABA, para conexões da API Oficial (Meta Cloud). |
| C | Variáveis Globais (`global_variables`) | Constantes da conta (texto ou número) que os fluxos usam como `{g_nome}`. |
| D | Campos Personalizados (`customers/custom_fields`) | Chaves de metadados extras do contato, mais a lista somente leitura dos campos de sistema (BOT). |
| E | Etiquetas (`labels`) | Tags coloridas de contatos e chats. Podem ser importadas do WhatsApp (providers não oficiais) e sincronizadas com ele. [INSTÁVEL NO BAILEYS] (etiquetas nativas só existem em número WhatsApp Business app; no Baileys a leitura/edição de labels via app state é parcial) |
| F | Fluxos Padrões (`connection_flow_configs`) | Por conexão WhatsApp: fluxo de boas-vindas, resposta padrão (com atraso), conversa finalizada, atendimento finalizado e gatilhos por palavra-chave. Tem edição em massa. |
| G | Traduções de fluxo (`flow_translations`) | Clona um fluxo traduzindo textos, áudios (dublagem/voz), imagens e PDFs para outro idioma. Consome tokens de uma carteira. A aba de settings mostra o histórico de execuções. |

Todos ficam no hub `/settings?tab=<id>`, dentro do grupo "Automação" (o histórico de traduções fica no grupo "Conta"); definição em pretty.js:117159-117340.

## 2. Telas e rotas

### 2.1 Abas do hub `/settings` deste módulo (pretty.js:117159-117340, renderização em 117520-117565)

| tab id | Rótulo pt-BR (título / descrição) | Grupo | Permissão para exibir | Componente |
|---|---|---|---|---|
| `connection_flow_configs` | "Fluxos Padrões" / "Defina os fluxos padrões de cada conexão do WhatsApp." | automation | `settings.dispatch.view` | `wbt` (pretty.js:102936) |
| `quick_replies` | "Respostas Rápidas" / "Gerencie e organize as respostas rápidas da sua empresa." | automation | `settings.quick_replies.view` | `ugt` (pretty.js:93785) |
| `whatsapp_templates` [REQUER WABA] | "Templates WhatsApp" / "Gerencie templates oficiais Meta por WABA." | automation | nenhuma (`permission: null`); passa pelo gate `RB()`, que hoje é sempre verdadeiro porque a flag de build `Kje` = "0" (pretty.js:11479, 117134-117144) | `kNt` (pretty.js:114980) |
| `global_variables` | "Variáveis Globais" / "Gerencie as variáveis que podem ser usadas em todos os seus fluxos." | automation | nenhuma; sempre liberada (prefixo `settings.global_variables.*` sempre retorna true, `KU`, pretty.js:36126-36128 e 36244-36252) | `oxt` (pretty.js:99081) |
| `custom_fields` | "Campos Personalizados" / "Gerencie campos customizados e variáveis do sistema BOT para seus contatos." | automation | `settings.fields.view` | `Nxt` (pretty.js:100985) |
| `tags` | "Etiquetas" | automation | `settings.labels.view` | `uxt` (pretty.js:100258) |
| `flow_translator_history` | "Traduções de fluxo" / "Só o tradutor de fluxo: original, cópia, reservado, usado e devolvido." | account | `flows.view` (escondida para o papel `support`) | `ljt` (pretty.js:116794) |

O hub tem sidebar recolhível (estado salvo em localStorage `leona.settingsHubCollapsed`) e um seletor pesquisável de categoria. Uma `tab` inválida ou sem permissão é redirecionada para a primeira aba permitida (pretty.js:117460-117470).

### 2.2 Rotas legadas que redirecionam para o hub

| Rota | Redireciona para | Ref |
|---|---|---|
| `/quick_replies` (fonte: REA) | `/settings?tab=quick_replies` | pretty.js:133766 |
| `/global_variables` (fonte: REA) | `/settings?tab=global_variables` | pretty.js:157134 |
| `/customer_custom_fields` (fonte: REA) | `/settings?tab=custom_fields` | pretty.js:157361 |
| `/labels` (fonte: REA), `/settings/labels` (fonte: REA) | `/settings?tab=tags` | pretty.js:123211, 122310 |
| `/connection_flow_configs` (fonte: REA) | `/settings?tab=connection_flow_configs` | pretty.js:249801 |
| `/settings/whatsapp-templates` [REQUER WABA] | `/settings?tab=whatsapp_templates` | pretty.js:122331 |

O guard de rota por prefixo (pretty.js:40915-40945) exige `settings.labels.view` em `/labels`, `settings.fields.view` em `/customer_custom_fields`, `settings.dispatch.view` em `/connection_flow_configs` e `settings.quick_replies.view` em `/quick_replies`. `/global_variables` não exige permissão (`null`).

### 2.3 Outros pontos de uso

- Chat: um popover de respostas rápidas com busca (debounce de 300 ms), filtro por tipo e paginação de 20 itens com "carregar mais". Os usados recentemente ficam em localStorage `recent_quick_replies` (fonte: REA), e IDs que não existem mais são limpos (pretty.js:182560-182600).
- Lista de fluxos: botão "Traduzir" abre o modal do tradutor (pretty.js:244600-244800).
- Editor de respostas rápidas: o menu de variáveis lista Variáveis Globais, Campos do Customer, Instância (conexão) e Campos Customizados (i18n pretty.js:16481-16484).

## 3. Modelo de dados / campos

### 3.A Resposta Rápida (`quick_reply`)

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `id` | int | auto | | |
| `shortcut` | string | sim | Normalizado ao digitar: minúsculas, removendo tudo que não for `a-z 0-9 _ espaço -`. Dica: "Use apenas letras minúsculas, números, hífens, underscores e espaços". | pretty.js:92985-92990, i18n 16460 |
| `quick_reply_actions_attributes[]` | lista ordenada | ≥1 ação não removida | Sem ações válidas, aparece o alerta "Adicione pelo menos uma ação de conteúdo válida." | pretty.js:92893-92896 |
| `created_at` | datetime | auto | coluna "Criado em" | |

Ação (`quick_reply_action`), enviada em multipart como `quick_reply[quick_reply_actions_attributes][i][...]` (pretty.js:90134-90165):

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | presente em edição |
| `_destroy` | "1" | remove uma ação existente |
| `action_type` | enum | `send_message`, `send_multi_media`, `send_sticker` (o rótulo `send_contact`, "Contato", existe no i18n, mas o editor não cria esse tipo) |
| `order` | int | índice; reordenável com "Mover para cima/baixo" |
| `media_file` | arquivo | upload |
| `config.message_text` | texto | para `send_message`; aceita variáveis `{full_name}`, `{g_xxx}` etc. |
| `config.caption` | texto | legenda opcional da mídia |
| `config.media_type` | enum | `image`, `video`, `audio`, `document` |
| `config.sticker_name` | string | default "sticker" |
| `config.file_name`, `config.file_url` | string | mídia existente |
| `config.contact_name`, `config.contact_phone` | string | suportados pelo serviço [NÃO VERIFICADO na UI] |

Tipos de arquivo aceitos e limites (pretty.js:90230-90240; i18n 16486-16489):

| Mídia | MIME / extensões | Limite exibido |
|---|---|---|
| image | jpeg, png, jpg, webp, heic, heif | 5 MB |
| video | mp4, webm, ogg, quicktime(mov), m4v | 16 MB |
| audio | aac, amr, mp4, mpeg/mp3, m4a, ogg/opus | 16 MB |
| document | .pdf .doc .docx .txt .xls .xlsx | 100 MB |
| sticker | image/webp | 100 KB |

O frontend só mostra os limites como dica [INFERIDO: a validação real é no backend].

### 3.B Template WhatsApp (`whatsapp_template`) [REQUER WABA]

> Todo o submódulo B (campos, enums, status, qualidade, categorias, endpoints) só existe com a WhatsApp Cloud API (`meta_cloud` + `waba_id`).

Estado do formulário, com defaults em pretty.js:112142-112185 e limites `tr` em pretty.js:112047-112056:

| Campo | Tipo | Obrig. | Validação / default |
|---|---|---|---|
| `connection_id` | int | sim | [REQUER WABA] Conexão `api_provider === "meta_cloud"` que tenha `waba_id`. A WABA é escolhida no seletor e cada WABA aparece uma vez (pretty.js:114966-114978). |
| `name` | string | sim | Normalizado para `[a-z0-9_]`, máximo 512 caracteres. Mensagem: "Use apenas letras minúsculas, números e underscore (máx. 512 caracteres)." Imutável depois de criado. |
| `language` | enum | sim | `pt_BR` (default), `pt_PT`, `en_US`, `en_GB`, `es_ES`, `es_AR`, `es_MX` (pretty.js:112057). Imutável. |
| `category` | enum | sim | `UTILITY` (default), `MARKETING`, `AUTHENTICATION` (pretty.js:112058) [REQUER WABA] |
| `parameter_format` | enum | sim | `positional` (`{{1}}`, `{{2}}`) ou `named` (`{{nome}}`). "Inserir variável" adiciona o próximo número ou `{{variavel_N}}`. |
| templateKind (UI) | enum | | `standard` ou `pix_order_details`. Pix força UTILITY, header IMAGE, body com `{{1}}` e um botão ORDER_DETAILS, e envia `display_format: "ORDER_DETAILS"`. [REQUER WABA] (botão PIX ORDER_DETAILS oficial) |
| Header | enum | não | `none`, `text` (≤60), `image` (JPEG/PNG ≤5 MB), `video` (MP4 ≤16 MB), `document` (PDF ≤100 MB). A mídia pode ser enviada por upload (gera `preview_url`/`header_handle`) ou por URL pública http(s). |
| Body | texto | sim (exceto AUTHENTICATION) | ≤1024 caracteres |
| Exemplos de variáveis | map | sim para cada variável | "Informe um valor de exemplo para esta variável." |
| Footer | texto | não | ≤60, estático, sem variáveis |
| Botões | lista | não | Tipos `quick_reply` (até 3), `url` (texto + URL), `phone` (texto + telefone com DDI), `order_details`. Texto do botão ≤25. Não é permitido misturar Quick Reply com URL/telefone; URL e telefone juntos vão até 2. [REQUER WABA] (botões de template oficial) |
| AUTHENTICATION: `add_security_recommendation` | bool | | default true |
| AUTHENTICATION: `code_expiration_minutes` | int | não | 1-90, default 10 |
| AUTHENTICATION: botão Copiar código (OTP COPY_CODE) | bool + texto | | default "Copiar código"; texto ≤25 [REQUER WABA] |

Validação completa em `QCt` (pretty.js:112218-112292).

Montagem de `components` no formato da Meta (pretty.js:112293-112392):
- HEADER `{format: TEXT|IMAGE|VIDEO|DOCUMENT, text?, example: {header_text | header_media_url | header_handle[] | header_media_filename}}`
- BODY `{text, example: {body_text: [[...]]} | {body_text_named_params: [{param_name, example}]}}`; em AUTHENTICATION é `{add_security_recommendation}`
- FOOTER `{text}`; em AUTHENTICATION é `{code_expiration_minutes}`
- BUTTONS `{buttons: [{type: QUICK_REPLY|URL|PHONE_NUMBER|ORDER_DETAILS|OTP, text, url?, phone_number?, otp_type: COPY_CODE?}]}`

Campos de leitura na listagem [REQUER WABA]: `name`, `category`, `language`, `status`, `quality_score`, `created_at`, `rejection_info.reason`, `rejection_info.recommendation`. Também há um indicador "Categoria alterada (impacto no preço)" [INFERIDO: campo de categoria anterior vindo da Meta].

### 3.C Variável Global (`global_variable`)

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `name` | string | sim na criação | Só `[a-zA-Z0-9_]`. Na criação, o prefixo `g_` é adicionado automaticamente. Imutável depois de criado; o fluxo referencia como `{g_…}`. | pretty.js:98132-98137 |
| `description` | texto | não | | |
| `data_type` | enum | sim | `"Texto"` (default) ou `"Número"`. Os valores persistidos são as strings em português. | pretty.js:98106, 98155-98162 |
| `value` | string/num | não na criação ("Valor inicial (opcional)") | Se o tipo for Número, a edição exige `^-?\d+(\.\d+)?$` | pretty.js:98149-98156 |

A listagem pagina e busca por nome ou descrição (debounce de 400 ms). Colunas: Nome, Descrição, Tipo, Valor, Ações. Há ação para copiar o nome (pretty.js:99140-99200).

### 3.D Campo Personalizado (custom field de contato)

| Campo | Tipo | Obrig. | Validação | Ref |
|---|---|---|---|---|
| `key` | string | sim | De 2 a 255 caracteres. Convertida para minúsculas no envio. Imutável depois de criada. | pretty.js:100860-100875 |
| `description` | texto | não | Única coisa editável (PATCH de descrição) | pretty.js:91200-91210 |
| `example_value` | string | leitura | Se for URL http(s), o tipo aparece como "Media"; senão, "Texto" | pretty.js:101025-101031 |

Os campos personalizados não têm exclusão. A dica de lista vazia diz que eles também nascem automaticamente quando um contato recebe um campo novo.

Campos de sistema (BOT), somente leitura (pretty.js:101004-101021; rótulos em i18n pretty.js:16880-16900):

| key | Rótulo | Tipo |
|---|---|---|
| `full_name` | Nome Completo | Texto |
| `first_name` | Primeiro Nome | Texto |
| `phone_number` | Telefone | Texto |
| `hora` | Hora (HH:mm) | Texto |
| `data` | Data (dd/MM) | Texto |
| `dia` | Dia da Semana | Texto |
| `response.type` | Tipo da Resposta (MIME da última resposta) | Variável |
| `response.erro` | Erro da Integração (último erro HTTP) | Variável |

As descrições dos campos BOT podem vir sobrescritas por `/customers/bot_fields`. A tela de settings também permite "Editar descrição" de um campo BOT, que usa o mesmo PATCH (pretty.js:101066-101080). A UI tem as abas "Customizados" e "Sistema (BOT)".

### 3.E Etiqueta (`label`)

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| `name` | string | sim | De 2 a 50 caracteres | pretty.js:99590-99596 |
| `color` | hex | sim | `^#([0-9A-Fa-f]{3}){1,2}$`, default `#0000FF` | pretty.js:99562, 99598 |
| `whatsapp_enabled` | bool | não | default false; "Adicionar ao WhatsApp Business" (a etiqueta também é criada ou sincronizada no WhatsApp) | pretty.js:99562-99690 |
| `leads_count` | int | leitura | Coluna "Contatos marcados"; só vem com `with_leads_count=true` | pretty.js:100680 |
| `created_at` | datetime | leitura | | |

Paleta de cores pré-definidas (pretty.js:95050-95082): azul, vermelho, verde, âmbar, roxo, laranja, ciano, lima, rosa, cinza, amarelo, magenta, preto e branco, além de "Personalizada" (hex livre). O i18n traz 15 nomes de cor (pretty.js:15722-15739).

### 3.F Fluxos Padrões (`connection_flow_config`) — um por conexão

| Campo | Tipo | Default | Rótulo / regra | Ref |
|---|---|---|---|---|
| `connection_id` | int | | Conexão WhatsApp | pretty.js:101965 |
| `welcome_flow_id` | int/null | null | "Boas-vindas": disparado para contato novo na primeira mensagem | i18n 16758 |
| `default_response_flow_id` | int/null | null | "Resposta padrão": quando nenhuma palavra-chave casa, após o período de inatividade | |
| `default_response_delay_hours` | int | 24 | "Atraso (h)": entre 1 e 168 | i18n 16790 |
| `finished_conversation_flow_id` | int/null | null | "Conversa finalizada": cliente reabre uma conversa já concluída | |
| `finished_attendance_flow_id` | int/null | null | "Atendimento finalizado": no momento em que o atendimento é concluído | |
| `keyword_triggers[]` / `keyword_triggers_attributes[]` | lista | [] | "Palavras-chave": têm prioridade sobre os outros fluxos padrões | pretty.js:102290-102320 |

Gatilho de palavra-chave:

| Campo | Tipo | Notas |
|---|---|---|
| `id` | int | |
| `flow_id` | int | obrigatório |
| `rule_type` | `any` ("Qualquer condição (OU)") / `all` ("Todas as condições (E)") | default `any` |
| `conditions[]` | `{match_type, keyword}` | `keyword` obrigatório. Formato legado: `keyword` + `match_type` na própria raiz do gatilho. |
| `position` | int | ordem |
| `active` | bool | default true |
| `_destroy` | bool | remoção |

O status de completude por conexão conta quantos dos 4 fluxos fixos estão preenchidos: `empty` ("Sem fluxos"), `incomplete` ("{{filled}}/{{total}}") e `complete` ("Completo"). Filtros: Todas, Incompletas, Sem fluxos (pretty.js:101975-101982).

### 3.G Tradução de fluxo (`flow_translation run`)

Requisição de estimativa e de criação (pretty.js:244669-244755):

| Campo | Tipo | Notas |
|---|---|---|
| `locale_code` | string | vem de `/flow_translation_locales` (`code`, `label`, `flag`, `currency`, `listing_label`) |
| `include_audio` | bool | |
| `include_image` | bool | |
| `include_pdf` | bool | com aviso de custo alto e baixa precisão |
| `audio_provider` | `fish` ("Econômica") / `elevenlabs` ("Premium (dublagem)") | só quando há áudio |
| `audio_voice_id` | string | só no provider fish; sem voz escolhida, o áudio vira "Original (clone)" |

O texto está sempre incluso. Grupos de voz: pt-BR, pt-PT, es-419, es-ES, en-US, en-GB, hi, other (pretty.js:247947).

Run no histórico (pretty.js:116870-116930): `id`, `created_at`, `source_flow_id`, `source_flow_name`, `source_flow_kept`, `result_flow_id`, `result_flow_name`, `result_flow_kept`, `locale_code`, `locale_label`, `status`, `reserved_tokens`, `charged_tokens`, `released_tokens`. O run detalhado também traz progresso (done/total por estágio), `errors[]` e `warnings[]` com `{error|warning|code, where|block|field, currency}`.

Estimativa: `tokens`, `available`, preço em BRL e quebra por texto, áudio, imagem e PDF. A carteira (`/flow_translations/wallet`) tem `available_units`. Settings: `{enabled, voice_clone_enabled}` (default true/true).

## 4. Estados e transições

### 4.1 Status de template WhatsApp (i18n pretty.js:17254) [REQUER WABA]

| Valor | Rótulo |
|---|---|
| PENDING | Pendente |
| IN_REVIEW | Em revisão |
| APPROVED | Aprovado |
| REJECTED | Rejeitado |
| PAUSED | Pausado |
| DISABLED | Desabilitado |
| FLAGGED | Sinalizado |
| REINSTATED | Reativado |
| ARCHIVED | Arquivado |
| LOCKED | Bloqueado |
| IN_APPEAL | Em recurso |
| LIMIT_EXCEEDED | Limite excedido |
| PENDING_DELETION | Exclusão pendente |
| DELETED | Excluído |

O filtro rápido de status na listagem oferece só: Todos, APPROVED, PENDING, IN_REVIEW e REJECTED (pretty.js:111577).

Transições:
- criar → PENDING ("Template enviado para revisão na Meta (status: Pendente)")
- a Meta aprova ou rejeita (o status chega por sincronização manual "Sincronizar" ou automática [INFERIDO: webhook Meta no backend])
- REJECTED → "Corrigir e reenviar". Só nesse status (pretty.js:114847): o modal mostra o motivo e a recomendação, permite mudar a categoria e os componentes (nome e idioma não mudam) e volta para PENDING
- APPROVED não é editável ("Após aprovação, não é possível editar o template")
- excluir → removido (PENDING_DELETION/DELETED vêm da Meta)

Erro especial `inconsistent_state` no reenvio: a Meta recebeu, mas o status local não foi atualizado. A UI bloqueia um novo reenvio e orienta a sincronizar (pretty.js:111553-111575).

Qualidade (`quality_score`) [REQUER WABA]: GREEN "Alta", YELLOW "Média", RED "Baixa", UNKNOWN "Desconhecida".
Categorias: UTILITY "Utilidade", MARKETING "Marketing", AUTHENTICATION "Autenticação".
Idiomas: pt_BR "Português (Brasil)", pt_PT "Português (Portugal)", en_US "Inglês (EUA)", en_GB "Inglês (Reino Unido)", es_ES "Espanhol (Espanha)", es_AR "Espanhol (Argentina)", es_MX "Espanhol (México)".

### 4.2 Run de tradução de fluxo (i18n pretty.js:25488-25505)

`queued` (Na fila) → `running` (Traduzindo) → `completed` (Concluído) | `failed` (Falhou) | `canceled` (Cancelado).

Estágios: `copy` (Cópia), `text` (Texto), `audio` (Áudio), `image` (Imagem), `pdf` (PDF), `media` (Mídia), `settle` (Fechamento).

Tokens: são reservados na criação, cobrados conforme o uso e devolvidos ao fim (colunas Reservado, Usado e Devolvido).

Códigos de erro por trecho (o texto fica no original): `placeholder_mismatch`, `over_limit`, `validation_failed`, `opaque_batch`, `untranslated`, `unknown`.

Códigos de aviso: `image_not_generated`, `missing_audio`, `missing_image`, `missing_action`, `empty_transcript`, `opaque_audio`, `opaque_image`, `opaque_pdf`, `missing_pdf`, `missing_voice`, `untranslated_audio`, `insufficient_credits`, `plain_photo`, `fx_unavailable`, `connection_flow_untranslated`, `currency_manual`, `currency_manual_sale`, `currency_manual_pix` (pretty.js:25425-25465).

### 4.3 Outros enums

- Match de palavra-chave (pretty.js:101731-101741): `equals` (É igual), `contains` (Contém, default), `different` (É diferente), `excludes` (Não contém), `starts_with` (Começa com), `ends_with` (Termina com).
- Tipos de ação de resposta rápida (pretty.js:90196-90229, i18n 16446): Texto, Imagem, Vídeo, Áudio, Documento, Sticker (e Contato só como rótulo).
- Filtro de tipo de resposta rápida (`media_type`): all, text, image, video, audio, document, sticker.
- Tipo de variável global: Texto, Número.
- Tipo exibido de campo personalizado: Texto, Media, Variável.

## 5. Ações e regras de negócio

### A. Respostas Rápidas
1. Listar com paginação, busca por atalho ou conteúdo e filtro por tipo. Colunas: Atalho, Tipo, Preview, Criado em, Ações. O preview mostra "(+N ações)".
2. Criar ou editar com atalho e lista de ações: adicionar texto, mídia (tipo escolhido) ou sticker; reordenar; remover (ação existente recebe `_destroy`); trocar ou remover arquivo; legenda opcional. O texto aceita variáveis com o mesmo padrão dos fluxos (`{full_name}`, `{g_x}`, campos de instância e campos customizados).
3. Excluir com confirmação ("excluir a resposta rápida "{{shortcut}}"?").
4. Copiar o atalho para a área de transferência.
5. No chat, mostrar os recentes primeiro (localStorage) e buscar no servidor.

### B. Templates WhatsApp [REQUER WABA]
1. Selecionar a WABA, entre as conexões Meta Cloud. Sem nenhuma, aparece "Nenhuma conexão Meta Cloud".
2. Listar com filtros de status, categoria, idioma, nome e busca, mais paginação.
3. Sincronizar com a Meta (`POST /whatsapp_templates/sync`), que retorna a contagem.
4. Criar em três modos: padrão, Pix (ORDER_DETAILS, com o texto do botão fixo "Copy Pix code") ou Autenticação (OTP). A pré-visualização imita o WhatsApp. O upload de mídia do header faz um preview antes da criação (`upload_header_media`, com `format` IMAGE/VIDEO/DOCUMENT).
5. Visualizar a pré-visualização com exemplos.
6. Corrigir e reenviar (só REJECTED).
7. Excluir (`DELETE` com `connection_id`) após a confirmação "Excluir template "{{name}}"?".
8. Regras exibidas: Quick Reply pode ser roteado no fluxo por payload; botões URL e telefone não geram resposta no fluxo.

### C. Variáveis Globais
1. Listar, buscar, criar (aplica o prefixo `g_`), editar descrição, tipo e valor (o nome é imutável), excluir com confirmação e copiar o nome.
2. Ao mudar o tipo para Número, o valor precisa ser numérico válido.

### D. Campos Personalizados
1. Listar os customizados e os do sistema em paralelo; a busca local é por key ou descrição.
2. Criar (key + descrição) e editar só a descrição. Não existe exclusão.

### E. Etiquetas
1. Listar com contagem de leads, buscar, criar, editar e excluir com confirmação.
2. "Importar do WhatsApp" só aparece se existir conexão `api_provider = uazapi` ou `z_api` com status `connected`. Chama `import_from_uazapi` e/ou `import_from_z_api` e soma `total_labels_imported`/`imported_count`, `total_labels_updated`/`updated_count`, `connections_processed` e `errors[]` (pretty.js:100315-100350, 100443-100450).
3. `sync_with_z_api` existe no serviço (pretty.js:99543) [NÃO VERIFICADO onde a UI chama].
4. O serviço guarda em cache em memória a lista sem contagem (`skip_leads_count`) e invalida o cache em toda mutação (pretty.js:99485-99510).

### F. Fluxos Padrões
1. Selecionar uma conexão na lista pesquisável (status Conectada/Desconectada e badge de completude).
2. Editar os 4 fluxos fixos, o atraso da resposta padrão e os gatilhos de palavra-chave (cada um com fluxo, regra any/all e condições). O botão Salvar fica desabilitado se faltar fluxo ou keyword ("Selecione um fluxo e preencha todas as palavras-chave").
3. Se a conexão não tiver config, ela é criada (POST); se tiver, é atualizada (PATCH). O default local está em pretty.js:101961-101973.
4. Seleção em massa: marcar N conexões e, para cada campo fixo, escolher "Não alterar" (sentinela `__keep__`), "Nenhum fluxo" (`__clear__`) ou um fluxo, além do atraso. A confirmação avisa quantas conexões serão sobrescritas e envia `POST bulk_update`. As palavras-chave não são editáveis em massa (pretty.js:101947-101950, i18n 16795-16830).
5. Alterações não salvas: ao trocar de conexão ou entrar no modo massa, o usuário confirma "Descartar" ou "Continuar editando".

### G. Traduções de fluxo
1. A partir de um fluxo, abrir o modal: escolher o idioma e o que incluir (áudio, imagem, PDF) e o provider ou voz do áudio. A estimativa é recalculada com debounce de 250 ms.
2. Se o saldo for menor que os tokens, a UI mostra "Comprar créditos" (top-up); um erro `insufficient_credits` vindo da API também desvia para a compra.
3. Confirmar cria o run e uma cópia do fluxo no idioma alvo. Se já existir cópia nesse idioma, a UI avisa que será criada outra.
4. O progresso chega por realtime e por polling a cada 3 s até `completed` ou `failed`. O modal pode ser fechado e a tradução continua em segundo plano. Ao final aparece "Abrir cópia" e o relatório de erros e avisos.
5. Moeda: botões, PIX e vendas em BRL não são convertidos; a UI avisa para ajustar manualmente.
6. A aba de settings "Traduções de fluxo" lista o histórico da conta (Data, Fluxo original, Cópia, Idioma, Status, Reservado, Usado, Devolvido), com link para o fluxo quando ele ainda existe (`*_kept`).

## 6. Endpoints da API (base `/api/v1`, Bearer token)

| Método | Caminho | Payload / query | Ref |
|---|---|---|---|
| GET | `/quick_replies` | `page, limit, search, media_type` → `{quick_replies, pagination{has_more,total_pages…}}` ou array | pretty.js:90096-90120 |
| GET | `/quick_replies/:id` | | pretty.js:90126 |
| POST | `/quick_replies` | multipart `quick_reply[shortcut]`, `quick_reply[quick_reply_actions_attributes][i][...]` | pretty.js:90169 |
| PUT | `/quick_replies/:id` | multipart, igual ao POST | pretty.js:90179 |
| DELETE | `/quick_replies/:id` | | pretty.js:90188 |
| GET | `/whatsapp_templates` [REQUER WABA] | `page, limit, waba_id, status, category, language, name, search` | pretty.js:111486-111500 |
| GET | `/whatsapp_templates/:id` [REQUER WABA] | | pretty.js:111502 |
| POST | `/whatsapp_templates/sync` (fonte: REA) [REQUER WABA] | `{connection_id}` | pretty.js:111520 |
| POST | `/whatsapp_templates/upload_header_media` [REQUER WABA] | multipart `connection_id, file, format` → `{preview_url, …handle}` | pretty.js:111528-111540 |
| POST | `/whatsapp_templates` (fonte: REA) [REQUER WABA] | `{connection_id, whatsapp_template: {name, language, category, parameter_format, components[], display_format?}}` | pretty.js:111545, 112393-112402 |
| PATCH | `/whatsapp_templates/:id` [REQUER WABA] | `{connection_id, whatsapp_template: {category, components}}`; erro com `inconsistent_state: true` | pretty.js:111554 |
| DELETE | `/whatsapp_templates/:id?connection_id=` [REQUER WABA] | | pretty.js:111565 |
| GET | `/global_variables` (fonte: REA) | `page, limit, search` → `{global_variables, pagination}` ou array | pretty.js:90348-90370 |
| POST | `/global_variables` (fonte: REA) | `{global_variable: {name, description, data_type, value}}` | pretty.js:90372 |
| PUT | `/global_variables/:id` | `{global_variable: {description, data_type, value}}` | pretty.js:90377 |
| DELETE | `/global_variables/:id` | | pretty.js:90382 |
| GET | `/customers/custom_fields` (fonte: REA) | → `{custom_fields: [{key, description, example_value}]}` | pretty.js:91188 |
| GET | `/customers/custom_fields?keys_only=true` (fonte: REA) | → só as keys | pretty.js:91178 |
| POST | `/customers/custom_fields` (fonte: REA) | `{key, description}` | pretty.js:91214 |
| PATCH | `/customers/custom_fields/:key/description` | `{description}` (key com URL-encode) | pretty.js:91201 |
| GET | `/customers/bot_fields` (fonte: REA) | → `{bot_fields: [{key, description}]}` | pretty.js:91225 |
| GET | `/labels` | `page, limit, search, with_leads_count, skip_leads_count` → `{labels, pagination}` ou array | pretty.js:99464-99478 |
| POST | `/labels` (fonte: REA) | `{label: {name, color, whatsapp_enabled}}` | pretty.js:99512 |
| PUT | `/labels/:id` | `{label: {...}}` | pretty.js:99519 |
| DELETE | `/labels/:id` | | pretty.js:99526 |
| POST | `/labels/import_from_uazapi` (fonte: REA) [INSTÁVEL NO BAILEYS] (só número Business app; labels via app state) | `{connection_id?}` | pretty.js:99531 |
| POST | `/labels/import_from_z_api` (fonte: REA) | `{connection_id?}` | pretty.js:99538 |
| POST | `/labels/sync_with_z_api` (fonte: REA) | `{}` | pretty.js:99544 |
| GET | `/connection_flow_configs` (fonte: REA) | → lista | pretty.js:101530 |
| GET | `/connection_flow_configs/:id` | | pretty.js:101535 |
| POST | `/connection_flow_configs` (fonte: REA) | `{connection_flow_config: {connection_id, welcome_flow_id, default_response_flow_id, default_response_delay_hours, finished_conversation_flow_id, finished_attendance_flow_id, keyword_triggers_attributes[]}}` | pretty.js:101549 |
| PATCH | `/connection_flow_configs/:id` | igual | pretty.js:101541 |
| POST | `/connection_flow_configs/bulk_update` (fonte: REA) | `{connection_ids[], connection_flow_config: {campos alterados}}` | pretty.js:101557 |
| DELETE | `/connection_flow_configs/:id` | | pretty.js:101565 |
| GET | `/flow_translations/voices` (fonte: REA) | → `{voices: [{id, name, flag, gender, group…}]}` | pretty.js:116733 |
| GET | `/flow_translation_locales` (fonte: REA) | → `{locales}` | pretty.js:116738 |
| GET | `/flow_translations/settings` (fonte: REA) | → `{enabled, voice_clone_enabled}` | pretty.js:116743 |
| GET | `/flow_translations/wallet` (fonte: REA) | → saldo (`available_units`) | pretty.js:116748 |
| POST | `/flows/:id/translation_estimate` | `{locale_code, include_audio, include_image, include_pdf, audio_provider?}` | pretty.js:116754 |
| POST | `/flows/:id/translations` | idem + `audio_voice_id?` → `{run}` | pretty.js:116760 |
| GET | `/flows/:id/translations/:runId` | → `{run}` | pretty.js:116766 |
| GET | `/flow_translations/runs` (fonte: REA) | → `{runs}` (histórico da conta) | pretty.js:116772 |

Endpoints administrativos do tradutor (`/admin/flow_translations/{locales,settings,secrets,billing_configs,runs/:id(/refund),usage_events/:id(/refund)}`, pretty.js:260554-260630) ficam documentados em 20-admin-interno.md.

Observação: o cliente HTTP tem um "flow codec" que ofusca payloads de algumas rotas de fluxo (versões v1/v2/v3, pretty.js:34180-34260). Se as rotas `/flows/...` do tradutor passam por ele, depende de `shouldUseFlowCodec` [NÃO VERIFICADO].

## 7. Eventos realtime (ActionCable)

| Canal | Params | Evento | Uso | Ref |
|---|---|---|---|---|
| `AccountNotificationsChannel` | `{account_id}` | `{type: "flow_translation", account_id, run: {...}}` | atualiza o progresso do run aberto no modal do tradutor (com polling de 3 s como fallback) | pretty.js:244472-244490 |

Não foi encontrado evento realtime para respostas rápidas, templates, variáveis, campos, etiquetas ou fluxos padrões. Essas listas recarregam após cada mutação e quando a empresa ativa muda (`accountChanged` do `useAccountChange`).

## 8. Permissões

Modelo: `settings.<recurso>.<view|edit|delete>` (pretty.js:36096-36125).

| Recurso | Chave | member (default) | admin/owner (default) |
|---|---|---|---|
| Respostas rápidas | `settings.quick_replies.*` | view **e edit** (exceção explícita, pretty.js:36195) | view/edit/delete |
| Etiquetas | `settings.labels.*` | view | view/edit/delete |
| Campos personalizados | `settings.fields.*` | view | view/edit/delete |
| Fluxos padrões | `settings.dispatch.*` | view | view/edit/delete |
| Variáveis globais | `settings.global_variables.*` | sempre true (todas as ações, para qualquer papel, inclusive support) | sempre true |
| Templates WhatsApp [REQUER WABA] | (nenhuma chave) | visível para todos enquanto `Kje` = false | idem |
| Histórico de traduções | `flows.view` | sim | sim |
| Traduzir fluxo | [INFERIDO: `flows.edit`, via `canTranslate`, pretty.js:244465] | não | sim |

- O owner (não support) tem tudo liberado. Se a conta definir `current_account.permissions` (lista customizada), ela substitui os defaults (pretty.js:36222-36226).
- O papel `support` só vê abas cuja permissão foi explicitamente concedida e nunca vê o histórico de traduções (pretty.js:117390-117400).
- Mapeamento usado em `hasPermission(resource, action)`: label → labels.view, quick_reply → quick_replies.view, global_variable → global_variables.view, connection_flow_config → dispatch.view (pretty.js:36296-36318).
- [INFERIDO] Nas telas analisadas, o frontend não esconde de forma visível os botões de editar e excluir por `.edit`/`.delete`. A aplicação real dessas permissões deve ficar no backend (respostas 403: "Você não tem permissão para realizar esta ação.").

## 9. Integrações externas

- **Meta WhatsApp Cloud API** [REQUER WABA]: templates (criação, revisão, status, qualidade, categoria), upload de mídia de exemplo via resumable upload / `header_handle` [INFERIDO], conexões `meta_cloud` com `waba_id`.
- **Providers não oficiais de WhatsApp**: uazapi e Z-API, para importar e sincronizar etiquetas com o WhatsApp Business.
- **Tradutor de fluxo** (as chaves ficam no admin, pretty.js:31360-31367): Qwen/DashScope (texto), ElevenLabs (dublagem), Groq (transcrição), Fish Audio (voz econômica e clone), Kie e Google "Nano Banana" (imagem), Lara (PDF). Câmbio para preços em outras moedas (`fx_unavailable`).
- **Carteira de créditos/tokens** do tradutor, com top-up (compra de créditos) [NÃO VERIFICADO: fluxo de checkout].

## 10. Lacunas

1. [NÃO VERIFICADO] Formato exato da resposta de `GET /whatsapp_templates` (paginação, campo de categoria anterior, `waba_id` por item) e como o status chega da Meta (webhook ou sync periódico).
2. [NÃO VERIFICADO] Limites de upload e validações server-side das respostas rápidas; existência real e UI do tipo `send_contact`.
3. [INFERIDO] A aplicação de `settings.*.edit/delete` acontece só no backend; não foi confirmado se a UI esconde botões para `member`.
4. [NÃO VERIFICADO] Algoritmo de "resposta padrão após inatividade" (o atraso em horas conta desde a última mensagem de quem?) e a semântica exata de `different`/`excludes` com múltiplas condições.
5. [NÃO VERIFICADO] Precificação do tradutor (tokens → BRL), regra de reserva e devolução, fluxo de compra de créditos e quando `voice_clone_enabled` = false.
6. [NÃO VERIFICADO] Onde `POST /labels/sync_with_z_api` é acionado e o efeito de `whatsapp_enabled` em providers que não são Z-API.
7. [INFERIDO] Os campos personalizados são criados implicitamente ao gravar um contato com uma key nova; a key é única por conta.
8. [NÃO VERIFICADO] Se excluir uma variável global ou etiqueta em uso por fluxos é bloqueado ou só gera falha em runtime.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Submódulo B inteiro: aba/rota `whatsapp_templates`, seleção de WABA, sync com a Meta, criar/corrigir/reenviar/excluir template | [REQUER WABA] | Não há aprovação de modelo no Baileys: usar Respostas Rápidas (submódulo A) como "modelos" de mensagem livre com variáveis |
| Campos `category` (UTILITY/MARKETING/AUTHENTICATION), `parameter_format`, `components` no formato Meta, `connection_id` meta_cloud | [REQUER WABA] | Modelo interno simples (texto + mídia + variáveis `{campo}`), sem categoria |
| Template Pix (`ORDER_DETAILS`, "Copy Pix code") | [REQUER WABA] | Mensagem de texto com o código Pix copia-e-cola (e QR como imagem) |
| Template de autenticação (OTP, botão COPY_CODE, expiração) | [REQUER WABA] | Mensagem de texto com o código OTP |
| Botões de template (quick_reply, url, phone) | [REQUER WABA] | Menu numerado em texto ("Responda 1, 2 ou 3") + links/telefone no corpo |
| Status de template (PENDING…DELETED), `quality_score`, "categoria alterada" | [REQUER WABA] | Não se aplica (sem revisão da Meta) |
| Upload de mídia de header (`upload_header_media`, `header_handle`) | [REQUER WABA] | Upload de mídia comum da Resposta Rápida |
| Endpoints `/whatsapp_templates*` e integração Meta WhatsApp Cloud API | [REQUER WABA] | Remover do clone |
| Importar/sincronizar etiquetas com o WhatsApp (`import_from_uazapi`) | [INSTÁVEL NO BAILEYS] | Labels nativas só em contas WhatsApp Business app, via app state do Baileys; manter etiquetas como dado interno do CRM e tratar sincronização como opcional |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Traduções de fluxo:** histórico apenas do tradutor, com original, cópia, reservado, usado e devolvido. Vazio: "Nenhuma tradução nesta conta."
- **Fluxos Padrões:** filtros Todas (N), Incompletas (N), Sem fluxos (N). Toggle "Seleção em massa" (aplicar o mesmo fluxo em várias conexões). Cards por conexão com o progresso "1/4" (gatilhos configurados de 4).
- **Respostas Rápidas:** "Nova Resposta", busca, filtro "Tipo: Todos os tipos". Vazio: "Criar Primeira Resposta".
- **Templates WhatsApp** [REQUER WABA]: "Gerencie templates oficiais Meta por WABA". Botões Sincronizar e Criar. Select WABA e filtro Status. Sem conexão oficial: "Nenhuma conexão Meta Cloud".
- **Variáveis Globais:** "Nova Variável", busca. Vazio: "Criar Variável".
- **Campos Personalizados:** abas Customizados | Sistema (BOT), botão "Novo Campo". Tabela NOME, DESCRIÇÃO ("Sem descrição"), TIPO (ex. Texto), AÇÕES. Há campos com prefixo "#" e campos de sistema com notação de ponto (ex. `ai.<campo>`) criados pela IA ou pelos fluxos.
- **Etiquetas:** subtítulo literal com "CRUD completo em breve". Botões "Importar do WhatsApp" e "Nova Etiqueta", busca. Tabela NOME, CONTATOS MARCADOS ("N contatos"), AÇÕES.
