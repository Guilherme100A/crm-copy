# 03 — Chats (Atendimento / Inbox)

Fonte: bundle JS público (REA + leitura de strings) e navegação somente leitura. Exemplos são fictícios.

## Telas e rotas
| Rota | Descrição | Permissão |
|---|---|---|
| `/chat` | Inbox de atendimento (lista + conversa + painel lateral) | `chat.view` |
| `/chats` | Alias da mesma tela | `chat.view` |

- A URL não carrega o id do chat. O chat selecionado fica em `sessionStorage["selected_chat_<accountId>"]`.
- Outros módulos (CRM, contatos, notificações) abrem um chat disparando o evento DOM `selectChat` (detail com o id do chat) e navegando para `/chat`.

## Features

### Lista de conversas (F01–F14)
1. **Abas por status** — `waiting` (Aguardando), `attending` (Atendendo), `resolved` (Resolvidos).
2. **Busca** por texto (`search`): nome ou telefone do contato.
3. **Filtro por atendente** (`assigned_to`).
4. **Filtro por status de resposta** (`response_status`).
5. **Filtro lido/não lido** (`read_status`).
6. **Filtro por período** (`created_from` e `created_to`). Se usar um, os dois são obrigatórios.
7. **Filtro por conexões** (`connection_ids[]`).
8. **Filtro por departamentos** (`department_ids[]`).
9. **Filtro por etiquetas** (`labels[]`).
10. **Filtro por CRM** (`crm_id`) e por contato (`customer_id`).
11. **Persistência dos filtros** em `localStorage["chat_filters"]`.
12. **Paginação** de 15 chats por página com scroll infinito; cache local de 10 s por combinação de filtros.
13. **Contador de não lidas** e indicador por chat.
14. **Escopo de visibilidade** — `current_account.chat_scope` (departamentos e conexões permitidos) limita as conversas que o atendente vê.

### Ciclo de vida do chat (F15–F22)
Estados: `waiting` → `attending` → `resolved` → (reabrir) `attending`/`waiting`.

| Ação | Endpoint | Transição |
|---|---|---|
| 15. Aceitar | `PATCH /chats/:id/assign {user_id}` | waiting → attending |
| 16. Assumir (de outro atendente) | `PATCH /chats/:id/assign {user_id}` | attending → attending (novo dono) |
| 17. Desatribuir | `/chats/:id/unassign` | attending → waiting [INFERIDO] |
| 18. Resolver | `/chats/:id/resolve` | → resolved |
| 19. Reabrir | `/chats/:id/reopen` | resolved → attending/waiting [NÃO VERIFICADO] |
| 20. Auto-assign | enviar a 1ª mensagem num chat que não é seu | atribui ao remetente |
| 21. Bloquear contato | `/chats/:id/block` | — |
| 22. Excluir chat | DELETE `/chats/:id` [INFERIDO]; gera `chat_destroyed` | — |

### Mensagens — leitura (F23–F30)
23. **Histórico paginado** — `GET /chats/:id/messages`, 25 por página, carrega ao subir o scroll.
24. **Marcar como lida** — `/chats/:id/mark_as_read`; **marcar todas** — `/chats/mark_all_as_read`.
25. **Tipos renderizados**: text, image, audio, video, document, sticker, pix_button, location, contact, whatsapp_order, missed_call, voice_call [INSTÁVEL NO BAILEYS] (Baileys só recebe o evento de chamada; não atende nem faz chamadas), link (preview), menus/listas/botões e carrossel [INSTÁVEL NO BAILEYS] (mensagens interativas não oficiais; o WhatsApp pode não renderizar ou bloquear).
26. **Status de entrega** (enviado/entregue/lido/falha) atualizado por realtime. O "lido" é [INSTÁVEL NO BAILEYS] (não chega se o contato desativou confirmação de leitura).
27. **Mensagens apagadas** exibidas como removidas (`message_deleted`).
28. **Mensagens de visualização única** com marcação própria.
29. **Assinatura do atendente** — prefixo `*Nome*:` no texto quando ativada.
30. **Notas internas** — `/chats/:id/notes` (listar/criar), não vão para o contato.

### Mensagens — envio (F31–F42)
31. **Texto** com quebra de linha e formatação WhatsApp (`*negrito*`, `_itálico_`, `~riscado~`).
32. **Imagem** (até 20 MB).
33. **Áudio** gravado no navegador ou arquivo (até 16 MB).
34. **Vídeo** (até 20 MB; 16 MB em conexões Meta).
35. **Documento** (até 30 MB).
36. **Upload de mídia** — `POST /media/upload` antes do envio.
37. **Figurinhas** — `/stickers` (CRUD, `toggle_favorite`); envio por `/chats/:id/send_sticker`.
38. **Botão Pix** (`pix_button`) [INSTÁVEL NO BAILEYS] (botão interativo; pode quebrar quando o WhatsApp muda o protocolo).
39. **Template oficial** [REQUER WABA] — só em conexões `meta_cloud`; enviado como `text` cujo conteúdo é um JSON `whatsappTemplateSend` (nome, idioma, variáveis).
40. **Visualização única** como opção de envio de mídia.
41. **Responder (citar)** uma mensagem.
42. **Encaminhar** mensagem para outro chat.

### Ações na mensagem (F43–F47)
43. **Reagir** — `/chats/:id/react`; só em provedores `uazapi` e `meta_cloud` e só em mensagens de até 7 dias. [INSTÁVEL NO BAILEYS] (funciona, mas depende do id/chave exata da mensagem original).
44. **Traduzir** — `/chats/:id/translations`; consome créditos da conta.
45. **Copiar** texto.
46. **Baixar** mídia.
47. **Apagar** mensagem (para todos).

### Produtividade (F48–F51)
48. **Respostas rápidas** — abrem digitando `/`; filtram por atalho; recentes em `localStorage`.
49. **Variáveis** nas respostas: `{{customer.*}}` (campos do contato), `{{global.g_*}}` (variáveis globais), `{saudacao}` (bom dia/boa tarde/boa noite) e afins.
50. **Agendamento de mensagem** — `/chats/:id/message_schedules` e `/message_schedules`:
    - `kind`: `message` ou `flow`
    - `recurrence`: `one_off`, `daily`, `weekly`, `monthly`
    - data/hora obrigatória, no máximo 31 dias à frente.
51. **Listar/cancelar agendamentos** do chat.

### Painel lateral do contato (F52–F62)
52. **Dados do contato** e edição (abre o contato).
53. **CRM e etapa do Kanban** — `/chats/:id/update_crm`.
54. **Etiquetas** — `/chats/:id/add_tag`, `/remove_tag`; importar etiquetas do contato com `/import_customer_labels`.
55. **Departamento** — trocar o departamento é a forma de transferir.
56. **Atendente responsável** (atribuir/trocar).
57. **Agente de IA** — ver opções `/ai_agent_options`, desativar `/release_ai_agent`, trocar `/switch_ai_agent`.
58. **Disparar fluxo** — `POST /flows/:id/trigger {chat_id}`.
59. **Fluxos em execução** — `/chats/:id/active_flow_executions`; cancelar com `/flow_executions/:id/cancel`.
60. **Respostas coletadas pela IA** — `/chats/:id/flow_executions_with_ai_data`.
61. **Criar fluxo a partir da conversa** — `/flows/from_conversation`.
62. **Contexto do painel** — `GET /chats/:id/panel_context` agrega os dados acima numa chamada.

## Permissões
- `chat.view` para acessar a rota.
- `chat_scope` da conta/usuário restringe departamentos e conexões visíveis.
- Assumir chat de outro atendente pode depender de permissão específica [NÃO VERIFICADO].

## Realtime — `ChatsChannel {account_id}`
| Evento | Efeito |
|---|---|
| `new_message` | adiciona a mensagem e sobe o chat na lista |
| `new_chat` | insere o chat na aba correspondente |
| `chat_destroyed` | remove da lista |
| `message_status_update` | atualiza ticks de entrega/leitura |
| `message_deleted` | marca mensagem como apagada |
| `chat_status_update` | move entre abas |
| `chat_updated` | atualiza campos (atendente, etiquetas, CRM) |
| `user_typing` | indicador de digitação |
| `customer_updated` | atualiza dados do contato |
| `flow_execution_created` / `flow_execution_cancelled` | atualiza fluxos ativos |

## Integrações externas
- Provedores WhatsApp: `uazapi` (não oficial) e `meta_cloud` (API oficial) [REQUER WABA]. As regras de reação e template dependem do provedor.
- Tradução via serviço de IA (créditos).

## Lacunas
- [NÃO VERIFICADO] Formato completo do `content` JSON de location, contact, menus/carrossel e whatsapp_order (visto em parte).
- [INFERIDO] Tradução concluída chega por `message_status_update`.
- [NÃO VERIFICADO] Ações em massa, tempo de espera e modal dedicado de transferência aparecem só em traduções/placeholders, sem implementação.
- [NÃO VERIFICADO] Payload completo de `panel_context`.
- [NÃO VERIFICADO] Janela de 24 h do Meta [REQUER WABA] não é aplicada no cliente; deve ser regra do backend.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| F39 Template oficial (`whatsappTemplateSend`) | [REQUER WABA] | Mensagem livre (texto/mídia) com variáveis de resposta rápida |
| Provedor `meta_cloud` | [REQUER WABA] | Só conexão Baileys (QR/código) |
| Janela de 24 h | [REQUER WABA] | Não se aplica; sem restrição de janela (cuidar de anti-spam/ritmo) |
| F38 Botão Pix | [INSTÁVEL NO BAILEYS] | Texto com a chave PIX formatada (copiável) |
| Menus/listas/botões/carrossel (render) | [INSTÁVEL NO BAILEYS] | Menu numerado em texto; carrossel → sequência de mídias com legenda |
| F43 Reagir | [INSTÁVEL NO BAILEYS] | `sendMessage` com `react` (guardar a key da mensagem) |
| Status "lido" (F26) | [INSTÁVEL NO BAILEYS] | Recibos `messages.update`; tratar "lido" como opcional |
| missed_call / voice_call | [INSTÁVEL NO BAILEYS] | Evento `call` só para registrar/rejeitar; sem chamada de voz |

## Observado no app (portal)

Passada somente leitura em 2026-10-15 (viewport 1100x556). Nenhuma ação foi executada. A conversa aberta foi escolhida sem mensagens não lidas, para não gerar confirmação de leitura.

- **Lista (coluna esquerda):** cabeçalho com o nome da empresa, busca "Buscar chats...", botão "Criar novo chat" (+) e botão "Filtros".
  - Abas de etapa: Aguardando | Atendendo | Resolvidos.
  - Filtro rápido: Tudo | Não lidas | Não respondidas, mais o ícone "Mensagens agendadas".
  - Item da lista: avatar com iniciais (ou "+DDI"), badge de não lidas, nome ou telefone, prévia da última mensagem, chip com o nome da conexão, hora, e setas "Voltar para <etapa anterior>" / "Avançar para <próxima etapa>" (move a etapa direto da lista).
  - Botão "Recolher lista de chats".
- **Modal "Filtros de chat":**
  - Responsável (busca por nome).
  - Última interação, com De/Até em datas (intervalo inclusivo, pelo horário da última mensagem).
  - CRM (select "Todos os CRMs").
  - Etiquetas (multi).
  - Conexões (multi, com busca; mostra status Conectada/Desconectada e também conexões deletadas, com sufixo "(deletado) <data>").
  - Departamentos (multi; vazio: "Nenhum departamento cadastrado.").
  - Botões Limpar / Cancelar / Aplicar.
- **Modal "Mensagens agendadas" (lista global):** vazio "Nenhum agendamento ativo na conta".
- **Modal "Criar novo chat":** escolha da CONEXÃO (cards com número e status), busca de cliente por nome/telefone/e-mail, link "Criar novo contato", Cancelar.
- **Cabeçalho do chat aberto:** "Abrir ações do chat" (avatar/nome), "Traduzir mensagens recebidas", "Gerar fluxo a partir da conversa", "Aceitar atendimento", "Agendar mensagem ou fluxo", "Disparar fluxo", "Resolver chat".
- **Barra de etiquetas:** "Abrir lista de etiquetas" (popover "ESCOLHER ETIQUETA" com as etiquetas da conta), chips aplicados (vazio: "Nenhuma etiqueta aplicada") e "Apagar todas as etiquetas".
- **Menu "Mais opções" de cada mensagem:** Responder, Encaminhar, Reagir (👍 ❤️ 😂 😮 😢 🙏 👏 🔥 + "Todos os emojis"), Copiar, Apagar.
- **Compositor:**
  - Anexar arquivo, Enviar sticker, Enviar botão PIX, Adicionar emoji.
  - Indicador de fluxo ativo ("Nenhum fluxo ativo").
  - "Ativar assinatura": toggle que prefixa o nome do atendente; não acionado.
  - Respostas rápidas (popover; vazio "Nenhuma resposta disponível.").
  - Textarea "Digite sua mensagem...", "Gravar áudio", "Enviar mensagem" (desabilitado sem texto).
- **Biblioteca de Stickers:** abas Biblioteca | Criar Sticker | Por URL | Favoritos.
- **Modal "Enviar botão PIX":**
  - Tipo de chave PIX: Chave aleatória (EVP), CPF, CNPJ, Telefone, E-mail.
  - Chave PIX* e Nome do beneficiário (nome exibido no WhatsApp, padrão "Pix").
  - Aviso de instabilidade de botões quando a Meta muda a API.
  - Cancelar / Enviar PIX.
- **Modal "Agenda mensagem":**
  - Tipo Mensagem | Fluxo.
  - Mensagem: Conteúdo vem de um select de respostas rápidas ou "Só texto". Se a resposta rápida tiver um bloco de texto, ele pode ser editado antes de agendar.
  - Fluxo: select de fluxo ativo ("Executa um fluxo ativo neste horário").
  - Data e hora (datetime; no máximo 31 dias à frente, a mesma regra dos fluxos).
  - Repetir: Não repetir | A cada dia | A cada semana | A cada mês.
  - Seção "Pendentes neste chat". Botões Fechar / Agendar.
- **Gaveta "AÇÕES DO CHAT" (direita):**
  - Avatar, telefone (copiar) e "Cliente #<id>" (copiar).
  - Atalhos CRM | Fluxo | Notas | Editar.
  - INFORMAÇÕES DO CLIENTE: telefone (com ícone de bloqueio), e-mail, conta, criado em.
  - CRM & KANBAN: "Selecionar CRM".
  - FILA / DEPARTAMENTO: "Sem departamento". É a transferência entre departamentos.
  - ATRIBUIÇÃO DE ATENDENTE: "Sem responsável (Fila)" + "Atribuir a mim".
  - DISPARAR FLUXO: busca por nome do fluxo + "Disparar".
  - NOTAS: "Adicionar" (vazio "Nenhuma nota ainda...").
  - AÇÕES DESTRUTIVAS: "Excluir chat".
  - Informações: Iniciado em / Última mensagem; botão "Aceitar atendimento".
