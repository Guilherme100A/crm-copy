// Schema `public.*` do WhatsApp, com os nomes/colunas do ai-manager (T06).
// Na raiz de `@crm/db` as tabelas ficam no objeto `wa` (ex.: `wa.sessions`), porque os nomes do ai-manager
// (`auditLogs`, `contacts`, `messages`…) colidem com os do schema `crm`. O wa-engine importa os nomes originais
// (tabelas, enums e tipos) de `@crm/db/wa`.
// Objeto comum, não `export * as`: o namespace de módulo tem protótipo null e quebra o `is()` do drizzle em createDb.
import * as tables from './tables/index.js'

export const wa = { ...tables }
