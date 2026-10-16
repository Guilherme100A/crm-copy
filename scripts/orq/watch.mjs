// Vigia da orquestração: a cada INTERVAL s lê a tela de cada agente (maestri check) e SAI (exit 0)
// com um relatório quando há algo que exige o Orquestrador. Rodar em background; re-armar após agir.
// Agentes = quem tem papel Operario/Tester no `maestri list` (pares fixos ou sob demanda).
// A cada ciclo grava .orq-tmp/heartbeat: se ele envelhecer, o orquestrador parou de atender
// (orq-check.ps1 stalled → notificação ao usuário).
// uso: node scripts/orq/watch.mjs [intervalSegundos=60]
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
const TMP = new URL('../../.orq-tmp/', import.meta.url)
mkdirSync(TMP, { recursive: true })
const HOLD = new URL('hold.txt', TMP) // nomes segurados de propósito pelo Orquestrador (espaço ou linha)
const held = () => (existsSync(HOLD) ? readFileSync(HOLD, 'utf8').split(/\s+/).filter(Boolean) : [])

const INTERVAL = Number(process.argv[2] ?? 60) * 1000
const IDLE_MS = 10 * 60_000
const VERIFY_MS = 40 * 60_000
const idleSince = new Map()
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 30_000, shell: true })

function agents() {
  try {
    return [...sh('maestri', ['list']).matchAll(/^\s*- name: "([^"]+)", role: "([^"]*(?:Operario|Tester)[^"]*)"/gm)].map((m) => ({ name: m[1], role: m[2] }))
  } catch { return null }
}

function screen(name) {
  try { return sh('maestri', ['check', `"${name}"`]) }
  catch (e) { return `__CHECK_FAILED__ ${e.message}` }
}

function classify(text) {
  const tail = text.split('\n').slice(-25).join('\n')
  if (text.startsWith('__CHECK_FAILED__')) return { state: 'error', why: 'maestri check falhou' }
  // sessão do agente morreu: o terminal voltou ao prompt do PowerShell (NÃO mandar prompts para ele)
  if (/^PS [A-Z]:\\[^\n]*>\s*$/m.test(tail.split('\n').slice(-4).join('\n'))) return { state: 'error', why: 'SESSÃO CAÍDA (prompt do PowerShell) — reiniciar com recruit --replace' }
  if (/trust this folder|MCP servers found|Do you want to (proceed|make|create|allow)|❯ 1\. Yes/i.test(tail)) return { state: 'dialog', why: 'diálogo aguardando resposta' }
  if (/API Error|rate_limit_error|usage limit reached|limit reached\s*·|Overloaded|exceeded your (current )?quota|credit balance is too low/i.test(tail)) return { state: 'error', why: 'erro de API/limite na tela' }
  const last12 = tail.split('\n').slice(-12).join('\n')
  // verify/testes em background ("1 shell still running") contam como trabalho
  const working = /shells? still running/.test(last12) || (/…\s*\(\d+[smh]|esc to interrupt|current work\b/.test(tail) && !/· done \d{1,2}:\d{2}/.test(last12))
  // só a caixa de entrada (linha ❯ logo antes do último separador ───); mensagens antigas no histórico também começam com ❯
  const lines = tail.split('\n'), sep = lines.findLastIndex((l) => /^─{10,}/.test(l))
  const input = sep > 0 ? (lines[sep - 1].match(/^❯ (.+)$/)?.[1] ?? '').trim() : ''
  const pending = input && !/^Try "/.test(input) ? input : ''
  return { state: working ? 'working' : 'idle', pending }
}

// verifies rodando há mais de VERIFY_MS (travados ou máquina sem memória)
function longVerifies() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('verify-age.ps1', import.meta.url))], { encoding: 'utf8', timeout: 30_000 })
    return out.trim().split('\n').filter(Boolean).map((l) => l.trim().split(' ')).filter(([, m]) => Number(m) * 60_000 > VERIFY_MS).map(([t, m]) => `verify da ${t} rodando há ${m} min`)
  } catch { return [] }
}

let downCycles = 0
for (;;) {
  writeFileSync(new URL('heartbeat', TMP), new Date().toISOString())
  const now = Date.now(), alerts = [], snapshot = []
  const team = agents()
  if (team === null) alerts.push('maestri list falhou')
  for (const { name } of team ?? []) {
    const c = classify(screen(name))
    if (c.state === 'idle') { if (!idleSince.has(name)) idleSince.set(name, now) } else idleSince.delete(name)
    const idleMin = idleSince.has(name) ? Math.round((now - idleSince.get(name)) / 60_000) : 0
    snapshot.push(`${name}:${c.state}${idleMin ? `(${idleMin}min)` : ''}`)
    if (c.state === 'dialog' || c.state === 'error') alerts.push(`${name}: ${c.why}`)
    if (c.state === 'idle' && c.pending && now - idleSince.get(name) > 2 * 60_000) alerts.push(`${name}: texto preso na entrada: "${c.pending.slice(0, 80)}"`)
    if (c.state === 'idle' && now - idleSince.get(name) >= IDLE_MS && !held().includes(name)) alerts.push(`${name} parado há ${idleMin} min: relatório perdido ou esperando o Orquestrador`)
  }
  alerts.push(...longVerifies())
  // Maestri inteiro sem resposta (todos falharam): só alerta após 3 ciclos seguidos.
  const allFailed = snapshot.length > 0 && snapshot.every((s) => s.includes(':error'))
  downCycles = allFailed ? downCycles + 1 : 0
  if (allFailed && downCycles < 3) { await new Promise((r) => setTimeout(r, INTERVAL)); continue }
  if (alerts.length) {
    console.log(`ALERTA ${new Date().toISOString()}\n- ${alerts.join('\n- ')}\nEstado: ${snapshot.join(' ')}`)
    process.exit(0)
  }
  await new Promise((r) => setTimeout(r, INTERVAL))
}
