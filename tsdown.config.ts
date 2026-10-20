/**
 * Build config: the browser half only.
 *
 * `lib/client.js` is a closure-factory bundle for the web shell's
 * `window.__ModuleLoader__` (React / cordis resolve through the loader's frozen
 * module table, everything else is inlined). The host half is emitted by
 * `tsc -p tsconfig.build.json` and is deliberately not touched here.
 *
 * @module dsh-methodology-injection/tsdown.config
 */

import { clientBundle } from './shared/tsdown.client.ts'

export default clientBundle('dsh-methodology-injection', 'src/client/index.tsx')
