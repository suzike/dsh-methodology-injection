/**
 * tsdown preset for this plugin's browser half.
 *
 * One artifact: `lib/client.js`. It is NOT a normal ES module — the web shell
 * fetches plugin bundles outside its module graph and evaluates them through
 * `window.__ModuleLoader__.load({ id, factory })`, so the bundle is CJS wrapped
 * in that closure: `require` is the loader's frozen module table (React and the
 * cordis DI entities), and everything else is inlined so no specifier the table
 * cannot answer ever reaches it.
 *
 * The host half stays on `tsc` (`tsconfig.build.json`) — this file configures
 * the browser bundle only. Adapted from the same author's
 * `shared/tsdown.client.ts` in `Dsh-freestyle-theme`, whose comments record the
 * reading of the shell's loader; the CSS-modules branch is dropped because this
 * plugin injects its handful of rules from a TypeScript string and imports no
 * `.module.css`.
 *
 * @module dsh-methodology-injection/shared/tsdown.client
 */

import { dirname, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { PLATFORM_MODULES } from './web-platform.ts'

/**
 * Wire/type layers a client bundle may inline: browser-safe contract surfaces
 * with no runtime identity to share (no Symbol / instanceof / singleton state).
 */
export const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|session|llm|tools|brand)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** Externals resolved from the loader module table. */
export const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES]

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Rebase a physical lib-relative source onto a browser URL that mirrors the repo directories. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('src/') ? `../${repositoryPath}` : source
}

/**
 * Build the browser bundle config for this plugin.
 * @param id - plugin id (package name), stamped into the `__ModuleLoader__.load` handoff.
 * @param entry - the client entry, e.g. `src/client/index.tsx`.
 * @returns the tsdown config for `lib/client.js`.
 */
export function clientBundle(id: string, entry: string): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Browser bundles inline node-idiom deps that probe `process.env.NODE_ENV`;
    // a CJS output cannot carry `import.meta.env`, so both are substituted here.
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    // Anything the frozen table cannot answer must be inlined instead.
    noExternal: (specifier: string) => (CLIENT_EXTERNALS.includes(specifier) ? undefined : true),
    plugins: [{
      // Bundle purity gate: platform seed entries stay external, inline-safe
      // wire layers inline, every other @deepseek-ai value import is an error.
      // Cross-plugin collaboration goes through cordis services instead.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (CLIENT_EXTERNALS.includes(source)) return null
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module, an inline-safe wire layer, `
          + 'or a generated /remote contribution — cross-plugin value imports are forbidden; '
          + 'type-only imports are erased and never reach this gate.',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}
