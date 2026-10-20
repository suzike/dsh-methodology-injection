/**
 * Methodology catalog: loading, validation, alias resolution, conflict lookup and
 * contract rendering.
 *
 * The catalog file is authored by the catalog workstream (`catalog/methods.json`,
 * schemaVersion 1). This module is deliberately strict: a malformed catalog must
 * disable arming with a visible reason, never silently inject garbage.
 */

import { createHash } from 'node:crypto'
import { readJsonFile } from './util.js'
import { asRecord, asString } from './util.js'
import { estimateTokens } from './estimate.js'
import { resolveAssists } from './assists.js'
import type {
  AssistClause,
  CatalogCategory,
  CatalogInject,
  CatalogMethod,
  CatalogView,
  ConflictRule,
  RenderedContract,
} from './types.js'

/**
 * Marker required by the Host contract (T2 requirement 3) and by trace parsing
 * (requirement 9). It is the *only* envelope around the catalog body: no title,
 * no numbering, no markdown decoration, no closing instruction.
 */
function markerLine(methodId: string): string {
  return `[[METHOD:${methodId}]]`
}

export class CatalogError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

/** Key for an unordered conflict pair. */
function pairKey(a: string, b: string): string {
  return [a, b].sort().join('\u0000')
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase()
}

function readStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new CatalogError('catalog-invalid', `${where} must be an array`)
  return value.map((item, index) => {
    const text = asString(item)
    if (text === undefined || text.trim() === '') {
      throw new CatalogError('catalog-invalid', `${where}[${index}] must be a non-empty string`)
    }
    return text
  })
}

function readInject(value: unknown, where: string): CatalogInject {
  const record = asRecord(value)
  if (!record) throw new CatalogError('catalog-invalid', `${where}.inject must be an object`)
  const positioning = asString(record.positioning)
  const skeleton = asString(record.skeleton)
  const lengthDiscipline = asString(record.lengthDiscipline)
  if (!positioning || positioning.trim() === '') {
    throw new CatalogError('catalog-invalid', `${where}.inject.positioning is required`)
  }
  if (!skeleton || skeleton.trim() === '') {
    throw new CatalogError('catalog-invalid', `${where}.inject.skeleton is required`)
  }
  if (!lengthDiscipline || lengthDiscipline.trim() === '') {
    throw new CatalogError('catalog-invalid', `${where}.inject.lengthDiscipline is required`)
  }
  return {
    positioning,
    constraints: readStringArray(record.constraints, `${where}.inject.constraints`),
    skeleton,
    lengthDiscipline,
  }
}

function readMethod(value: unknown, index: number): CatalogMethod {
  const where = `methods[${index}]`
  const record = asRecord(value)
  if (!record) throw new CatalogError('catalog-invalid', `${where} must be an object`)
  const id = asString(record.id)
  if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new CatalogError('catalog-invalid', `${where}.id must be lower-case kebab-case`)
  }
  const zh = asString(record.zh)
  const en = asString(record.en)
  const category = asString(record.category)
  const oneliner = asString(record.oneliner)
  if (!zh || !en || !category || !oneliner) {
    throw new CatalogError('catalog-invalid', `${where} needs zh, en, category and oneliner`)
  }
  const displayRecord = asRecord(record.display)
  if (!displayRecord) throw new CatalogError('catalog-invalid', `${where}.display must be an object`)
  const display = {
    what: asString(displayRecord.what) ?? '',
    whenToUse: asString(displayRecord.whenToUse) ?? '',
    misuse: asString(displayRecord.misuse) ?? '',
    source: asString(displayRecord.source) ?? '',
  }
  return {
    id,
    zh,
    en,
    category,
    aliases: record.aliases === undefined ? [] : readStringArray(record.aliases, `${where}.aliases`),
    oneliner,
    inject: readInject(record.inject, where),
    display,
    conflicts:
      record.conflicts === undefined ? [] : readStringArray(record.conflicts, `${where}.conflicts`),
  }
}

function readCategory(value: unknown, index: number): CatalogCategory {
  const where = `categories[${index}]`
  const record = asRecord(value)
  if (!record) throw new CatalogError('catalog-invalid', `${where} must be an object`)
  const id = asString(record.id)
  const zh = asString(record.zh)
  const en = asString(record.en)
  const intent = asString(record.intent)
  if (!id || !zh || !en || !intent) {
    throw new CatalogError('catalog-invalid', `${where} needs id, zh, en and intent`)
  }
  return { id, zh, en, intent }
}

function readConflictRule(value: unknown, index: number): ConflictRule {
  const where = `conflictRules[${index}]`
  const record = asRecord(value)
  if (!record) throw new CatalogError('catalog-invalid', `${where} must be an object`)
  const pair = readStringArray(record.pair, `${where}.pair`)
  if (pair.length !== 2) throw new CatalogError('catalog-invalid', `${where}.pair needs two ids`)
  const rule = asString(record.rule)
  if (!rule || rule.trim() === '') throw new CatalogError('catalog-invalid', `${where}.rule is required`)
  return {
    pair,
    rule,
    preferred: asString(record.preferred) ?? null,
    preferWhen: asString(record.preferWhen) ?? null,
  }
}

/** Strip trailing spaces per line, normalise newlines, collapse blank runs. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Catalog body without marker/envelope: this is what the budget is calibrated on. */
export function contractBody(method: CatalogMethod): string {
  const inject = method.inject
  return tidy(
    [
      inject.positioning,
      ...inject.constraints,
      inject.skeleton,
      inject.lengthDiscipline,
    ].join('\n'),
  )
}

/**
 * Render the injected contract: marker line, then the catalog body verbatim.
 *
 * Byte-stability matters: the framework dedupes runtime-context snapshots by exact
 * text (dsh-agent-loop/lib/index.js:334-347), so the same method must always render
 * the same bytes. This function is pure and has no timestamp/randomness.
 */
export function renderContract(
  method: CatalogMethod,
  maxTokens: number,
  assists: readonly AssistClause[] = [],
): RenderedContract {
  const body = contractBody(method)
  const assistLines = assists.map((assist) => assist.clause).join('\n')
  const text = assistLines === ''
    ? tidy(`${markerLine(method.id)}\n${body}`)
    : tidy(`${markerLine(method.id)}\n${body}\n${assistLines}`)
  const tokens = estimateTokens(text)
  return {
    methodId: method.id,
    text,
    bodyTokens: estimateTokens(body),
    tokens,
    hash: createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16),
    overBudget: tokens > maxTokens,
  }
}

/** Parsed marker of one injected block. */
export interface ParsedMarker {
  methodId: string
}

/**
 * Two regex objects on purpose: a `/g` regex carries `lastIndex` state, so sharing one
 * between a `test()` and a `matchAll()` silently skips the first marker.
 */
const MARKER_SOURCE = /\[\[METHOD:([a-z0-9][a-z0-9-]*)\]\]/u
const MARKER_GLOBAL = /\[\[METHOD:([a-z0-9][a-z0-9-]*)\]\]/gu

/** Extract every method marker from a message text. */
export function parseMarkers(text: string): ParsedMarker[] {
  const found: ParsedMarker[] = []
  MARKER_GLOBAL.lastIndex = 0
  for (const match of text.matchAll(MARKER_GLOBAL)) {
    const methodId = match[1]
    if (methodId !== undefined) found.push({ methodId })
  }
  return found
}

/** True when the text carries at least one methodology marker. */
export function hasMarker(text: string): boolean {
  return MARKER_SOURCE.test(text)
}

/** Loaded, validated catalog with lookup helpers. */
export class MethodologyCatalog implements CatalogView {
  readonly file: string
  readonly budget: number
  readonly methods: readonly CatalogMethod[]
  readonly categories: readonly CatalogCategory[]
  readonly conflictRules: readonly ConflictRule[]
  readonly loadedAt: string
  private readonly byId = new Map<string, CatalogMethod>()
  private readonly aliasIndex = new Map<string, string>()
  private readonly rules = new Map<string, ConflictRule>()

  private constructor(input: {
    file: string
    budget: number
    methods: CatalogMethod[]
    categories: CatalogCategory[]
    conflictRules: ConflictRule[]
  }) {
    this.file = input.file
    this.budget = input.budget
    this.methods = input.methods
    this.categories = input.categories
    this.conflictRules = input.conflictRules
    this.loadedAt = new Date().toISOString()
    for (const method of input.methods) {
      this.byId.set(method.id, method)
      for (const key of [method.id, method.zh, method.en, ...method.aliases]) {
        const normalized = normalizeLookup(key)
        if (normalized !== '' && !this.aliasIndex.has(normalized)) {
          this.aliasIndex.set(normalized, method.id)
        }
      }
    }
    for (const rule of input.conflictRules) {
      const [a, b] = rule.pair
      if (a !== undefined && b !== undefined) this.rules.set(pairKey(a, b), rule)
    }
  }

  static load(file: string): MethodologyCatalog {
    let parsed: unknown
    try {
      parsed = readJsonFile(file)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CatalogError('catalog-unreadable', `${file}: ${message}`)
    }
    const root = asRecord(parsed)
    if (!root) throw new CatalogError('catalog-invalid', `${file}: root must be an object`)
    if (root.schemaVersion !== 1) {
      throw new CatalogError('catalog-invalid', `${file}: schemaVersion must be 1`)
    }
    const budgetRecord = asRecord(root.injectionBudget)
    const maxTokens = budgetRecord === undefined ? 150 : Number(budgetRecord.maxTokens)
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
      throw new CatalogError('catalog-invalid', `${file}: injectionBudget.maxTokens must be > 0`)
    }
    if (!Array.isArray(root.methods) || root.methods.length === 0) {
      throw new CatalogError('catalog-invalid', `${file}: methods must be a non-empty array`)
    }
    const methods = root.methods.map(readMethod)
    const seen = new Set<string>()
    for (const method of methods) {
      if (seen.has(method.id)) {
        throw new CatalogError('catalog-invalid', `${file}: duplicate method id ${method.id}`)
      }
      seen.add(method.id)
    }
    const categories = Array.isArray(root.categories)
      ? root.categories.map(readCategory)
      : []
    const conflictRules = Array.isArray(root.conflictRules)
      ? root.conflictRules.map(readConflictRule)
      : []
    return new MethodologyCatalog({ file, budget: maxTokens, methods, categories, conflictRules })
  }

  has(methodId: string): boolean {
    return this.byId.has(methodId)
  }

  get(methodId: string): CatalogMethod | undefined {
    return this.byId.get(methodId)
  }

  /** Resolve by id, alias, Chinese name or English name (case-insensitive). */
  resolve(input: string): CatalogMethod | undefined {
    const id = this.aliasIndex.get(normalizeLookup(input))
    return id === undefined ? undefined : this.byId.get(id)
  }

  conflict(a: string, b: string): ConflictRule | undefined {
    if (a === b) return undefined
    const direct = this.rules.get(pairKey(a, b))
    if (direct) return direct
    const left = this.byId.get(a)
    const right = this.byId.get(b)
    const declared = left?.conflicts?.includes(b) === true || right?.conflicts?.includes(a) === true
    if (!declared) return undefined
    return { pair: [a, b], rule: '目录声明为互斥，不可同轮并置。', preferred: null, preferWhen: null }
  }

  render(methodId: string, assistIds: readonly string[] = []): RenderedContract | undefined {
    const method = this.byId.get(methodId)
    if (method === undefined) return undefined
    const assists = resolveAssists(assistIds) ?? []
    return renderContract(method, this.budget, assists)
  }

  /** Payload for the client picker: no injection body, includes budget estimates. */
  publicCatalog(): Record<string, unknown> {
    const categoryById = new Map(this.categories.map((category) => [category.id, category]))
    return {
      schemaVersion: 1,
      budget: this.budget,
      loadedAt: this.loadedAt,
      categories: this.categories,
      methods: this.methods.map((method) => {
        const rendered = renderContract(method, this.budget)
        return {
          id: method.id,
          zh: method.zh,
          en: method.en,
          category: method.category,
          categoryLabel: categoryById.get(method.category)?.zh ?? method.category,
          aliases: method.aliases,
          oneliner: method.oneliner,
          display: method.display,
          conflicts: method.conflicts ?? [],
          tokens: rendered.tokens,
          bodyTokens: rendered.bodyTokens,
          contractHash: rendered.hash,
        }
      }),
      conflictRules: this.conflictRules,
    }
  }

  stats(): Record<string, unknown> {
    const tokenStats = this.methods.map((method) => ({
      methodId: method.id,
      tokens: renderContract(method, this.budget).tokens,
    }))
    const values = tokenStats.map((item) => item.tokens)
    return {
      file: this.file,
      loadedAt: this.loadedAt,
      schemaVersion: 1,
      methods: this.methods.length,
      categories: this.categories.length,
      conflictRules: this.conflictRules.length,
      budget: this.budget,
      tokens: {
        min: values.length === 0 ? 0 : Math.min(...values),
        max: values.length === 0 ? 0 : Math.max(...values),
        overBudget: tokenStats.filter((item) => item.tokens > this.budget).map((item) => item.methodId),
      },
    }
  }
}
