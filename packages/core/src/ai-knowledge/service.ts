// Base de conhecimento dos agentes de IA (T52; 07 §3.4, §4): fontes `site|pdf|text|file|faq|flow` com limite por
// slot (site 1, pdf 2, text 2, faq 10, flow 1; arquivo ≤ 8 MB), ingestão em job (`pending → ready|failed` com o
// código de 07 §3.4), trechos indexados por busca textual do Postgres ('portuguese', sem embeddings), reindexar,
// excluir e o evento `ai_knowledge_source.updated`.
import { and, asc, count, eq, sql } from 'drizzle-orm'
import { aiAgents, aiKnowledgeChunks, aiKnowledgeSources, flows, type AiKnowledgeFaqItem, type AiKnowledgeKind, type AiKnowledgeSlot, type Database } from '@crm/db'
import type { SafeHttpOptions } from '../flows/nodes/external/http'
import { FlowStore } from '../flows/store/store'
import type { RealtimePublisher } from '../realtime/publisher'
import { chunkText, extractPdfPages, isPdfHeader, KnowledgeIngestError, normalizeKnowledgeText } from './extract'
import { readSite } from './site'

/** Limite de fontes por slot (07 §3.4, `mb`). */
export const KNOWLEDGE_SLOT_LIMITS: Record<AiKnowledgeSlot, number> = { site: 1, pdf: 2, text: 2, faq: 10, flow: 1 }
export const KNOWLEDGE_FILE_MAX_BYTES = 8 * 1024 * 1024
export const KNOWLEDGE_TEXT_MAX_CHARS = 100_000
export const KNOWLEDGE_FAQ_MAX_ITEMS = 200
export const KNOWLEDGE_SEARCH_DEFAULT_LIMIT = 5
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KINDS: readonly AiKnowledgeKind[] = ['site', 'pdf', 'text', 'file', 'faq', 'flow']

/** Códigos de criação (07 §3.4) em `details.error_code`. */
export type KnowledgeErrorCode =
  | 'unsupported_kind'
  | 'url_required'
  | 'text_required'
  | 'text_too_long'
  | 'faq_item_required'
  | 'flow_missing'
  | 'file_missing'
  | 'unsupported_file'
  | 'not_pdf'
  | 'too_large'
  | 'knowledge_limit'
  | 'pdf_limit'
  | 'text_limit'
  | 'faq_limit'

export class AiKnowledgeError extends Error {
  constructor(
    readonly code: 'not_found' | 'validation' | 'limit_reached' | 'payload_too_large',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AiKnowledgeError'
  }
}

const invalid = (errorCode: KnowledgeErrorCode, message: string, path = 'kind') =>
  new AiKnowledgeError('validation', message, { error_code: errorCode, fields: [{ path, message }] })

export interface KnowledgeFileInput {
  filename: string
  contentType?: string | null
  data: Uint8Array
}

export interface CreateKnowledgeInput {
  kind?: unknown
  url?: unknown
  title?: unknown
  body?: unknown
  items?: unknown
  replace?: unknown
  flow_id?: unknown
  file?: KnowledgeFileInput | null
}

export interface KnowledgeSourceDto {
  id: string
  agent_id: string
  kind: AiKnowledgeKind
  slot: AiKnowledgeSlot
  status: 'pending' | 'ready' | 'failed'
  title: string | null
  url: string | null
  filename: string | null
  flow_id: string | null
  items: AiKnowledgeFaqItem[] | null
  pages_count: number | null
  questions_count: number | null
  chunks_count: number
  error_message: string | null
  error_detail: string | null
  created_at: string
  updated_at: string
}

export interface KnowledgeHit {
  source_id: string
  kind: AiKnowledgeKind
  title: string | null
  content: string
  rank: number
}

export interface AiKnowledgeJobData {
  companyId: string
  sourceId: string
}

export interface AiKnowledgeServiceOptions {
  db: Database
  publisher?: Pick<RealtimePublisher, 'publish'>
  /** Enfileira a ingestão (job `ai-knowledge`). Sem ela, a fonte fica `pending` até alguém chamar `process`. */
  enqueue?: (data: AiKnowledgeJobData, opts: { jobId: string }) => Promise<void>
  /** Opções do HTTP SSRF-safe do `site` (testes: `lookup`/`allowHosts`). */
  http?: SafeHttpOptions
  logger?: { warn(obj: object, msg?: string): void }
}

type Row = typeof aiKnowledgeSources.$inferSelect

export class AiKnowledgeService {
  constructor(private readonly opts: AiKnowledgeServiceOptions) {}

  private get db() {
    return this.opts.db
  }

  // ------------------------------------------------------------------ CRUD

  async list(companyId: string, agentId: string): Promise<KnowledgeSourceDto[]> {
    await this.agent(companyId, agentId)
    const rows = await this.db
      .select()
      .from(aiKnowledgeSources)
      .where(and(eq(aiKnowledgeSources.companyId, companyId), eq(aiKnowledgeSources.agentId, agentId)))
      .orderBy(asc(aiKnowledgeSources.createdAt))
    return rows.map(toDto)
  }

  async get(companyId: string, agentId: string, sourceId: string): Promise<KnowledgeSourceDto> {
    return toDto(await this.row(companyId, agentId, sourceId))
  }

  async create(companyId: string, agentId: string, input: CreateKnowledgeInput): Promise<KnowledgeSourceDto> {
    const values = await this.prepare(companyId, input)
    const row = await this.db.transaction(async (tx) => {
      // Trava o agente: duas criações simultâneas não furam o limite do slot.
      const [agent] = await tx
        .select({ id: aiAgents.id })
        .from(aiAgents)
        .where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, agentId)))
        .for('update')
      if (!agent) throw new AiKnowledgeError('not_found', 'Agente não encontrado')
      if (values.slot === 'faq' && input.replace === true)
        await tx.delete(aiKnowledgeSources).where(and(eq(aiKnowledgeSources.agentId, agentId), eq(aiKnowledgeSources.slot, 'faq')))
      const [used] = await tx
        .select({ n: count() })
        .from(aiKnowledgeSources)
        .where(and(eq(aiKnowledgeSources.agentId, agentId), eq(aiKnowledgeSources.slot, values.slot)))
      const limit = KNOWLEDGE_SLOT_LIMITS[values.slot]
      if ((used?.n ?? 0) >= limit) {
        const errorCode: KnowledgeErrorCode = values.slot === 'pdf' || values.slot === 'text' || values.slot === 'faq' ? `${values.slot}_limit` : 'knowledge_limit'
        throw new AiKnowledgeError('limit_reached', `Limite de ${limit} fonte(s) do tipo ${values.slot} atingido`, { error_code: errorCode, slot: values.slot, limit })
      }
      const [inserted] = await tx
        .insert(aiKnowledgeSources)
        .values({ ...values, companyId, agentId, status: 'pending' })
        .returning()
      return inserted!
    })
    await this.publish(row, 'pending')
    await this.enqueue(row)
    return toDto(row)
  }

  /** "Ler de novo": volta para `pending`, limpa o erro e enfileira a ingestão. */
  async reindex(companyId: string, agentId: string, sourceId: string): Promise<KnowledgeSourceDto> {
    const cur = await this.row(companyId, agentId, sourceId)
    const [row] = await this.db
      .update(aiKnowledgeSources)
      .set({ status: 'pending', errorMessage: null, errorDetail: null, updatedAt: new Date() })
      .where(eq(aiKnowledgeSources.id, cur.id))
      .returning()
    await this.publish(row!, 'pending')
    await this.enqueue(row!)
    return toDto(row!)
  }

  async remove(companyId: string, agentId: string, sourceId: string): Promise<void> {
    const cur = await this.row(companyId, agentId, sourceId)
    await this.db.delete(aiKnowledgeSources).where(eq(aiKnowledgeSources.id, cur.id))
    await this.publish(cur, 'deleted')
  }

  // ------------------------------------------------------------------ ingestão (job)

  /** Lê a fonte, troca os trechos e termina `ready` (com contagens) ou `failed` (com o código). Fonte apagada → null. */
  async process(sourceId: string): Promise<KnowledgeSourceDto | null> {
    const [src] = await this.db.select().from(aiKnowledgeSources).where(eq(aiKnowledgeSources.id, sourceId)).limit(1)
    if (!src) return null
    let result: { chunks: string[]; pages: number | null; questions: number | null; title?: string | null }
    try {
      result = await this.extract(src)
    } catch (err) {
      const e =
        err instanceof KnowledgeIngestError
          ? err
          : new KnowledgeIngestError('generic', err instanceof Error ? err.message : String(err), err instanceof Error ? err.name : null)
      if (!(err instanceof KnowledgeIngestError)) this.opts.logger?.warn({ err, sourceId }, 'falha inesperada na ingestão de conhecimento')
      const [row] = await this.db.transaction(async (tx) => {
        await tx.delete(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.sourceId, src.id))
        return tx
          .update(aiKnowledgeSources)
          .set({ status: 'failed', errorMessage: e.code, errorDetail: e.detail?.slice(0, 200) ?? null, chunksCount: 0, updatedAt: new Date() })
          .where(eq(aiKnowledgeSources.id, src.id))
          .returning()
      })
      if (!row) return null
      await this.publish(row, 'failed')
      return toDto(row)
    }
    const [row] = await this.db.transaction(async (tx) => {
      await tx.delete(aiKnowledgeChunks).where(eq(aiKnowledgeChunks.sourceId, src.id))
      if (result.chunks.length)
        await tx.insert(aiKnowledgeChunks).values(result.chunks.map((content, position) => ({ companyId: src.companyId, agentId: src.agentId, sourceId: src.id, position, content })))
      return tx
        .update(aiKnowledgeSources)
        .set({
          status: 'ready',
          errorMessage: null,
          errorDetail: null,
          pagesCount: result.pages,
          questionsCount: result.questions,
          chunksCount: result.chunks.length,
          ...(result.title && !src.title ? { title: result.title } : {}),
          updatedAt: new Date(),
        })
        .where(eq(aiKnowledgeSources.id, src.id))
        .returning()
    })
    if (!row) return null
    await this.publish(row, 'ready')
    return toDto(row)
  }

  private async extract(src: Row): Promise<{ chunks: string[]; pages: number | null; questions: number | null; title?: string | null }> {
    switch (src.slot) {
      case 'pdf': {
        if (!src.fileData) throw new KnowledgeIngestError('file_missing', 'arquivo ausente')
        const { totalPages, pages } = await extractPdfPages(src.fileData)
        return { chunks: pages.flatMap((p) => chunkText(p)), pages: totalPages, questions: null }
      }
      case 'text': {
        const text = normalizeKnowledgeText(src.fileData ? Buffer.from(src.fileData).toString('utf8') : (src.body ?? ''))
        if (!text) throw new KnowledgeIngestError('empty', 'texto vazio')
        return { chunks: chunkText(src.title ? `${src.title}\n${text}` : text), pages: 1, questions: null }
      }
      case 'faq': {
        const items = (src.items ?? []).filter((i) => i.q?.trim() && i.a?.trim())
        if (!items.length) throw new KnowledgeIngestError('empty', 'FAQ sem perguntas')
        return { chunks: items.flatMap((i) => chunkText(`Pergunta: ${i.q.trim()}\nResposta: ${i.a.trim()}`)), pages: null, questions: items.length }
      }
      case 'flow': {
        const text = await this.flowText(src.companyId, src.flowId)
        if (!text) throw new KnowledgeIngestError('empty', 'o fluxo não tem texto')
        return { chunks: chunkText(text), pages: null, questions: null }
      }
      case 'site': {
        const pages = await readSite(src.url ?? '', { http: this.opts.http })
        return { chunks: pages.flatMap((p) => chunkText(p.title ? `${p.title}\n${p.text}` : p.text)), pages: pages.length, questions: null, title: pages[0]!.title }
      }
    }
  }

  /** Textos do fluxo (mensagens, perguntas, opções…) a partir da definição atual. */
  private async flowText(companyId: string, flowId: string | null): Promise<string> {
    if (!flowId) throw new KnowledgeIngestError('flow_missing', 'fluxo ausente')
    let def: Awaited<ReturnType<FlowStore['toDefinition']>>
    try {
      def = await new FlowStore(this.db).toDefinition({ companyId }, flowId)
    } catch {
      throw new KnowledgeIngestError('flow_missing', 'fluxo não encontrado')
    }
    const texts: string[] = []
    const walk = (v: unknown, key: string) => {
      if (typeof v === 'string') {
        if (/(^|_)(id|ids|url|type|key|handle|color|variable|method)$/i.test(key)) return
        const t = v.trim()
        if (t.length >= 3 && /\p{L}/u.test(t) && !/^https?:\/\//i.test(t)) texts.push(t)
      } else if (Array.isArray(v)) v.forEach((x) => walk(x, key))
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
    }
    for (const node of def.nodes) {
      if (node.name && node.type !== 'start') texts.push(node.name)
      for (const action of node.actions) walk(action.config, '')
    }
    return normalizeKnowledgeText([...new Set(texts)].join('\n'))
  }

  // ------------------------------------------------------------------ busca

  /** Trechos mais relevantes do agente para a consulta (full-text 'portuguese', termos em OU, `ts_rank_cd`). */
  async search(input: { companyId: string; agentId: string; query: string; limit?: number }): Promise<KnowledgeHit[]> {
    const terms = [...new Set((input.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2))].slice(0, 16)
    if (!terms.length) return []
    const tsquery = terms.join(' | ')
    const limit = Math.max(1, Math.min(input.limit ?? KNOWLEDGE_SEARCH_DEFAULT_LIMIT, 50))
    const { rows } = await this.db.execute(sql`
      select c.source_id, s.kind, s.title, c.content, ts_rank_cd(c.tsv, q) as rank
      from crm.ai_knowledge_chunks c
      join crm.ai_knowledge_sources s on s.id = c.source_id, to_tsquery('portuguese', ${tsquery}) q
      where c.company_id = ${input.companyId} and c.agent_id = ${input.agentId} and s.status = 'ready' and c.tsv @@ q
      order by rank desc, c.position asc
      limit ${limit}`)
    return (rows as Array<{ source_id: string; kind: AiKnowledgeKind; title: string | null; content: string; rank: number | string }>).map((r) => ({
      source_id: r.source_id,
      kind: r.kind,
      title: r.title,
      content: r.content,
      rank: Number(r.rank),
    }))
  }

  /** Porta `KnowledgeSearch` do runtime dos agentes (T68): só o texto dos trechos. */
  asKnowledgeSearch(limit = KNOWLEDGE_SEARCH_DEFAULT_LIMIT): { search(input: { companyId: string; agentId: string; query: string }): Promise<string[]> } {
    return { search: async (input) => (await this.search({ ...input, limit })).map((h) => h.content) }
  }

  // ------------------------------------------------------------------ apoio

  private async agent(companyId: string, agentId: string): Promise<void> {
    if (!UUID_RE.test(agentId)) throw new AiKnowledgeError('not_found', 'Agente não encontrado')
    const [a] = await this.db.select({ id: aiAgents.id }).from(aiAgents).where(and(eq(aiAgents.companyId, companyId), eq(aiAgents.id, agentId))).limit(1)
    if (!a) throw new AiKnowledgeError('not_found', 'Agente não encontrado')
  }

  private async row(companyId: string, agentId: string, sourceId: string): Promise<Row> {
    await this.agent(companyId, agentId)
    if (!UUID_RE.test(sourceId)) throw new AiKnowledgeError('not_found', 'Fonte não encontrada')
    const [row] = await this.db
      .select()
      .from(aiKnowledgeSources)
      .where(and(eq(aiKnowledgeSources.companyId, companyId), eq(aiKnowledgeSources.agentId, agentId), eq(aiKnowledgeSources.id, sourceId)))
      .limit(1)
    if (!row) throw new AiKnowledgeError('not_found', 'Fonte não encontrada')
    return row
  }

  /** Valida a entrada e devolve as colunas da fonte (sem company/agent/status). */
  private async prepare(companyId: string, input: CreateKnowledgeInput): Promise<Omit<typeof aiKnowledgeSources.$inferInsert, 'companyId' | 'agentId'>> {
    const kind = typeof input.kind === 'string' && (KINDS as readonly string[]).includes(input.kind) ? (input.kind as AiKnowledgeKind) : null
    if (!kind) throw invalid('unsupported_kind', 'Tipo de conhecimento não suportado')
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 255) : null
    const file = input.file ?? null
    if (file && file.data.byteLength > KNOWLEDGE_FILE_MAX_BYTES)
      throw new AiKnowledgeError('payload_too_large', 'Arquivo acima de 8 MB', { error_code: 'too_large', max_bytes: KNOWLEDGE_FILE_MAX_BYTES })

    if (kind === 'site') {
      const raw = typeof input.url === 'string' ? input.url.trim() : ''
      let url: URL | null
      try {
        url = raw ? new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : null
      } catch {
        url = null
      }
      if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) throw invalid('url_required', 'Informe a URL do site', 'url')
      return { kind, slot: 'site', url: url.toString(), title }
    }
    if (kind === 'faq') {
      const items = Array.isArray(input.items) ? input.items : []
      const clean = items.map((i) => ({ q: typeof i?.q === 'string' ? i.q.trim() : '', a: typeof i?.a === 'string' ? i.a.trim() : '' }))
      if (!clean.length || clean.some((i) => !i.q || !i.a)) throw invalid('faq_item_required', 'Cada pergunta precisa de pergunta e resposta', 'items')
      if (clean.length > KNOWLEDGE_FAQ_MAX_ITEMS) throw invalid('faq_item_required', `Máximo de ${KNOWLEDGE_FAQ_MAX_ITEMS} perguntas`, 'items')
      return { kind, slot: 'faq', items: clean, title }
    }
    if (kind === 'flow') {
      const flowId = typeof input.flow_id === 'string' ? input.flow_id.trim() : ''
      const [flow] = UUID_RE.test(flowId) ? await this.db.select({ id: flows.id, name: flows.name }).from(flows).where(and(eq(flows.companyId, companyId), eq(flows.id, flowId))).limit(1) : []
      if (!flow) throw invalid('flow_missing', 'Fluxo não encontrado', 'flow_id')
      return { kind, slot: 'flow', flowId: flow.id, title: title ?? flow.name }
    }

    // pdf | text | file
    if (kind === 'text' && !file) {
      const body = typeof input.body === 'string' ? input.body.trim() : ''
      if (!body) throw invalid('text_required', 'Escreva o texto', 'body')
      if (body.length > KNOWLEDGE_TEXT_MAX_CHARS) throw invalid('text_too_long', `Texto acima de ${KNOWLEDGE_TEXT_MAX_CHARS} caracteres`, 'body')
      return { kind, slot: 'text', body, title }
    }
    if (!file || file.data.byteLength === 0) throw invalid('file_missing', 'Envie o arquivo', 'file')
    const filename = file.filename.slice(0, 255)
    const ext = /\.[^.]+$/.exec(filename.toLowerCase())?.[0] ?? ''
    const looksPdf = ext === '.pdf' || /pdf/i.test(file.contentType ?? '')
    const slot: AiKnowledgeSlot | null = kind === 'pdf' ? 'pdf' : kind === 'text' ? 'text' : looksPdf ? 'pdf' : TEXT_EXTENSIONS.includes(ext) ? 'text' : null
    if (!slot) throw invalid('unsupported_file', 'Use PDF, TXT, MD ou CSV', 'file')
    if (slot === 'pdf' && !isPdfHeader(file.data)) throw invalid('not_pdf', 'O arquivo não é um PDF', 'file')
    if (slot === 'text' && ext && !TEXT_EXTENSIONS.includes(ext)) throw invalid('unsupported_file', 'Texto aceita .txt, .md ou .csv', 'file')
    return { kind, slot, filename, contentType: file.contentType ?? null, fileData: Buffer.from(file.data), title: title ?? filename }
  }

  private async enqueue(row: Row): Promise<void> {
    if (!this.opts.enqueue) return
    // jobId por (fonte, momento): reindex gera um job novo.
    await this.opts.enqueue({ companyId: row.companyId, sourceId: row.id }, { jobId: `knowledge-${row.id}-${row.updatedAt.getTime()}` })
  }

  private async publish(row: Row, status: 'pending' | 'ready' | 'failed' | 'deleted'): Promise<void> {
    if (!this.opts.publisher) return
    try {
      await this.opts.publisher.publish(row.companyId, 'ai_knowledge_source.updated', {
        agent_id: row.agentId,
        source_id: row.id,
        status,
        ...(status === 'deleted' ? {} : { source: toDto(row) }),
      } as never)
    } catch (err) {
      this.opts.logger?.warn({ err, sourceId: row.id }, 'falha ao publicar ai_knowledge_source.updated')
    }
  }
}

export function toDto(r: Row): KnowledgeSourceDto {
  return {
    id: r.id,
    agent_id: r.agentId,
    kind: r.kind,
    slot: r.slot,
    status: r.status,
    title: r.title,
    url: r.url,
    filename: r.filename,
    flow_id: r.flowId,
    items: r.items ?? null,
    pages_count: r.pagesCount,
    questions_count: r.questionsCount,
    chunks_count: r.chunksCount,
    error_message: r.errorMessage,
    error_detail: r.errorDetail,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  }
}
