# 21 — Realtime e Plataforma (transversal)

Fonte: bundle JS público (REA + strings). Somente leitura.

## Realtime (ActionCable)
- Conexão: `wss://<api>/cable?token=<auth_token>`.
- Reconecta ao voltar online (`online`) e quando a aba volta a ficar visível (`visibilitychange`).

| Canal | Params | Eventos |
|---|---|---|
| `AccountNotificationsChannel` | `account_id` | `lead_counter_incremented`, `support_access_requested`, `support_access_granted`, `support_access_revoked`, `support_access_cancelled`, `sales_export`, `customers_export`, `customers_bulk_delete`, `customers_import`, `flow_translation`, `leona_billing_paid`, `mass_dispatch_prepare` |
| `ConnectionsChannel` | — | 13 eventos `connection_*` (status, QR, conectado, desconectado etc.), `flows_auto_paused`, `flows_resumed`, `trial_blocked` |
| `NotificationChannel` | — | `new_message` (ver 14) |
| `ChatsChannel` | `account_id` | ver 03-chats |
| `FlowsChannel` | `flow_id` | `distributor_updated` |
| `LeonaAISessionChannel` | `session_id` | 21 tipos, de `activity` até `done` (streaming do assistente de IA) |
| `SupportNotificationsChannel` | `user_id` | avisos de suporte |
| `MetaStructureBundleChannel` | — | progresso da estrutura Meta [NÃO VERIFICADO detalhes] |
| `InboundWebhookSamplesChannel` | `webhook_id` | `sample_received` |

## Cliente HTTP
1. **Autenticação** — header `Authorization: Bearer <token>`, token em `localStorage["auth_token"]`.
2. **Sem header de conta** — a conta ativa muda via `POST /accounts/:id/switch`.
3. **Deduplicação** de GETs idênticos em voo.
4. **401** com "Token inválido ou expirado" → checa `GET /auth/profile`; se falhar, vai para `/login`.
5. **403, 422 e 408/502/503/504** têm mensagens de erro próprias.
6. **Paginação padrão**: `{current_page, limit, total_count, total_pages, has_more}`.
7. **Bundle do editor de fluxos** — `/flows/:id/editor_bundle` vem ofuscado (codec v3).

## Plataforma
8. **i18n** — pt-BR (padrão e fallback), en, es; 11 namespaces.
9. **Tema** claro/escuro em `localStorage["theme"]`; segue o sistema; atalho Ctrl/Cmd+M alterna.
10. **Telemetria de debug** — `POST /client_debug_events`; buffer de 100, flush a cada 5 s ou 20 eventos, `keepalive` no `pagehide`; escopo `flow_builder`.
11. **Widget de suporte** de terceiros via script externo (`window.LeonaChat`).
12. **SDK do Facebook** (Embedded Signup da Meta). [REQUER WABA]
13. **Serviços externos** — Google Fonts, ViaCEP (endereço por CEP), flagcdn (bandeiras de DDI).
14. **Feature flags de build** — coexistência com WhatsApp Business: ligada [REQUER WABA]; template só para admin: desligada (restringe a aba `whatsapp_templates` a admin) [REQUER WABA].

## Lacunas
- [NÃO VERIFICADO] Nomes exatos dos 13 eventos `connection_*` estão em 08-conexoes.
- [NÃO VERIFICADO] Payloads dos eventos de `LeonaAISessionChannel` (ver 07-agentes-ia).
- [INFERIDO] Não há refresh token; a sessão expira e exige novo login.

## Compatibilidade Baileys (clone)

> O clone usa só Baileys (sem WABA/Cloud API). Itens marcados neste arquivo:

| Item | Marca | Equivalente no Baileys |
|---|---|---|
| SDK do Facebook para Embedded Signup | [REQUER WABA] | Não carregar o SDK para WhatsApp; pareamento por QR/código |
| Flag de coexistência com WhatsApp Business | [REQUER WABA] | Não se aplica (Baileys já roda como dispositivo vinculado ao app do celular) |
| Flag "template só para admin" (aba `whatsapp_templates`) | [REQUER WABA] | Não se aplica; usar mensagens rápidas/modelos de texto livre |
