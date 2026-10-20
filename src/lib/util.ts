/** Filesystem and path helpers for the Host half. */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** DSH home directory, honouring the same override the harness itself uses. */
export function dshHome(): string {
  const override = process.env.DSH_HOME
  if (typeof override === 'string' && override.trim() !== '') return resolve(override)
  return join(homedir(), '.dsh')
}

/** Directory this plugin owns for durable state. */
export function stateDirectory(): string {
  return join(dshHome(), 'dsh-methodology-injection')
}

/** Single state file: session arms + content-free injection history. */
export function stateFilePath(): string {
  return join(stateDirectory(), 'state.json')
}

/** Walk up from a module location until a `package.json` is found. */
export function findPackageRoot(from: string): string {
  let dir = resolve(from)
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return resolve(from)
}

/** Package root of this plugin (`lib/lib/util.js` -> plugin root). */
export const packageRoot: string = findPackageRoot(dirname(fileURLToPath(import.meta.url)))

/**
 * Catalog locations, in preference order.
 *
 * `tsc` does not copy JSON, so `scripts/copy-catalog.mjs` also places a copy at
 * `lib/catalog/methods.json`; both layouts are accepted. The env override exists
 * for tests and for a user-supplied catalog.
 */
export function catalogCandidates(): string[] {
  const override = process.env.DSH_METHODOLOGY_CATALOG
  const list: string[] = []
  if (typeof override === 'string' && override.trim() !== '') list.push(resolve(override))
  list.push(join(packageRoot, 'catalog', 'methods.json'))
  list.push(join(packageRoot, 'lib', 'catalog', 'methods.json'))
  return list
}

/** First existing catalog path, or the canonical one when none exists yet. */
export function catalogPath(): string {
  const candidates = catalogCandidates()
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return candidates[0] ?? join(packageRoot, 'catalog', 'methods.json')
}

export function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true })
}

/** Read a UTF-8 JSON file, refusing anything above `maxBytes`. */
export function readJsonFile(path: string, maxBytes = 4 * 1024 * 1024): unknown {
  const raw = readFileSync(path, 'utf8')
  if (raw.length > maxBytes) throw new Error(`file too large: ${path} (${raw.length} bytes)`)
  return JSON.parse(raw) as unknown
}

/** Write JSON atomically: temp file in the same directory, then rename. */
export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDirectory(dirname(path))
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Safe accessor for an unknown value as a record. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Safe accessor for an unknown value as a string. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
