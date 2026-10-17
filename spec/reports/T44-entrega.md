# T44 — entrega do Operário

```text
DONE T44 operario
STATUS: DONE
Verify: 0 (node spec/verify/verify.mjs T44 --role operario --base 5789462) — APROVADO, escopo 18 arquivos
```

Tempo: ~21 min (22:51–23:12 de 2026-10-16).

## Arquivos alterados
- Web (novos): `apps/web/src/features/flows/{api.ts,model.ts,view.tsx,dnd.tsx,tree.tsx,dialogs.tsx,flows-page.tsx,flows.unit.test.ts}`, `apps/web/src/i18n/{pt-BR,en,es}/flows.json`.
- Web (alterado): `apps/web/src/routes/flows/index.tsx` (placeholder substituído; `page-flows` mantido).
- API: `apps/api/src/routes/flows/index.ts` (+ `flows.db.unit.test.ts`), `apps/api/src/routes/flow-share/index.ts` (+ `flow-share.db.unit.test.ts`: teste novo, aditivo).
- Core: `packages/core/src/flows/store/store.ts` (+ `store.db.unit.test.ts`).
- Não toquei em `routes/flows/$flowId/**` (T45), `tests/**` nem `routeTree.gen.ts` (a rota já existia).

## Contrato de search params de `/flows`
- `?folder=<uuid>|root`: ausente = raiz ("Sem pasta"). Trocar de pasta faz **push** no histórico; busca, filtro e visão fazem **replace**.
- `?flow_status=all|active|paused|draft|archived|folders`: ausente = `all`. `folders` mostra só as pastas e esconde os fluxos.
  - **Não é `?status=`.** O TanStack Router une o tipo dos search params de todas as rotas, e `/chats` já usa `status` (`waiting|attending|resolved`). Com `status`, o typecheck de `features/chat-list/chat-list-panel.tsx` quebra.
- `?q=`: a busca procura em **todas** as pastas, sem diferenciar acento nem maiúsculas.
  - Com `q` ou com status ≠ `all`, reordenar fica desabilitado. Mover para pasta continua funcionando.
  - Com busca, cada fluxo mostra o nome da pasta dele.
- `?view=cards|table`: ausente = `cards`. No mobile (< 1024 px) a lista é sempre de cartões e não há botões de visão.
- Valor inválido em qualquer param é ignorado (`.catch(undefined)`).

## Notas e decisões
- **Dados:** um único `GET /api/flows`, sem filtro. Árvore, contadores das pastas, filtros e paginação são calculados no cliente.
  - A paginação é só da tabela: 20 por página, com rótulo "de–até de total".
- **Novo fluxo / Criar primeiro fluxo:**
  - Faz `POST /api/flows { name, folder_id: pasta atual }` e navega para `/flows/<id>/edit`.
  - O nome é único na pasta: "Novo Fluxo", "Novo Fluxo 1"…
  - `LIMIT_REACHED` vira toast com a mensagem do servidor.
- **Reorder:**
  - Soltar um fluxo sobre outro coloca o arrastado **antes** do alvo.
  - A zona `flows-drop-end` (só aparece durante o arrasto de um fluxo) leva ao fim da lista.
  - O cliente renumera a pasta em 0..n-1 e envia `POST /api/flows/:id/reorder` só dos fluxos cuja posição mudou, em sequência.
- **Mover pasta:**
  - O bloqueio de pasta em si mesma ou numa descendente acontece no cliente: o alvo fica `data-over="blocked"` e ao soltar aparece o aviso `flows-dnd-blocked`. A API não é chamada.
  - Soltar a pasta nela mesma não faz nada.
- **Exclusão de fluxo (decisão do Orquestrador):**
  - `DELETE /api/flows/:id` **sem** force continua 409 `CONFLICT`, com `details.error_code = 'flow_referenced'` e `details.references`. Agora traz também `details.connection_flow_configs` e `details.business_hour_configs` (`{ kind, id, name }`).
  - **Com `?force=1`** (aceita também `true`), `FlowStore.deleteFlowDetaching` faz numa transação:
    - anula `welcome_flow_id`, `default_response_flow_id`, `finished_conversation_flow_id` e `finished_attendance_flow_id` das configs de conexão que apontam para o fluxo;
    - apaga os `keyword_triggers` do fluxo;
    - em `business_hour_configs`, grava `flow_id = null` e `active = false`;
    - exclui o fluxo.
  - A resposta é `{ deleted: true, detached: { connection_flow_configs: [ids], business_hour_configs: [ids] } }`.
  - A auditoria registra `flow.delete` com `detail.force` e `detail.detached`.
  - Sem referências, `?force=1` exclui normalmente.
  - A UI sempre busca o `deletion-impact` antes de excluir.
    - Se houver configs, ela lista as configs e confirma com force (botão "Desvincular e excluir", `data-force="true"`).
    - Se aparecer um 409 tardio, ela mostra a lista recebida e o próximo confirmar vai com force.
- **Import com limite:** `POST /api/flows/import` e `POST /api/flows/import-json` passam `createFlow` por `store404`. Com o limite atingido, a resposta é 409 `LIMIT_REACHED`, não 500.
- **`support` sem empresa ativa:** fora desta tarefa (pendência da T54). Um erro no GET vira a caixa `flows-error` com "Tentar novamente", sem quebrar a tela.
- **Correção encontrada na fumaça:**
  - O problema: o dnd-kit marca o elemento arrastável desabilitado com `aria-disabled="true"` (e `role="button"`). O Playwright passava a considerar desabilitado o menu dentro do item, para o member.
  - A correção: sem `flows.edit`, o item nem é registrado no dnd.
- **Menu do fluxo:** Editar, Editar nome, Duplicar, Compartilhar, Ativar/Pausar/Desarquivar, Arquivar, Mover para…, Remover da pasta e Excluir.
  - Sem `flows.edit`, o menu fica só com Abrir e Compartilhar.
  - Excluir exige `flows.delete`.
  - "Traduzir" ficou fora: não há API.
- **Fumaça manual no harness** (Playwright, desktop 1366 px e mobile 390 px), tudo OK:
  - estado vazio, cartões e tabela, filtro, busca;
  - pasta na URL com reload, breadcrumb e Voltar;
  - arrastar fluxo para pasta na árvore;
  - reordenar, que persistiu após reload;
  - pasta A arrastada para C (descendente): bloqueada e com o parent intacto;
  - compartilhar e copiar;
  - importar 1 código válido e 1 inválido;
  - excluir com config de conexão via force;
  - member sem ações de edição;
  - mobile sem rolagem horizontal (`scrollWidth = clientWidth = 390`), com o sheet de pastas fechando ao escolher uma.

## Testids para o Tester
### Página e cabeçalho
- `page-flows` (raiz).
- Cabeçalho, só com `flows.edit`:
  - `flows-import`;
  - `flows-new-folder`;
  - `flows-new`, que cria o fluxo e navega para `/flows/<id>/edit`.
- Filtros e visão:
  - `flows-search`;
  - `flows-status-filter`: `<select>` nativo com os values `all|active|paused|draft|archived|folders`;
  - `flows-filters-clear`, que só aparece com filtro ativo;
  - `flows-view-cards` e `flows-view-table` (`aria-pressed`), só no desktop.

### Lista de fluxos
- Contêiner: `flows-cards` (`<ul>`) ou `flows-table` (`<table>`).
- Item `flows-item-<id>`, com os atributos `data-folder-id="<uuid|root>"`, `data-position` e `data-over="true"` (quando está sob um reorder).
  - `flows-item-name-<id>`: link para `/flows/<id>/edit`; sem `flows.edit`, leva a `/flows/<id>`.
  - `flows-item-status-<id>` (`data-status`) e `flows-item-blocks-<id>` (`data-count`).
  - `flows-item-updated-<id>`: "Hoje, HH:mm", "Ontem, HH:mm" ou a data.
  - `flows-item-handle-<id>`: alça de arrasto, só com `flows.edit`.
  - `flows-item-menu-<id>` abre o menu (`role="menuitem"`), com estes itens:
    - `flows-item-edit-<id>`, `flows-item-rename-<id>`, `flows-item-duplicate-<id>`, `flows-item-share-<id>`;
    - `flows-item-activate-<id>` | `flows-item-pause-<id>` | `flows-item-unarchive-<id>`, conforme o status;
    - `flows-item-archive-<id>`, `flows-item-move-<id>`;
    - `flows-item-remove-folder-<id>`, só se o fluxo está numa pasta;
    - `flows-item-delete-<id>`, só com `flows.delete`.
    - Sem `flows.edit`, o menu tem só `flows-item-open-<id>` e `flows-item-share-<id>`.
- Paginação (tabela): `flows-pager`, `flows-page-range` ("1–20 de 45"), `flows-page-prev`, `flows-page-next`.

### Pastas (cards das subpastas da pasta atual)
- Card e conteúdo:
  - `flows-folders` (`<ul>`);
  - `flows-folder-card-<id>`, com `data-drop-target="folder"` e `data-over="true|blocked"`;
  - `flows-folder-open-<id>`, `flows-folder-name-<id>`;
  - `flows-folder-count-<id>`, com `data-flows` e `data-folders`.
- Ações:
  - `flows-folder-handle-<id>`, só com `flows.edit`;
  - `flows-folder-menu-<id>`, que abre `flows-folder-edit-<id>` (edit) e `flows-folder-delete-<id>` (delete).
- Modal de pasta: `flows-folder-editor`, `flows-folder-name`, `flows-folder-color-<blue|green|purple|orange|red|yellow|gray>` (`role="radio"`, `aria-checked`), `flows-folder-save`, `flows-folder-cancel`, `flows-folder-error`.
- Excluir pasta: `flows-folder-delete` (modal), `flows-folder-delete-confirm`, `flows-folder-delete-cancel`.

### Árvore e breadcrumb
- Árvore:
  - `flows-tree`;
  - nós `flows-folder-root` e `flows-folder-<id>`, com `aria-current="page"` na pasta atual, `data-drop-target="folder"` e `data-over="true|blocked"`.
- Breadcrumb: `flows-breadcrumb`, `flows-breadcrumb-root`, `flows-breadcrumb-<id>` e `flows-back` (Voltar à pasta anterior).
- Mobile: `flows-tree-open` abre `flows-tree-sheet`, que tem `flows-tree-close`. Clicar num nó navega e fecha o sheet. No mobile, `flows-tree` só existe dentro do sheet.
- Pasta da URL que não existe: `flows-folder-missing`.

### Arrastar
- Gesto com o ponteiro, sempre pela **alça**: `mouse.down`, mover ≥ 10 px, mover até o alvo com `steps`, `mouse.up`.
- Alvos:
  - nó da árvore ou card de pasta: move o fluxo ou a pasta;
  - outro `flows-item-<id>`: reordena (fica antes do alvo) e mostra `flows-drop-hint` ("Solte aqui para reordenar");
  - `flows-drop-end`: leva ao fim da lista.
- Bloqueio: `flows-dnd-blocked` (`role="alert"`), com o alvo em `data-over="blocked"`.
- Alternativa sem arrastar: menu → `flows-item-move-<id>`, que abre `flows-move-editor` com `flows-move-select` (value = uuid, ou `""` para a raiz) e `flows-move-save`.

### Excluir fluxo
- Modal `flows-delete`.
- Impacto `flows-delete-impact`:
  - `flows-delete-impact-active-runs`, `flows-delete-impact-total-runs`, `flows-delete-impact-configs` e `flows-delete-impact-refs`, todos com `data-count`;
  - `flows-delete-impact-config-<configId>` (`data-kind="connection_flow_config|business_hour_config"`) e `flows-delete-impact-ref-<flowId>`;
  - `flows-delete-force-warning`, quando há configs.
- Botões: `flows-delete-confirm` (`data-force="true|false"`) e `flows-delete-cancel`.

### Compartilhar, importar e renomear
- Compartilhar: `flows-share` (modal), `flows-share-code` (10 caracteres de `A-HJ-NP-Z2-9`), `flows-share-copy`, `flows-share-close`.
- Importar:
  - modal `flows-import-dialog`;
  - `flows-import-codes`: textarea que aceita vírgula, ponto e vírgula, espaço ou quebra de linha, e deduplica sem diferenciar maiúsculas;
  - `flows-import-count`, `flows-import-submit`, `flows-import-error`;
  - resultado em `flows-import-result`, com `flows-import-ok-<CÓDIGO>` e `flows-import-fail-<CÓDIGO>` (código em maiúsculas);
  - `flows-import-cancel` (vira "Fechar" depois do resultado).
- Renomear: `flows-rename-editor`, `flows-rename-input`, `flows-rename-save`.

### Vazio e erro
- `flows-empty` ("Nenhum fluxo encontrado").
  - `flows-empty-create` ("Criar primeiro fluxo") só aparece com `flows.edit` e sem filtro.
  - Com filtro, o texto muda para "Nenhum fluxo corresponde aos filtros".
- Erro: `flows-error`.

## Como criar dados no harness
1. Suba o harness com `E2E_IGNORE_STDIN=1 node scripts/e2e/serve.mjs` e rode `resetSeed`.
2. Faça `loginAs(page, 'owner')`. Envie o header `x-requested-with: crm` nas mutações.
3. Crie os dados pela API:
   - pasta: `POST /api/flow-folders { name, color?, parent_id? }` → `{ folder }`;
   - fluxo: `POST /api/flows { name, folder_id? }` → `{ flow }` (status `draft`, 1 bloco);
   - código de compartilhamento: `GET /api/flows/<id>/share-code` → `{ code }`. O import aceita código da própria empresa;
   - config que referencia o fluxo, para testar o impacto e o force:
     - `POST /api/connections { name }` → `{ connection }`;
     - `PUT /api/connection-flow-configs/<connectionId> { welcome_flow_id: <flowId> }` → 200.
   - referência de outro fluxo: `POST /api/flows/<outro>/nodes` com um nó `connection_flow` e a ação `{ type: 'execute_flow', config: { target_flow_id } }`. O padrão está em `apps/api/src/routes/flows/flows.db.unit.test.ts`.
4. Usuários para os testes de permissão:
   - member (`member@demo.test`): só `flows.view` e `flows.run`, para o AC-T44-04 (sem ações de edição);
   - owner e admin: têm edit e delete.
5. Depois de mudar `?folder=` ou o filtro, espere `await expect(page).toHaveURL(...)` antes de recarregar (licoes, T53).
6. Para checar persistência, leia pela API: `GET /api/flows/<id>` (`folder_id`, `position`) e `GET /api/flow-folders` (`parent_id`).

## Pendências para outras tarefas
- **Import em lote sem transação:** se o limite estourar no meio de vários códigos, as cópias já criadas ficam (`flow-share/index.ts`).
- **Nome no impacto do horário comercial:** a fonte de referências de `business-hours` devolve `name = connectionId` (uuid), e não o nome da conexão. Está nos Paths de business-hours, fora da T44.
- **Suporte sem empresa ativa em `/flows`:** segue pendente na T54.
- **Runs no impacto:** o seed não tem como gerar runs. O AC pede só mostrar as contagens, que aparecem zeradas sem dados.
- **Brief:** faltou avisar da colisão de tipo de `?status=` com `/chats`. Sugiro registrar em `docs/licoes.md`: "search param com nome já usado por outra rota, com outros valores, quebra o typecheck do reducer de navigate".
