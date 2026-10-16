#!/usr/bin/env node
// routes:gen (SPEC 2.4): regenera src/routeTree.gen.ts com o mesmo gerador e a mesma config do plugin do Vite.
// Use em conflito de merge do routeTree.gen.ts em vez de mesclar à mão.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Generator, getConfig } from '@tanstack/router-generator'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const config = getConfig({ target: 'react', autoCodeSplitting: true, quoteStyle: 'single', semicolons: false }, root)
await new Generator({ config, root }).run()
process.stdout.write(`routeTree.gen.ts atualizado (${config.generatedRouteTree})\n`)
