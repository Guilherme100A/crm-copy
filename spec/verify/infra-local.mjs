#!/usr/bin/env node
// Sobe Postgres e Redis nativos (spec/INFRA.md) se ainda não estiverem respondendo,
// e garante que o banco `crm` exista. Idempotente.
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { join } from 'node:path'

const TOOLS = process.env.CRM_TOOLS ?? process.env.WSM_TOOLS ?? 'C:/Users/green/tools'
const PG_BIN = join(TOOLS, 'pg/pgsql/bin')
const REDIS_DIR = join(TOOLS, 'redis', 'Redis-8.10.2-Windows-x64-msys2')
const DB_NAME = process.env.CRM_DB_NAME ?? 'crm'

export function portOpen(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((res) => {
    const s = createConnection({ port, host })
    const done = (ok) => {
      s.destroy()
      res(ok)
    }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ensureDatabase() {
  const env = { ...process.env, PGPASSWORD: process.env.PGPASSWORD ?? 'wsm' }
  const psql = join(PG_BIN, 'psql.exe')
  const q = spawnSync(psql, ['-h', '127.0.0.1', '-U', 'wsm', '-d', 'postgres', '-tAc', `select 1 from pg_database where datname='${DB_NAME}'`], { env, encoding: 'utf8' })
  if (q.status !== 0) return false
  if (q.stdout.trim() === '1') return true
  const c = spawnSync(psql, ['-h', '127.0.0.1', '-U', 'wsm', '-d', 'postgres', '-c', `create database "${DB_NAME}"`], { env, encoding: 'utf8' })
  return c.status === 0
}

export async function ensureInfra() {
  if (!(await portOpen(5432))) {
    spawnSync(join(PG_BIN, 'pg_ctl.exe'), ['-D', join(TOOLS, 'pgdata'), '-l', join(TOOLS, 'pg.log'), '-w', 'start'], { stdio: 'inherit' })
  }
  if (!(await portOpen(6379))) {
    spawn(join(REDIS_DIR, 'redis-server.exe'), ['--port', '6379'], { cwd: REDIS_DIR, detached: true, stdio: 'ignore' }).unref()
    for (let i = 0; i < 20 && !(await portOpen(6379)); i++) await sleep(250)
  }
  const postgres = await portOpen(5432)
  return { postgres, redis: await portOpen(6379), database: postgres ? ensureDatabase() : false }
}

if (process.argv[1] && process.argv[1].endsWith('infra-local.mjs')) {
  const st = await ensureInfra()
  console.log(JSON.stringify(st))
  process.exit(st.postgres && st.redis && st.database ? 0 : 1)
}
