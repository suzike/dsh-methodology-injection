在输入框里选一个方法论，这一轮就按它的方式回答。

## 这一版能做什么

- **65 个方法论 / 6 类**：表达组织 8、理解拆解 15、推理求解 10、决策判断 13、创新设计 10、交互引导 9，264 个别名参与搜索
- **三态生效**：本轮（默认，用完即焚）/ 锁定（pinned）/ 辅助（stack）
- **43 组互斥裁决**：冲突时不报错，明确告诉你该优先用哪个、为什么
- **单轮注入 ≤150 token**：正文实测 83–117，含 marker 整块 88–122
- **留痕可回溯**：轮末徽章读 trace，显示当初注入的契约原文与 hash，可复用
- **隐私内容无关**：只存方法 id、契约 hash、turn、时间戳；不存 prompt、不存模型输出、不存路径

## 装法

```bash
git clone https://github.com/suzike/dsh-methodology-injection.git ~/.dsh/plugins/dsh-methodology-injection
cd ~/.dsh/plugins/dsh-methodology-injection && npm install && npm run build
```

然后在所用 profile 的 `package.json` 里加 `link:../../plugins/dsh-methodology-injection` 依赖与 `dsh.profile.bundles` 条目，建好 `node_modules` 链接，启用后刷新页面。详见 [README](README.md#一分钟上手)。

## 这一版修掉的 bug

**arm 之后下一轮静默不注入。** `armedForTurn` 用「上一轮 + 1」猜，而插件常在会话已走过几轮后才被看见，猜早一轮 → `turn` 模式的精确相等判定永不命中，还会被 turn 起始剪枝删掉。修法：命中条件 `===` → `<=`，删掉 turn 起始剪枝，单次消费仍由 turn 结束清理保证。

## 已知限制

- **不支持热重载**：改动 `src/**` 或 `lib/**` 后必须整机重启 DSH，否则重挂 exact 路由会报 `duplicate exact route` 并进入 `application: "failed"`（首次装包不需要重启）
- **界面截图未随版**：DSH Web 由运行时签名 cookie 保护，非 GUI 进程无法取证，截图留待使用者补
- **落地态需一次真实回合确认**：`arm → 发送 → lastInjection.landed: true` 要在重启后用一句真实消息观测

```bash
curl -s http://127.0.0.1:60880/api/methodology.diagnostics | grep -o '"landed":[a-z]*'
```

## 验证

- `npm run verify`：typecheck 0 error / build 通过 / `node --test` 25 pass, 0 fail
- 活体 5 条路由全部 200：`state` / `arm` / `release` / `trace` / `diagnostics`
- 目录校验：65 条全部在预算内，别名唯一，互斥对称
