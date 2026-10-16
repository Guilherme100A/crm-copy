// AC-T10-03: migrate converte `menu` legado em `interactive_menu` com handles `option:<id>` estáveis.
import { beforeAll, describe, expect, it } from 'vitest'
import { clone, edge, flow, fmt, loadFlows, menuConfig, msg, node, type Def } from './support'

let F: any
beforeAll(async () => {
  F = await loadFlows()
})

/** Fluxo legado: menu (send_option_list) com handles do formato antigo (option-<i>, menu-other, timeout). */
function legacyFlow(options: Array<{ id?: string; title: string }>): Def {
  return flow(
    [
      node('start', 'start'),
      msg('m1'),
      node('legacy', 'menu', [
        ['send_option_list', menuConfig(options)],
        ['save_user_data', { field_name: 'escolha', save_empty: true }],
      ]),
      msg('o1'),
      msg('o2'),
      msg('other'),
      msg('tmo'),
    ],
    [
      edge('start', 'source', 'm1', 'e1'),
      edge('m1', 'source', 'legacy', 'e2'),
      edge('legacy', 'option-0', 'o1', 'e_opt0'),
      edge('legacy', 'option-1', 'o2', 'e_opt1'),
      edge('legacy', 'menu-other', 'other', 'e_other'),
      edge('legacy', 'timeout', 'tmo', 'e_tmo'),
    ],
  )
}

const edgeById = (def: Def, id: string) => def.edges.find((e) => e.id === id)!
const nodeById = (def: Def, id: string) => def.nodes.find((n) => n.id === id)!

describe('migrate: menu legado → interactive_menu', () => {
  it('AC-T10-03 converte o nó e a ação, preservando a config e as opções', () => {
    const legacy = legacyFlow([
      { id: 'opt_x', title: 'Comprar' },
      { id: 'opt_y', title: 'Suporte' },
    ])
    const out: Def = F.migrate(clone(legacy))
    const n = nodeById(out, 'legacy')
    expect(n.type).toBe('interactive_menu')
    const types = n.actions.map((a) => a.type)
    expect(types).toContain('send_interactive_menu')
    expect(types).not.toContain('send_option_list')
    const menu = n.actions.find((a) => a.type === 'send_interactive_menu')!
    expect((menu.config as any).message).toBe('Escolha uma opção')
    expect((menu.config as any).options.map((o: any) => [o.id, o.title])).toEqual([
      ['opt_x', 'Comprar'],
      ['opt_y', 'Suporte'],
    ])
  })

  it('AC-T10-03 handles legados viram option:<id da opção>, other e timeout; arestas preservadas', () => {
    const out: Def = F.migrate(legacyFlow([{ id: 'opt_x', title: 'Comprar' }, { id: 'opt_y', title: 'Suporte' }]))
    expect(edgeById(out, 'e_opt0')).toEqual({ id: 'e_opt0', from: 'legacy', handle: 'option:opt_x', to: 'o1' })
    expect(edgeById(out, 'e_opt1')).toEqual({ id: 'e_opt1', from: 'legacy', handle: 'option:opt_y', to: 'o2' })
    expect(edgeById(out, 'e_other')).toEqual({ id: 'e_other', from: 'legacy', handle: 'other', to: 'other' })
    expect(edgeById(out, 'e_tmo')).toEqual({ id: 'e_tmo', from: 'legacy', handle: 'timeout', to: 'tmo' })
    expect(out.edges.map((e) => e.id).sort()).toEqual(['e1', 'e2', 'e_opt0', 'e_opt1', 'e_other', 'e_tmo'])
    const errors = F.validate(out)
    expect(errors, fmt(errors)).toEqual([])
  })

  it('AC-T10-03 reordenar as opções não muda os handles (dependem do id, não da posição)', () => {
    const out: Def = F.migrate(legacyFlow([{ id: 'opt_x', title: 'Comprar' }, { id: 'opt_y', title: 'Suporte' }]))
    const handlesBefore = [...F.nodeHandles(nodeById(out, 'legacy'))].sort()
    expect(handlesBefore).toEqual(expect.arrayContaining(['option:opt_x', 'option:opt_y', 'other', 'timeout']))

    const reordered = clone(out)
    const cfg = nodeById(reordered, 'legacy').actions.find((a) => a.type === 'send_interactive_menu')!.config as any
    cfg.options.reverse()
    expect([...F.nodeHandles(nodeById(reordered, 'legacy'))].sort()).toEqual(handlesBefore)
    // as arestas continuam apontando para os mesmos destinos e o fluxo segue válido
    expect(edgeById(reordered, 'e_opt0').handle).toBe('option:opt_x')
    expect(edgeById(reordered, 'e_opt0').to).toBe('o1')
    const errors = F.validate(reordered)
    expect(errors, fmt(errors)).toEqual([])
    // migrar de novo não mexe em nada
    expect(F.migrate(clone(reordered))).toStrictEqual(reordered)
  })

  it('AC-T10-03 opções legadas sem id recebem id estável e os handles seguem esse id ao reordenar', () => {
    const out: Def = F.migrate(legacyFlow([{ title: 'Comprar' }, { title: 'Suporte' }]))
    const cfg = nodeById(out, 'legacy').actions.find((a) => a.type === 'send_interactive_menu')!.config as any
    const ids = cfg.options.map((o: any) => o.id)
    for (const id of ids) expect(typeof id === 'string' && id.length > 0, `id inválido: ${String(id)}`).toBe(true)
    expect(new Set(ids).size).toBe(2)
    expect(edgeById(out, 'e_opt0').handle).toBe(`option:${ids[0]}`)
    expect(edgeById(out, 'e_opt1').handle).toBe(`option:${ids[1]}`)

    // migração determinística: mesmo legado → mesmos ids
    const again: Def = F.migrate(legacyFlow([{ title: 'Comprar' }, { title: 'Suporte' }]))
    expect(again).toStrictEqual(out)

    const reordered = clone(out)
    const rcfg = nodeById(reordered, 'legacy').actions.find((a) => a.type === 'send_interactive_menu')!.config as any
    rcfg.options.reverse()
    const rmig: Def = F.migrate(clone(reordered))
    expect(rmig.edges).toStrictEqual(out.edges)
    expect([...F.nodeHandles(nodeById(rmig, 'legacy'))].sort()).toEqual([...F.nodeHandles(nodeById(out, 'legacy'))].sort())
    expect(F.validate(rmig)).toEqual([])
  })

  it('AC-T10-03 migrate é idempotente e não altera fluxo já no formato novo', async () => {
    const legacy = legacyFlow([{ id: 'opt_x', title: 'Comprar' }, { id: 'opt_y', title: 'Suporte' }])
    const once = F.migrate(clone(legacy))
    expect(F.migrate(clone(once))).toStrictEqual(once)
    const { sampleFlow } = await import('./support')
    expect(F.migrate(sampleFlow())).toStrictEqual(sampleFlow())
  })
})
