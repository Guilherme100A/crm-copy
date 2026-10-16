import { defineConfig } from 'drizzle-kit'

// Migrations do schema `crm` (SPEC T01). Gerar: pnpm --filter @crm/db db:generate:crm --name <txx>_<slug>
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/crm/index.ts',
  out: './drizzle/crm',
  schemaFilter: ['crm'],
  migrations: { schema: 'crm', table: '__drizzle_migrations' },
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://wsm:wsm@127.0.0.1:5432/crm' },
})
