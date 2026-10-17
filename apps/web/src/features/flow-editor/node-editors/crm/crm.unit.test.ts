import { CHAT_STATUS_VALUES } from '@crm/shared/flows'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, HttpError } from '@/lib/http'
import { agentsQuery, boardsQuery, columnsQuery, departmentsQuery, labelsQuery, teamQuery } from '../logic/api'
import { switchAction, validateConfig } from '../logic/rules'
import {
  addTag,
  isNewTag,
  kanbanConfig,
  manipulatorConfig,
  manipulatorValue,
  removeTag,
  tagConfig,
  withAgentMode,
  withBoard,
  withColumn,
  withOperation,
} from './crm-rules'

type Fn<T> = () => Promise<T>
const run = <T,>(q: { queryFn?: unknown }) => (q.queryFn as Fn<T>)()

afterEach(() => vi.restoreAllMocks())

describe('AC-T57-03 nós de CRM listam os dados reais da empresa (API)', () => {
  it('etiquetas, departamentos, quadros, colunas, agentes e equipe vêm das rotas reais', async () => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      const items: Record<string, unknown[]> = {
        '/api/labels': [{ id: 'l1', name: 'VIP', color: '#f00' }],
        '/api/departments/all': [{ id: 'd1', name: 'Vendas', color: '#0f0' }],
        '/api/crms': [{ id: 'b1', name: 'Funil' }],
        '/api/crms/b1/columns': [
          { id: 'c2', name: 'Ganho', position: 1, conversion_goal: true },
          { id: 'c1', name: 'Novo', position: 0, conversion_goal: false },
        ],
        '/api/ai-agents': [{ id: 'ag1', name: 'Sofia', status: 'active' }],
        '/api/team': [{ user_id: 'u1', user: { name: 'Ana', email: 'ana@x.com' } }],
      }
      return { items: items[path] ?? [] } as never
    })
    expect(await run(labelsQuery())).toEqual({ items: [{ id: 'l1', name: 'VIP', color: '#f00' }], denied: false })
    expect((await run<{ items: unknown[] }>(departmentsQuery())).items).toHaveLength(1)
    expect((await run<{ items: unknown[] }>(boardsQuery())).items).toEqual([{ id: 'b1', name: 'Funil' }])
    // Colunas na ordem do quadro.
    expect((await run<{ items: { id: string }[] }>(columnsQuery('b1'))).items.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect((await run<{ items: unknown[] }>(agentsQuery())).items).toEqual([{ id: 'ag1', name: 'Sofia', status: 'active' }])
    expect((await run<{ items: unknown[] }>(teamQuery())).items).toEqual([{ user_id: 'u1', name: 'Ana', email: 'ana@x.com' }])
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/api/labels', '/api/departments/all', '/api/crms', '/api/crms/b1/columns', '/api/ai-agents', '/api/team'])
  })

  it('403/404 não quebra o editor: lista vazia com `denied`; outros erros sobem', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(new HttpError(403, 'FORBIDDEN', 'x')).mockRejectedValueOnce(new HttpError(404, 'NOT_FOUND', 'x')).mockRejectedValueOnce(new HttpError(500, 'X', 'x'))
    expect(await run(labelsQuery())).toEqual({ items: [], denied: true })
    expect(await run(departmentsQuery())).toEqual({ items: [], denied: true })
    await expect(run(boardsQuery())).rejects.toBeInstanceOf(HttpError)
  })

  it('etiquetas gravam NOMES, sem repetir (sem caixa); nome novo é permitido', () => {
    let tags = addTag([], ' VIP ')
    tags = addTag(tags, 'vip')
    tags = addTag(tags, 'Lead quente')
    expect(tags).toEqual(['VIP', 'Lead quente'])
    expect(removeTag(tags, 'VIP')).toEqual(['Lead quente'])
    expect(isNewTag('Lead quente', [{ name: 'VIP' }])).toBe(true)
    expect(isNewTag('vip', [{ name: 'VIP' }])).toBe(false)
    expect(validateConfig('add_tags', tagConfig('add_tags', tags))).toEqual({})
    expect(validateConfig('remove_tags', tagConfig('remove_tags', tags))).toEqual({})
    expect(validateConfig('add_tags', tagConfig('add_tags'))).toHaveProperty('tags', { key: 'minItems', vars: { min: 1 } })
    // Trocar adicionar ↔ remover mantém a ação (id) e os nomes.
    const [a] = switchAction([{ id: 'a1', type: 'add_tags', order: 0, config: tagConfig('add_tags', tags) }], 'a1', 'remove_tags', tagConfig('remove_tags', tags))
    expect(a).toEqual({ id: 'a1', type: 'remove_tags', order: 0, config: { action: 'remove', tags } })
  })

  it('status do chat e departamento usam os valores do motor', () => {
    for (const s of CHAT_STATUS_VALUES) expect(validateConfig('change_chat_status', { chat_status: s })).toEqual({})
    expect(validateConfig('set_department', { department_id: '' })).toHaveProperty('department_id', { key: 'required' })
    expect(validateConfig('set_department', { department_id: 'd1', department_name: 'Vendas', department_color: '#0f0' })).toEqual({})
  })

  it('Kanban: quadro + coluna; valor só em coluna-meta; trocar quadro zera a coluna; remover pede só o quadro', () => {
    let c = kanbanConfig('create_kanban_card', {})
    expect(validateConfig('create_kanban_card', c)).toMatchObject({ crm_id: { key: 'required' }, crm_column_id: { key: 'required' } })
    c = withBoard(c, { id: 'b1', name: 'Funil' }, true)
    c = withColumn(c, { id: 'c2', name: 'Ganho', conversion_goal: true })
    c = { ...c, value: '{venda.valor}' }
    expect(validateConfig('create_kanban_card', c)).toEqual({})
    const noGoal = withColumn(c, { id: 'c1', name: 'Novo', conversion_goal: false })
    expect(noGoal).not.toHaveProperty('value')
    expect(noGoal).not.toHaveProperty('crm_column_conversion_goal')
    expect(validateConfig('create_kanban_card', { ...noGoal, value: 10 })).toHaveProperty('value', { key: 'goalOnly' })
    expect(withBoard(c, { id: 'b2', name: 'Outro' }, true)).toMatchObject({ crm_id: 'b2', crm_column_id: '' })
    expect(kanbanConfig('remove_kanban_card', c)).toEqual({ crm_id: 'b1', crm_name: 'Funil' })
    expect(validateConfig('remove_kanban_card', kanbanConfig('remove_kanban_card', c))).toEqual({})
  })

  it('Manipulador: conta exige número (ou variável); data de criação aceita variável', () => {
    let c = manipulatorConfig('set_contact_custom_field')
    expect(validateConfig('set_contact_custom_field', c)).toMatchObject({ field_name: { key: 'required' }, value: { key: 'required' } })
    c = withOperation({ ...c, field_name: 'pontos' }, 'add')
    expect(c.value_type).toBe('number')
    expect(validateConfig('set_contact_custom_field', { ...c, value: manipulatorValue('10,5', 'number') })).toEqual({})
    expect(manipulatorValue('10,5', 'number')).toBe(10.5)
    expect(validateConfig('set_contact_custom_field', { ...c, value: 'dez' })).toHaveProperty('value', { key: 'number' })
    expect(validateConfig('set_contact_custom_field', { ...c, value: '{g_bonus}' })).toEqual({})
    expect(validateConfig('set_contact_custom_field', { ...c, value_type: 'text', value: '1' })).toHaveProperty('value_type', { key: 'mathNumber' })
    expect(validateConfig('set_contact_custom_field', { field_name: 'plano', operation: 'set_value', value_type: 'text', value: 'ouro' })).toEqual({})
    expect(validateConfig('set_created_at', manipulatorConfig('set_created_at'))).toHaveProperty('value', { key: 'required' })
    expect(validateConfig('set_created_at', { operation: 'set_value', value: '{data}' })).toEqual({})
  })

  it('Agente de IA: entregar exige o agente; remover não', () => {
    expect(validateConfig('control_ai_agent', { mode: 'activate', agent_id: '' })).toHaveProperty('agent_id', { key: 'required' })
    expect(validateConfig('control_ai_agent', { mode: 'activate', agent_id: 'ag1' })).toEqual({})
    expect(withAgentMode({ mode: 'activate', agent_id: 'ag1' }, 'deactivate')).toEqual({ mode: 'deactivate' })
    expect(validateConfig('control_ai_agent', { mode: 'deactivate' })).toEqual({})
  })
})
