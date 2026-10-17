// Regras puras da lista de fluxos (06 §2.1, §3.2, §5.1): a API não pagina nem conta, então árvore de pastas,
// contadores, filtros, paginação da tabela, ordem do arrasto e o bloqueio "pasta dentro de descendente" são do cliente.
import type { FlowDto, FlowStatus, FolderDto } from './api'

/** `?folder=` ausente ou `root` = "Sem pasta" (raiz). */
export const ROOT = 'root'
export type FolderKey = string // uuid | ROOT

/** Filtro de status da URL (`?status=`): `all` (padrão), um status da API, ou `folders` (só pastas). */
export const STATUS_FILTERS = ['all', 'active', 'paused', 'draft', 'archived', 'folders'] as const
export type StatusFilter = (typeof STATUS_FILTERS)[number]

export const PAGE_SIZE = 20

export const folderIdOf = (key: FolderKey | undefined): string | null => (!key || key === ROOT ? null : key)

export interface TreeNode {
  folder: FolderDto
  depth: number
  children: TreeNode[]
}

const byPosition = <T extends { position: number; created_at: string }>(a: T, b: T) =>
  a.position - b.position || a.created_at.localeCompare(b.created_at)

/** Árvore de pastas ordenada por posição; pasta com pai inexistente vai para a raiz. */
export function buildTree(folders: readonly FolderDto[]): TreeNode[] {
  const ids = new Set(folders.map((f) => f.id))
  const kids = new Map<string | null, FolderDto[]>()
  for (const f of folders) {
    const parent = f.parent_id && ids.has(f.parent_id) ? f.parent_id : null
    kids.set(parent, [...(kids.get(parent) ?? []), f])
  }
  const seen = new Set<string>()
  const walk = (parent: string | null, depth: number): TreeNode[] =>
    [...(kids.get(parent) ?? [])].sort(byPosition).flatMap((folder) => {
      if (seen.has(folder.id)) return []
      seen.add(folder.id)
      return [{ folder, depth, children: walk(folder.id, depth + 1) }]
    })
  return walk(null, 0)
}

/** Filhas diretas de uma pasta (ou da raiz), na ordem. */
export function childFolders(folders: readonly FolderDto[], parent: string | null): FolderDto[] {
  const ids = new Set(folders.map((f) => f.id))
  return folders.filter((f) => (f.parent_id && ids.has(f.parent_id) ? f.parent_id : null) === parent).sort(byPosition)
}

/** Ids da pasta e de todas as descendentes. */
export function descendantIds(folders: readonly FolderDto[], id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of folders)
      if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
  }
  return out
}

/** Mover a pasta `id` para `target` (null = raiz) é permitido? Bloqueia ela mesma e descendentes (06 §3.2). */
export function canMoveFolder(folders: readonly FolderDto[], id: string, target: string | null): boolean {
  if (target === null) return true
  return !descendantIds(folders, id).has(target)
}

/** Caminho da raiz até a pasta (inclusive); pasta desconhecida → []. */
export function breadcrumb(folders: readonly FolderDto[], id: string | null): FolderDto[] {
  const byId = new Map(folders.map((f) => [f.id, f]))
  const path: FolderDto[] = []
  const seen = new Set<string>()
  let cur = id ? byId.get(id) : undefined
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.unshift(cur)
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
  }
  return path
}

/** Contadores do card de pasta: fluxos diretos e subpastas diretas. */
export function folderCounts(flows: readonly FlowDto[], folders: readonly FolderDto[], id: string) {
  return {
    flows: flows.filter((f) => f.folder_id === id).length,
    folders: folders.filter((f) => f.parent_id === id).length,
  }
}

/** Fluxos de uma pasta (null = raiz), na ordem da API (posição, criação). */
export function flowsIn(flows: readonly FlowDto[], folder: string | null): FlowDto[] {
  return flows.filter((f) => (f.folder_id ?? null) === folder).sort(byPosition)
}

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()

/**
 * O que a tela mostra: com busca, procura em todas as pastas (06 §2.1, busca global); sem busca, só a pasta atual.
 * O filtro de status vale para os fluxos; `folders` esconde os fluxos e mostra só as pastas.
 */
export function visibleItems(
  flows: readonly FlowDto[],
  folders: readonly FolderDto[],
  opts: { folder: string | null; search?: string; status?: StatusFilter },
): { flows: FlowDto[]; folders: FolderDto[] } {
  const q = norm(opts.search ?? '')
  const status = opts.status ?? 'all'
  const baseFlows = q ? [...flows].sort((a, b) => a.name.localeCompare(b.name)) : flowsIn(flows, opts.folder)
  const baseFolders = q ? folders.filter((f) => norm(f.name).includes(q)) : childFolders(folders, opts.folder)
  const shownFlows =
    status === 'folders'
      ? []
      : baseFlows.filter(
          (f) => (!q || norm(f.name).includes(q)) && (status === 'all' || f.status === (status as FlowStatus)),
        )
  const shownFolders = status === 'all' || status === 'folders' ? baseFolders : []
  return { flows: shownFlows, folders: shownFolders }
}

/** Fatia da página (1-based) e o rótulo "de–até de total". */
export function paginate<T>(rows: readonly T[], page: number, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(rows.length / size))
  const p = Math.min(Math.max(1, page), pages)
  const start = (p - 1) * size
  const slice = rows.slice(start, start + size)
  return {
    rows: slice,
    page: p,
    pages,
    from: rows.length ? start + 1 : 0,
    to: start + slice.length,
    total: rows.length,
  }
}

/**
 * Reordenar (o `reorder` da API grava só a posição do fluxo, sem renumerar vizinhos): tira `id` da lista, põe no
 * índice de `beforeId` (ou no fim) e devolve as posições 0..n-1 que mudaram, para enviar uma chamada por fluxo.
 */
export function reorderPlan(
  list: readonly FlowDto[],
  id: string,
  beforeId: string | null,
): { id: string; position: number }[] {
  const ids = list.map((f) => f.id)
  const from = ids.indexOf(id)
  if (from < 0 || id === beforeId) return []
  ids.splice(from, 1)
  const at = beforeId ? ids.indexOf(beforeId) : -1
  ids.splice(at < 0 ? ids.length : at, 0, id)
  const current = new Map(list.map((f) => [f.id, f.position]))
  const sameOrder = ids.every((x, i) => x === list[i]!.id)
  // Mesma ordem e posições já distintas e crescentes: nada a fazer.
  if (sameOrder && list.every((f, i) => i === 0 || f.position > list[i - 1]!.position)) return []
  return ids.map((x, position) => ({ id: x, position })).filter((p) => current.get(p.id) !== p.position)
}

/** Códigos do textarea de importação: vírgula, ponto e vírgula, espaço ou quebra de linha; sem repetir (maiúsculas). */
export function parseCodes(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[\s,;]+/)) {
    const code = raw.trim().toUpperCase()
    if (!code || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  return out
}

export const MAX_IMPORT_CODES = 50

/** Nome único na pasta para "Novo fluxo" (06 §3.1): "Novo Fluxo", "Novo Fluxo 1", "Novo Fluxo 2"… */
export function uniqueName(base: string, taken: readonly string[]): string {
  const names = new Set(taken.map((n) => n.trim().toLowerCase()))
  if (!names.has(base.toLowerCase())) return base
  for (let i = 1; ; i++) if (!names.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`
}

/** "Atualizado": hoje/ontem com hora, senão a data (06 §2.1). */
export function updatedLabel(
  iso: string,
  now: Date,
  locale: string,
): { kind: 'today' | 'yesterday' | 'date'; text: string } {
  const d = new Date(iso)
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0) return { kind: 'today', text: time }
  if (diff === 1) return { kind: 'yesterday', text: time }
  return { kind: 'date', text: d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }) }
}

/** Ações de status do menu conforme o status atual (06 §4.1). */
export function statusActions(status: FlowStatus): ('activate' | 'pause' | 'archive' | 'unarchive')[] {
  switch (status) {
    case 'active':
      return ['pause', 'archive']
    case 'paused':
    case 'draft':
      return ['activate', 'archive']
    case 'archived':
      return ['unarchive']
  }
}
