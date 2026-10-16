// Acesso do wa-engine às tabelas `public.*` (iguais às do ai-manager) com os nomes originais do `@wsm/db`,
// para que o código portado do ai-manager mude só o import (`@wsm/db` → `../db`).
export * from '@crm/db/wa'
export { createDb, runMigrations, type Database } from '@crm/db'
