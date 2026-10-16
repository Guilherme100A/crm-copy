// Tabelas `public.*` do WhatsApp copiadas 1:1 do ai-manager (`packages/db/src/schema/**`), com os mesmos nomes,
// colunas, enums e constraints, para que o CRM rode sobre o banco do ai-manager no modo extensão (SPEC T06).
// Lido pelo drizzle-kit (drizzle.wa.config.ts) e exposto com os nomes originais em `@crm/db/wa`.
export * from './enums.js'
export * from './tables.js'
export * from './limits.js'
export * from './suggestions.js'
export * from './ai-settings.js'
export * from './session-links.js'
export * from './proxy-settings.js'
