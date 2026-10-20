# T2 — Host 半边：注入管线 / 状态 / 留痕 / 诊断

本文只写**已实测、已断言**的事实。契约来源见 `PROBE.md`（t1 冻结），客户端线上契约见
`src/client/`（t3）。任何与本文件冲突的说法，以本文件和测试为准。

---

## 1. 分层与文件

```
src/index.ts         插件入口：装配 catalog 槽、store、三条注入通道、五条路由
src/lib/catalog.ts   目录加载/校验/冲突裁决/契约渲染（纯函数）
src/lib/store.ts     per-session 状态机 + 落盘 + 内容无关 trace
src/lib/inject.ts    context 注入 → pre-step 校验/兜底 → 轮次事件与 trace 重建
src/lib/http.ts      五条 exact 路由 + 统一错误形状
src/lib/assists.ts   4 条 Host 内置辅助项（provisional，客户端可增）
src/lib/draft.ts     「读取输入草稿」的**空接口位**（t2 不实现，t5 接 recommend/polish）
src/lib/estimate.ts  token 估算（与 scripts/validate-catalog.mjs 同一公式）
src/lib/util.ts      DSH_HOME / 状态目录 / 目录候选路径 / 原子写
```

三条通道的**权威顺序**：`catalog`（内容）→ `store`（本会话 arm 了什么）→ `inject`（怎么送进模型）。

## 2. 注入管线

1. **主通道 `systemPrompt.context`**
   `ctx.systemPrompt.context({ name:'methodology-contract', order:230, interpolate:false, text })`。
   - `text(assembly)` 里 `assembly.agent.id` 就是 SessionId（PROBE §1.1/§1.2）。
   - 未 arm → 返回 `''`，框架视为无贡献（`renderContextSections` 过滤空串）。
   - 已 arm → 返回契约块文本，框架自己把它变成尾部 `runtime-context` 消息追加进 step。
   - 空串 → 框架会发一个 `CLEARED` 快照（released 后契约确实消失）。
   - 同一文本快照被框架去重（`dsh-agent-loop/lib/index.js:334-347`），所以锁定型不会每轮刷屏。
2. **校验/兜底 `agent/pre-step`**
   `next()` 之后只在 `decision.kind === 'enter'` 时处理：
   - step 消息里已有 `[[METHOD:` → 记 `landed(channel:'context')`，把 `channel.verified` 置真；
   - 已验证过 → 直接放行（框架已去重，契约在历史里）；
   - 未验证、本轮组装过（`channel.pendingTurn === turn`）、`step === 1`、且本轮尚未投递过 →
     **追加一条 `source.kind:'plugin'` 的 user 消息**（`form:'notice'`）并记 `channel:'pre-step'` + `degraded`。
     刻意不复用 `runtime-context` 这个 source：它归框架 RuntimeContextProjection 所有，复用会与快照去重打架。
   - 全程 try/catch，绝不把异常抛回 harness。
3. **轮次与留痕 `agent/inbox/claimed` + `session/event`**
   - `agent/inbox/claimed`（一 turn 一次）→ `turnStart(sessionId, turn)`；顺带丢弃 `armedForTurn < turn` 的过期轮次型 arm。
   - `session/event`：`turn/start`/`turn/end` 作为备份；`user/message` 里出现 `[[METHOD:<id>]]` → 写 trace。
   - trace 只存 `{methodId, contractHash, sessionId, turn, ts}`；**测试断言 state.json 不含用户原文**。

### 注入文本格式（逐字节稳定）

```
[[METHOD:<id>]]
<positioning>
<constraint 1>
<constraint 2>
<skeleton>
<lengthDiscipline>
```

- 四段顺序固定，单 `\n` 连接，**无标题、无编号、无 `- ` 装饰、无前后缀说明**。
- 首行 marker 是留痕与 `GET /trace` 的回溯锚点。
- 纯函数 + 无时间戳/随机数：同一方法两次渲染、两个实例渲染必须 `===`（已断言）。
- 辅助项（assists）仅在用户显式选择时追加在正文之后，默认路径逐字节等于目录正文。
- 预算：`injectionBudget.maxTokens = 150`；当前 65 条实测**正文 83–117 token**（与 `scripts/validate-catalog.mjs` 逐条一致），含 marker 整块 88–122 token。
  超限**直接拒绝注入并报 `budget-exceeded`，绝不截断**。

### 失败定位（`GET /diagnostics` 的 `lastInjection.stage`）

| stage | 含义 | 已实现证据 |
| --- | --- | --- |
| `armed` | arm 成功，尚未组装 | 单测 |
| `assembled` | context 渲染出非空文本（turn/step/token 已记） | 单测 |
| `landed` | step 里看到 marker，`channel` 说明来源 | 单测 |
| `context-miss` | 组装过但 step 无 marker → 走兜底 | 单测（`note:'fallback'`） |
| `budget-exceeded` | 渲染超预算 → 拒绝注入 | 单测 |
| `catalog-error` | 目录不可用 → 返回空串不注入 | 单测 |
| `fallback-failed` / `error` | 兜底构造消息或钩子抛错 | 代码路径，未构造单测 |

`channel.verified/degraded/pendingTurn` 让「context 是否真的在干活」可判定：`verified` 一旦为真，
后续轮次不再走兜底，避免一条契约进两次。

## 3. 状态

- **key = sessionId = agent.id**（不是全局变量；参照实现 `dsh-answer-method` 的全局 arm bug 已避免）。
- 内存 `Map` + 落盘 `<DSH_HOME>/dsh-methodology-injection/state.json`（`DSH_HOME` 可覆盖，否则 `~/.dsh`）。
  原子写（同目录 tmp + rename）；损坏文件重命名为 `.corrupt-<ts>` 后从空开始；7 天无 arm 的会话回收。
- 三态（`mode`）：
  - `turn`：`armedForTurn = lastTurn + 1`，只在该轮生效，`turn/end` 消费即清；
  - `pinned`：持续到 `release`；
  - `stack`：与主 arm 并行叠加（锁主 arm 的替换不影响 stack）。
- 互斥：主 arm（turn/pinned）互相**替换**（换方法不算并存）；stack 与任何已有 entry 都查目录
  `conflictRules`（43 组）与 `method.conflicts`，冲突返回 409 `conflict` 并带 `{withMethodId, rule, preferred, preferWhen}`。
- 幂等：同 method+mode+assists 重复 arm 返回当前快照且 `unchanged`。

## 4. HTTP 契约（五条 exact 路由）

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/methodology.state` | GET | `?sessionId=`；未知会话返回空快照（200），不是错误 |
| `/api/methodology.arm` | POST | `{sessionId, methodId, assists?, mode?}`，`mode` 缺省 `turn` |
| `/api/methodology.release` | POST | `{sessionId, methodId?}`；armed 清空，recent 保留 |
| `/api/methodology.trace` | GET | `?sessionId=&turn=`；该轮无留痕 → 404 `trace-not-found` |
| `/api/methodology.diagnostics` | GET | 最近一次注入真相 + 各会话 channel/stage |

- 响应永远是**整份快照**（不是 ack），带 `cache-control: no-store`。
- 错误统一 `{ error: { code, message } }`；非法方法 → 405 `method-not-allowed`；
  目录不可用 → 503 `catalog-unavailable`（state/trace/arm）但 diagnostics 仍 200 且 `ok:false`。
- 快照在 t3 冻结字段之外**只增不改**：`stack`、`activeNow`、`channel`、`lastInjection`、`turn`、`budget`、`maxAssists`；
  `MethodCard` 额外给 `en/category/categoryLabel/tokens/bodyTokens/contractHash/display/conflicts`。

## 5. 构建与运行期路径

`tsc` 不复制 JSON，所以：

- `npm run build:host` → `tsc -p tsconfig.build.json` → `lib/**`（`src/index.ts` → `lib/index.js`，`src/lib/*` → `lib/lib/*`）
- `node scripts/copy-catalog.mjs` → `catalog/methods.json` → **`lib/catalog/methods.json`**（逐字节校验 sha256，并校验 schemaVersion/methods 非空）
- `npm run build`（t3 加的客户端 tsdown 也在里面）→ 最后一步必跑 copy-catalog
- `package.json` 的 `files` 已包含 `catalog`，`prepack` 会重新构建

**运行期目录解析顺序**（`src/lib/util.ts`，第一个存在的赢）：

1. `$DSH_METHODOLOGY_CATALOG`（开发/测试覆盖）
2. `<packageRoot>/catalog/methods.json`（仓库直跑）
3. `<packageRoot>/lib/catalog/methods.json`（打包后的随包副本）

`packageRoot` 由编译产物位置向上找 `package.json` 得到，即 `lib/lib/util.js` → 插件根。

**状态文件**：`<DSH_HOME>/dsh-methodology-injection/state.json`（默认 `~/.dsh/...`）。

## 6. 验证

```bash
npm run build:host && node scripts/copy-catalog.mjs
./node_modules/.bin/tsc -p tsconfig.json --noEmit     # Host 半边
npm test                                              # node --test，20 条
node scripts/simulate-turn.mjs                        # 无会话复现一整轮（见 docs/T2-EVIDENCE.txt）
node scripts/validate-catalog.mjs                     # 目录侧（t4）
```

最近一次结果（本机）：

- Host typecheck：0 error
- `npm test`：**20 pass / 0 fail**
- 目录：65 methods / 6 categories / 43 conflict rules / budget 150 / 正文 83–117 / 整块 88–122 token，0 overBudget，且正文估算与 validate-catalog 逐条一致
- 覆盖到的断言：契约逐字节稳定（跨实例）、marker 首行 + 四段原文、无装饰、预算超限不截断、
  三态语义、互斥裁决与主 arm 替换、stack 并置、context 命中不重复、pre-step 兜底只发一次、
  子 agent（未 arm 的 id）零注入、trace 可从日志重建且 state.json 无用户原文、release 保留 recent、
  五条路由注册形状、统一错误形状、目录坏掉时 diagnostics.ok=false 且 state 503、
  叠加轮次的 recent 取主 arm、diagnostics/trace/契约三方 `contractHash` 一致。
- 路由耗时（本机）：`arm` 约 4.2ms（含落盘 flush），`state` 约 1.0ms。
- 完整一轮的行为转录：`docs/T2-EVIDENCE.txt`（arm → 组装 → 命中/兜底 → 留痕 → 诊断 → 落盘 → 释放）。

### 未在本机验证（需要装包后才能做）

**「注入块真的落进会话 JSONL」**：这要求插件被真实加载、真实跑一轮对话。
本机目前未加载本插件（`profile: web` 的依赖里还没有），因此该条留到 t5 装包后验；
在此之前，管线正确性由「框架源码事实（turn/start 先于 preStep、runtime-context 追加与去重）
+ 单测模拟同样的 decision 形状」支撑，而不是靠记忆。

## 7. 已知限制

- `npm run typecheck` 现在包含 t3 的 `tsconfig.client.json`，客户端侧当前有 1 处
  `exactOptionalPropertyTypes` 报错（`src/client/api.ts`），属 t3 范围；Host 用
  `tsc -p tsconfig.json --noEmit` 单独校验。
- `mode` 缺省 `turn`（贴「本轮对话」语义）；客户端目前不传 `mode`，将来要暴露锁定型/叠加型时
  只需在 arm body 里带上，Host 已支持。
- assists 由 Host 内置 4 条（`counterexample/evidence/uncertainty/next-step`），目录 schema 尚无 assists 字段；
  一次最多 2 条，正文与整块都按 150 预算校验。
- `draft.ts` 是空接口位，`canReadDraft()` 恒为 false；`/recommend`、`polish` 未实现。
