# Importação de contatos (T67)

| Método | Rota | Notas |
|---|---|---|
| POST | `/api/contacts/imports` | multipart: `file` (CSV, até 50 MB), `mode` (`upsert`), `create_missing_labels` (padrão `true`), `default_label_ids[]` ou `default_label_ids_json` → 201 `{ job }` |
| GET | `/api/contacts/imports/:id` | `{ import }` (job da T27; relatório em `counters`) |
| GET | `/api/contacts/import-template.csv` | modelo com BOM e `;` |
| POST | `/api/contacts/import-from-whatsapp` | `{ connection_id }` → `{ imported, updated, skipped, warnings }`; conexão fora de `CONNECTED_STATES` → 409 `SESSION_NOT_CONNECTED` |

O CSV vai para o `ExportFileStore` (T27) e é processado pelo job `contacts_import` na fila `imports`. A leitura é
em streaming (papaparse `NODE_STREAM_INPUT`): uma pré-leitura decide o encoding (UTF-8 válido, senão Windows-1252)
e conta as linhas para o progresso; o delimitador (`,` `;` TAB) é detectado pelo papaparse.

Colunas (cabeçalho sem diferença de maiúsculas/acentos): `nome`, `telefone` (obrigatória), `email`, `etiquetas`
(separadas por `|`, `,` ou `;`), `estado`, `cidade`, `cep`, `opt_out` (`sim/true/1/x`). Linha sem telefone válido
entra no relatório como `Linha N: telefone inválido` (cabeçalho = linha 1); erros iguais são agrupados
(`error_groups`, até 8) e avisos contados (`warnings_report`, `"{msg} ({n}x)"`).

Upsert por `phone_e164`/`wa_lid`: existente conta como `updated`, campos preenchidos substituem e etiquetas são
acrescentadas. Etiquetas da linha têm prioridade sobre as padrão; etiqueta inexistente só é criada com
`create_missing_labels`.

Consentimento (SPEC 1.4 nº 3): contato novo nasce com `consent = true`, `consent_source = 'import'`, repassado ao
`WaGateway.recordConsent`; `opt_out` verdadeiro importa com opt-out (`WaGateway.optOut`). A importação nunca
reverte um opt-out existente.

Worker: o kind é registrado no processo pelo `registry.ts`; as dependências vêm de
`configureContactsImport({ files, waGateway })` (mesmo diretório de arquivos da API).
