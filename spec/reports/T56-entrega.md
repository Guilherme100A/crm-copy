# T56 — entrega do operário (UI editores de nó: mensagem e interativos)

STATUS: DONE · branch `task/T56` (base 4e4f506, sem commit) · tempo: ~20 min (23:18 → 23:38, 2026-10-16)

## Arquivos alterados
- `apps/web/src/features/flow-editor/node-editors/registry.ts` (compartilhado, **só acréscimo**: `collectNodeEditors` + glob `./*/index.ts`)
- `apps/web/src/features/flow-editor/canvas/flow-editor.unit.test.ts` (ajuste mínimo: o teste do registro usa o tipo `x_test`, porque `message` agora vem registrado)
- `apps/web/src/features/flow-editor/node-editors/messaging/`: `index.ts`, `rules.ts`, `api.ts`, `kit.tsx`, `single.ts`, `message-editor.tsx`, `pix-editor.tsx`, `notification-editor.tsx`, `messaging.unit.test.ts`
- `apps/web/src/features/flow-editor/node-editors/interactive/`: `index.ts`, `rules.ts`, `save-field.tsx`, `menu-editor.tsx`, `carousel-editor.tsx`, `wait-response-editor.tsx`, `interactive.unit.test.ts`
- `apps/web/src/i18n/{pt-BR,en,es}/node-editors-messaging.json` (um JSON para os dois grupos)

## Verify
`0 (node spec/verify/verify.mjs T56 --role operario --base 4e4f506)` — typecheck, lint, test (42 testes da T56 + flow-editor), i18n:check, build, FORBIDDEN e escopo (21 arquivos) ok.
Além disso: harness E2E do worktree + Playwright (script descartável, fora de `tests/`), desktop 1440×900 e sheet mobile 390×844: todos os fluxos abaixo persistiram no `editor-bundle`, 0 erro de console, 0 px de overflow horizontal no mobile.

## Contrato

### Carga dos editores (decisão do Orquestrador)
Cada grupo cria `node-editors/<grupo>/index.ts` com
`export const nodeEditors: Record<string, NodeEditor> = { <tipo>: Editor }`.
O `registry.ts` descobre por `import.meta.glob('./*/index.ts', { eager: true })` e registra ao final do módulo.
**Atenção T57:** os módulos do glob rodam antes do corpo do registry (imports içados), então o grupo NÃO chama `registerNodeEditor` no topo nem importa valores do registry (só `import type`); senão dá TDZ no `editors`.

Tipos registrados pela T56: `message`, `pix`, `notification` (grupo messaging) e `interactive_menu`, `menu`, `carousel`, `wait_response` (grupo interactive).

### Bloqueio de salvar (AC-T56-02)
Rascunho local por editor (`useActionsDraft` em `messaging/kit.tsx`): toda mudança valida as configs com `getActionSchema(type).safeParse` (schema do T10). `onChange` (= autosave do canvas) **só é chamado com o rascunho sem erros**. Com erro: mensagem inline no campo (`ne-error-<caminho>`), `ne-status[data-state=blocked]` e o nó salvo fica no último estado válido. Ao corrigir, salva sozinho (`data-state=saved`). Nó novo (criado vazio pela paleta) ganha a ação principal padrão no rascunho; se o padrão já for válido (Aguardar resposta), grava na hora.

### Mídia
Upload por `POST /api/media` → config recebe `blob:<sha256>` (`media_url` / `file_url` / `sticker_url` / `image` do cartão / `imageButton` do menu) + `media_id` (extra, só para a prévia via `GET /api/media/:id`) + `file_label`/`filename` (nome exibido). Também aceita URL http(s) digitada (`media_source: url`).
Conferido no código: o nó envia via `ctx.wa.send` → fila do wa-engine → `apps/wa-worker/src/boot/start.ts` embrulha o deliver com `withBlobRefs`, que troca `{image|video|audio|document|sticker: {url: 'blob:…'}}` pelos bytes do BlobStore. Carrossel e imagem do menu passam por `send_multi_media` (imagem), então também resolvem. `s.render(url)` não altera `blob:` (sem chaves).
Figurinha da biblioteca: `GET /api/stickers` só traz `media_id` opaco, então o editor relê `/api/media/<id>` e reenvia ao `/api/media` (endereçado por conteúdo: mesmo sha256, sem duplicar).

### Prévias (AC-T56-04)
Réplicas puras (a web não importa `@crm/core`): `menuText` e o envio do carrossel (`interactive/rules.ts`), `pixMessage`/`pixEmv` com CRC16 (`messaging/rules.ts`). Teste de paridade com 4 saídas reais do `pix.ts` do core. Chave ou valor com variável → código mostrado como "(código gerado no envio)".

### Divisão com a T57
T56: `message`, `pix`, `notification`, `interactive_menu`, `menu`, `carousel`, `wait_response` (+ `save_user_data` dentro de menu/aguardar). Todo o resto é da T57. Não ofereço `pix_body`, `header_image_url`, nem o nó `template`.

## Como o Tester chega ao editor de cada nó
Padrão de `tests/acceptance/T45/editor.e2e.ts`: `POST /api/flows {name}` → `GET /api/flows/<id>/editor-bundle` (nó start) → `PUT /api/flows/<id>/definition` com os nós → `page.goto('/flows/<id>/edit')` → clicar `.react-flow__node[data-id="<nó>"]` → ler `getByTestId('flow-node-editor')` (no mobile use `.filter({ visible: true })`; há 2 painéis no DOM).
Os nós podem ir com `actions: []` (o editor cria a ação principal no rascunho). Exemplo usado na checagem: `message` com `send_message`, e `interactive_menu`, `carousel`, `pix`, `wait_response`, `notification` vazios. A persistência se confere relendo o `editor-bundle` depois de ~2,5 s (autosave).
Upload: `setInputFiles` em `ne-action-file-<i>` (PNG de 1 px funciona). Seed sem figurinhas: para a biblioteca, crie por `POST /api/stickers` (multipart `file`).

## Testids
Comuns:
- `ne-status` (`data-state` = `saved` | `blocked`)
- `ne-error-<caminho>`: caminho da config com `.` (ex.: `message_text`, `options.1.title`, `carousel.0.image`, `timeout_value`, `gatilho`). Ele fica dentro do contêiner da ação/opção/cartão, então busque escopado (ex.: `getByTestId('ne-action-1').getByTestId('ne-error-message_text')`).
- `ne-var-picker` (um por campo com variável; escope pelo contêiner) → lista `ne-var-list` → `ne-var-<nome>` (ex.: `ne-var-first_name`, globais `ne-var-g_x`, campos personalizados pela chave)
- `ne-preview` com `ne-preview-message-<i>` (`data-kind` = `text` | `image`), `ne-preview-text-<i>` e `ne-preview-code-<i>`
- `ne-timeout-value`, `ne-timeout-unit`
- `ne-save`, `ne-save-enabled`, `ne-save-field` (salvar a resposta: menu e aguardar)

Mensagem (`ne-message`):
- `ne-msg-add-<action_type>` (send_message, send_multi_media, send_file, send_sticker, send_contact, delay_between_messages)
- `ne-msg-actions`, `ne-msg-empty`
- `ne-action-<i>` (`data-type`, `data-action-id`, `data-invalid`)
- `ne-action-handle-<i>` (arrastar), `ne-action-up-<i>`, `ne-action-down-<i>`, `ne-action-remove-<i>`
- Campos por linha (`<i>` = posição):
  - texto: `ne-action-text-<i>`, `ne-action-typing-<i>`
  - mídia: `ne-action-media-type-<i>`, `ne-action-caption-<i>`, `ne-action-view-once-<i>`, `ne-action-ptt-<i>`
  - origem (mídia, arquivo, figurinha): `ne-action-source-file-<i>`, `ne-action-source-url-<i>`, `ne-action-file-<i>` (input file), `ne-action-url-<i>`, `ne-action-name-<i>` (nome do enviado), `ne-action-upload-error-<i>`
  - arquivo: `ne-action-file-name-<i>`
  - figurinha: `ne-action-sticker-name-<i>`, `ne-action-stickers-<i>`, `ne-action-sticker-<stickerId>-<i>`
  - contato: `ne-action-contact-name-<i>`, `ne-action-contact-phone-<i>`
  - atraso: `ne-action-delay-mode-<i>` (fixed|random), `ne-action-delay-<i>`, `ne-action-delay-min-<i>`, `ne-action-delay-max-<i>`

Menu (`ne-menu`; tipos `interactive_menu` e `menu`):
- `ne-menu-baileys-notice` (texto "Enviado como menu numerado em texto: …"), `ne-menu-legacy-notice` (só no `menu`)
- `ne-menu-type`, `ne-menu-message`, `ne-menu-button-label` (só em lista), `ne-menu-footer`
- `ne-menu-image-enabled` e `ne-menu-image-{source-file|source-url|file|url|name}` (só em botões)
- `ne-menu-options`; por opção `ne-menu-option-<id>` (`data-handle="option:<id>"`, `data-index`), `ne-menu-option-handle-<id>`, `-title-<id>`, `-description-<id>`, `-type-<id>` (só em botões), `-up-<id>`, `-down-<id>`, `-remove-<id>`
- `ne-menu-add-option`. Erro de lista vazia: `ne-error-options`.
- O id da opção é gerado no cliente (`option_<ts36><4>`) e não muda ao reordenar. O handle no canvas é `[data-handleid="option:<id>"]`.

Carrossel (`ne-carousel`):
- `ne-carousel-baileys-notice`, `ne-carousel-text`, `ne-carousel-cards`, `ne-carousel-add-card` (até 10)
- Cartão: `ne-carousel-card-<i>` (`data-card-id`), `ne-carousel-card-{up|down|remove}-<i>`, `ne-carousel-card-text-<i>`, `ne-carousel-card-{source-file|source-url|file|url|name}-<i>`
- `ne-carousel-add-button-<i>` (até 3)
- Botão: `ne-carousel-button-<id>` (`data-handle` só para REPLY), `-text-<id>`, `-type-<id>`, `-payload-<id>` (não-REPLY), `-handle-<id>`, `-remove-<id>`
- Prazo: `ne-timeout-*` (erro em `ne-error-gatilho`)

Pix (`ne-pix`): `ne-pix-notice`, `ne-pix-type`, `ne-pix-key`, `ne-pix-merchant`, `ne-pix-amount` e `ne-preview`.
Notificação (`ne-notification`): `ne-notification-name`, `-country`, `-phone`, `-message`.
Aguardar resposta (`ne-wait`): `ne-wait-message-enabled`, `ne-wait-message`, `ne-wait-indefinitely`, `ne-timeout-*` e `ne-save-*`.

## Notas / pendências para outras tarefas
- Não é botão Aplicar: o bloqueio é automático (`ne-status`). O brief sugeria `ne-apply`, que não existe.
- Fora do escopo do editor (não oferecidos):
  - `vary_text_with_ai` e `delete_on_label_*` do texto (dependem de integração de IA e etiquetas; candidatos à T57 ou a uma tarefa futura);
  - áudio por IA (`media_source: ai`), que o motor recusa no nó;
  - `uazapi_video_type`/`ptv` (pendência da T51 no wa-port);
  - buffer e reação ao lead do Aguardar resposta;
  - `readchat`/`readmessages` do carrossel.
- Menu legado: só o aviso. A ação "Copiar para bloco Menu" mexe no canvas (T45).
- Erros de ids duplicados no carrossel caem em `carousel.N.id`, pelo índice achatado do T10, e não aparecem num campo. Os ids são gerados no cliente, então isso não acontece pela UI.
- O texto do Pix na prévia replica o core. Se `pixMessage` mudar, o teste de paridade (`messaging.unit.test.ts`) precisa ser atualizado.

## O que faltou no brief
- Ao fazer o registro com glob dentro do próprio `registry.ts`, existe um ciclo de import: `registerNodeEditor` no topo de um grupo daria TDZ. O contrato declarativo (`nodeEditors`) evita isso. Vale avisar a T57.
- `/api/stickers` não devolve `sha256`, então a figurinha da biblioteca não vira `blob:` sem reenviar o arquivo.
- `/api/custom-fields` devolve também os campos do sistema (`first_name`…). O seletor deduplica.
