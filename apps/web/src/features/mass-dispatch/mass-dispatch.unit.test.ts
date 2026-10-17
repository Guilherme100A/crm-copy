import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MassDispatchDraft } from '@/features/contacts/selection'
import { configureHttp } from '@/lib/http'
import {
  PREPARATION_PHASES,
  detailKey,
  listKey,
  massDispatchApi,
  quotaKey,
  type MassDispatchDto,
  type MassDispatchesPage,
  type QuotaDto,
} from './api'
import {
  PRESET_INTERVALS,
  applyPreset,
  buildFormData,
  buildManifest,
  canCancel,
  effectiveInterval,
  effectiveWindow,
  errorPathsOf,
  initialForm,
  matchesSearch,
  overview,
  patchDispatch,
  patchPage,
  phaseStates,
  preparationDone,
  quotaPercent,
  readDraft,
  shortId,
  startsAtIso,
  stepOfPath,
  validateStep,
  type WizardForm,
} from './logic'
import { applyMassDispatchEvent, handleMassDispatchEvent } from './realtime'

const md = (over: Partial<MassDispatchDto> = {}): MassDispatchDto => ({
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Reativação',
  status: 'scheduled',
  targets: [
    {
      id: 't1',
      connection_id: 'c1',
      connection_name: 'Vendas 01',
      flow_id: 'f1',
      flow_name: 'Boas-vindas',
      assigned_count: 10,
      sent_count: 2,
      failed_count: 1,
    },
  ],
  flow_b_id: null,
  flow_b_name: null,
  weekdays: [1, 2, 3, 4, 5],
  window_start: '08:00',
  window_end: '18:00',
  time_zone: 'America/Sao_Paulo',
  interval_min_seconds: 5,
  interval_max_seconds: 30,
  daily_limit: null,
  starts_scheduling_at: '2026-10-16T12:00:00.000Z',
  total_count: 10,
  pending_count: 7,
  sent_count: 2,
  failed_count: 1,
  skipped_count: 0,
  cancelled_count: 0,
  progress_percent: 30,
  preparation_progress: { phase: 'completed', scheduled_count: 10, target_count: 10 },
  preparation_error: null,
  first_sent_at: null,
  last_sent_at: null,
  finished_at: null,
  created_at: '2026-10-16T12:00:00.000Z',
  created_by: null,
  ...over,
})

const quota = (over: Partial<QuotaDto> = {}): QuotaDto => ({
  limit: 1000,
  used: 250,
  remaining: 750,
  bonus: 0,
  billable_slots: 2,
  per_instance_limit: 500,
  period: '2026-10',
  ...over,
})

const draftIds: MassDispatchDraft = {
  open_create: true,
  mode: 'ids',
  ids: ['a', 'b'],
  except_ids: [],
  filters: {},
  count: 2,
}
const draftAll: MassDispatchDraft = {
  open_create: true,
  mode: 'all_except',
  ids: [],
  except_ids: ['x'],
  filters: { label_ids: ['l1'] },
  count: 41,
}

const form = (over: Partial<WizardForm> = {}): WizardForm => ({
  ...initialForm(null),
  targets: [{ connection_id: 'c1', flow_id: 'f1' }],
  ...over,
})

const page = (items: MassDispatchDto[]): MassDispatchesPage => ({
  items,
  page: { page: 1, limit: 100, total_count: items.length, total_pages: 1, has_more: false },
})

describe('visão geral e cota (AC-T83-01)', () => {
  it('cards: restantes/usados da cota; em andamento = preparing+scheduled+running(+paused); concluídos = completed', () => {
    const items = [
      md({ id: 'a', status: 'preparing' }),
      md({ id: 'b', status: 'scheduled' }),
      md({ id: 'c', status: 'running' }),
      md({ id: 'd', status: 'paused' }),
      md({ id: 'e', status: 'completed' }),
      md({ id: 'f', status: 'completed' }),
      md({ id: 'g', status: 'cancelled' }),
      md({ id: 'h', status: 'failed' }),
    ]
    expect(overview(items, quota())).toEqual({ remaining: 750, used: 250, limit: 1000, running: 4, completed: 2 })
    expect(overview([], undefined)).toEqual({ remaining: null, used: null, limit: null, running: 0, completed: 0 })
  })

  it('barra da cota: percentual limitado a 0–100 e cota zerada', () => {
    expect(quotaPercent(quota())).toBe(25)
    expect(quotaPercent(quota({ used: 1200 }))).toBe(100)
    expect(quotaPercent({ used: 0, limit: 0 })).toBe(0)
    expect(quotaPercent({ used: 3, limit: 0 })).toBe(100)
    expect(quotaPercent(undefined)).toBe(0)
  })

  it('busca no cliente por nome, fluxo e conexão (sem nome, usa o nome padrão)', () => {
    const d = md({ name: null, flow_b_name: 'Variante' })
    expect(matchesSearch(d, '', 'x')).toBe(true)
    expect(matchesSearch(d, 'boas', 'x')).toBe(true)
    expect(matchesSearch(d, 'VENDAS', 'x')).toBe(true)
    expect(matchesSearch(d, 'variante', 'x')).toBe(true)
    expect(matchesSearch(d, '#1111', 'Disparo em massa #11111111')).toBe(true)
    expect(matchesSearch(d, 'nada', 'x')).toBe(false)
    expect(shortId(d.id)).toBe('11111111')
  })

  it('cancelar só em preparing/scheduled/running/paused (CANCELLABLE_STATUSES da T60)', () => {
    expect(['preparing', 'scheduled', 'running', 'paused'].every((s) => canCancel(s as never))).toBe(true)
    expect(['completed', 'cancelled', 'failed'].some((s) => canCancel(s as never))).toBe(false)
  })
})

describe('wizard: presets e validações (AC-T83-02)', () => {
  it('presets lento/normal/rápido fixam o intervalo; personalizado mantém o atual', () => {
    expect(PRESET_INTERVALS).toEqual({
      fast: { min: 0, max: 5 },
      normal: { min: 5, max: 30 },
      slow: { min: 30, max: 120 },
    })
    const f = initialForm(null)
    expect(f.preset).toBe('normal')
    expect([f.interval_min, f.interval_max]).toEqual([5, 30])
    const slow = applyPreset(f, 'slow')
    expect([slow.interval_min, slow.interval_max]).toEqual([30, 120])
    const fast = applyPreset(slow, 'fast')
    expect([fast.interval_min, fast.interval_max]).toEqual([0, 5])
    const custom = applyPreset({ ...fast, interval_min: 7, interval_max: 9 }, 'custom')
    expect([custom.preset, custom.interval_min, custom.interval_max]).toEqual(['custom', 7, 9])
  })

  it('sem randomizar o intervalo é fixo (max = min)', () => {
    expect(effectiveInterval({ interval_min: 10, interval_max: 40, randomize: true })).toEqual({ min: 10, max: 40 })
    expect(effectiveInterval({ interval_min: 10, interval_max: 40, randomize: false })).toEqual({ min: 10, max: 10 })
  })

  it('sem horário comercial: todos os dias de 00:00 a 23:59', () => {
    expect(
      effectiveWindow({ business_hours: false, weekdays: [1], window_start: '09:00', window_end: '10:00' }),
    ).toEqual({
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      start: '00:00',
      end: '23:59',
    })
    expect(
      effectiveWindow({ business_hours: true, weekdays: [5, 1, 1], window_start: '09:00', window_end: '10:00' }),
    ).toEqual({
      weekdays: [1, 5],
      start: '09:00',
      end: '10:00',
    })
  })

  it('passo Dados: conexão e fluxo obrigatórios em cada alvo', () => {
    const ctx = { remaining: 10, audienceCount: 1 }
    expect(validateStep('data', form(), ctx)).toEqual({})
    expect(validateStep('data', form({ targets: [] }), ctx)).toEqual({ targets: 'targetsRequired' })
    expect(
      validateStep(
        'data',
        form({
          targets: [
            { connection_id: 'c1', flow_id: 'f1' },
            { connection_id: '', flow_id: '' },
          ],
        }),
        ctx,
      ),
    ).toEqual({
      'targets.1.connection_id': 'connectionRequired',
      'targets.1.flow_id': 'flowRequired',
    })
  })

  it('passo Configurações: dias, janela, intervalo, limite diário (≥ 1 e ≤ cota) e data', () => {
    const ctx = { remaining: 100, audienceCount: 1 }
    expect(validateStep('settings', form(), ctx)).toEqual({})
    expect(validateStep('settings', form({ weekdays: [] }), ctx)).toEqual({ weekdays: 'weekdaysRequired' })
    expect(validateStep('settings', form({ weekdays: [], business_hours: false }), ctx)).toEqual({})
    expect(validateStep('settings', form({ window_start: '18:00', window_end: '08:00' }), ctx)).toEqual({
      window_end: 'windowEmpty',
    })
    expect(validateStep('settings', form({ window_start: '25:00' }), ctx)).toEqual({ window_start: 'timeInvalid' })
    expect(validateStep('settings', form({ preset: 'custom', interval_min: 50, interval_max: 20 }), ctx)).toEqual({
      interval_max_seconds: 'intervalOrder',
    })
    expect(
      validateStep('settings', form({ preset: 'custom', interval_min: 50, interval_max: 20, randomize: false }), ctx),
    ).toEqual({})
    expect(validateStep('settings', form({ interval_min: 0, interval_max: 121 }), ctx)).toEqual({
      interval_max_seconds: 'intervalRange',
    })
    expect(validateStep('settings', form({ daily_limit: '0' }), ctx)).toEqual({ daily_limit: 'dailyLimitInvalid' })
    expect(validateStep('settings', form({ daily_limit: '2.5' }), ctx)).toEqual({ daily_limit: 'dailyLimitInvalid' })
    expect(validateStep('settings', form({ daily_limit: '101' }), ctx)).toEqual({
      daily_limit: 'dailyLimitExceedsQuota',
    })
    expect(validateStep('settings', form({ daily_limit: '101' }), { ...ctx, remaining: null })).toEqual({})
    expect(validateStep('settings', form({ daily_limit: ' 100 ' }), ctx)).toEqual({})
    expect(validateStep('settings', form({ starts_at: 'xx' }), ctx)).toEqual({ starts_scheduling_at: 'dateInvalid' })
  })

  it('passo Público: seleção vazia e cota esgotada', () => {
    expect(validateStep('audience', form(), { remaining: 10, audienceCount: 3 })).toEqual({})
    expect(validateStep('audience', form(), { remaining: 10, audienceCount: null })).toEqual({})
    expect(validateStep('audience', form(), { remaining: 0, audienceCount: 0 })).toEqual({
      manifest: 'selectionRequired',
      quota: 'noQuota',
    })
  })

  it('editar um campo limpa os erros que pertencem a ele', () => {
    expect(errorPathsOf('daily_limit')).toEqual(['daily_limit'])
    expect(errorPathsOf('targets')).toEqual(['targets', 'connection_id', 'flow_id'])
    expect(errorPathsOf('starts_at')).toEqual(['starts_scheduling_at'])
    expect(errorPathsOf('interval_min')).toEqual(['interval_min_seconds', 'interval_max_seconds'])
    expect(errorPathsOf('audience')).toEqual(['manifest'])
    expect(errorPathsOf('business_hours')).toEqual(['weekdays', 'window_start', 'window_end'])
  })

  it('erros do servidor caem no passo do campo', () => {
    expect(stepOfPath('targets.0.flow_id')).toBe('data')
    expect(stepOfPath('targets')).toBe('data')
    expect(stepOfPath('name')).toBe('data')
    expect(stepOfPath('weekdays')).toBe('settings')
    expect(stepOfPath('window_end')).toBe('settings')
    expect(stepOfPath('interval_max_seconds')).toBe('settings')
    expect(stepOfPath('daily_limit')).toBe('settings')
    expect(stepOfPath('manifest')).toBe('audience')
  })
})

describe('público e corpo multipart', () => {
  it('manifesto: rascunho por ids, por todos-exceto com filtros, ou todos os contatos', () => {
    expect(buildManifest('draft', draftIds)).toEqual({ version: 1, mode: 'ids', filters: {}, ids: ['a', 'b'] })
    expect(buildManifest('draft', draftAll)).toEqual({
      version: 1,
      mode: 'all_except',
      filters: { label_ids: ['l1'] },
      except_ids: ['x'],
    })
    expect(buildManifest('all', draftIds)).toEqual({ version: 1, mode: 'all_except', filters: {}, except_ids: [] })
    expect(buildManifest('draft', null)).toEqual({ version: 1, mode: 'all_except', filters: {}, except_ids: [] })
  })

  it('initialForm: com rascunho o público começa nele', () => {
    expect(initialForm(draftIds).audience).toBe('draft')
    expect(initialForm(null).audience).toBe('all')
  })

  it('readDraft: aceita só o formato da T77', () => {
    expect(readDraft({ massDispatchDraft: draftAll, __TSR_index: 1 }, 'massDispatchDraft')).toEqual(draftAll)
    expect(readDraft({ massDispatchDraft: { ...draftIds, open_create: false } }, 'massDispatchDraft')).toBeNull()
    expect(readDraft({ massDispatchDraft: { ...draftIds, mode: 'x' } }, 'massDispatchDraft')).toBeNull()
    expect(readDraft({}, 'massDispatchDraft')).toBeNull()
    expect(readDraft(undefined, 'massDispatchDraft')).toBeNull()
    expect(
      readDraft({ massDispatchDraft: { open_create: true, mode: 'ids', ids: ['a', 3] } }, 'massDispatchDraft'),
    ).toEqual({
      open_create: true,
      mode: 'ids',
      ids: ['a'],
      except_ids: [],
      filters: {},
      count: 0,
    })
  })

  it('startsAtIso: vazio = agora (servidor); data local → ISO', () => {
    expect(startsAtIso('')).toBeNull()
    expect(startsAtIso('nope')).toBeNull()
    expect(startsAtIso('2026-10-20T09:30')).toBe(new Date('2026-10-20T09:30').toISOString())
  })

  it('buildFormData: alvos, weekdays[], janela, intervalo efetivo, limite, início e manifesto como arquivo', async () => {
    const fd = buildFormData(
      form({
        name: '  Black Friday ',
        targets: [
          { connection_id: 'c1', flow_id: 'f1' },
          { connection_id: 'c2', flow_id: 'f2' },
        ],
        weekdays: [1, 3],
        window_start: '09:00',
        window_end: '17:00',
        preset: 'custom',
        interval_min: 12,
        interval_max: 60,
        randomize: false,
        daily_limit: '50',
        starts_at: '2026-10-20T09:30',
        audience: 'draft',
      }),
      draftIds,
    )
    expect(fd.get('name')).toBe('Black Friday')
    expect(JSON.parse(String(fd.get('targets')))).toEqual([
      { connection_id: 'c1', flow_id: 'f1' },
      { connection_id: 'c2', flow_id: 'f2' },
    ])
    expect(fd.get('connection_id')).toBe('c1')
    expect(fd.get('flow_id')).toBe('f1')
    expect(fd.getAll('weekdays[]')).toEqual(['1', '3'])
    expect([fd.get('window_start'), fd.get('window_end')]).toEqual(['09:00', '17:00'])
    expect([fd.get('interval_min_seconds'), fd.get('interval_max_seconds')]).toEqual(['12', '12'])
    expect(fd.get('daily_limit')).toBe('50')
    expect(fd.get('starts_scheduling_at')).toBe(new Date('2026-10-20T09:30').toISOString())
    const file = fd.get('manifest') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('application/json')
    expect(JSON.parse(await file.text())).toEqual({ version: 1, mode: 'ids', filters: {}, ids: ['a', 'b'] })
  })

  it('buildFormData sem nome, limite e início não envia esses campos', () => {
    const fd = buildFormData(form({ business_hours: false }), null)
    expect(fd.has('name')).toBe(false)
    expect(fd.has('daily_limit')).toBe(false)
    expect(fd.has('starts_scheduling_at')).toBe(false)
    expect(fd.getAll('weekdays[]')).toEqual(['0', '1', '2', '3', '4', '5', '6'])
    expect([fd.get('window_start'), fd.get('window_end')]).toEqual(['00:00', '23:59'])
    expect([fd.get('interval_min_seconds'), fd.get('interval_max_seconds')]).toEqual(['5', '30'])
  })

  it('massDispatchApi.create envia multipart (sem Content-Type JSON) e cancel faz POST /:id/cancel', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    configureHttp({
      fetch: async (url, init) => {
        calls.push({ url, init })
        return new Response(JSON.stringify({ mass_dispatch: md(), warnings: [], released_count: 3 }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const r = await massDispatchApi.create(buildFormData(form(), null))
    expect(r.mass_dispatch.id).toBe(md().id)
    expect(calls[0]!.url).toBe('/api/mass-dispatches')
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.init.body).toBeInstanceOf(FormData)
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBeUndefined()
    await massDispatchApi.cancel('a/b')
    expect(calls[1]!.url).toBe('/api/mass-dispatches/a%2Fb/cancel')
  })
})

describe('preparação: fases (AC-T83-04)', () => {
  it('fases na ordem do runner da T74', () => {
    expect(PREPARATION_PHASES).toEqual(['queued', 'resolving_recipients', 'counting', 'scheduling', 'completed'])
  })

  it('estado de cada fase conforme a fase atual', () => {
    expect(phaseStates('preparing', { phase: 'queued' })).toEqual({
      queued: 'current',
      resolving_recipients: 'pending',
      counting: 'pending',
      scheduling: 'pending',
      completed: 'pending',
    })
    expect(phaseStates('preparing', { phase: 'counting' })).toEqual({
      queued: 'done',
      resolving_recipients: 'done',
      counting: 'current',
      scheduling: 'pending',
      completed: 'pending',
    })
    const done = phaseStates('scheduled', { phase: 'completed' })
    expect(Object.values(done).every((s) => s === 'done')).toBe(true)
    // Já saiu da preparação sem fase gravada: tudo concluído.
    expect(Object.values(phaseStates('running', {})).every((s) => s === 'done')).toBe(true)
    expect(phaseStates('preparing', {}).queued).toBe('current')
    expect(phaseStates('failed', { phase: 'scheduling' })).toMatchObject({
      counting: 'done',
      scheduling: 'failed',
      completed: 'pending',
    })
  })

  it('preparationDone', () => {
    expect(preparationDone(md({ status: 'preparing', preparation_progress: { phase: 'scheduling' } }))).toBe(false)
    expect(preparationDone(md({ status: 'preparing', preparation_progress: { phase: 'completed' } }))).toBe(true)
    expect(preparationDone(md({ status: 'failed', preparation_progress: { phase: 'counting' } }))).toBe(true)
    expect(preparationDone(md({ status: 'scheduled' }))).toBe(true)
  })
})

describe('realtime mass_dispatch.updated', () => {
  afterEach(() => vi.useRealTimers())

  it('patchDispatch aplica status, fase e contagens e recalcula o progresso', () => {
    const d = patchDispatch(md({ status: 'preparing', preparation_progress: { phase: 'queued' } }), {
      mass_dispatch_id: 'x',
      status: 'scheduled',
      preparation_progress: { phase: 'completed', scheduled_count: 20, target_count: 20 },
      total_count: 20,
      pending_count: 15,
      sent_count: 4,
      failed_count: 1,
      skipped_count: 2,
    })
    expect(d.status).toBe('scheduled')
    expect(d.preparation_progress.phase).toBe('completed')
    expect([d.total_count, d.pending_count, d.sent_count, d.failed_count, d.skipped_count]).toEqual([20, 15, 4, 1, 2])
    expect(d.progress_percent).toBe(25)
    expect(patchDispatch(md(), { total_count: 0, sent_count: 0, failed_count: 0 }).progress_percent).toBe(0)
  })

  it('patchPage: null quando o disparo não está na página', () => {
    const p = page([md({ id: 'a' })])
    expect(patchPage(p, 'zz', { status: 'running' })).toBeNull()
    expect(patchPage(p, 'a', { status: 'running' })!.items[0]!.status).toBe('running')
  })

  it('evento atualiza detalhe e listas no cache e depois recarrega lista e cota (debounce)', async () => {
    vi.useFakeTimers()
    const qc = new QueryClient()
    const id = 'a'
    qc.setQueryData(detailKey(id), md({ id, status: 'preparing', preparation_progress: { phase: 'queued' } }))
    qc.setQueryData(listKey(1), page([md({ id, status: 'preparing' }), md({ id: 'b' })]))
    const spy = vi.spyOn(qc, 'invalidateQueries')
    handleMassDispatchEvent(
      {
        type: 'mass_dispatch.updated',
        data: {
          mass_dispatch_id: id,
          status: 'preparing',
          preparation_progress: { phase: 'scheduling', scheduled_count: 3, target_count: 10 },
          total_count: 10,
          pending_count: 10,
          sent_count: 0,
          failed_count: 0,
          skipped_count: 0,
        },
      },
      qc,
    )
    expect(qc.getQueryData<MassDispatchDto>(detailKey(id))!.preparation_progress.phase).toBe('scheduling')
    expect(qc.getQueryData<MassDispatchesPage>(listKey(1))!.items[0]!.total_count).toBe(10)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
    expect(keys).toContain(JSON.stringify(['mass-dispatch', 'list']))
    expect(keys).toContain(JSON.stringify(quotaKey))
  })

  it('evento sem id ou de outro tipo não mexe no cache', () => {
    const qc = new QueryClient()
    qc.setQueryData(listKey(1), page([md({ id: 'a' })]))
    expect(applyMassDispatchEvent(qc, { status: 'running' })).toBe(false)
    handleMassDispatchEvent({ type: 'connection.updated', data: { mass_dispatch_id: 'a', status: 'running' } }, qc)
    expect(qc.getQueryData<MassDispatchesPage>(listKey(1))!.items[0]!.status).toBe('scheduled')
  })
})

describe('i18n (AC-T83-03: aviso de ritmo)', () => {
  const dir = join(__dirname, '../../i18n')
  const read = (lang: string) => JSON.parse(readFileSync(join(dir, lang, 'mass-dispatch.json'), 'utf8'))
  const get = (obj: unknown, path: string) =>
    path
      .split('.')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj)

  it('aviso de que o ritmo real pode ser mais lento por causa dos limites de segurança, nas 3 línguas', () => {
    expect(read('pt-BR').pace.notice).toMatch(/mais lento/)
    expect(read('pt-BR').pace.notice).toMatch(/limites de segurança/)
    expect(read('en').pace.notice).toMatch(/slower/)
    expect(read('es').pace.notice).toMatch(/más lento/)
    expect(read('pt-BR').confirm.flowNotice).toMatch(/cancela qualquer fluxo em andamento/)
  })

  it('toda chave literal usada nos componentes existe em pt-BR (inclui status, fases, presets e erros)', () => {
    const pt = read('pt-BR')
    const src = readdirSync(__dirname)
      .filter((f) => f.endsWith('.tsx'))
      .map((f) => readFileSync(join(__dirname, f), 'utf8'))
      .join('\n')
    const keys = new Set([...src.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)].map((m) => m[1]!))
    for (const k of ['status', 'phases', 'presets', 'errors']) expect(pt[k]).toBeTypeOf('object')
    for (const s of ['preparing', 'scheduled', 'running', 'paused', 'completed', 'cancelled', 'failed'])
      keys.add(`status.${s}`)
    for (const p of PREPARATION_PHASES) keys.add(`phases.${p}`)
    for (const p of ['slow', 'normal', 'fast', 'custom']) keys.add(`presets.${p}`).add(`presets.${p}Hint`)
    for (const s of ['data', 'settings', 'audience']) keys.add(`wizard.step.${s}`)
    for (const c of ['name', 'flow', 'status', 'progress', 'schedule']) keys.add(`cols.${c}`)
    const missing = [...keys].filter((k) => typeof get(pt, k) !== 'string')
    expect(missing).toEqual([])
  })

  it('todo código de erro de validateStep tem texto', () => {
    const pt = read('pt-BR')
    const all = [
      validateStep('data', form({ targets: [] }), { remaining: 0, audienceCount: 0 }),
      validateStep('data', form({ targets: [{ connection_id: '', flow_id: '' }] }), { remaining: 0, audienceCount: 0 }),
      validateStep(
        'settings',
        form({ weekdays: [], window_start: 'x', window_end: 'y', daily_limit: '0', starts_at: 'z' }),
        { remaining: 0, audienceCount: 0 },
      ),
      validateStep(
        'settings',
        form({ window_start: '10:00', window_end: '09:00', daily_limit: '5', interval_min: -1, interval_max: 200 }),
        { remaining: 1, audienceCount: 0 },
      ),
      validateStep('settings', form({ preset: 'custom', interval_min: 9, interval_max: 3 }), {
        remaining: 1,
        audienceCount: 0,
      }),
      validateStep('audience', form(), { remaining: 0, audienceCount: 0 }),
    ]
    const codes = new Set(all.flatMap((e) => Object.values(e)))
    expect(codes.size).toBeGreaterThanOrEqual(12)
    for (const c of codes) expect(typeof pt.errors[c]).toBe('string')
  })
})
