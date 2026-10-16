// @ts-check
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

// Fronteiras de pacote (SPEC 1.4 nº 11). `no-restricted-imports` não se acumula entre blocos:
// o último bloco que casar com o arquivo vence, então cada zona declara a lista completa.
const WA = {
  group: [
    '@whiskeysockets/baileys',
    '@whiskeysockets/baileys/*',
    'baileys',
    'baileys/*',
    'baileys-antiban',
    'baileys-antiban/*',
  ],
  message: 'Baileys só dentro de @crm/wa-engine; o resto fala com o WhatsApp por @crm/wa-port (SPEC 1.4 nº 11).',
}
const ENGINE = {
  group: ['@crm/wa-engine', '@crm/wa-engine/*'],
  message: 'Domínio, shared, API, worker e web usam só @crm/wa-port, nunca @crm/wa-engine (SPEC 1.4 nº 11).',
}
const AI = {
  group: [
    'ai',
    'ai/*',
    '@ai-sdk/*',
    '@anthropic-ai/sdk',
    '@anthropic-ai/sdk/*',
    'openai',
    'openai/*',
    '@google/genai',
    '@google/genai/*',
    '@elevenlabs/*',
    'groq-sdk',
    'groq-sdk/*',
  ],
  message: 'SDKs de IA só nos adapters de packages/ai; use as portas de @crm/ai (SPEC 1.4 nº 11).',
}
const restrict = (...patterns) => ({ 'no-restricted-imports': ['error', { patterns }] })

const AI_ADAPTERS = ['packages/ai/src/aisdk/**', 'packages/ai/src/elevenlabs/**', 'packages/ai/src/groq/**']
const WA_ONLY_PORT = ['packages/core/**', 'packages/shared/**', 'apps/api/**', 'apps/worker/**', 'apps/web/**']

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'spec/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  // Padrão para todo código de produto: nem Baileys nem SDK de IA.
  { files: ['apps/**', 'packages/**'], rules: restrict(WA, AI) },
  // Só o wa-engine importa Baileys (o wa-worker usa o wa-engine).
  { files: ['packages/wa-engine/**'], rules: restrict(AI) },
  // Adapters de IA podem usar os SDKs.
  { files: AI_ADAPTERS, rules: restrict(WA) },
  // Domínio, contratos, API, worker e web: também proibido @crm/wa-engine.
  { files: WA_ONLY_PORT, rules: restrict(WA, ENGINE, AI) },
)
