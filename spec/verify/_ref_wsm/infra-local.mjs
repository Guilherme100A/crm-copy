#!/usr/bin/env node
// Sobe Postgres e Redis nativos (spec/INFRA.md) se ainda não estiverem respondendo.
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'

const TOOLS = process.env.WSM_TOOLS ?? 'C:/Users/green/tools'
const REDIS_DIR = join(TOOLS, 'redis', 'Redis-8.10.2-Windows-x64-msys2')

export function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((res) => {
    const s = createConnection({ port, host })
    const done = (ok) => { s.destroy(); res(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function ensureInfra() {
  if (!(await portOpen(5432))) {
    spawnSync(join(TOOLS, 'pg/pgsql/bin/pg_ctl.exe'), ['-D', join(TOOLS, 'pgdata'), '-l', join(TOOLS, 'pg.log'), '-w', 'start'], { stdio: 'inherit' })
  }
  if (!(await portOpen(6379))) {
    spawn(join(REDIS_DIR, 'redis-server.exe'), ['--port', '6379'], { cwd: REDIS_DIR, detached: true, stdio: 'ignore' }).unref()
    for (let i = 0; i < 20 && !(await portOpen(6379)); i++) await sleep(250)
  }
  return { postgres: await portOpen(5432), redis: await portOpen(6379) }
}

if (process.argv[1] && process.argv[1].endsWith('infra-local.mjs')) {
  const st = await ensureInfra()
  console.log(JSON.stringify(st))
  process.exit(st.postgres && st.redis ? 0 : 1)
}
