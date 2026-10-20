/**
 * Host-side contract tests.
 *
 * They run against the *built* output (lib/) with plain node:test, so what is
 * verified here is exactly what ships. Nothing here touches a live DSH session:
 * the harness context, HTTP requests and responses are minimal fakes.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MethodologyCatalog, renderContract } from '../lib/lib/catalog.js'
import { buildBundle, CONTEXT_NAME, CONTEXT_ORDER } from '../lib/lib/inject.js'
import { MethodologyStore } from '../lib/lib/store.js'
import { assistCards } from '../lib/lib/assists.js'
import { catalogPath } from '../lib/lib/util.js'

const CATALOG_PATH = catalogPath()
assert.ok(CATALOG_PATH !== undefined, 'catalog/methods.json must exist in the checkout')

const catalog = MethodologyCatalog.load(CATALOG_PATH)

/** Minimal Cordis-like context: records everything the plugin registers. */
function fakeHost() {
  const state = {
    contexts: [],
    routes: new Map(),
    listeners: new Map(),
    effects: 0,
  }
  const ctx = {
    effect(execute) {
      state.effects += 1
      const dispose = execute()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    on(event, listener) {
      const list = state.listeners.get(event) ?? []
      list.push(listener)
      state.listeners.set(event, list)
      return () => {}
    },
    systemPrompt: {
      context(entry) {
        state.contexts.push(entry)
        return () => {}
      },
    },
    webServer: {
      register(route) {
        state.routes.set(route.path, route)
        return () => {}
      },
    },
  }
  return { ctx, state }
}

/** Fresh temp DSH_HOME so each test owns its state file. */
function withHome() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-method-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return {
    dir,
    restart() {
      const { ctx, state } = fakeHost()
      plugin.apply(ctx)
      return { ctx, state }
    },
    dispose() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const plugin = await import('../lib/index.js')

function fakeRequest({ method = 'GET', url, body }) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function fakeResponse() {
  return {
    status: 0,
    headers: {},
    payload: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.payload = payload
    },
    get json() {
      return JSON.parse(this.payload)
    },
  }
}

async function call(route, request) {
  const res = fakeResponse()
  await route.handler(request, res)
  return res
}

const contextEntry = (state) => state.contexts.find((entry) => entry.name === CONTEXT_NAME)

const agentAssembly = (sessionId) => ({ agent: { id: sessionId }, scope: { id: sessionId } })

/** Two methods the catalog does not declare mutually exclusive. */
function compatiblePair() {
  for (const a of catalog.methods) {
    for (const b of catalog.methods) {
      if (a.id === b.id) continue
      if (catalog.conflict(a.id, b.id) === undefined && catalog.conflict(b.id, a.id) === undefined) {
        return [a.id, b.id]
      }
    }
  }
  throw new Error('catalog declares every pair mutually exclusive')
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

// ---------------------------------------------------------------- catalog shape

test('catalog: schema, count, budget and per-method contract fit', () => {
  assert.equal(catalog.budget, 150)
  assert.ok(catalog.methods.length >= 49, `expected >= 49 methods, got ${catalog.methods.length}`)
  for (const method of catalog.methods) {
    const contract = catalog.render(method.id)
    assert.ok(contract !== undefined, `render failed for ${method.id}`)
    assert.equal(contract.overBudget, false, `${method.id} is ${contract.tokens} tokens > ${catalog.budget}`)
    assert.equal(contract.bodyTokens <= contract.tokens, true)
  }
})

test('contract text: marker first line, then exactly the four inject sections', () => {
  const method = catalog.get('pyramid')
  assert.ok(method !== undefined)
  const { text } = catalog.render('pyramid')
  const lines = text.split('\n')
  assert.equal(lines[0], '[[METHOD:pyramid]]')
  const expected = [
    method.inject.positioning,
    ...method.inject.constraints,
    method.inject.skeleton,
    method.inject.lengthDiscipline,
  ].join('\n')
  assert.equal(text.slice('[[METHOD:pyramid]]\n'.length), expected)
  // No decoration: no heading, no list marker, no closing tag.
  assert.equal(/^#/m.test(text), false)
  assert.equal(/^[-*]\s/m.test(text), false)
  assert.equal(text.includes('</'), false)
})

test('contract rendering is byte-stable across calls and instances', () => {
  const reloaded = MethodologyCatalog.load(CATALOG_PATH)
  for (const method of catalog.methods) {
    const a = catalog.render(method.id)
    const b = catalog.render(method.id)
    const c = reloaded.render(method.id)
    assert.equal(a.text, b.text, `${method.id} unstable within instance`)
    assert.equal(a.text, c.text, `${method.id} unstable across instances`)
    assert.equal(a.hash, c.hash, `${method.id} hash unstable`)
  }
})

test('assists are opt-in and appended after the body', () => {
  const plain = catalog.render('pyramid')
  const withAssist = catalog.render('pyramid', ['evidence'])
  assert.equal(withAssist.text.startsWith(plain.text), true)
  assert.ok(withAssist.text.length > plain.text.length)
  assert.ok(assistCards().length >= 4)
  for (const card of assistCards()) {
    assert.equal(typeof card.id, 'string')
    assert.equal(typeof card.name, 'string')
    assert.equal(typeof card.clause, 'string')
  }
})

test('over-budget contracts are flagged, never truncated', () => {
  const method = catalog.get('pyramid')
  const tiny = renderContract(method, 10)
  assert.equal(tiny.overBudget, true)
  assert.equal(tiny.text.startsWith('[[METHOD:pyramid]]'), true)
  assert.equal(tiny.text.includes(method.inject.lengthDiscipline), true)
})

// ------------------------------------------------------------------ three states

test('turn mode: applies to one turn, then is consumed', () => {
  const store = new MethodologyStore({ file: join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json') })
  const before = store.arm(
    { sessionId: 's', methodId: 'pyramid', mode: 'turn', assists: [], tokens: 100, contractHash: 'h', budget: 150 },
    catalog,
  )
  assert.equal(before.ok, true)
  assert.equal(before.state.entries[0].armedForTurn, 1)
  assert.equal(store.activeAt('s', 1).length, 1)
  store.turnEnd('s', 1)
  assert.equal(store.activeAt('s', 1).length, 0)
  assert.equal(store.activeAt('s', 2).length, 0)
})

test('pinned mode: stays active until released', () => {
  const store = new MethodologyStore({ file: join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json') })
  store.arm(
    { sessionId: 's', methodId: 'pyramid', mode: 'pinned', assists: [], tokens: 100, contractHash: 'h', budget: 150 },
    catalog,
  )
  store.turnStart('s', 1)
  store.turnEnd('s', 1)
  store.turnStart('s', 2)
  assert.equal(store.activeAt('s', 1).length, 1)
  assert.equal(store.activeAt('s', 2).length, 1)
  const released = store.release('s')
  assert.deepEqual(released.removed, ['pyramid'])
  assert.equal(store.activeAt('s', 2).length, 0)
})

test('stack mode: primary and stacks coexist in one contract block', () => {
  const store = new MethodologyStore({ file: join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json') })
  const arm = (methodId, mode) =>
    store.arm({ sessionId: 's', methodId, mode, assists: [], tokens: 100, contractHash: 'h', budget: 150 }, catalog)
  const [primary, stacked] = compatiblePair()
  assert.equal(arm(primary, 'pinned').ok, true)
  assert.equal(arm(stacked, 'stack').ok, true)
  const entries = store.activeAt('s', 1)
  assert.equal(entries.length, 2)
  const bundle = buildBundle(catalog, entries)
  assert.ok(bundle !== undefined)
  assert.deepEqual(bundle.methodIds.slice().sort(), [primary, stacked].sort())
  assert.ok(bundle.text.includes(`[[METHOD:${primary}]]`))
  assert.ok(bundle.text.includes(`[[METHOD:${stacked}]]`))
})

test('mutually exclusive methods cannot share a turn', () => {
  const store = new MethodologyStore({ file: join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json') })
  const arm = (methodId, mode) =>
    store.arm({ sessionId: 's', methodId, mode, assists: [], tokens: 100, contractHash: 'h', budget: 150 }, catalog)
  assert.equal(arm('pyramid', 'pinned').ok, true)
  const conflict = arm('scqa', 'stack')
  assert.equal(conflict.ok, false)
  assert.equal(conflict.code, 'conflict')
  assert.ok(conflict.conflicts.length > 0)
  assert.equal(conflict.conflicts[0].withMethodId, 'pyramid')
  // Replacing the primary is allowed: it is an exchange, not a coexistence.
  assert.equal(arm('scqa', 'pinned').ok, true)
})

// -------------------------------------------------------- injection channels

test('context channel: unarmed sessions contribute nothing', () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const entry = contextEntry(state)
    assert.ok(entry !== undefined)
    assert.equal(entry.order, CONTEXT_ORDER)
    assert.equal(entry.interpolate, false)
    assert.equal(entry.text(agentAssembly('nobody')), '')
  } finally {
    env.dispose()
  }
})

test('context channel: armed session renders a stable contract, pre-step confirms it', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const entry = contextEntry(state)
    const routes = state.routes
    const armResponse = await call(
      routes.get('/api/methodology.arm'),
      fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's1', methodId: 'pyramid' } }),
    )
    assert.equal(armResponse.status, 200, armResponse.payload)
    assert.equal(armResponse.json.armed.methodId, 'pyramid')
    assert.equal(armResponse.json.armed.mode, 'turn')
    assert.equal(armResponse.headers['cache-control'], 'no-store')

    const text1 = entry.text(agentAssembly('s1'))
    const text2 = entry.text(agentAssembly('s1'))
    assert.equal(text1, text2)
    assert.equal(text1, catalog.render('pyramid').text)

    // The framework appends the runtime-context message itself: pre-step sees it.
    const preStep = state.listeners.get('agent/pre-step')[0]
    const decision = await preStep(
      { agent: { id: 's1' }, turn: 1, step: 1 },
      async () => ({ kind: 'enter', messages: [userMessage('问题'), userMessage(text1)] }),
    )
    assert.equal(decision.messages.length, 2, 'must not append a duplicate')

    const diagnostics = await call(routes.get('/api/methodology.diagnostics'), fakeRequest({ url: '/api/methodology.diagnostics' }))
    assert.equal(diagnostics.status, 200)
    const body = diagnostics.json
    assert.equal(body.ok, true)
    assert.equal(body.catalogSize, catalog.methods.length)
    assert.equal(body.lastInjection.channel, 'context')
    assert.equal(body.lastInjection.landed, true)
    assert.equal(body.lastInjection.stage, 'landed')
    assert.equal(body.lastInjection.turn, 1)
    assert.deepEqual(body.lastInjection.methodIds, ['pyramid'])
    assert.equal(body.sessions[0].channel.verified, true)
    // One fingerprint everywhere: diagnostics, /trace and the rendered contract agree.
    assert.equal(body.lastInjection.contractHash, catalog.render('pyramid').hash)
  } finally {
    env.dispose()
  }
})

test('pre-step fallback: fires once when the context channel produced nothing', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const entry = contextEntry(state)
    await call(
      state.routes.get('/api/methodology.arm'),
      fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's2', methodId: 'pyramid' } }),
    )
    // Assembly happened (so the turn is pending) but the step has no marker.
    assert.notEqual(entry.text(agentAssembly('s2')), '')
    const preStep = state.listeners.get('agent/pre-step')[0]
    const decision = await preStep({ agent: { id: 's2' }, turn: 1, step: 1 }, async () => ({
      kind: 'enter',
      messages: [userMessage('问题')],
    }))
    assert.equal(decision.messages.length, 2)
    const injected = decision.messages[1]
    const text = injected.content.map((part) => part.text).join('\n')
    assert.equal(text, catalog.render('pyramid').text)
    assert.equal(injected.source.kind, 'plugin')
    assert.equal(injected.source.plugin, 'dsh-methodology-injection')

    // Same turn again: must not append twice.
    const again = await preStep({ agent: { id: 's2' }, turn: 1, step: 1 }, async () => ({
      kind: 'enter',
      messages: [userMessage('问题')],
    }))
    assert.equal(again.messages.length, 1)

    const diagnostics = (await call(state.routes.get('/api/methodology.diagnostics'), fakeRequest({ url: '/api/methodology.diagnostics' }))).json
    assert.equal(diagnostics.lastInjection.channel, 'pre-step')
    assert.equal(diagnostics.lastInjection.landed, true)
    assert.match(diagnostics.lastInjection.note, /fallback/)
    assert.equal(diagnostics.sessions[0].channel.degraded, true)
    assert.equal(diagnostics.lastInjection.contractHash, catalog.render('pyramid').hash)
  } finally {
    env.dispose()
  }
})

test('sub-agents are excluded: an unarmed id never receives a contract', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    await call(
      state.routes.get('/api/methodology.arm'),
      fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 'parent', methodId: 'pyramid' } }),
    )
    const entry = contextEntry(state)
    assert.notEqual(entry.text(agentAssembly('parent')), '')
    assert.equal(entry.text(agentAssembly('child-session')), '')
    const preStep = state.listeners.get('agent/pre-step')[0]
    const decision = await preStep({ agent: { id: 'child-session' }, turn: 1, step: 1 }, async () => ({
      kind: 'enter',
      messages: [userMessage('子任务')],
    }))
    assert.equal(decision.messages.length, 1)
  } finally {
    env.dispose()
  }
})

// ---------------------------------------------------------------- trace / state

test('trace: parsed from the session log, content-free, and served per turn', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    await call(
      state.routes.get('/api/methodology.arm'),
      fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's3', methodId: 'pyramid' } }),
    )
    const entry = contextEntry(state)
    const text = entry.text(agentAssembly('s3'))
    const sessionEvent = state.listeners.get('session/event')[0]
    const session = { id: 's3' }
    sessionEvent(session, { type: 'turn/start', data: { turn: 1 } })
    sessionEvent(session, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: '我的原始提问 SEN秘内容' }] },
    })
    sessionEvent(session, {
      type: 'user/message',
      data: { role: 'user', content: [{ type: 'text', text: `我的原始提问 SEN秘内容\n${text}` }] },
    })

    const snapshotResponse = await call(
      state.routes.get('/api/methodology.state'),
      fakeRequest({ url: '/api/methodology.state?sessionId=s3' }),
    )
    assert.equal(snapshotResponse.status, 200)
    const snapshot = snapshotResponse.json
    assert.equal(snapshot.sessionId, 's3')
    assert.equal(snapshot.recent.length, 1)
    assert.equal(snapshot.recent[0].methodId, 'pyramid')
    assert.equal(snapshot.recent[0].turn, 1)
    assert.equal(snapshot.recent[0].name, catalog.get('pyramid').zh)
    assert.equal(typeof snapshot.recent[0].ts, 'number')
    assert.ok(snapshot.catalog.methods.length === catalog.methods.length)
    assert.ok(snapshot.catalog.assists.length === assistCards().length)

    const traceResponse = await call(
      state.routes.get('/api/methodology.trace'),
      fakeRequest({ url: '/api/methodology.trace?sessionId=s3&turn=1' }),
    )
    assert.equal(traceResponse.status, 200)
    assert.equal(traceResponse.json.methodId, 'pyramid')
    assert.equal(traceResponse.json.contract, text)
    assert.equal(traceResponse.json.contractHash, catalog.render('pyramid').hash)

    const missing = await call(
      state.routes.get('/api/methodology.trace'),
      fakeRequest({ url: '/api/methodology.trace?sessionId=s3&turn=99' }),
    )
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'trace-not-found')

    // The persisted state must never contain user text.
    const file = join(env.dir, 'dsh-methodology-injection', 'state.json')
    assert.equal(existsSync(file), true)
    const raw = readFileSync(file, 'utf8')
    assert.equal(raw.includes('SEN秘内容'), false, 'user content leaked into state.json')
    assert.equal(raw.includes('我的原始提问'), false, 'user content leaked into state.json')
    assert.ok(raw.includes('pyramid'))
  } finally {
    env.dispose()
  }
})

test('recent: one row per turn, the primary arm wins over stacked arms', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const [primary, stacked] = compatiblePair()
    const arm = (methodId, mode) =>
      call(
        state.routes.get('/api/methodology.arm'),
        fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's9', methodId, mode } }),
      )
    await arm(primary, 'pinned')
    await arm(stacked, 'stack')
    const text = contextEntry(state).text(agentAssembly('s9'))
    const sessionEvent = state.listeners.get('session/event')[0]
    sessionEvent({ id: 's9' }, { type: 'turn/start', data: { turn: 1 } })
    sessionEvent({ id: 's9' }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })
    const response = await call(
      state.routes.get('/api/methodology.state'),
      fakeRequest({ url: '/api/methodology.state?sessionId=s9' }),
    )
    assert.equal(response.json.recent.length, 1)
    assert.equal(response.json.recent[0].methodId, primary)
    // Both methods are still visible to the picker as the active aim.
    assert.equal(response.json.armed.methodId, primary)
    assert.equal(response.json.stack.length, 1)
    assert.equal(response.json.stack[0].methodId, stacked)
  } finally {
    env.dispose()
  }
})

test('state: unknown session is a valid empty snapshot, not an error', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const response = await call(
      state.routes.get('/api/methodology.state'),
      fakeRequest({ url: '/api/methodology.state?sessionId=never-seen' }),
    )
    assert.equal(response.status, 200)
    assert.equal(response.json.armed, null)
    assert.deepEqual(response.json.recent, [])
  } finally {
    env.dispose()
  }
})

test('release: clears the aim but keeps the trace', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const armRoute = state.routes.get('/api/methodology.arm')
    const releaseRoute = state.routes.get('/api/methodology.release')
    await call(armRoute, fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's4', methodId: 'pyramid' } }))
    const entry = contextEntry(state)
    const text = entry.text(agentAssembly('s4'))
    const sessionEvent = state.listeners.get('session/event')[0]
    sessionEvent({ id: 's4' }, { type: 'turn/start', data: { turn: 1 } })
    sessionEvent({ id: 's4' }, { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text }] } })

    const released = await call(
      releaseRoute,
      fakeRequest({ method: 'POST', url: '/api/methodology.release', body: { sessionId: 's4' } }),
    )
    assert.equal(released.status, 200)
    assert.equal(released.json.armed, null)
    assert.equal(released.json.recent.length, 1)
    assert.equal(entry.text(agentAssembly('s4')), '')
  } finally {
    env.dispose()
  }
})

// ------------------------------------------------------------------- failures

test('errors use one shape: { error: { code, message } }', async () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    const arm = state.routes.get('/api/methodology.arm')

    const unknown = await call(arm, fakeRequest({ method: 'POST', url: '/api/methodology.arm', body: { sessionId: 's', methodId: 'no-such-method' } }))
    assert.equal(unknown.status, 404)
    assert.equal(unknown.json.error.code, 'unknown-method')
    assert.equal(typeof unknown.json.error.message, 'string')

    const badJson = await call(arm, {
      method: 'POST',
      url: '/api/methodology.arm',
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{nope', 'utf8')
      },
    })
    assert.equal(badJson.status, 400)
    assert.equal(badJson.json.error.code, 'bad-json')

    const noSession = await call(state.routes.get('/api/methodology.state'), fakeRequest({ url: '/api/methodology.state' }))
    assert.equal(noSession.status, 400)
    assert.equal(noSession.json.error.code, 'bad-request')

    const methodNotAllowed = await call(arm, fakeRequest({ url: '/api/methodology.arm' }))
    assert.equal(methodNotAllowed.status, 405)
    assert.equal(JSON.parse(methodNotAllowed.payload).error.code, 'method-not-allowed')

    const tooFewAssists = await call(
      arm,
      fakeRequest({
        method: 'POST',
        url: '/api/methodology.arm',
        body: { sessionId: 's', methodId: 'pyramid', assists: ['evidence', 'counterexample', 'next-step'] },
      }),
    )
    assert.equal(tooFewAssists.status, 400)
    assert.equal(tooFewAssists.json.error.code, 'bad-request')
  } finally {
    env.dispose()
  }
})

test('diagnostics reports the failure stage when the catalog is unavailable', async () => {
  const env = withHome()
  const previousCatalog = process.env.DSH_METHODOLOGY_CATALOG
  const broken = join(env.dir, 'broken-catalog.json')
  writeFileSync(broken, '{"schemaVersion":1,"methods":[]}', 'utf8')
  process.env.DSH_METHODOLOGY_CATALOG = broken
  try {
    const { state } = env.restart()
    const response = await call(state.routes.get('/api/methodology.diagnostics'), fakeRequest({ url: '/api/methodology.diagnostics' }))
    assert.equal(response.status, 200)
    assert.equal(response.json.ok, false)
    assert.equal(response.json.catalogSize, 0)
    assert.equal(typeof response.json.lastError, 'string')
    const stateRoute = await call(state.routes.get('/api/methodology.state'), fakeRequest({ url: '/api/methodology.state?sessionId=x' }))
    assert.equal(stateRoute.status, 503)
    assert.equal(stateRoute.json.error.code, 'catalog-unavailable')
    const entry = contextEntry(state)
    assert.equal(entry.text(agentAssembly('x')), '')
  } finally {
    if (previousCatalog === undefined) delete process.env.DSH_METHODOLOGY_CATALOG
    else process.env.DSH_METHODOLOGY_CATALOG = previousCatalog
    env.dispose()
  }
})

test('routes registered: exactly the five documented endpoints', () => {
  const env = withHome()
  try {
    const { state } = env.restart()
    assert.deepEqual([...state.routes.keys()].sort(), [
      '/api/methodology.arm',
      '/api/methodology.diagnostics',
      '/api/methodology.release',
      '/api/methodology.state',
      '/api/methodology.trace',
    ])
    for (const route of state.routes.values()) assert.equal(route.kind, 'exact')
    assert.equal(state.contexts.length, 1)
    assert.equal(state.contexts[0].name, CONTEXT_NAME)
  } finally {
    env.dispose()
  }
})
