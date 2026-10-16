// Transferência de fluxos entre empresas (T43): ids novos, etiquetas recriadas por nome, mídias reemitidas para a
// empresa destino (o blob é endereçado por conteúdo; só o id assinado muda) e referências a outros fluxos.
import { and, eq, inArray, sql } from 'drizzle-orm'
import { flows, labels, type Database } from '@crm/db'
import type { MediaService } from '@crm/core'
import type { FlowDefinition } from '@crm/shared/flows'

export interface TransferWarning {
  code: 'flow_reference_missing' | 'media_unavailable'
  node_id: string
  action_id?: string
  /** `flow_reference_missing`: o fluxo alvo que não existe na empresa destino. */
  target_flow_id?: string
}

/** Cor das etiquetas criadas na importação (formato #RRGGBB exigido pela T26). */
export const IMPORTED_LABEL_COLOR = '#6B7280'

const TAG_ACTIONS = new Set(['add_tags', 'remove_tags'])
const MEDIA_PATH = /\/api\/media\/([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g

/** Nomes das etiquetas usadas nas ações de etiqueta. */
export function labelNamesOf(def: FlowDefinition): string[] {
  const names = new Map<string, string>()
  for (const n of def.nodes)
    for (const a of n.actions)
      if (TAG_ACTIONS.has(a.type) && Array.isArray(a.config.tags))
        for (const t of a.config.tags) if (typeof t === 'string' && t.trim()) names.set(t.trim().toLowerCase(), t.trim())
  return [...names.values()]
}

/** Garante na empresa as etiquetas pelo nome (sem diferenciar maiúsculas); devolve as criadas. */
export async function ensureLabels(db: Database, companyId: string, names: string[]): Promise<string[]> {
  if (!names.length) return []
  const existing = await db
    .select({ name: labels.name })
    .from(labels)
    .where(and(eq(labels.companyId, companyId), inArray(sql`lower(${labels.name})`, names.map((n) => n.toLowerCase()))))
  const have = new Set(existing.map((e) => e.name.toLowerCase()))
  const missing = names.filter((n) => !have.has(n.toLowerCase()))
  if (!missing.length) return []
  const created = await db
    .insert(labels)
    .values(missing.map((name) => ({ companyId, name, color: IMPORTED_LABEL_COLOR })))
    .onConflictDoNothing()
    .returning({ name: labels.name })
  return created.map((r) => r.name)
}

/**
 * Reemite para `toCompany` os ids de mídia da `fromCompany` encontrados nas configs (string inteira ou dentro de
 * `/api/media/<id>`). Mídia que não existe mais vira aviso. Mesma empresa → nada muda.
 */
export async function copyMedia(media: MediaService, def: FlowDefinition, fromCompany: string, toCompany: string, warnings: TransferWarning[]) {
  if (fromCompany === toCompany) return
  const cache = new Map<string, string | null>()
  const reissue = async (id: string): Promise<string | null> => {
    if (cache.has(id)) return cache.get(id)!
    const out = await media
      .get(fromCompany, id)
      .then((m) => media.store(toCompany, m.data, m.mime, m.file_name))
      .then((info) => info.id)
      .catch(() => null)
    cache.set(id, out)
    return out
  }
  const looksLikeMediaId = (s: string) => /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s) && s.length > 40
  const walk = async (value: unknown, onMissing: () => void): Promise<unknown> => {
    if (typeof value === 'string') {
      if (looksLikeMediaId(value)) {
        const id = await reissue(value)
        if (id) return id
        // Não é mídia da origem (ou sumiu): só avisa se parecia mesmo um id de mídia.
        onMissing()
        return value
      }
      let out = value
      for (const m of [...value.matchAll(MEDIA_PATH)]) {
        const id = await reissue(m[1]!)
        if (id) out = out.replace(m[1]!, id)
        else onMissing()
      }
      return out
    }
    if (Array.isArray(value)) return Promise.all(value.map((v) => walk(v, onMissing)))
    if (value && typeof value === 'object') {
      const o: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) o[k] = await walk(v, onMissing)
      return o
    }
    return value
  }
  for (const n of def.nodes)
    for (const a of n.actions) {
      let warned = false
      a.config = (await walk(a.config, () => {
        if (!warned) warnings.push({ code: 'media_unavailable', node_id: n.id, action_id: a.id })
        warned = true
      })) as Record<string, unknown>
    }
}

/**
 * `execute_flow.target_flow_id`: aponta para a cópia quando o alvo veio no mesmo pedido (`remap`); senão, se o
 * fluxo não existe na empresa destino, limpa o campo e avisa.
 */
export async function fixFlowReferences(db: Database, def: FlowDefinition, toCompany: string, remap: Map<string, string>, warnings: TransferWarning[]) {
  const targets: Array<{ node: string; action: string; config: Record<string, unknown>; id: string }> = []
  for (const n of def.nodes)
    for (const a of n.actions)
      if (a.type === 'execute_flow' && typeof a.config.target_flow_id === 'string' && a.config.target_flow_id)
        targets.push({ node: n.id, action: a.id, config: a.config, id: a.config.target_flow_id })
  if (!targets.length) return
  for (const t of targets) if (remap.has(t.id)) t.config.target_flow_id = remap.get(t.id)
  const rest = targets.filter((t) => !remap.has(t.id))
  const uuids = rest.map((t) => t.id).filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const found = uuids.length
    ? new Set((await db.select({ id: flows.id }).from(flows).where(and(eq(flows.companyId, toCompany), inArray(flows.id, uuids)))).map((r) => r.id))
    : new Set<string>()
  for (const t of rest) {
    if (found.has(t.id)) continue
    warnings.push({ code: 'flow_reference_missing', node_id: t.node, action_id: t.action, target_flow_id: t.id })
    t.config.target_flow_id = ''
  }
}
