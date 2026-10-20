/**
 * Wiring smoke test for the built client bundle.
 *
 * Typecheck proves the types line up; this proves the artifact the loader will
 * actually execute does the right thing: it evaluates the closure factory with
 * `react` as its only external, seats exactly four entries with the agreed ids
 * and orders, survives a double `apply`, and renders each seated component
 * through React without throwing.
 *
 * Requires `npm run build` first (skipped, not failed, when `lib/client.js` is
 * absent so `npm test` stays usable on a clean checkout).
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const bundlePath = new URL('../lib/client.js', import.meta.url)

/** Evaluate the bundle the way the shell's module loader does. */
function loadBundle() {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const factories = new Map()

  const scope = globalThis
  const hadWindow = 'window' in scope
  const previousWindow = scope.window
  scope.window = {
    __ModuleLoader__: {
      load(entry) {
        factories.set(entry.id, entry.factory)
      },
    },
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(readFileSync(bundlePath, 'utf8'))()
  } finally {
    if (hadWindow) scope.window = previousWindow
    else delete scope.window
  }

  const factory = factories.get('dsh-methodology-injection')
  assert.ok(factory, 'bundle registered itself with the module loader')
  const mod = factory((id) => {
    if (id === 'react') return React
    throw new Error(`unexpected external: ${id}`)
  })
  return { React, renderToStaticMarkup, mod }
}

/** A slots service that records instead of mounting. */
function recordingSlots(registrations) {
  return {
    inject(host, factory) {
      factory()
    },
    register(options, component) {
      registrations.push({ ...options, component })
      return () => {}
    },
  }
}

test('seats the four agreed entries', { skip: !existsSync(bundlePath) }, () => {
  const { mod } = loadBundle()
  const registrations = []
  mod.apply({ slots: recordingSlots(registrations) })

  assert.equal(mod.name, 'dsh-methodology-injection')
  assert.deepEqual(
    registrations.map((entry) => [entry.name, entry.id, entry.order]),
    [
      ['conversation.input.left', 'methodology-chip', 1],
      ['conversation.input.overlay', 'methodology-recall', 10],
      ['conversation.input.overlay', 'methodology-panel', 90],
      ['conversation.chat.turnTail', 'methodology-badge', 30],
    ],
  )
  // A fresh id per entry: reusing a shipped id would replace someone else's cell.
  for (const entry of registrations) assert.ok(entry.id.startsWith('methodology-'))
})

test('a second apply does not seat the slots twice', { skip: !existsSync(bundlePath) }, () => {
  const { mod } = loadBundle()
  const registrations = []
  const slots = recordingSlots(registrations)
  mod.apply({ slots })
  mod.apply({ slots })
  assert.equal(registrations.length, 4)
})

test('every seated component renders or declines without throwing', { skip: !existsSync(bundlePath) }, () => {
  const { React, renderToStaticMarkup, mod } = loadBundle()
  const registrations = []
  mod.apply({ slots: recordingSlots(registrations) })

  const props = {
    sessionId: 'session-smoke',
    turn: { turn: 2 },
    seq: 1,
    openFile() {},
    useInput() {},
    inputActions: {},
  }

  const html = new Map()
  for (const entry of registrations) {
    const markup = renderToStaticMarkup(React.createElement(entry.component, props))
    html.set(entry.id, markup)
  }

  // Idle chip: the ✦ affordance and its label, no armed state yet.
  const chip = html.get('methodology-chip')
  assert.match(chip, /✦/)
  assert.match(chip, /方法/)
  assert.match(chip, /data-dmi-chip="session-smoke"/)

  // Nothing is armed, loaded or open, so these three must return nothing at all
  // rather than an empty shell taking space in the composer or the transcript.
  assert.equal(html.get('methodology-panel'), '')
  assert.equal(html.get('methodology-recall'), '')
  assert.equal(html.get('methodology-badge'), '')
})

test('a missing sessionId declines instead of guessing one', { skip: !existsSync(bundlePath) }, () => {
  const { React, renderToStaticMarkup, mod } = loadBundle()
  const registrations = []
  mod.apply({ slots: recordingSlots(registrations) })
  for (const entry of registrations) {
    assert.equal(renderToStaticMarkup(React.createElement(entry.component, {})), '')
  }
})

test('no hard-coded colours in the client sources', { skip: !existsSync(bundlePath) }, () => {
  // The brief: every colour is a token, so light/dark follow the shell. A hex
  // or rgb() literal anywhere in the UI layer is a theming bug waiting to ship.
  const sources = ['chip.tsx', 'panel.tsx', 'badge.tsx', 'recall.tsx', 'ui.tsx', 'styles.ts']
  for (const file of sources) {
    const text = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
    const literals = text.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g) ?? []
    assert.deepEqual(literals, [], `${file} must colour through tokens only`)
  }
})
