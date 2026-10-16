# Jobs de exportação e importação (T27)

Infraestrutura genérica usada por contatos, vendas e kanban. Estado em `crm.background_jobs`, processamento no
worker (filas BullMQ `exports` e `imports`, prefixo `crm`, uma tentativa), arquivo no `ExportFileStore`.

## Registrar um tipo

```ts
import { registerExportKind, keysetPages } from '@crm/core'

registerExportKind('contacts_export', {
  permission: 'contacts.view', // quem não é o criador precisa dela para ver/baixar (e para criar)
  columns: [{ key: 'name', header: 'Nome' }, { key: 'phone', header: 'Telefone', format: (v) => v ?? '' }],
  count: (ctx) => contarContatos(ctx.db, ctx.companyId, ctx.filters), // opcional: progresso em %
  query: (ctx) => keysetPages((after, limit) => paginaDeContatos(ctx, after, limit), { pageSize: 1000 }),
  fileName: (id) => `customers_export_${id}.csv`,
})
```

`query` devolve um `AsyncIterable` consumido sob demanda: o CSV é escrito em streaming (backpressure), nunca em
memória. Imports usam `registerImportKind(kind, { permission, run(ctx) })`, com `ctx.progress({ processed, total,
phase, counters })`.

API e worker precisam importar o módulo que registra o tipo (o registro é por processo).

## API

| Método | Rota | Notas |
|---|---|---|
| POST | `/api/jobs` | `{ kind, filters?, delimiter?: ',' \| ';' }` → 201 `{ job }`; exige a permissão do kind |
| GET | `/api/jobs?kind=&limit=` | `{ items }`, mais recentes primeiro (limit padrão 3, máx. 50), só os visíveis |
| GET | `/api/jobs/:id` | `{ job }` |
| GET | `/api/jobs/:id/file` | CSV UTF-8 com BOM, `attachment`; 409 se o job não terminou com sucesso |

Acesso: criador ou permissão do kind (mesma empresa sem acesso → 403); outra empresa → 404. As rotas de export dos
módulos podem criar o job pelo mesmo serviço (`exportJobsFor(deps).create(...)`).

## Progresso

`job.progress` (SSE) vai só para o criador: ao iniciar, a cada 10% (sem `count`, a cada 1000 linhas) e no fim
(`completed` com `row_count` ou `failed` com `error`). O banco é atualizado nos mesmos marcos.

## Arquivos

`FsExportFileStore` (`STORAGE_DIR/exports`) escreve num temporário e publica com rename atômico no fim; em falha o
temporário é apagado, então nenhum arquivo parcial fica acessível. API e worker precisam apontar para o mesmo
diretório. Composição do worker: `configureExports({ db, redis | publisher, files? })`.
