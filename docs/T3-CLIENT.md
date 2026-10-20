# T3 — Client 半边：chip / 面板 / 留痕徽章 / 召回条

本文只写**已实现、已验证**的东西。Host 契约见 `docs/T2-HOST.md`，槽位事实见 `PROBE.md`（t1 冻结）。
客户端不持有任何业务真相：会话、目录、trace 全部来自 Host 的五个 exact 路由，本层只做呈现与交互。

---

## 1. 文件与职责

```
src/client/index.tsx     入口：装样式、装快捷键、按固定 id/order 落四个槽位
src/client/api.ts        五个路由的线上契约（类型 + 调用 + 错误码表），唯一 fetch 出口
src/client/store.ts      per-session 视图状态机（模块级 Map + subscribe 供 useSyncExternalStore）
src/client/search.ts     纯搜索：归一化、高亮命中、排序（前缀 > 子串 > 简介 > 标签 > 多词全含）
src/client/styles.ts     令牌表 T + 注入式样式表（hover/focus/keyframes/reduced-motion）
src/client/ui.tsx        Kbd、高亮文本、按钮等无状态原子
src/client/chip.tsx      输入框左侧的「✦ 方法」入口
src/client/recall.tsx    输入框上方的「上一轮：X · 复用」召回条
src/client/panel.tsx     方法论面板（浮层 / 全屏两种语义）
src/client/badge.tsx     本轮末尾的留痕徽章 + 契约全文
src/client/shortcuts.ts  ⌘K / ⌘⇧M 运行时仲裁与 Escape 分层关闭
```

客户端 bundle 是 `window.__ModuleLoader__.load({ id, factory })` 闭包，**唯一外部依赖 `react`**
（平台表内）；其余全部内联，故 `lib/client.js` 70 kB / gzip 18.6 kB 自足。

## 2. 槽位契约

| 槽位 | id | order | 作用 |
| --- | --- | --- | --- |
| `conversation.input.left` | `methodology-chip` | 1 | 入口按钮（贴住已有 order 0 的控件） |
| `conversation.input.overlay` | `methodology-recall` | 10 | 召回条（composer 卡内的浮层位） |
| `conversation.input.overlay` | `methodology-panel` | 90 | 面板浮层（同 anchor，向上生长） |
| `conversation.chat.turnTail` | `methodology-badge` | 30 | 本轮留痕徽章 |

四个 id 全部自带 `methodology-` 前缀：**复用别人的 id 会顶掉别人的格子**，这条有测试守着。
`sessionId` 一律取 slot props（`standardProps.sessionId`），**不猜、不从 URL 推、不跨会话共享**；
拿不到 sessionId 就渲染 `null`，四个组件都如此（也有测试）。

## 3. 状态机（`store.ts`）

```
idle ──ensureLoaded──> loading ──snapshot──> ready
                          └──error──> ready + error（错误不吞，落 view.error）
```

- 状态按 `sessionId` 分槽（`Map`），`focusedSession` 记录最近活动会话，订阅者用
  `useSyncExternalStore` 取快照，`getServerSnapshot` 返回同一份空视图 → 无 SSR 撕裂。
- `openPanel(seed?)` / `closePanel()` 记录 `closedAt`，供「选中后 120ms 关闭」和
  「Esc 只关最上层」判定先后顺序。
- `arm()` 成功后置 `pulse`（chip 脉冲）并把面板关闭排到 120ms 后；失败只写 `flash`/`error`，
  面板**不关**（用户要能换个方法再试）。
- `toggleAssist()` **不动** `panel` 字段 —— 「+ 辅助」绝不能把面板关掉。
- `traces` 按 turn 缓存（Map），`ensureTrace(turn)` 幂等，404 落到 `null` 而不抛。

## 4. 交互硬规则（逐条对应需求）

1. **搜索**：`setQuery` 清 `pendingActiveId`；Enter 时「有高亮选高亮，无高亮才退到第一个匹配」，
   高亮由 `rankOf()` 决定（name 前缀 0 / name 子串 1 / tagline 2 / 标签 3 / 多词全含 4）。
2. **单选即走**：`arm()` → 120ms 后面板关闭，同时 chip 脉冲一次（`@keyframes dmi-pulse`）。
3. **「+ 辅助」不关面板**：见上，且最多 2 条（Host 预算 150 token，超了 arm 会 400，本层先拦）。
4. **⌘K 运行时仲裁**：拦截真实 `keydown`，`setTimeout(0)` 后读 `event.defaultPrevented`
   —— 被 DSH 占用就永久退到 ⌘⇧M，并在提示条显示**实际生效**的快捷键；
   用合成事件探测会误触发 DSH 自身行为，所以不那么做。结果落 `localStorage`。
5. **Escape 只关最上层**：全屏 → 收起为浮层；浮层 → 关闭；都不改变已选方法。
6. **展开**：浮层右上「展开」切 `position:fixed; inset:0` 的 dialog（`aria-modal`），
   宽屏双栏（列表 / 契约预览），窄屏单栏（`window.innerWidth < 760`）。
7. **动效**：全部 `@media (prefers-reduced-motion: reduce)` 下归零，只保留状态变化本身。

## 5. 样式纪律

- 颜色 100% 走 `--dsw-alias-*` / 少量非 alias 令牌（`--dsw-radius-*`、`--dsw-elevation-*`、
  `--dsw-focus-ring-*`、`--dsw-font-family`）；**零硬编码色值**，有测试扫源码。
- hover / `:focus-visible` / keyframes / 媒体查询只能靠注入样式表，故 `styles.ts` 注入一个
  `style[data-dsh-plugin-css]`（幂等，可卸载）；布局仍用内联样式，不赌 `.module.css` 的哈希。
- 尺寸对齐官方 popup 配方：浮层 `bottom: calc(100% + 6px)`、`width: min(440px, 100%)`、
  `z-index: 100`、`box-shadow: var(--dsw-elevation-prominent)`。

## 6. 验证

```bash
npm run verify   # typecheck → build → node --test tests/*.test.mjs
```

实测结果：`typecheck` exit 0；`build` 产出 `lib/client.js`；`tests` 25/25 通过
（host 20 + client wiring 5）。client wiring 覆盖：四个槽位的 name/id/order 表、二次 `apply`
不重复占位、四个组件在 props 缺失时返回空串而不炸、空闲态 chip 含 `✦`/「方法」、
以及源码无硬编码色值。

## 7. 交给 T4 的集成检查清单

- [ ] 插件装进 profile 后，`conversation.input.left` 里出现「✦ 方法」（在已有控件右侧）。
- [ ] 点开面板 → 向上生长、不改变 composer 高度；Esc 逐层退出。
- [ ] 输入框空 → 点任一行 → 120ms 内关闭、chip 变实心描边并脉冲一次。
- [ ] 「+ 辅助」勾选两条后第三条禁用；第三条若强行 arm 由 Host 返回 400 并被提示条显示。
- [ ] 发送一轮 → 末尾徽章出现；点开看到契约全文与「换一个」；刷新后徽章仍能取回（trace 走 Host）。
- [ ] 再开一个会话 → chip 回到灰态（状态按 sessionId 隔离，不串会话）。
- [ ] 深色/浅色主题切换 → chip 渐变描边、徽章底色、浮层阴影全部跟随，无一处写死颜色。
- [ ] 系统「减少动态效果」开启 → 脉冲/升起动画消失，功能不受影响。
