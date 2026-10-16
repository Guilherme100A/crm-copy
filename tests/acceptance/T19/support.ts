// Apoio da suíte T19 (não é arquivo de teste). Superfície pública (combinada com o Operário):
// '@crm/core': FlowStore(db), FlowStoreError (code 'CONFLICT' | 'NOT_FOUND' | 'VALIDATION_ERROR');
// métodos com ctx { companyId, userId? } como 1º argumento. FlowDefinition crm.flow/v1 de '@crm/shared/flows'.
// Banco: Postgres descartável com as migrations `crm` (SPEC 3.10).
import { randomBytes } from 'node:crypto'
import { createTempDb, dropTempDb, lit, sqlOk, type TempDb } from '../helpers/pg'

export const rand = (n = 4) => randomBytes(n).toString('hex')

export interface CrmDb {
  tmp: TempDb
  db: any
  close(): Promise<void>
}

export async function migratedCrmDb(): Promise<CrmDb> {
  const mod: any = await import('@crm/db')
  const tmp = createTempDb('crm_acc_t19')
  const db = mod.createDb(tmp.url)
  await mod.runMigrations(db, { set: 'crm' })
  return {
    tmp,
    db,
    close: async () => {
      const pool = db?.$client
      pool?.on?.('error', () => {})
      await pool?.end?.().catch(() => {})
      dropTempDb(tmp)
    },
  }
}

export async function flowStore(db: any): Promise<{ store: any; FlowStoreError: any }> {
  const core: any = await import('@crm/core')
  if (typeof core.FlowStore !== 'function') throw new Error('@crm/core não exporta FlowStore')
  return { store: new core.FlowStore(db), FlowStoreError: core.FlowStoreError }
}

export const flowsShared = (): Promise<any> => import('@crm/shared/flows')

/** Empresa em crm.companies; devolve o id. */
export function newCompany(url: string): string {
  const slug = `t19-${rand()}`
  return sqlOk(url, `INSERT INTO crm.companies (name, slug) VALUES (${lit(`Empresa ${slug}`)}, ${lit(slug)}) RETURNING id;`)[0]![0]!
}

export const ctxOf = (companyId: string) => ({ companyId })

/** Erro de uma promessa (ou undefined se resolveu). */
export async function caught(p: Promise<unknown>): Promise<any> {
  return p.then(
    () => undefined,
    (e: unknown) => e,
  )
}

/** FlowDefinition válida com start → mensagem (2 ações) → menu (opções) e volta, variáveis e refs. */
export async function sampleDefinition(text = 'Olá {first_name}!'): Promise<any> {
  const { ACTION_EXAMPLES, FLOW_SCHEMA_VERSION } = await flowsShared()
  return {
    schema: FLOW_SCHEMA_VERSION,
    entry: 'start',
    nodes: [
      { id: 'start', type: 'start', name: 'Início', position: { x: 0, y: 0 }, actions: [] },
      {
        id: 'msg1',
        type: 'message',
        name: 'Boas-vindas',
        description: 'primeira mensagem',
        position: { x: 250, y: 40 },
        actions: [
          { id: 'a-msg', type: 'send_message', order: 0, config: { ...ACTION_EXAMPLES.send_message, message_text: text } },
          { id: 'a-delay', type: 'delay_between_messages', order: 1, config: ACTION_EXAMPLES.delay_between_messages },
        ],
      },
      {
        id: 'menu1',
        type: 'interactive_menu',
        name: 'Menu',
        position: { x: 500, y: 80.5 },
        actions: [{ id: 'a-menu', type: 'send_interactive_menu', order: 0, config: ACTION_EXAMPLES.send_interactive_menu }],
      },
      {
        id: 'tags1',
        type: 'tags',
        name: 'Etiqueta',
        position: { x: 750, y: -20 },
        actions: [{ id: 'a-tags', type: 'add_tags', order: 0, config: ACTION_EXAMPLES.add_tags }],
      },
    ],
    edges: [
      { id: 'e1', from: 'start', handle: 'source', to: 'msg1' },
      { id: 'e2', from: 'msg1', handle: 'source', to: 'menu1' },
      { id: 'e3', from: 'menu1', handle: 'option:option_1', to: 'tags1' },
      { id: 'e4', from: 'menu1', handle: 'option:option_2', to: 'msg1' },
      { id: 'e5', from: 'menu1', handle: 'timeout', to: 'msg1' },
    ],
    variables: [{ name: 'interesse', description: 'o que o lead quer', default: 'nenhum' }],
    refs: { tags: [{ id: 'tag-lead', name: 'lead' }] },
  }
}

/** Normaliza para comparar sem depender da ordem de linhas do banco. */
export function canon(def: any): any {
  const byId = (a: any, b: any) => String(a.id).localeCompare(String(b.id))
  return {
    ...def,
    nodes: [...def.nodes].sort(byId).map((n: any) => ({ ...n, actions: [...n.actions].sort((a: any, b: any) => a.order - b.order) })),
    edges: [...def.edges].sort(byId),
    variables: [...def.variables].sort((a: any, b: any) => a.name.localeCompare(b.name)),
  }
}
