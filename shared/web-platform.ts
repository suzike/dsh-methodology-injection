/**
 * Browser platform modules — the module-table entries the web shell seeds
 * before any plugin bundle runs.
 *
 * A client bundle may only `require` what this list names: every other
 * specifier must be inlined, because a `require()` the frozen table cannot
 * answer is a guaranteed runtime throw. Mirrors the shell's own
 * `platformModules()` factory in `@deepseek-ai/dsh-web-frontend`, read from the
 * installed DSH build. Keep it aligned when upgrading DSH.
 *
 * @module dsh-methodology-injection/shared/web-platform
 */

/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** One platform module specifier (a seed-table key). */
export type PlatformModule = (typeof PLATFORM_MODULES)[number]
