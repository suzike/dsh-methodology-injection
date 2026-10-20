#!/usr/bin/env node
/**
 * Reproduce a whole turn without a live DSH session.
 *
 * The fakes below mirror only what PROBE.md verified about the harness:
 *  - `agent.id` is the SessionId,
 *  - the framework appends the runtime-context message to the step messages,
 *  - the same snapshot text is deduped,
 *  - `agent/inbox/claimed` fires once per turn.
 *
 * Two sessions are driven: one where the context channel demonstrably lands, one where
 * it does not (so the pre-step fallback has to fire). Output is a transcript meant to
 * be pasted into review evidence: `node scripts/simulate-turn.mjs`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sentinel = '这是用户的原始提问，绝不该出现在 state.json 里'
const home = mkdtempSync(join(tmpdir(), 'dsh-method-evidence-'))
process.env.DSH_HOME = home

const plugin = await import('../lib/index.js')

const listeners = new Map()
const routes = new Map()
let contextEntry
const ctx = {
  effect(execute) {
    return execute()
  },
  on(event, listener) {
    const list = listeners.get(event) ?? []
    list.push(listener)
    listeners.set(event, list)
    return () => {}
  },
  systemPrompt: {
    context(entry) {
      contextEntry = entry
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => {}
    },
  },
}

plugin.apply(ctx)

const request = ({ method = 'GET', url, body }) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const response = () => ({
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
})

async function call(path, init) {
  const res = response()
  await routes.get(path).handler(request(init), res)
  return { status: res.status, body: JSON.parse(res.payload) }
}

const message = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const emit = (event, ...args) => {
  for (const listener of listeners.get(event) ?? []) listener(...args)
}
const preStep = listeners.get('agent/pre-step')[0]

function section(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

section('1. arm 会话 A（turn 模式，默认）')
const armed = await call('/api/methodology.arm', {
  method: 'POST',
  url: '/api/methodology.arm',
  body: { sessionId: 'session-A', methodId: '金字塔原理' },
})
console.log(JSON.stringify({ status: armed.status, armed: armed.body.armed, budget: armed.body.budget }, null, 2))

section('2. 组装：context 通道渲染出的契约（逐字节稳定，两次一致）')
const first = contextEntry.text({ agent: { id: 'session-A' }, scope: { id: 'session-A' } })
const second = contextEntry.text({ agent: { id: 'session-A' }, scope: { id: 'session-A' } })
console.log(first)
console.log(`\n同一会话两次渲染 === ${first === second}；长度 ${first.length} 字符`)

section('3. 轮次边界 agent/inbox/claimed → pre-step（框架已把契约追加进 step）')
emit('agent/inbox/claimed', { agent: { id: 'session-A' }, turn: 1 })
const landed = await preStep({ agent: { id: 'session-A' }, turn: 1, step: 1 }, async () => ({
  kind: 'enter',
  messages: [message(sentinel), message(first)],
}))
console.log(`step 消息数 ${landed.messages.length}（框架已注入，Host 不追加）`)

section('4. 会话 B：context 没到（模拟框架未追加），pre-step 兜底')
await call('/api/methodology.arm', {
  method: 'POST',
  url: '/api/methodology.arm',
  body: { sessionId: 'session-B', methodId: '金字塔原理' },
})
contextEntry.text({ agent: { id: 'session-B' }, scope: { id: 'session-B' } })
emit('agent/inbox/claimed', { agent: { id: 'session-B' }, turn: 1 })
const fallback = await preStep({ agent: { id: 'session-B' }, turn: 1, step: 1 }, async () => ({
  kind: 'enter',
  messages: [message(sentinel)],
}))
const appended = fallback.messages[1]
console.log(`step 消息数 ${fallback.messages.length}`)
console.log(`追加消息 source = ${JSON.stringify(appended.source)}`)
console.log(`追加文本首行 = ${appended.content[0].text.split('\n')[0]}`)
const again = await preStep({ agent: { id: 'session-B' }, turn: 1, step: 1 }, async () => ({
  kind: 'enter',
  messages: [message(sentinel)],
}))
console.log(`同一轮重复调用 step 消息数 ${again.messages.length}（不得二次注入）`)

section('5. 留痕：user/message 里出现 marker → trace（只存 methodId/hash/turn）')
const sessionEvent = listeners.get('session/event')[0]
sessionEvent({ id: 'session-A' }, { type: 'turn/start', data: { turn: 1 } })
sessionEvent({ id: 'session-A' }, { type: 'user/message', data: message(`${sentinel}\n${first}`) })

const trace = await call('/api/methodology.trace', {
  url: '/api/methodology.trace?sessionId=session-A&turn=1',
})
console.log(JSON.stringify({ status: trace.status, trace: { ...trace.body, contract: `${trace.body.contract.slice(0, 24)}…` } }, null, 2))
const missing = await call('/api/methodology.trace', {
  url: '/api/methodology.trace?sessionId=session-A&turn=7',
})
console.log(`无留痕的轮次 → ${missing.status} ${JSON.stringify(missing.body)}`)

section('6. GET /api/methodology.diagnostics（最近一次注入真相）')
const diagnostics = await call('/api/methodology.diagnostics', { url: '/api/methodology.diagnostics' })
console.log(JSON.stringify(diagnostics.body, null, 2))

section('7. state.json 落盘内容（绝不含用户原文）')
const file = join(home, 'dsh-methodology-injection', 'state.json')
const raw = readFileSync(file, 'utf8')
console.log(raw.trim())
console.log(`\n含用户原文？${raw.includes(sentinel)}`)
console.log(`含 marker？${raw.includes('[[METHOD:')}（应为 false：指纹只存 hash）`)

section('8. 释放：armed 清空，recent 保留')
const released = await call('/api/methodology.release', {
  method: 'POST',
  url: '/api/methodology.release',
  body: { sessionId: 'session-A' },
})
console.log(JSON.stringify({ status: released.status, armed: released.body.armed, recent: released.body.recent }, null, 2))
console.log(`释放后 context 文本长度 = ${contextEntry.text({ agent: { id: 'session-A' } }).length}`)

rmSync(home, { recursive: true, force: true })
