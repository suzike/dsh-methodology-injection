# PROBE.md — 真实契约取证结果（T1）

> 本文件是本项目的**唯一事实来源**。任何未经本文件确认的类型/字段/签名，一律不得写进代码。
> 取证时间：2026-10-20。DSH 版本：0.2.1-rc.2。

## 0. 取证方法（可复现，不依赖记忆）

DSH 源码在 `D:\Software\DSH\resources\app.asar`（175MB，21,412 个文件）。`app.asar` 里的东西 **shell/glob/grep 直接读不到**，但可以用 asar CLI 完整抽出：

```bash
cd /d/Software/DSH/resources
npx --yes @electron/asar list app.asar > /tmp/asar-list.txt      # 清单，约 30 秒
npx --yes @electron/asar extract app.asar /tmp/dsh-src            # 全文抽取，实测 30 秒
# 之后所有契约都在这里读：
#   /tmp/dsh-src/dsh/node_modules/@deepseek-ai/<pkg>/lib/*.js
```

306 个 `@deepseek-ai/*` 包，**没有 .d.ts，也没有 .js.map**，只有编译后的 .js。但 JSDoc 注释被完整保留，够用。

另有一条更轻的路：`cordis_inspect_query` 的 Service / Event / Slots provider 能直接吐类型声明，但**它吐的是窄化声明，会骗人**（见 §1.2）。

---

## 1. 已冻结的契约（读了源码，逐条带证据）

### 1.1 `agent.id` 就是 `SessionId`

```ts
export interface Agent { readonly id: SessionId }
```
证据：`Event.listEvents` → `referencedTypes.Agent`。
影响：Host 侧不需要任何"从 agent 反查会话"的适配层，`sessionId = agent.id`。

### 1.2 `AssembleContext` 运行时含 `agent`，**Inspect 吐的声明是错的**

```js
// dsh-agent/lib/types/dispatch.js:92
export function assembleContextFor(agent, signal) {
    return { agent, scope: agent, ...(signal === undefined ? {} : { signal }) };
}
```
而 `Service.listService({service:'systemPrompt'})` 返回的声明是 `AssembleContext { scope?: ScopeKey; signal?: AbortSignal }` —— **没有 agent**。

**结论：Inspect 的类型声明是窄化版，不能当签名依据。** 这解释了为什么旧插件 `dsh-answer-method` 里 `context.agent.id` 的写法在类型上"不合法"但运行时是对的。

影响：系统提示的每个 section/context 的 `text(ctx)` **都能拿到 `ctx.agent.id`**，也就是**天然支持 per-session**，不需要任何全局单例 + 自己过滤。

### 1.3 注入通道：`systemPrompt.context()` → 官方 runtime-context 消息（**这是最优解**）

调用链（全部来自源码，非推测）：

```
systemPrompt.context(entry)                        // 我们注册的地方
  → assembly.contexts                              // assemble() 收进来
  → renderContextSections(assembly)                // dsh-agent-loop/lib/index.js:913
  → this.runtimeContext.project(joined, sections)  // :915
  → createUserMessage({ content:[{type:'text',text}],
                        source:{ kind:'runtime-context', form:'snapshot', sections } })
  → preStep 的默认 next() 把这条消息追加到 step messages  // :916-923
```

证据：`dsh-agent-loop/lib/index.js:902-930`（preStep）、`:218`（`const SOURCE = "runtime-context"`）、`:334-347`（project）。

```js
// preStep 的默认分支（我们不改它，直接受益）
() => {
  const sections = renderContextSections(assembly);
  const context = this.runtimeContext.project(joinContextSections(sections), sections);
  return Promise.resolve({
    kind: 'enter',
    messages: context === undefined ? claimed : [...claimed, context],
  });
}
```

**这意味着：我们只要注册一个 context，框架会自己把它变成一条模型可见的 runtime-context 消息，追加进 step，UI 按 `context` 节点渲染，不污染用户气泡。**

对比先前设想的"把契约块接在用户消息末尾"：那个方案会让用户气泡变长变丑，还要自己造 `UserMessage` 对象（需要 `id`/`role`/`content`/`source` 四件套，跨包 import 被 purity gate 禁止）。**否决，改用 context()。**

### 1.4 同一方法不会被每 step 重复注入

```js
// dsh-agent-loop/lib/index.js:334-347
project(current, sections) {
  if (this.retained === undefined && current.length === 0) return;
  const snapshot = current.length === 0 ? CLEARED : current;
  if (this.retained?.text === snapshot) return;   // ← 文本没变就不再产生消息
  return createUserMessage({ ... });
}
```
`retained` 记住上一次快照文本。同一方法持续 arm 时，只在**文本变化**时产生新快照消息。

影响：锁定型（持续生效）不会每轮刷一条；换方法时才会产生新快照。**天然就是我们要的去重语义，不用自己写 turn 级去重。**

### 1.5 `agent/request` **不能**注入

```ts
export interface LlmCallConfig extends LlmCallControls { provider: string; model: string }
export interface LlmCallControls { reasoningEffort?; temperature?; maxTokens?; stop? }
```
原文注释：*"Model-visible content must use logged channels; this waterfall cannot mutate messages."*

影响：**彻底否决**这条路。先前版本把它当主路径是错的。

### 1.6 `agent/pre-step` 能改消息，但只在必要时用

```ts
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```
影响：作为 §1.3 的**兜底**——如果 context 方案实测不生效（例如被 suppressRuntimeContext 挡掉），退到这里自行追加消息。但自己造消息要满足 `createUserMessage` 的形状，风险高于改注册方式，故不首选。

### 1.7 客户端 slot props：sessionId 是白给的

所有 session 作用域 slot 的 standardProps 一致包含：

```
useInput: SnapshotSelectorHook<InputState>   inputActions: InputActions
sessionId: SessionId                          useChat / useConversation / useTrajectory / useSession
useSessions / useSessionStatus / useSessionAccess / useWorkspaces / useAccess / useProjection
```
证据：`Slots.listSubTree` 对 `conversation.input.left`、`conversation.input.overlay`、`conversation.chat.turnTail` 三次返回的 standardProps 完全一致。

旧插件里也确认了用法：`sessionId = props.sessionId`。

影响：
- **client 侧不需要 HTTP 猜会话**，`props.sessionId` 直接拿来当 key。
- `useInput(InputState)` 能读草稿 → 自动推荐可以做（但见 §3 决策：只做建议不做静默注入）。
- `useTrajectory` / `useChat` 能拿到历史 → 「上一轮用了什么」可以在 composer 里算出来。

### 1.8 `MessageSourceMap` 里所有可用来源（决定"痕迹"长什么样）

```
user / model / tool / system-prompt / model-selection / runtime-context /
working-directory / user-approval / ptc-mode / tool-registry / user-rpc /
agent-message / subagent-settled / skill-invocation / compact-checkpoint /
cordis-host-runner / team-message / user-question-reply / goal / plan-mode /
schedule / session-reference / webhook
```

**没有"方法论"这一类，且这个 map 不可扩展**（和 UserTextId 固定 6 键同理）。

影响：不能给用户气泡加自定义 chip 类型。痕迹只能靠 ① runtime-context 节点本身 ② turnTail 徽章 ③ 自己的 state 文件。

### 1.9 槽位占用现状（决定 order 与不撞车）

- `conversation.input.left`：仅 `agency-agents` (order 0) → **我们的 chip 用 order 1**
- `conversation.input.overlay`：`slash-menu`(0)、`command-popup`(1)、`feedback-dialog`(2)、`dsh-context/context-modal`(10) → 面板用 order 20 或更高
- `conversation.chat.turnTail`：deliverables、plan、univer-turn-preview、dsh-mnemon/turn-tail、schedule-created(20)、agent-teams-summary(50) → 我们的徽章用 order 30 附近

`conversation.chat.node` 与 `conversation.user.text.node` 都是固定 kind 表，**不能新增**。

### 1.10 旧的 `@suzike/dsh-answer-method` 确认没活

三重证据：
1. `Config.listConfigs(name='@suzike/dsh-answer-method')` → `entries:[], total:0`
2. `conversation.input.left` 的 occupants 里没有它
3. profile 的 package.json 里有依赖与 bundle 条目，但 Loader 没加载它

影响：**环境干净，无冲突**。但它是同一作者的可用参考（`ctx.get('llm')`、`agentDefaultModel`、`webServer.register` 的真实用法都在里面）。

### 1.11 `webServer.register` 真实签名

```js
ctx.effect(() => ctx.webServer.register({
  kind: 'exact',
  path: '/api/<name>/...',
  handler: (req, res) => { ... },
}), '<label>')
```
证据：旧插件 `lib/index.js:200-360` 共 8 处，形状完全一致。

### 1.12 `commands.register` 会进原生 slash-menu

`conversation.input.overlay` 里已有 `slash-menu` 与 `command-popup` 占用者；`commands.execute` 注释原文：*"Parse and execute a known command **without sending it to the model**."*

影响：注册 `/m` 后键盘用户零成本获得第二入口，且**不消耗模型调用**。这是白捡的。

---

## 2. 仍未验证（必须装包后实测，不许猜）

| # | 未知 | 为什么要紧 | 怎么验 |
|---|---|---|---|
| U1 | `InputActions` 的方法名 | 决定能否把方法论名写回草稿 / 能否主动提交 | 装包后 `Object.keys(props.inputActions)` 打到 console |
| U2 | `InputState` 的字段 | 决定自动推荐能否读草稿原文 | 同上，dump 一次 |
| U3 | 子 agent 是否也触发我们的 context | 若触发，子 agent 也会被塞方法论 | spawn 一个子 agent，看它的请求里有没有 |
| U4 | `install_bundle` 是否要求重启 DSH | 决定交付流程 | 装一次看 `nextStep` 字段 |
| U5 | `.module.css` 是否被 client bundle 支持 | 决定样式方案 | 看 `shared/tsdown.client.ts` 能不能编译过 |

**U1/U2 不解决，T3 的设计不能冻结；U3 不解决，T2 有污染子 agent 的风险。**

---

## 3. 由证据直接推翻的三个先前判断（存档，防止再犯）

| 先前判断 | 真实情况 | 影响 |
|---|---|---|
| 用 `agent/request` 注入 | 该 waterfall 明确不能改消息，`LlmCallConfig` 只有 5 个采样字段 | 主路径作废 |
| client 拿不到 sessionId，多标签页会串（我曾定为"硬拦路"） | props 里直接有 `sessionId` | 硬拦路不存在，我当时的风险清单是虚张声势 |
| 契约必须塞进用户消息（因此要压到 150 token） | 官方有 runtime-context 通道，不进用户气泡 | token 预算可放宽到 400，内容设计不必牺牲完整性 |

---

## 4. 最终注入设计（冻结版）

```
用户在 chip/面板选中方法
  → POST /api/methodology/arm { sessionId, methodId, mode: 'turn'|'pinned'|'stack' }
  → Host 状态：Map<SessionId, ArmedState>（内存 + ~/.dsh/dsh-methodology-injection/state.json）
  → 每一步 systemPrompt.assemble 时，我们注册的 context 的 text(ctx) 读 ctx.agent.id
      · 未 arm → 返回 ''
      · 已 arm → 返回紧凑契约块
  → 框架自己把它变成 runtime-context 消息，追加进该 step
  → 模型看到：用户原文 + 方法论契约
  → 痕迹：runtime-context 节点（原生 context 渲染）+ turnTail 徽章 + composer 召回提示
```

失败与兜底：
- context 没生效 → 退 `agent/pre-step` 自行追加（§1.6）
- 两者都不行 → 退 `systemPrompt.section()`（旧插件路径，已验证可跑）
- 任一降级都要在 `GET /diagnostics` 里标出来，不许静默

---

## 5. 交给 T2/T3/T4 的硬约束（从这里抄，不要自己推）

**T2（Host）**
- `inject = ['systemPrompt', 'webServer']`；可选依赖用 `ctx.get('commands')`
- context 注册：`{ name: 'methodology-contract', order: <避让已有>, text: (ctx) => armed.get(ctx.agent.id) ? buildContract(id) : '', interpolate: false }`
- 状态 key：`agent.id`（= SessionId），不要新造 session 概念
- trace 只存 `methodId / contractHash / sessionId / turn / ts`，**严禁存用户原文**
- 路由：`arm / release / state / catalog / trace / diagnostics` 六个 exact 路由

**T3（Client）**
- `sessionId` 取 `props.sessionId`，不要自己从 URL/存储里猜
- chip 注册在 `conversation.input.left`，`id: 'methodology-chip'`，`order: 1`
- 面板注册在 `conversation.input.overlay`，`id: 'methodology-panel'`，`order: 20`
- turnTail 徽章 `id: 'methodology-badge'`，`order: 30`
- **先去 dump U1/U2**，再决定草稿相关交互是否做
- 样式只用 CSS 变量，绝不写死色值

**T4（目录）**
- 注入层 ≤400 token（原 150 的约束已因 §1.3 放宽）
- 注入层与展示层必须分开存
- 每条方法必须能被第三方从回答结构上区分出来（这是 t6 的硬验收）
