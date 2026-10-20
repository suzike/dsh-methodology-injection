/**
 * Host half of dsh-methodology-injection.
 *
 * Every API call here is backed by a PROBE.md finding; do not "improve" them from
 * memory:
 *  - `systemPrompt.context(...)` entries become `runtime-context` messages that the
 *    framework appends to the step messages itself (PROBE.md §1.3).
 *  - Inside `text(assembly)`, `assembly.agent.id` is the real SessionId (§1.1 §1.2).
 *  - `webServer.register({ kind: 'exact', path, handler })` is the routing API (§1.11).
 *  - `agent/request` can never inject messages; it is not used anywhere here (§1.5).
 *
 * Three layers, in order of authority:
 *   catalog  -> what a method's contract text is (content, versioned, validated)
 *   store    -> what a session has armed, and the content-free trace
 *   inject   -> how the text reaches the model (context first, pre-step as safety net)
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MethodologyCatalog } from './lib/catalog.js'
import { buildRoutes, methodAllowed } from './lib/http.js'
import type { HttpRuntime, Route } from './lib/http.js'
import {
  CONTEXT_ORDER,
  registerContext,
  registerPreStep,
  registerSessionEvents,
  registerTurnBoundary,
} from './lib/inject.js'
import type { InjectionRuntime } from './lib/inject.js'
import { MethodologyStore } from './lib/store.js'
import { catalogPath, ensureDirectory, packageRoot, stateDirectory, stateFilePath } from './lib/util.js'

export const name = 'dsh-methodology-injection'
export const inject = ['systemPrompt', 'webServer']

/** Read once from package.json so the reported version cannot drift. */
const VERSION: string = (() => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const version = (parsed as { version?: unknown }).version
      if (typeof version === 'string') return version
    }
  } catch {
    // fall through
  }
  return '0.0.0'
})()

/**
 * Lazily (re)loads the catalog.
 *
 * A bad or missing catalog must degrade the plugin, not crash the Host, and a fixed
 * catalog should be picked up without restarting: we retry at most once every 5 s.
 */
class CatalogSlot {
  private current: MethodologyCatalog | undefined
  private failure: string | undefined
  private attemptedAt = 0
  private readonly file: string | undefined

  constructor(file: string | undefined) {
    this.file = file
  }

  get(): MethodologyCatalog | undefined {
    const now = Date.now()
    if (this.current !== undefined && this.failure === undefined) return this.current
    if (now - this.attemptedAt < 5000) return this.current
    this.attemptedAt = now
    if (this.file === undefined) {
      this.failure = '找不到 catalog/methods.json（随包副本或开发目录均不存在）'
      return this.current
    }
    try {
      this.current = MethodologyCatalog.load(this.file)
      this.failure = undefined
    } catch (error) {
      this.failure = error instanceof Error ? error.message : String(error)
    }
    return this.current
  }

  error(): string | undefined {
    return this.failure
  }

  location(): string {
    return this.file ?? '(missing)'
  }
}

/** Minimal structural view of the Cordis context we depend on. */
interface PluginCtx {
  effect(execute: () => (() => void) | void, label?: string): unknown
  on(event: string, listener: (...args: unknown[]) => unknown): unknown
  systemPrompt: { context(entry: unknown): unknown }
  webServer: { register(route: { kind: 'exact'; path: string; handler: (req: unknown, res: unknown) => unknown }): unknown }
}

export function apply(ctx: PluginCtx): void {
  ensureDirectory(stateDirectory())
  const store = new MethodologyStore({ file: stateFilePath() })
  const slot = new CatalogSlot(catalogPath())

  const runtime: InjectionRuntime & HttpRuntime = {
    store,
    catalog: () => slot.get(),
    catalogFailure: () => slot.error(),
    catalogLocation: () => slot.location(),
    version: VERSION,
    contextOrder: CONTEXT_ORDER,
    fail(sessionId, turn, step, stage, note) {
      try {
        store.noteFailure(sessionId, { turn, step, stage, note })
      } catch {
        // diagnostics must never break a turn
      }
    },
  }

  // Warm the catalog once so /diagnostics is truthful from the first request.
  slot.get()

  // 1) Primary channel: per-session runtime context.
  ctx.effect(() => registerContext(ctx, runtime), 'methodology-injection: contract context')

  // 2) Safety net + content-free trace of what actually reached the session.
  ctx.effect(() => registerPreStep(ctx, runtime), 'methodology-injection: pre-step fallback')

  ctx.effect(() => registerTurnBoundary(ctx, runtime), 'methodology-injection: turn boundary')

  ctx.effect(() => registerSessionEvents(ctx, runtime), 'methodology-injection: session events')

  // 3) HTTP routes (one exact route per endpoint, per PROBE §1.11).
  const routes: Route[] = buildRoutes(runtime)
  for (const route of routes) {
    ctx.effect(() => {
      ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: (req: unknown, res: unknown) => {
          const request = req as { method?: string }
          if (!methodAllowed(route, request as never)) {
            const response = res as {
              writeHead(status: number, headers: Record<string, string>): void
              end(body: string): void
            }
            const body = JSON.stringify({
              error: { code: 'method-not-allowed', message: `${route.path} 只接受 ${route.methods.join('/')}` },
            })
            response.writeHead(405, {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'no-store',
              allow: route.methods.join(', '),
              'content-length': String(Buffer.byteLength(body)),
            })
            response.end(body)
            return
          }
          return route.handler(req as never, res as never)
        },
      })
    }, `methodology-injection: ${route.path}`)
  }
}
