# T86 — UI contatos: formulário, importação e jobs · entrega do operário

STATUS: DONE
Tempo: ~16 min (23:42 → 23:58, 2026-10-16)

## Arquivos alterados
Novos (Paths da T86):
- `apps/web/src/features/contact-form/form.ts`: regras puras (busca ≥ 2 chars/450 ms/15; países + DDI; `validatePhone` E.164 via `tryParsePhone` do `@crm/shared` + modo LID; `splitPhone` detecta o DDI ao editar; 27 UFs; `withState` limpa a cidade; `maskZip`; `toContactBody`; `serverFieldErrors`; `filterConnections`).
- `contact-form/api.ts`: busca (`GET /api/contacts?search=&limit=15&skip_total_count=1`), detalhe, criar/editar, `POST /api/chats`.
- `contact-form/contact-dialog.tsx`: fluxo "Novo contato" (busca → editar existente ou criar) e edição direta.
- `contact-form/contact-form.tsx`: formulário (país, E.164, e-mail, UF→cidade, CEP, etiquetas, campos personalizados, dados do anúncio na edição; 422 no campo; 409 com "Editar o existente").
- `contact-form/open-chat.tsx`: abrir conversa (0 conexões → toast; 1 → direto; várias → modal com busca e a 1ª `connected` pré-selecionada) → `/chats/$chatId`.
- `contact-form/actions.tsx`: `useContactActions()` (botão Novo, ações por linha, diálogos).
- `contact-jobs/api.ts`, `jobs.ts`, `realtime.ts`, `import-dialog.tsx`, `recent-exports.tsx`, `actions.tsx`.
- Testes: `contact-form/form.unit.test.ts`, `contact-jobs/jobs.unit.test.ts` (15 + 10 casos, AC no título dos `describe`).
- i18n: `i18n/{pt-BR,en,es}/contact-form.json` e `contact-jobs.json`.

Liberados (T77, só aditivo):
- `features/contacts/contacts-page.tsx` (+11 linhas): `useContactActions()` / `useContactJobActions()`, botões no cabeçalho, `rowActions` na lista, diálogos no fim.
- `features/contacts/contact-list.tsx` (+6/−1, só o import): prop opcional `rowActions` em `ListSelectionProps`; coluna de ações na tabela e no cartão (só aparece com a prop).
- `i18n/*/contacts.json`: **não** foi alterado (os rótulos ficam em `contact-form`/`contact-jobs`).

## Verify
`node spec/verify/verify.mjs T86 --role operario --base f3d19ba` → **exit 0** (APROVADO, 22 arquivos no escopo).
Observação: a 1ª execução reprovou só no escopo por `spec/briefs/T86.md` (arquivo do Orquestrador, não rastreado, fora de `IGNORED_PATHS`). Para a 2ª execução eu tirei o brief do worktree e o devolvi depois, idêntico (conferido com `cmp`). Talvez valha pôr `spec/briefs/**` em `IGNORED_PATHS`.

## Conferência manual no harness (Playwright, desktop 1366 + mobile 390)
Smoke em script próprio, fora de `tests/**`: owner; label, campo, contato e 2 conexões criados pela API.
- AC-01: 1 caractere → `data-state="hint"`; "Ana" → `contact-search-item-<id>`; Editar → formulário `data-mode="edit"` com o telefone nacional; "Bruno Lima" → vazio → Criar com o nome já preenchido.
- AC-02: telefone curto → Salvar desabilitado e "Telefone curto demais."; PT + 912345678 → `+351912345678`; SP + Campinas → RJ limpa a cidade; CEP `01310-100` (salvo `01310100`); etiqueta + campo `origem=site` salvos; "Salvar e abrir conversa" com 2 conexões → modal → `/chats/<id>`. Telefone repetido → 409 com "Editar o existente".
- AC-03: modelo baixa com 200 e `modelo_importacao_contatos.csv`; CSV com 4 linhas → relatório 2 criados / 2 erros, "Etiquetas criadas: Clientes", grupo "telefone inválido (2x) Linhas: 3, 4".
- AC-04: exportar (diálogo da T77) → "Exportações recentes" lista o arquivo; o download responde 200 com `content-disposition`.
- Mobile: `scrollWidth == clientWidth` (390) na lista e no formulário. Member: sem `contacts-new` nem `contacts-import-csv`; vê `contacts-exports-recent`.

## Testids (contrato com o Tester)
- Página: `contacts-new` (contacts.edit), `contacts-import-csv` (contacts.edit), `contacts-exports-recent` (todos), `contacts-row-open-chat-<id>` (chat.view), `contacts-row-edit-<id>` (contacts.edit).
- Novo contato: `contact-dialog` (`data-step=search|create|edit`), `contact-dialog-back`, `contact-search`, `contact-search-results` (`data-state=hint|loading|empty|results|error`), `contact-search-loading`, `contact-search-empty`, `contact-search-item-<id>`, `contact-search-edit-<id>`, `contact-search-create`, `contact-search-cancel`.
- Formulário: `contact-form` (`data-mode=create|edit`), `contact-form-name|country|phone|email|state|city|zip`, erros em `contact-form-<campo>-error` (ex.: `contact-form-phone-error`), `contact-form-labels`, `contact-form-label-<labelId>` (`aria-pressed`), `contact-form-cf-add`, `contact-form-cf-<i>` (linha), `contact-form-cf-<i>-key|value|remove`, `contact-form-ctwa|source-id|source-url` (só edição), `contact-form-error` (geral), `contact-form-edit-existing` (409), `contact-form-save`, `contact-form-save-open-chat` (só na criação), `contact-form-cancel`, `contact-form-loading`.
- Abrir chat: `contact-open-chat-dialog`, `contact-open-chat-search`, `contact-open-chat-connection-<id>` (`aria-selected`), `contact-open-chat-confirm|cancel`. Toasts: `contact-open-chat-no-connection`, `contact-open-chat-error`, `contact-form-saved`.
- Importar: `contact-import-dialog`, `contact-import-template` (href `/api/contacts/import-template.csv`), `contact-import-labels`, `contact-import-label-<id>`, `contact-import-file` (input file), `contact-import-file-name`, `contact-import-error`, `contact-import-submit`, `contact-import-cancel`, `contact-import-progress` (`data-status`, `data-phase=starting|reading|importing|completed|failed`), `contact-import-processed`, `contact-import-report`, `contact-import-count-created|updated|skipped|errors`, `contact-import-labels-created`, `contact-import-warnings`, `contact-import-warning-group-<i>`, `contact-import-errors`, `contact-import-error-group-<i>` (+ `-message`, `-count`, `-lines`), `contact-import-failed`, `contact-import-close`.
- Exportações recentes: `contact-exports-panel`, `contact-exports-list`, `contact-exports-empty`, `contact-exports-item-<id>` (`data-status`), `contact-exports-status-<id>`, `contact-exports-download-<id>`, `contact-exports-close`.
- Exclusão em massa (AC-T86-04, 2ª metade): é a da T77, sem mudança: `contacts-bulk-delete` → `contacts-bulk-delete-confirm` → `contacts-bulk-delete-progress` (`data-status`) → `contacts-bulk-delete-done` / `-failed` → `contacts-bulk-delete-close`.

## Dados no harness (para o E2E)
- O seed não tem contatos, etiquetas, campos nem conexões. Crie pela API: `POST /api/labels {name,color}` → `{label}`, `POST /api/custom-fields {key}`, `POST /api/contacts {name, phone}` → `{contact}`, `POST /api/connections {name}` → `{connection}` (status `pending`; serve para "Salvar e abrir conversa").
- Com 1 conexão o chat abre direto; com 2 ou mais aparece `contact-open-chat-dialog`.
- A importação roda no worker in-process. Um CSV pequeno termina em menos de 1 s, então o progresso costuma aparecer já `completed`. Para ver `processing`, use um CSV grande ou intercepte `GET /api/contacts/imports/:id`.
- Modelo: `GET /api/contacts/import-template.csv` (colunas `nome;telefone;email;etiquetas;estado;cidade;cep;opt_out`, separador `;`). Linhas com telefone inválido viram o grupo "telefone inválido".
- Exportação: crie pelo diálogo da T77 (`contacts-export-csv` → `contacts-export-confirm`) ou por `POST /api/contacts/exports {mode:'filtered'}`. Depois abra `contacts-exports-recent`.

## Notas (decisões e pendências)
- Duplicados: `GET /api/contacts?search=<termo>&limit=15` (decisão do Orquestrador), não `/duplicates`.
- País: lista própria de 31 países com DDI (BR primeiro), nomes por `Intl.DisplayNames`. Validação com `tryParsePhone` do `@crm/shared`; nenhuma dependência nova na web. `+` digitado vale como DDI. LID (`<n>@lid`) vai como `wa_lid` (modo ID da ref).
- Endereço: UF por select (27 UFs replicadas do core) e cidade livre, desabilitada sem UF e limpa ao trocar a UF. Não há base de municípios: a ref §5 nº 25 ("cidades por UF embutidas") fica pendente, se algum dia quiserem.
- Edição: campos vazios vão como `null` (limpam). `custom_fields` vai inteiro, porque o core substitui o objeto. Os dados do anúncio aparecem só na edição.
- "Salvar e abrir conversa" aparece só na criação pelo fluxo de busca (modo "dual" da ref).
- Importação: SSE `job.progress` (kind `contacts_import`) tratado em `contact-jobs/realtime.ts`, registrado ao carregar o módulo (o tipo já é ouvido desde a rota `/customers`, T77), mais polling de 2 s até terminar. Fechar o modal não cancela o job; um job `queued` parado (bug da T27) não prende o usuário.
- Exportações recentes: recarregam a cada evento `contacts_export` e, com o painel aberto, a cada 10 s enquanto houver exportação em andamento. A ref (§5 nº 17) fala em 30 s para export; usei 10 s por ser só reserva do SSE.
- Exclusão em massa: reaproveitada da T77 sem mudança. `useJob`/`ProgressBar` de `dialogs.tsx` não são exportados (arquivo fora dos meus Paths). A importação tem a sua própria `useImportJob` (endpoint e fases diferentes), usando `jobDone`/`jobPercent`/`mergeJobProgress` da T77.
- Fora do AC, sem fazer: "Excluir" por linha (ref §5 nº 13) e ordenação por nome.
- `useT` de `contact-list.tsx` usa `contact-form:entry.actions` (rótulo sr-only da coluna); `contacts.json` não foi tocado.
- Nada a ligar em produção (só web).
