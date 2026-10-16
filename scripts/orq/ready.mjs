// uso: node ready.mjs "<merged csv>" "<in-progress csv>" → tarefas com todas as deps em merged, por altura
const [merged, busy] = process.argv.slice(2).map((s) => new Set(s.split(',').filter(Boolean)))
const m = await import(new URL('../../spec/verify/tasks.mjs', import.meta.url))
const L = Array.isArray(m.TASKS) ? m.TASKS : Object.values(m.TASKS)
const by = new Map(L.map((t) => [t.id, t])); const memo = new Map()
const h = (id) => memo.get(id) ?? (memo.set(id, 1 + Math.max(0, ...L.filter((t) => (t.deps ?? []).includes(id)).map((t) => h(t.id)))), memo.get(id))
const ready = L.filter((t) => !merged.has(t.id) && !busy.has(t.id) && (t.deps ?? []).every((d) => merged.has(d)) && !(t.minWave > 0 && false))
ready.sort((a, b) => h(b.id) - h(a.id)).forEach((t) => console.log(`${t.id}[h${h(t.id)}] ${t.title}`))
