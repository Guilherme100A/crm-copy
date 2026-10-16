// AC-T10-04: nó `unsupported` → validate dá `unsupported_node` e a ativação não é permitida.
import { beforeAll, describe, expect, it } from 'vitest'
import { REF_GATEWAY, clone, edge, fmt, loadFlows, msg, node, sampleFlow, type Def } from './support'

let F: any
beforeAll(async () => {
  F = await loadFlows()
})

const OUT_OF_SCOPE = ['kieai_integration', REF_GATEWAY, 'make_call', 'template_meta'] as const

/** sampleFlow com um nó extra depois de `ma` (alcançável, conectado a uma mensagem). */
function withExtra(extra: ReturnType<typeof node>): Def {
  const def = sampleFlow()
  def.nodes.push(extra, msg('after'))
  def.edges.push(edge('ma', 'source', extra.id), edge(extra.id, 'success', 'after'))
  return def
}

describe('nós fora de escopo', () => {
  it('AC-T10-04 catálogo: os 4 tipos fora de escopo só existem como unsupported; payment e approved_sale são suportados', () => {
    expect([...F.UNSUPPORTED_NODE_TYPES].sort()).toEqual([...OUT_OF_SCOPE].sort())
    for (const t of OUT_OF_SCOPE) expect(F.NODE_TYPES, `${t} não pode ser suportado`).not.toContain(t)
    expect(F.NODE_TYPES).toContain('payment')
    expect(F.NODE_TYPES).toContain('approved_sale')
  })

  it('AC-T10-04 nó type "unsupported" → unsupported_node com o nodeId e canActivate falso', () => {
    const def = withExtra(node('kie', 'unsupported', [['kieai_generate', { generation_type: 'image', prompt: 'x' }]], { original_type: 'kieai_integration' }))
    const errors = F.validate(def)
    expect(errors.some((e: any) => e.code === 'unsupported_node' && e.nodeId === 'kie'), fmt(errors)).toBe(true)
    expect(F.canActivate(def)).toBe(false)
    expect(F.canActivate(sampleFlow())).toBe(true)
  })

  for (const t of OUT_OF_SCOPE) {
    it(`AC-T10-04 migrate transforma "${t}" em unsupported (original_type preservado), validate acusa e a ativação é negada`, () => {
      const action: [string, Record<string, unknown>] =
        t === 'kieai_integration' ? ['kieai_generate', {}] : t === 'make_call' ? ['make_call', { call_duration: 8 }] : t === 'template_meta' ? ['send_template', {}] : ['create_payment_charge', { gateway: REF_GATEWAY, amount: '10,00' }]
      const raw = withExtra(node('x', t, [action]))
      // o tipo cru também precisa ser barrado pelo validate
      const rawErrors = F.validate(clone(raw))
      expect(rawErrors.some((e: any) => e.code === 'unsupported_node' && e.nodeId === 'x'), fmt(rawErrors)).toBe(true)
      expect(F.canActivate(clone(raw))).toBe(false)

      const out: Def = F.migrate(clone(raw))
      const x = out.nodes.find((n) => n.id === 'x')!
      expect(x.type).toBe('unsupported')
      expect(x.original_type).toBe(t)
      const errors = F.validate(out)
      expect(errors.some((e: any) => e.code === 'unsupported_node' && e.nodeId === 'x'), fmt(errors)).toBe(true)
      expect(F.canActivate(out)).toBe(false)
    })
  }

  it('AC-T10-04 removido o nó unsupported o fluxo volta a ser ativável', () => {
    const def = withExtra(node('kie', 'unsupported', [], { original_type: 'kieai_integration' }))
    expect(F.canActivate(def)).toBe(false)
    def.nodes = def.nodes.filter((n) => n.id !== 'kie' && n.id !== 'after')
    def.edges = def.edges.filter((e) => e.from !== 'kie' && e.to !== 'kie')
    expect(F.validate(def)).toEqual([])
    expect(F.canActivate(def)).toBe(true)
  })

  it('AC-T10-04 ações fora de escopo não são suportadas', () => {
    for (const a of ['kieai_generate', 'make_call', 'send_template']) expect(F.SUPPORTED_ACTION_TYPES).not.toContain(a)
  })
})
