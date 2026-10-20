#!/usr/bin/env node
/**
 * Ship the catalog inside `lib/`.
 *
 * `tsc` only emits JavaScript, so without this step the packaged plugin would lose
 * `catalog/methods.json` (it lives outside `src/`). The Host resolves the catalog in
 * this order (see src/lib/util.ts):
 *
 *   1. $DSH_METHODOLOGY_CATALOG          (developer override)
 *   2. <packageRoot>/catalog/methods.json (development checkout)
 *   3. <packageRoot>/lib/catalog/methods.json (packaged copy written by this script)
 *
 * The copy is verified byte-for-byte so a stale or truncated catalog cannot ship.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const source = join(root, 'catalog', 'methods.json')
const target = join(root, 'lib', 'catalog', 'methods.json')

function fail(message) {
  console.error(`[copy-catalog] ${message}`)
  process.exit(1)
}

if (!existsSync(source)) fail(`missing ${source}`)

let parsed
try {
  parsed = JSON.parse(readFileSync(source, 'utf8'))
} catch (error) {
  fail(`catalog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
}

if (parsed?.schemaVersion !== 1) fail(`expected schemaVersion 1, got ${String(parsed?.schemaVersion)}`)
if (!Array.isArray(parsed?.methods) || parsed.methods.length === 0) fail('catalog has no methods')

mkdirSync(dirname(target), { recursive: true })
copyFileSync(source, target)

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const [want, got] = [hash(source), hash(target)]
if (want !== got) fail(`copy mismatch: ${want} != ${got}`)

const bytes = statSync(target).size
const budget = parsed?.injectionBudget?.maxTokens ?? 150
console.log(
  `[copy-catalog] ${parsed.methods.length} methods, ${bytes} bytes, budget ${budget} tokens -> lib/catalog/methods.json`,
)
console.log(`[copy-catalog] sha256 ${got}`)
