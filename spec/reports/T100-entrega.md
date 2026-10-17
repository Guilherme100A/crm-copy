# T100 — UI admin interno · entrega do operário

- **Base:** `5e34a73` (branch `task/T100`). **Tempo:** ~25 min de relógio (23:58 de 2026-10-16 → 00:23 de 2026-10-17), incluindo harness, conferência no navegador e verify.
- **Verify:** `node spec/verify/verify.mjs T100 --role operario --base 5e34a73` → **exit 0** (APROVADO; api/core/web typecheck+lint+test afetados, web i18n+build, regras FORBIDDEN, escopo 24 arquivos).

## Arquivos
**Web (Paths da tarefa)**
- `apps/web/src/routes/admin/index.tsx`: substitui o placeholder. `validateSearch: { tab: z.string().optional().catch(undefined) }`.
- `apps/web/src/features/admin/`:
  - `admin-page.tsx`: hub com os grupos e o replace;
  - `rules.ts`: regras puras;
  - `api.ts`: DTOs e queries;
  - `ui.tsx`: cabeçalho "atualizado às", confirmação, campo de imagem e selo;
  - `overview-tab.tsx`, `users-tab.tsx`, `accounts-tab.tsx`, `announcements-tab.tsx` (avisos e banners), `infra-tabs.tsx` (saúde e sessões), `ai-tab.tsx`;
  - `credits-dialog.tsx`, `announcement-popup.tsx`;
  - `admin.unit.test.ts` (17 testes).
- `apps/web/src/i18n/{pt-BR,en,es}/admin.json`.

**Liberados pelo Orquestrador (só acréscimos)**
- `apps/web/src/app/shell/app-shell.tsx`: 1 import estático e 1 elemento `<AnnouncementPopup session={session} />`, logo depois do `SupportApprovalModal`.
- `packages/core/src/admin-ops/admin-media.ts` (novo) e `admin-media.unit.test.ts` (novo); `packages/core/src/admin-ops/index.ts` ganhou 1 linha de export.
- `apps/api/src/routes/admin-ops/index.ts`: rotas `POST /api/admin/uploads` e `GET /api/public/admin-media/:id`, e 2 opções novas em `AdminOpsOptions`. Novo `admin-uploads.db.unit.test.ts`.
- `apps/api/src/middleware/public-routes.ts`: `{ method: 'GET', path: '/api/public/admin-media/*' }`.
- `routeTree.gen.ts` não mudou (a rota `/admin/` já existia).

## Decisões
- **Abas** (as dos ACs), na ordem `overview, users, accounts, announcements, banners | health, sessions | ai`, em 3 grupos (Plataforma / Infraestrutura / Produto).
  - Aba ausente, inválida ou escondida faz replace para `overview`.
  - A busca e a página ficam em estado local de cada aba. Trocar de aba desmonta a anterior (`key={active}`), então as duas zeram.
  - Debounce de 450 ms. A página volta a 1 quando a busca muda.
  - A aba da IA usa `ai` / "IA" (F-NO-BRAND).
- **Modo extensão:** a sonda `GET /api/admin/wa/sessions` é a mesma query da aba Sessões, com `retry: false`.
  - **404** esconde a aba, e `?tab=sessions` faz replace para `overview`.
  - Outro erro (502 sem gateway) mantém a aba, que mostra o erro.
  - Enquanto a sonda não responde, a aba fica visível.
- **"Atualizado às HH:MM"** (hora local):
  - Saúde usa o `checked_at` do servidor.
  - Sessões usa o `dataUpdatedAt` da query.
  - IA usa o maior `dataUpdatedAt` entre uso e carteiras.
  - Atualizar faz `refetch`.
  - Saúde e Sessões mostram o prefixo "Só visualização · ". A IA, que tem escrita, não mostra.
- **Créditos:** podem ser lançados pela aba Empresas (botões Recarregar/Ajustar em cada linha, para qualquer empresa) e pela aba IA (carteiras existentes).
  - Créditos inteiros: recarga > 0, ajuste ≠ 0 (aceita negativo).
  - Nota obrigatória (1–500).
  - Confirmação com o texto "Recarregar N créditos para X?" antes do POST `/api/platform/companies/:id/ai/{topups|adjustments}`.
- **Usuário:**
  - E-mail validado pela regex do servidor; senha ≥ 6 e confirmação.
  - Na edição, o e-mail fica desabilitado e não é enviado, e senha vazia não muda a senha.
  - O perfil usa o `role` legado: `client|client_employee|admin|support`, com padrão `client_employee` (20 §3.1).
  - Não há exclusão de usuário (20 §5 item 2).
- **Empresas:** lista, ativar/desativar com confirmação e créditos de IA. A edição de limites, cotas e `inbox_limits` ficou fora (não está no AC).
- **Visão geral:** só métricas da T95 (novas empresas e usuários, totais, mensagens e mensagens por dia). Sem faturamento. Período padrão: o do servidor (7 dias), com botão "Últimos 7 dias".
- **Upload (backend):** `POST /api/admin/uploads` (platform_admin, multipart no campo `file`).
  - Aceita só PNG, JPEG, GIF ou WebP, **conferidos pelos bytes** (SVG é recusado), com até 2 MB. Fora disso responde **422** em `details.fields[0].path = 'file'`.
  - Grava no BlobStore compartilhado (`deps.blobStore ?? FsBlobStore`) e responde 201 `{ url, id, mime, size }`.
  - A URL é `${API_PUBLIC_URL || origem da requisição}/api/public/admin-media/<sha256>.<hmac22>`.
  - O id é assinado (HMAC de uma chave derivada de `CREDENTIALS_KEY`, finalidade `crm:admin-media:v1`). Assim, blobs de chat e avatar no mesmo store **não** são servidos pela rota pública: id sem assinatura válida responde 404.
  - O GET público serve com `cache-control: public, max-age=31536000, immutable`, `nosniff` e `cross-origin-resource-policy: cross-origin`.
  - Grava auditoria global `admin.upload.create`.
- **Pop-up do cliente:**
  - Montado no shell. Lê `GET /api/announcements` (`staleTime` de 5 min) quando há empresa ativa e a sessão não é de suporte. Não aparece em `/admin*`.
  - Mostra o primeiro aviso não fechado, já na ordem de prioridade do servidor.
  - "Fechar" grava o id em `localStorage['dismissedAnnouncements:<userId>']` (JSON, até 200 ids, com try/catch), sem chamar a API, e o próximo aviso aparece em seguida.

## Testids (contrato com o Tester)
- **Hub:**
  - `page-admin`;
  - abas desktop `admin-tab-<id>` (`aria-current="page"` na ativa);
  - mobile: select nativo `admin-tab-select` com opções `admin-tab-option-<id>`;
  - painéis `admin-panel-<id>`.
- **Listas (kit da T58):**
  - prefixos `admin-users`, `admin-accounts`, `admin-announcements`, `admin-banners`;
  - por lista: `-search`, `-table` (desktop) / `-cards` (mobile), `-item-<id>`, `-empty`, `-new`;
  - paginador: `-prev`, `-next`, `-page` (texto "Página X de Y"; só aparece quando há mais de 1 página);
  - editar/excluir: `-item-edit-<id>`, `-item-delete-<id>`; confirmação de exclusão: `-confirm`, `-confirm-ok`, `-confirm-cancel`.
- **Campos das linhas:**
  - `admin-users-item-{name,email,role,companies}-<id>`;
  - `admin-accounts-item-{name,status,credits,adjust,toggle}-<id>`;
  - `admin-announcements-item-{title,type,active}-<id>`;
  - `admin-banners-item-{image,title,active}-<id>`.
- **Modal de usuário:**
  - `admin-user-editor`, `admin-user-{name,email,whatsapp,role,password,password-confirmation}`;
  - erros `admin-user-{name,email,password,password-confirmation}-error`;
  - `admin-user-save`, `admin-user-cancel`, `admin-user-error` (erro geral do servidor, ex.: 409);
  - empresas do usuário: `admin-user-companies`, `admin-user-companies-item-<account_id>`, `admin-user-companies-empty`, `admin-user-companies-close`.
- **Aviso:**
  - `admin-announcement-editor`, `admin-announcement-{title,message,type,url,priority,expires-at,active}`, `admin-announcement-save`;
  - imagem: `admin-announcement-image-file` (input file oculto; use `setInputFiles`), `admin-announcement-image-upload` (botão), `admin-announcement-image-url`, `admin-announcement-image-preview` (`<img>`), `admin-announcement-image-remove`, `admin-announcement-image-error`;
  - erros `admin-announcement-{title,message,url,priority}-error`.
- **Banner:** o mesmo esquema com prefixo `admin-banner-` (sem message e type). `admin-banner-save` fica **desabilitado** sem imagem e durante o upload.
- **Saúde:**
  - `admin-health-updated-at` (texto "Só visualização · atualizado às HH:MM"), `admin-health-refresh`, `admin-health-overall`;
  - blocos `admin-health-{postgres,redis,wa-events}` com `…-status`;
  - tabela `admin-health-queues` com linhas `admin-health-queue-<nome>`.
- **Sessões:** `admin-sessions-updated-at`, `admin-sessions-refresh`, `admin-sessions-table`, `admin-sessions-item-<sessionId>`, `admin-sessions-item-state-<id>`, `admin-sessions-empty`, `admin-sessions-error`.
- **IA:**
  - `admin-ai-updated-at` ("atualizado às HH:MM"), `admin-ai-refresh`, `admin-ai-from`, `admin-ai-to`;
  - uso: `admin-ai-usage` (tabela), `admin-ai-usage-totals`, `admin-ai-usage-empty`;
  - carteiras: `admin-ai-wallets`, `admin-ai-wallets-empty`, `admin-ai-item-<companyId>`, `admin-ai-item-balance-<companyId>`, `admin-ai-item-topup-<companyId>`, `admin-ai-item-adjust-<companyId>`.
- **Créditos:**
  - `admin-credits-editor`, `admin-credits-amount`, `admin-credits-note`, `admin-credits-amount-error`, `admin-credits-note-error`, `admin-credits-save`, `admin-credits-error`;
  - confirmação: `admin-credits-confirm`, `admin-credits-confirm-ok`, `admin-credits-confirm-cancel`;
  - toast `admin-credits-saved`.
- **Empresa:** confirmação de ativar/desativar `admin-accounts-confirm`, `admin-accounts-confirm-ok`.
- **Visão geral:** `admin-overview-{new-companies,new-users,messages,connections,companies,users}`, `admin-overview-start`, `admin-overview-end`, `admin-overview-reset`, `admin-overview-chart`.
- **Pop-up do cliente:** `admin-announcement-popup` (com `data-announcement-id` e `data-type`), `admin-announcement-popup-{title,message,image,link,close}`.
- **Toasts** (`notify` type = testid): `admin-user-saved`, `admin-announcement-saved`, `admin-announcement-deleted`, `admin-banner-saved`, `admin-banner-deleted`, `admin-account-saved`, `admin-credits-saved`, `admin-error`.

## Dados no harness (para o E2E)
- Login: `platform@demo.test` (platform_admin), senha `Senha-e2e-123`. Cliente: `owner@demo.test`, que tem empresa ativa, então o pop-up aparece.
- O seed não tem avisos, banners nem carteiras de IA:
  - crie avisos e banners pela UI ou por `POST /api/admin/announcements|banners`;
  - a carteira aparece na aba IA depois da 1ª recarga (pela aba Empresas: `admin-accounts-item-credits-<id>`).
- O upload funciona no harness. A URL usa a origem da API (`http://127.0.0.1:<E2E_API_PORT>/api/public/admin-media/…`), porque o harness não define `API_PUBLIC_URL`. O `<img>` carrega cross-origin (conferido: `naturalWidth` correto na prévia e no pop-up).
- O FakeWaGateway do harness responde `/api/admin/wa/sessions` com 200, então a aba Sessões aparece. Para o modo extensão, use `page.route('**/api/admin/wa/sessions', r => r.fulfill({ status: 404, … }))` antes de abrir `/admin?tab=sessions`: a URL vai para `tab=overview` e `admin-tab-sessions` some.
- Fechar o pop-up não gera requisição não-GET. Depois de recarregar, o pop-up não volta para o mesmo usuário (outro usuário no mesmo navegador ainda o vê).

## Conferido no navegador (harness, Playwright de rascunho, desktop 1366 e mobile 390)
- aba inválida → overview;
- busca "owner" filtra a lista;
- erros de e-mail e senha no modal;
- criar usuário;
- busca zerada ao trocar de aba;
- aviso com upload e prévia (imagem pública carregada) e salvo;
- banner com salvar desabilitado sem imagem e habilitado após o upload;
- saúde, sessões e IA com "atualizado às HH:MM";
- nota obrigatória → confirmação → saldo 500 na aba IA;
- 404 da sonda esconde Sessões;
- mobile sem rolagem horizontal (usuários e saúde);
- pop-up no cliente com a imagem, "fechar" que persiste após recarregar e sem chamada de API.

## Pendências para outras tarefas
- **Ligar em produção:** nada novo no worker. A rota pública usa `API_PUBLIC_URL` (já no `.env.example`), que precisa ser a URL pública da API em produção.
- Trocar `CREDENTIALS_KEY` invalida as URLs de imagem já gravadas (o id é assinado por ela), como acontece com os ids de `/api/media`.
- Admin sem UI (fora do AC): edição de limites, `inbox_limits` e cota de disparos por empresa, configuração global de disparos, segredos de plataforma, auditoria e preços de IA. As rotas da T95/T96/T37 existem.
- Banners da home do cliente: a T96 entrega `GET /api/banners` e o bootstrap, mas nenhuma tela do cliente mostra os banners ainda (fica com o dashboard).
- Os blobs enviados e não usados não são limpos (não há GC no BlobStore).
