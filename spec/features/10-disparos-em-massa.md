# 10 — Disparos em massa (Mass dispatches)

> Fonte: `_bundle/pretty.js` (serviço `Laa` em pretty.js:257950-258040, wizard em pretty.js:274503-275300, lista/detalhe em pretty.js:275380-276400, i18n `settings.massDispatchPage` em pretty.js:17256) mais a tabela do REA. **(fonte: REA)** = presente na tabela do REA. Exemplos fictícios.

## 1. Visão geral

Um disparo em massa **inicia um fluxo** (não uma mensagem avulsa nem um template direto) para muitos contatos de uma vez. Ele usa um ou mais **números de envio** (conexões conectadas), cada um com o seu fluxo, e alterna entre eles. O ritmo é controlado por:
- **janela de envio**: dias da semana e horário de início e fim, ou 24x7;
- **intervalo aleatório** entre envios (mínimo/máximo em segundos, com presets);
- **limite diário** opcional;
- **início agendado**.

O consumo é medido por uma **cota por ciclo de cobrança**: `nº de números faturáveis × limite por número` (default 500 por instância, configurável pelo admin), mais bônus por conta. O público vem da **seleção de contatos** (IDs explícitos ou "todos da base exceto…", com filtros), enviada ao backend como um **manifesto JSON**. O backend prepara a campanha em segundo plano (resolve destinatários e agenda os envios) e envia por uma fila dedicada.

Contagem aproximada: **~25 features**.

## 2. Telas e rotas

| Rota | Descrição | Ref |
|---|---|---|
| `mass-dispatches` (fonte: REA), montada como `/mass-dispatches` | Lista com cards de visão geral (Restantes, Usados no ciclo, Em andamento, Concluídos), barra "Cota do ciclo" com ajuda, busca (nome, fluxo ou número) e tabela (Nome, Fluxo, Status, Progresso, Agenda, Ações) | pretty.js:276336, 272999 |
| Wizard "Novo disparo em massa" (modal, 3 passos) | **Dados** → **Configurações** → **Público**, seguido de modal de confirmação | pretty.js:274559-275300 |
| Modal "Preparando disparo em massa" | Progresso da preparação por fase | pretty.js:275400-275480 |
| Modal "Ver detalhes" | Configuração, agenda, progresso, distribuição A/B, contagens por alvo, botão Cancelar | pretty.js:275580-275925 |
| Atalho a partir de Contatos (`/customers`) | Ação em massa "Novo disparo em massa" navega para `/mass-dispatches` com `state.openCreate=true` e a seleção/filtros atuais | pretty.js:155250-155270, 276123-276140 |

## 3. Modelo de dados / campos

### 3.1 Formulário de criação (wizard)

| Campo | Tipo | Obrig. | Default / validação | Passo |
|---|---|---|---|---|
| name | string | não | "Nome (opcional)". Sem nome, exibe "Disparo em massa #id" | Dados |
| targets[] | {connection_id, flow_id} | sim (≥1) | 1º alvo pré-preenchido com a 1ª conexão `connected` e o 1º fluxo "acionável" (`/flows/names?triggerable_only=true`). Pode adicionar ou remover números. Só conexões conectadas | Dados |
| connection_id / flow_id | int | sim | copiados do 1º alvo (compatibilidade) | |
| flow_b_id | int | não | Fluxo B para teste A/B. Aceito pela API e exibido no detalhe, mas não exposto no wizard atual [NÃO VERIFICADO] | |
| businessHoursToggle | bool | — | true: "Enviar apenas em horário comercial". false: todos os dias de 00:00 a 23:59 | Config. |
| weekdays[] | int 0–6 (0=Dom) | sim se o toggle estiver ligado | default [1,2,3,4,5] (Seg–Sex) | Config. |
| window_start / window_end | "HH:MM" | sim | default 08:00 / 18:00 | Config. |
| speed preset | enum | — | `fast` (0–5 s), `normal` (5–30 s, default), `slow` (30–120 s), `custom` | Config. |
| randomize delay | bool | — | true: intervalo aleatório entre min e max. false: intervalo fixo (max = min) | Config. |
| interval_min_seconds / interval_max_seconds | int (s) | sim | slider de 0 a 120 (`Fz=120`). max ≥ min | Config. |
| daily_limit | int | não | inteiro ≥ 1 e ≤ cota restante. Vazio = sem limite. Ao atingir, pausa e retoma no próximo dia permitido | Config. |
| starts_scheduling_at | datetime-local → ISO | não | default: agora | Config. |
| seleção de público | snapshot de seleção | sim | "Selecione ao menos um contato" | Público |

Validações (pretty.js:274660-274760): `formRequired` (número, fluxo e dias da semana), `noQuota` (restante ≤ 0), `dailyLimitInvalid`, `dailyLimitExceedsQuota`, `selectionRequired`, `invalidSelection` (do backend).

### 3.2 Manifesto de público (arquivo JSON enviado como `manifest`, pretty.js:153245-153290)

```
{ version: 1, mode: "ids", filters: {}, ids: [<ids de contato>] }
ou
{ version: 1, mode: "all_except", filters: {search?, label_ids?, crm_column_ids?, created_at_from?, created_at_to?, custom_field_key?, custom_field_value?}, except_ids: [...] }
```
É montado no navegador com progresso ("Montando manifesto de contatos… N%"). Filtros disponíveis: busca, etiquetas (contato ou chat), etapas de Kanban, intervalo de criação e campo personalizado (com valor opcional).

> Não há upload de CSV nem segmentação própria neste módulo: o público vem da tela de Contatos e dos seus filtros. Também não há envio de template direto. Para a API Oficial, o template inicial é configurado no próprio fluxo [REQUER WABA].

### 3.3 MassDispatch (resposta)

| Campo | Tipo | Notas |
|---|---|---|
| id, account_id, name | | |
| status | enum | ver §4 |
| connection_id, connection_name, flow_id, flow_name, flow_b_name | | |
| targets[] | {connection_id, connection_name, flow_id, flow_name, assigned_count, sent_count, failed_count} | "N agendados · N disparados · N falhas" por alvo |
| total_count, sent_count, failed_count, pending_count, progress_percent | int | "X / Y fluxos disparados · Z falhas". "Disparados" significa que o fluxo começou, sem confirmação de entrega no WhatsApp |
| A/B: aSent/aScheduled/bSent/bScheduled | int | "Distribuição A/B" [nomes de campo NÃO VERIFICADOS] |
| weekdays, window_start, window_end, interval_min_seconds, interval_max_seconds, daily_limit, starts_scheduling_at | | |
| first_sent_at, last_sent_at, finished_at, created_at | datetime | |
| preparation_progress | {phase, scheduled_count, target_count} | fases: `queued`, `resolving_recipients`, `counting`, `scheduling`, `completed`, `processing` |
| preparation_error | string | |

### 3.4 Cota (`mass_dispatch_quota`)

| Campo | Notas |
|---|---|
| limit, used, remaining | por ciclo de assinatura |
| billable_slots | nº de números (instâncias) faturáveis |
| per_instance_limit | taxa por número (admin, default 500) |

Texto exibido: "{used} de {limit} usados ({remaining} restantes) · {slots} número(s) × {rate}/número".

## 4. Estados e transições

`status`: `preparing` (Preparando), `scheduled` (Agendado), `running` (Em andamento), `completed` (Concluído), `cancelled` (Cancelado), `failed` (Falhou).

```
criar → preparing ──(preparação ok)──▶ scheduled ──(janela/horário)──▶ running ──▶ completed
            │                              │                             │
            └──(erro)──▶ failed            └──── cancelar ───────────────┴──▶ cancelled
```
- Cancelar está disponível em `preparing`, `scheduled` e `running` (pretty.js:275583-275586). Os pendentes são cancelados e as mensagens já enviadas não são revertidas. A resposta traz `released_count`, que devolve cota (`used -= released`, `remaining += released`).
- O limite diário causa uma pausa implícita até o próximo dia permitido. Não existe status "paused" nem ação manual de pausar/retomar [NÃO VERIFICADO no backend].
- "Em andamento" na visão geral conta preparing + scheduled + running.

## 5. Ações e regras de negócio

1. **Criar** (multipart): monta o manifesto, envia e recebe `{mass_dispatch, warnings[]}`. O warning de código `only_first_n` aparece como aviso (ex.: cota insuficiente; só os N primeiros são agendados). Os demais aparecem como info.
2. **Confirmação obrigatória** antes de criar: (a) disparar cancela qualquer fluxo em andamento do mesmo lead; (b) se algum alvo for API Oficial (`meta_cloud`): sem template inicial no fluxo e lead fora da janela de 24 h, o fluxo não inicia [REQUER WABA].
3. **Preparação assíncrona**: o modal faz polling de `GET /mass_dispatches/:id` mostrando a fase e "agendados / alvo". O usuário pode fechar, e o progresso continua na lista.
4. **Atualização automática**: enquanto houver disparo em andamento, a lista e a cota são recarregadas a cada 5 s (pretty.js:276140-276155). O carregamento inicial tenta de novo uma vez após 350 ms.
5. **Rotação entre números**: com vários alvos, o backend alterna os envios entre os números, cada um com o seu fluxo.
6. **Intervalo aleatório**: cada envio espera um valor aleatório entre min e max segundos. Com randomização desligada, o intervalo é fixo.
7. **Admin**: `GET/PATCH /admin/mass_dispatch_settings {per_instance_limit}` (fonte: REA) e `GET/PATCH /admin/accounts/:id/mass_dispatch_quota {bonus_delta}` (bônus de cota por conta).

## 6. Endpoints da API

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/mass_dispatches/quota` | → `{mass_dispatch_quota}` | REA |
| GET | `/mass_dispatches` | → `{mass_dispatches[]}` | REA |
| GET | `/mass_dispatches/:id` | → `{mass_dispatch}` | grep |
| POST (multipart) | `/mass_dispatches` | `manifest` (File JSON), `connection_id`, `flow_id`, `flow_b_id?`, `targets[i][connection_id]`, `targets[i][flow_id]`, `name?`, `weekdays[]`, `window_start`, `window_end`, `interval_min_seconds`, `interval_max_seconds`, `daily_limit?` (>0), `starts_scheduling_at?` (ISO) → `{mass_dispatch, warnings}` | REA (GET) / grep (POST multipart) |
| POST | `/mass_dispatches/:id/cancel` | `{}` → `{mass_dispatch, released_count}` | grep |
| GET/PATCH | `/admin/mass_dispatch_settings` | `{per_instance_limit}` | REA |
| GET/PATCH | `/admin/accounts/:id/mass_dispatch_quota` | `{bonus_delta}` | grep |

Dependências: `GET /connections` (filtra `connected`), `GET /flows/names?triggerable_only=true`.

## 7. Eventos realtime

Nenhum canal ActionCable específico. Usa polling de 5 s na lista e polling no modal de preparação [NÃO VERIFICADO se o backend emite eventos em `FlowsChannel` ou `AccountNotificationsChannel` ao concluir].

## 8. Permissões

Rota `/mass-dispatches` exige `contacts.view` (pretty.js:40915). A criação parte da seleção de contatos. Não foi identificada permissão específica de criar/cancelar [INFERIDO: `contacts.view`/`contacts.edit`]. Endpoints admin são restritos ao painel interno.

## 9. Integrações externas

Indireta: os envios saem pelas conexões WhatsApp (UAZAPI ou Meta Cloud API [REQUER WABA]) por meio do motor de fluxos. Para a Meta, valem a janela de 24 h e o template [REQUER WABA].

## 10. Lacunas

- [NÃO VERIFICADO] Algoritmo de distribuição entre alvos (round-robin? proporcional?) e divisão A/B (50/50?).
- [NÃO VERIFICADO] Comportamento quando uma conexão do alvo desconecta durante `running` (falha? pausa? realoca?).
- [NÃO VERIFICADO] Não há relatório por destinatário na UI (só contagens agregadas por alvo). A existência de endpoint de destinatários não foi encontrada.
- [NÃO VERIFICADO] Fuso horário usado na janela (provável fuso da conta).
- [INFERIDO] O campo `flow_b_id` (A/B) está disponível apenas via API ou versão anterior da UI.
- [NÃO VERIFICADO] Reset da cota na virada do ciclo e regra de cálculo de `billable_slots`.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Template inicial no fluxo para alvos API Oficial | [REQUER WABA] | Primeira mensagem livre do fluxo (texto/mídia) |
| Confirmação (b): regra template + janela de 24 h para `meta_cloud` | [REQUER WABA] | Remover o aviso; manter só o aviso (a) |
| Envio via Meta Cloud API | [REQUER WABA] | Só conexões Baileys; reforçar intervalo aleatório e limite diário (risco de banimento) |

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- Título "Disparos em massa", subtítulo (envia um fluxo para muitos contatos, com cota por ciclo da assinatura) e o botão "Novo disparo em massa".
- Cards: RESTANTES (ex. 1000), USADOS NO CICLO ("0 / 1000"), EM ANDAMENTO, CONCLUÍDOS. Vazio: "Nenhum disparo em massa ainda". Cota observada: 1000 por ciclo.
