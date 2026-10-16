# 14 — Notificações, Anúncios e Banners

Fonte: bundle JS público (REA + strings). Somente leitura.

## Telas e rotas
- Não há rota própria. A central fica no sino do cabeçalho e as preferências num modal/aba de configurações.
- Admin interno: `/admin/announcements` e `/admin/banners` (fonte: REA; ver 20-admin-interno).

## Features
1. **Sino com badge** — mostra o número de não lidas; acima de 9 aparece "9+".
2. **Central de notificações** — lista as notificações recentes de novas mensagens.
3. **Abrir chat pela notificação** — clicar no item navega para `/chat` e dispara `selectChat`.
4. **Supressão do chat aberto** — mensagens do chat que está aberto não geram notificação.
5. **Expiração automática** — itens com mais de 1 h são removidos; limpeza a cada 10 min.
6. **Notificação do navegador** (Notification API) — fecha sozinha após 5 s; pede permissão ao usuário.
7. **Toast in-app** — dura 3 s.
8. **Som** — gerado por oscilador WebAudio (sem arquivo de áudio); mudo durante a gravação de áudio no chat.
9. **Volume** ajustável (0–100).
10. **Preferências** salvas em `localStorage["notification_settings"]`:

    | Campo | Tipo | Padrão |
    |---|---|---|
    | `enabled` | boolean | true |
    | `volume` | number 0–100 | 50 |
    | `browserNotifications` | boolean | true |
    | `toastNotifications` | boolean | true |
    | `sounds` | boolean | true |
11. **Restaurar padrão** das preferências.
12. **Anúncios** — vêm em `GET /dashboard/bootstrap` (`announcements`). Campos: `title`, `message`, `announcement_type` (`info` | `warning` | `error` | `success`), `url`, `image_url`, `priority`, `expires_at`, `active`.
13. **Ordenação/expiração de anúncios** — por `priority`; somem após `expires_at` ou com `active=false`.
14. **Fechar anúncio** — só oculta localmente (não chama API).
15. **Banners** — também em `/dashboard/bootstrap` (`banners`), exibidos no topo/dashboard.

## Realtime
- `NotificationChannel` (sem parâmetros), evento `new_message` → alimenta sino, toast, som e notificação do navegador.

## Permissões
- Qualquer usuário logado recebe notificações; o filtro é o mesmo escopo de chats (`chat_scope`) [INFERIDO].
- Gestão de anúncios/banners só para admin interno.

## Lacunas
- [NÃO VERIFICADO] Payload completo do `NotificationChannel`.
- [INFERIDO] Não há persistência no servidor das notificações lidas; tudo é local.
- [NÃO VERIFICADO] Campos completos de banner (provavelmente imagem, link e período).

## Observado no app (portal)

Passada somente leitura em 2026-10-15.

- O sino no rodapé da sidebar abre o popover "Notificações". Lista vazia: "Nenhuma notificação". Toggle "Receber no dispositivo" (notificação do navegador), controle de volume com valor padrão 50% (bate com o default `volume:50` do bundle) e link "Avançado".
- O dashboard mostra um banner promocional que pode ser fechado (vem do bootstrap).
