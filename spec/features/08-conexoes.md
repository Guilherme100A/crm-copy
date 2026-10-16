# 08 — Conexões (instâncias WhatsApp) e Fluxos padrão por conexão

> Fonte: análise estática de `_bundle/pretty.js` mais a tabela do REA (`_rea/rea-endpoints.md`). **(fonte: REA)** = presente na tabela do REA. "grep" = template literal encontrado só no bundle. Exemplos fictícios.

## 1. Visão geral

Uma **conexão** é um número de WhatsApp ligado à conta. Ela consome um **slot** do plano (tiers Starter e Pro). Há três provedores (`api_provider`):

| Valor | Rótulo UI | Natureza |
|---|---|---|
| `uazapi` | "API Web (uazapi)" | WhatsApp não oficial. Pareamento por QR Code ou por código no telefone. Suporta proxy, configurações da instância, credenciais e rotação de servidor |
| `z_api` | (legado, sem opção de criação na UI) | Não oficial, via Z-API. Suporta importar etiquetas e reiniciar [INFERIDO: só instâncias legadas] |
| `meta_cloud` [REQUER WABA] | "API Oficial (Meta)" | WhatsApp Cloud API (WABA) via Embedded Signup do Facebook. Registro do número com PIN 2FA. Modo "Coexistência (Beta)" |

Não há Instagram/Messenger como tipo de conexão neste módulo. Meta Ads e perfis Facebook ficam em `/facebook/*`, e `/settings/meta` redireciona para `/facebook/profiles`.

O módulo também cobre **Fluxos padrões por conexão** (`connection_flow_configs`): boas-vindas, resposta padrão, conversa finalizada, atendimento finalizado e gatilhos por palavra-chave.

Contagem aproximada: **~45 features**.

## 2. Telas e rotas

| Rota | Descrição | Ref |
|---|---|---|
| `connections` (fonte: REA), montada como `/connections` | Lista de conexões com cards de slots (Starter/Pro), stats Conectadas/Desconectadas, busca por nome ou número, filtro de status, tabela (Conexão, Tipo, Status, Criada em, Desconectada em, Ações) e ordenação por conexão ou data | pretty.js:148299, i18n `connections.*` (pretty.js:16636) |
| Modal "Nova Conexão" / "Editar Conexão" | Nome e tipo. Na edição, abas Conexão, Perfil, Comercial e Privacidade | pretty.js:139639-140100 |
| Modal "Conectar WhatsApp" | Abas QR Code e Código via Telefone, mais proxy por localização | pretty.js:146843+ |
| Modais de ação | Proxy personalizado, Configurações da instância, Notificar desconexão (webhook), Credenciais, URL de recebimento (UAZAPI), Parar todos os fluxos, Migrar instância, Excluir, Ajustar downgrade, Registro Meta Cloud (PIN) [REQUER WABA] | pretty.js:135265-136400 |
| Modal "Instâncias desconectadas" (global) | Alerta das últimas 24 h com campanhas e conjuntos Meta pausados | `disconnectAlertModal.*` |
| `/connection_flow_configs` (fonte: REA) → redireciona para `/settings?tab=connection_flow_configs` | Fluxos padrões por conexão | pretty.js:249801, 102936 |
| `/settings/meta` (fonte: REA) → redireciona para `/facebook/profiles` | Perfis Meta (OAuth) | pretty.js:122318 |

## 3. Modelo de dados / campos

### 3.1 Connection

| Campo | Tipo | Obrig. | Validação / default | Ref |
|---|---|---|---|---|
| id | int | | | |
| name | string | sim | trim; 2 a 100 caracteres. "Nome é obrigatório" | pretty.js:139722-139734 |
| api_provider | enum | sim (criação) | `uazapi` (default) \| `meta_cloud` [REQUER WABA] (\| `z_api` legado). Imutável após criar | pretty.js:139666 |
| status | enum | | ver §4 | |
| phone_number | string | | preenchido após parear | |
| img_url | string | | foto do perfil | |
| instance_id | string | | id da instância no provedor não oficial | |
| created_at, disconnected_at | datetime | | | pretty.js:138689 |
| reconnect_attempts, last_reconnect_attempt_at | int / datetime | | tooltip "Tentativas de Reconexão" | pretty.js:147507 |
| proxy_enabled, proxy_url | bool / string | | URL `http\|https\|socks4\|socks5://...` obrigatória se habilitado | pretty.js:135276-135290 |
| webhook_url, webhook_timeout | string / int (ms) | | URL http/https opcional (vazio desabilita). timeout entre 1 e 3000, default 1000 | pretty.js:135851-135866 |
| ephemeral_enabled, ephemeral_duration | bool / enum | | `off`, `1d`, `7d`, `90d` (default `off`). Só uazapi | pretty.js:135487 |
| save_contacts_enabled | bool | | "Salvar novos contatos na agenda do WhatsApp". Só uazapi | |
| pause_meta_campaigns_on_disconnect | bool | | Beta. Pausa campanhas e conjuntos Meta cujo nome contém `[NNNN]` (4 últimos dígitos) quando a instância cai | |
| waba_id, phone_number_id, business_id [REQUER WABA] | string | | meta_cloud | pretty.js:138642 |
| whatsapp_cloud_registration_status [REQUER WABA] | enum | | `pending`, `otp_requested`, `otp_verified`, `registered`, `failed` | pretty.js:136360 |
| scheduled_for_deletion, scheduled_from_downgrade, deleted | bool | | badges "Excluída" e "Excluída · downgrade" | pretty.js:84911 |
| pending_downgrade (+ data agendada) | bool | | badge "Downgrade pendente". O ajuste roda às 02:00 | |

### 3.2 Perfil WhatsApp (edição, só `uazapi` e `meta_cloud` conectados)

- **Perfil**: foto (JPEG recomendado, 640x640 na API Web; enviada como data URL; pode remover) e nome do perfil (não editável na API Oficial).
- **Comercial**: about, descrição, endereço, e-mail, sites (até 2; edição de sites só na API Oficial [REQUER WABA]), categoria (vertical) e categorias. Na API Web, é preciso preencher ao menos um de descrição, endereço ou e-mail.
- **Privacidade** (só API Web): groupadd, last, status, profile, readreceipts, online e calladd, com valores `all`, `contacts`, `contact_blacklist`, `none`, `match_last_seen`, `known` (mais "Manter atual").
- Botão "Sincronizar" relê o perfil do WhatsApp.

### 3.3 ConnectionFlowConfig (pretty.js:101965-101978)

| Campo | Tipo | Default | Regra |
|---|---|---|---|
| connection_id | int | | 1 por conexão |
| welcome_flow_id | int\|null | null | "Boas-vindas": novo contato, primeira mensagem |
| default_response_flow_id | int\|null | null | "Resposta padrão": sem palavra-chave, após inatividade |
| default_response_delay_hours | int | 24 | 1 a 168 h |
| finished_conversation_flow_id | int\|null | null | Cliente reabre conversa já concluída |
| finished_attendance_flow_id | int\|null | null | No momento em que o atendimento é concluído |
| keyword_triggers[] | | [] | têm prioridade sobre os demais |
| ↳ flow_id | int | obrig. | |
| ↳ rule_type | enum | `any` | `any` (OU) \| `all` (E) |
| ↳ conditions[] {match_type, keyword} | | `contains` | match_type: `equals`, `contains`, `different`, `excludes`, `starts_with`, `ends_with`. keyword obrigatória |
| ↳ active, position, _destroy | | | nested attributes (`keyword_triggers_attributes`) |

Estado do card: `empty` (0 dos 4 fluxos), `incomplete` ou `complete`. Filtros: Todas, Incompletas, Vazias.

## 4. Estados e transições

**Connection.status**: `connected` (Conectada), `disconnected` (Desconectada), `restricted` (Restrita; Meta ou WhatsApp restringiu) [REQUER WABA] (o bundle descreve como "Official API"), `connecting` (Conectando), `pending` (Pendente), desconhecido. Fluxo típico na uazapi: criar → `disconnected`/`connecting` → QR ou código → `connected` → (queda) `disconnected` (dispara alerta e auto-pausa de fluxos) → reconectar.
**Exclusão**: `schedule_deletion` marca `scheduled_for_deletion` ("desassinatura"). A exclusão definitiva ocorre no fim do período de cobrança. Os tooltips mostram "será desconectada e deletada em N dias".
**Downgrade**: `pending_downgrade`. Às 02:00 as conexões sinalizadas são desconectadas e excluídas. O dono pode trocar a sinalização 1:1 por outra conexão do mesmo tipo (`/billing/swap_pending_downgrade_connection`). Não é possível só remover a sinalização.
**Registro Meta Cloud** [REQUER WABA]: `pending` → `otp_requested` → `otp_verified` → `registered` | `failed`.

Disponibilidade das ações por provedor e status (pretty.js:147748-147777):
- Desconectar: não oficial e `connected`; meta_cloud em `connected` ou `restricted`.
- Conectar/Reconectar (QR ou código): não oficial e `disconnected`/`connecting`.
- Reconectar API Oficial [REQUER WABA]: meta_cloud `disconnected`, não agendada para exclusão.
- Reiniciar e importar etiquetas: `connected` com instance_id (uazapi ou z_api).
- Proxy, rotacionar, credenciais, URL de recebimento: uazapi com instance_id (e flags de feature/admin) [INFERIDO].

## 5. Ações e regras de negócio

1. **Criar conexão**: exige slot disponível (`starter_slots_available`) ou conta Beta/Trial dentro do limite. Sem slot, oferece "Adicionar slots" (→ `/billing` com `buyMoreType`). A API Oficial [REQUER WABA] exige slot Starter ou uma API Oficial desconectada que possa ser reconectada com o mesmo número. Contas trial: um número já usado em teste gratuito é bloqueado (`connection_trial_blocked`).
2. **Embedded Signup (Meta)** [REQUER WABA] (inclui coexistência): exige HTTPS. Carrega o SDK do Facebook e chama `FB.login` com `config_id` (outro config quando é coexistência) e `extras.featureType="whatsapp_business_app_onboarding"` na coexistência. Recebe `code`, `waba_id`, `phone_number_id` e `business_id` por postMessage e faz `POST /whatsapp_embedded_signup/exchange_code {code, waba_id, phone_number_id, business_id, connection_name, is_coexistence}` → `{connection, job_id}` (pretty.js:134664-134760).
3. **Finalizar registro Meta Cloud** [REQUER WABA]: informar o PIN de verificação em duas etapas (6 dígitos) → `whatsapp_registration/register`.
4. **QR Code**: `GET qr_code` (com proxy por país/estado/cidade opcional). O QR expira a cada ~20 s ("Atualizar QR Code"). O modal consulta `GET /connections/:id` a cada 5 s até `connected` e também ouve `qr_code_updated` (pretty.js:146935).
5. **Código no telefone**: seletor de DDI mais número só com dígitos. Valida `^[1-9]\d{6,14}$` sobre DDI+número e chama `phone_code/:numero` → código e expiração.
6. **Proxy gerenciado por localização** (só uazapi): `proxy_managed_cities` com country, state e search, retornando países, estados e cidades. Aplicar gera um novo QR. **Proxy personalizado**: `configure_proxy {enable, proxy_url}` / `remove_proxy`.
7. **Notificar desconexão** (webhook de saída por conexão): `configure_webhook {webhook_url, webhook_timeout}`. Evento disponível: `disconnected`.
8. **URL de recebimento UAZAPI** (admin/suporte) [INFERIDO]: `configure_uazapi_receive_webhook {receive_webhook_url}` (http/https) e "Usar URL padrão do ambiente".
9. **Configurações da instância**: mensagens temporárias, salvar contatos e campanhas Meta, com opção `apply_to_all` para replicar em todas as instâncias da conta.
10. **Credenciais** (somente leitura): URL e token da instância (copiar).
11. **Reiniciar**, **Rotacionar instância** (migra para outro servidor UAZAPI e exige parear de novo; aviso forte), **Importar etiquetas** do WhatsApp (`/labels/import_from_uazapi` ou `/labels/import_from_z_api` com `connection_id`) (fonte: REA).
12. **Parar todos os fluxos ativos**: mostra a contagem (`active_flow_executions_summary`) e exige digitar o nome exato da instância (`confirmation_name`). Ação irreversível.
13. **Fluxos pausados na queda**: quando a conexão cai, o backend pausa os fluxos automaticamente (`flows_auto_paused`). Ao reconectar com fluxos pausados (`connection_reconnected_with_paused_flows`), mostra um modal com paused/waiting/failed/received counts e total_leads, e as opções **Retomar** (`resume_paused_flows`) ou **Cancelar** (`cancel_paused_flows`).
14. **Alerta de desconexão**: `GET disconnect_alert` → `{has_recent_disconnected, disconnected_connections[], paused_adsets[], paused_campaigns[]}`. Abre o modal global uma vez ("Entendi").
15. **Toggle "notificar enviadas por mim"** (`toggle_notify_sent_by_me`) [NÃO VERIFICADO na UI].
16. **Excluir**: modal com os efeitos (fluxos parados, slot liberado, instância apagada, irreversível) → `schedule_deletion`.
17. **Fluxos padrões**: edição por conexão (create se `id==0`, senão PATCH). Modo **Seleção em massa**: escolher várias conexões e aplicar campos ("Não alterar" mantém) via `bulk_update`. Palavras-chave continuam por conexão. Avisa quantas serão sobrescritas. Validação: todo gatilho precisa de fluxo e de todas as keywords preenchidas.

## 6. Endpoints da API (`FBe`, pretty.js:41740-42080)

| Método | Caminho | Payload | Fonte |
|---|---|---|---|
| GET | `/connections?page&limit&search&status` | → array ou `{connections, pagination, status_counts}` | grep |
| GET | `/connections/for_reports` | | REA |
| GET | `/connections/for_picker` | | REA |
| GET | `/connections/disconnect_alert` | | REA |
| GET | `/connections/:id` | | grep |
| POST | `/connections` | `{connection:{name, api_provider}}` | REA |
| PUT | `/connections/:id` | `{connection:{name}}` | grep |
| POST | `/connections/:id/schedule_deletion` | | grep |
| POST | `/connections/:id/connect` \| `/disconnect` \| `/restart` \| `/rotate_instance` | | grep |
| GET | `/connections/:id/qr_code?proxy_managed_country&proxy_managed_state&proxy_managed_city` | → `{qr_code}` | grep |
| GET | `/connections/:id/proxy_managed_cities?country&state&search` | → `{countries, country, state, states, cities[{value,label,state,state_label,raw_city}]}` | grep |
| GET | `/connections/:id/device_info` \| `/status` | | grep |
| GET | `/connections/:id/phone_code/:phone` | → `{phone_code}` | grep |
| POST | `/connections/:id/toggle_notify_sent_by_me` | | grep |
| POST | `/connections/:id/resume_paused_flows` \| `/cancel_paused_flows` | | grep |
| GET | `/connections/:id/active_flow_executions_summary` | | grep |
| POST | `/connections/:id/cancel_all_active_flow_executions` | `{confirmation_name}` | grep |
| POST | `/connections/:id/configure_proxy` | `{enable, proxy_url}` | grep |
| DELETE | `/connections/:id/remove_proxy` | | grep |
| POST | `/connections/:id/configure_webhook` | `{webhook_url, webhook_timeout}` | grep |
| POST | `/connections/:id/configure_uazapi_receive_webhook` | `{receive_webhook_url}` | grep |
| POST | `/connections/:id/configure_instance_settings` | `{ephemeral_enabled, ephemeral_duration, save_contacts_enabled}` | grep |
| POST | `/connections/:id/configure_meta_campaign_settings` | `{pause_meta_campaigns_on_disconnect, apply_to_all}` | grep |
| GET | `/connections/:id/credentials` | → `{credentials:{url, token}}` | grep |
| POST | `/connections/:id/whatsapp_registration/register` [REQUER WABA] | `{pin}` | grep |
| GET/PATCH | `/connections/:id/whatsapp_profile` | campos de perfil, comercial e privacidade | grep |
| POST | `/connections/:id/whatsapp_profile_image` | `{image: dataURL, remove}` | grep |
| POST | `/whatsapp_embedded_signup/exchange_code` [REQUER WABA] | ver §5.2 | REA |
| POST | `/labels/import_from_uazapi` \| `/labels/import_from_z_api` | `{connection_id}` | REA |
| POST | `/billing/swap_pending_downgrade_connection` | troca de sinalização [payload NÃO VERIFICADO] | grep |
| GET | `/connection_flow_configs` | | REA |
| GET | `/connection_flow_configs/:id` | | grep |
| POST | `/connection_flow_configs` | `{connection_flow_config:{connection_id, welcome_flow_id, default_response_flow_id, finished_conversation_flow_id, finished_attendance_flow_id, default_response_delay_hours, keyword_triggers_attributes}}` | REA |
| PATCH | `/connection_flow_configs/:id` | `{connection_flow_config}` | grep |
| POST | `/connection_flow_configs/bulk_update` | `{connection_ids[], connection_flow_config}` | REA |
| DELETE | `/connection_flow_configs/:id` | | grep |
| POST | `/meta_oauth/start` | `{profile_id?}` → `{oauth_url}` (perfis Meta, `/settings/meta`) | REA |
| GET/DELETE | `/meta_profiles`, `/meta_profiles/:id`; POST `/meta_profiles/:id/refresh_ad_accounts`; PUT `/meta_ad_accounts/:id {meta_ad_account:{included_in_dashboard}}` | | REA (lista) / grep |

## 7. Eventos realtime

Canal **`ConnectionsChannel`** (pretty.js:134385-134555, 45772-45820), com os eventos:
- `connection_created`, `connection_updated` → upsert na lista.
- `connection_deleted` → remove e mostra toast.
- `connection_status_changed` → atualiza o status. Se vier `qr_code`, dispara o evento DOM `qr_code_updated` `{connectionId, qrCode}`.
- `connection_connected` → toast de sucesso com nome e telefone.
- `connection_disconnected`, `connection_disconnected_alert` (toast warning com dedupe de 5 s).
- `connection_restricted_alert` [REQUER WABA] → status `restricted`.
- `connection_reconnected_with_paused_flows` → modal retomar/cancelar.
- `flows_auto_paused` → status `disconnected` e warning.
- `flows_resumed` → evento DOM.
- `connection_trial_blocked` → evento DOM `trial_blocked` e toast de erro.

O badge de alerta global reage a: disconnected, disconnected_alert, flows_auto_paused e trial_blocked.

## 8. Permissões

`connections.view` (rota), `connections.edit`, `connections.delete` (pretty.js:36208-36213; owner/admin têm por padrão). Fluxos padrões: `settings.dispatch.view` (recurso `connection_flow_config`). Perfis Meta: `facebook.profiles`. Algumas ações (rotacionar, URL UAZAPI, credenciais) dependem de flags de papel interno [INFERIDO].

## 9. Integrações externas

UAZAPI (WhatsApp Web API), Z-API (legado), Meta WhatsApp Cloud API (Embedded Signup, Facebook JS SDK, Graph) [REQUER WABA], Meta Marketing API (pausa de campanhas e conjuntos na desconexão), provedor de proxy gerenciado por cidade.

## 10. Lacunas

- [NÃO VERIFICADO] Lista completa de estados internos de reconexão automática e política de backoff.
- [NÃO VERIFICADO] Diferença funcional entre os slots Starter e Pro (limites de mensagens?) e regra que define o tier da conexão.
- [INFERIDO] `z_api` como legado (não aparece como opção de criação).
- [NÃO VERIFICADO] Payload de `device_info` e de `status`.
- [NÃO VERIFICADO] UI do `toggle_notify_sent_by_me`.
- [NÃO VERIFICADO] Servidores UAZAPI (painel admin de "servers", com uazapi_total/official_total, fica fora deste módulo).

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| Provedor `meta_cloud` ("API Oficial (Meta)") | [REQUER WABA] | Só um provedor: sessão Baileys (pareamento por QR ou por código no telefone, como `uazapi`) |
| Embedded Signup do Facebook, incluindo coexistência, e `POST /whatsapp_embedded_signup/exchange_code` | [REQUER WABA] | Nenhum. A "coexistência" já é nativa: o Baileys entra como dispositivo vinculado e o app do celular continua funcionando |
| Registro do número com PIN 2FA (`whatsapp_registration/register`, `whatsapp_cloud_registration_status`) | [REQUER WABA] | Nenhum. O pareamento por QR ou código substitui o registro |
| Campos `waba_id`, `phone_number_id`, `business_id` | [REQUER WABA] | Guardar JID do número e as credenciais de autenticação da sessão Baileys |
| Ação "Reconectar API Oficial" e regra de slot da API Oficial | [REQUER WABA] | Reconectar por novo QR ou código |
| Status `restricted` e evento `connection_restricted_alert` | [REQUER WABA] | Detectar `loggedOut` ou ban no `connection.update` do Baileys e mapear para `disconnected` (ou um status "banido" próprio) |
| Edição de sites do perfil comercial | [REQUER WABA] | Só leitura dos sites; manter edição de about, descrição, endereço e e-mail se o Baileys suportar (`updateBussinesProfile` é limitado) |

Observação: `/settings/meta` e `/meta_oauth/start` servem a perfis Meta de anúncios (Marketing API), não ao WhatsApp. Por isso não foram marcados.

## Observado no app (portal)

Passada somente leitura em 2026-10-15. Nada foi salvo; modais abertos e fechados com Escape/Cancelar.

- **Cabeçalho:** "Conexões" e o botão "Criar nova conexão". Cards: Conectadas (N), Desconectadas (N), Slots Disponíveis ("usados / total", "N criadas").
- **Lista:** busca por nome ou número da instância, select de status ("Todos os status"), ordenação por conexão e por data de criação.
- **Tabela:** Conexão (avatar, nome, número), TIPO (ex. "STARTER"), selo "Proxy configurado", STATUS, Criada em, DESCONECTADA EM, AÇÕES.
- **Menu de ações da linha:** Desconectar, Reiniciar, Rotacionar instância, Importar Etiquetas, Parar todos os fluxos ativos, Proxy Personalizado, Notificar Desconexão, Ver credenciais, Editar, Excluir.
- **Modal "Configuração de Proxy":** switch "Habilitar proxy personalizado". Desabilitado, usa o proxy interno padrão. Botões Cancelar / Salvar.
- **Modal de criação:**
  - Campos: Nome da Conexão*, Tipo de Conexão*: "API Web (uazapi)" ou "API Oficial (Meta)" [REQUER WABA].
  - Sem slots: aviso "Você não tem slots disponíveis..." com o botão "Adicionar slots".
  - "Próximos passos": a conexão é criada como Desconectado, depois escanear o QR Code ou digitar o telefone.
  - Botões Cancelar / Criar Conexão.
