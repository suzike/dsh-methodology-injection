# 方法论目录（catalog）

这个目录就是插件卖的东西本身。`methods.json` 是唯一数据源：**65 条方法论、6 大类、264 个检索别名、43 组互斥裁决**。
（第一批 49 条为骨架方法，第二批 15 条补经典工具：SWOT/PESTEL/五力/两把剃刀/A3/8D/SMART/GROW/PDCA/九宫格/设计冲刺/故事地图/AARRR/NVC。）
`../scripts/validate-catalog.mjs` 是它的门禁，任何一条不过就不该发版。

```
catalog/
  methods.json          唯一数据源（Host 与 UI 都读它）
  README.md             本文件：schema、取舍、扩展与校验方式
scripts/
  validate-catalog.mjs  零依赖校验器（字段/预算/唯一性/互斥双向一致）
```

## 1. 为什么分成 inject 与 display 两层

同一套内容有两种读者，需求正好相反：

| | inject（注入层） | display（展示层） |
| --- | --- | --- |
| 读者 | 模型 | 人（命令面板、预览、徽章） |
| 目标 | 改变这一次回答的形状 | 帮人决定要不要选它 |
| 形态 | 定位 1 句＋硬约束 3–5 条＋输出骨架＋篇幅纪律 | 是什么／何时用／常见误用／出处 |
| 预算 | 硬上限 150 token | 不设上限，随便长 |
| 失败方式 | 占预算、把模型带偏、每轮都付钱 | 无（不注入就不花钱） |

两层在 JSON 里是**两个独立子对象**，不是一堆平铺字段：

```jsonc
{
  "id": "first-principles",
  "zh": "第一性原理",
  "en": "First Principles Thinking",
  "category": "understanding",
  "aliases": ["第一原理", "拆到不可再分", "从物理出发", "First Principles"],
  "oneliner": "拆到不可再分，再从零重建",
  "inject": {
    "positioning": "拆到不可再分的事实，再从那里重建方案。",
    "constraints": ["列出当前结论依赖的每一条假设", "标出哪条是物理或成本硬约束"],
    "skeleton": "硬事实：…（不可再分）\n惯例假设：…（可删）\n重建：…",
    "lengthDiscipline": "只重推一步结论，不做全景推演。"
  },
  "display": {
    "what": "…",
    "whenToUse": "…",
    "misuse": "…",
    "source": "…"
  },
  "conflicts": ["reverse-engineering", "analogy", "assumption-busting"]
}
```

校验器会对两层做**泄漏检查**：`display` 任一段的前 24 字只要出现在注入文本里就报错（E083）。
这条不是洁癖——展示层是给人看的解释性长句，混进 prompt 既占预算又会让模型开始"讲解方法论"而不是"用方法论"。

## 2. 注入层的四条写作纪律

1. **定位句只回答"用我干什么"**，一句话，不超过 40 字，不要出现"本方法论"这种自我介绍。
2. **硬约束必须动词开头、且可判定做到了没有**。反例：「论据要清晰」——无法判定；正例：「按一种顺序排列同层并注明」。
   校验器用动词前缀白名单给 W060 警告（启发式，不是真理，但 65 条警告清空过一次是真的改好了）。
3. **骨架是该方法的标志性结构**，≤ 6 行、≤ 80 字，用 `…` 占位而不是示例内容。骨架不是模板，不该让模型照抄文字。
4. **篇幅纪律只约束结构复杂度，不加长度**。写"只重推一步结论"，不写"请详细展开三点"。

> 一句总结：注入层要求"更短、更硬、更像指令"；展示层要求"更长、更软、更像说明"。两层混写是这类产品最常见的死法。

## 3. 预算：150 还是 400

两条约束同时存在，我们取了更严的一条：

- T1 探针（`PROBE.md`）测出官方 `systemPrompt.context()` 通道对单条 runtime-context 文本的软上限是 **400 token**；
- T4 产品要求注入层 **≤ 150 token**。

取 150 的理由：注入是**每一轮都付**的固定成本，且和用户真实问题抢注意力。400 是"框架不会截断你"的技术边界，不是"你应该用满"的产品预算。
`injectionBudget.maxTokens = 150` 写在 JSON 里，校验器按它卡线；将来若要放宽，改这一处即可，但请同时改本节说明。

估算方法刻意保守（`estimateTokens()`）：汉字与全角标点每个算 1 token，其余每 4 字符算 1 token。
真实 BPE 对中文通常略低于 1 token/字，所以这是上限估计。当前实测：min 83 / mean 102.8 / max 117（`elenchus`）。
第二批起执行更严的内部线：**新增条目不得超过既有最长的 117 token**（实际全部 ≤114），避免"每次加一条就把上限顶高一点"的棘轮效应。

## 4. aliases：让人用大白话搜到

用户不会搜 `MECE`，会搜「逻辑树」；不会搜 `elevator pitch`，会搜「60 秒电梯演讲」。
规则：

- 每条 3–8 个，单个 ≤ 20 字；
- 方法内不重复，**全局归一化后唯一**（忽略大小写、空格、连字符、间隔号），否则两个方法会抢同一个搜索词（E046）；
- 至少一个不是中英文正式名（W041），否则等于没写别名；
- 别名不得等于另一个方法的 id（E047）。

## 5. 互斥表：冲突必须给出裁决，不能只说"互斥"

`conflicts` 是双向声明：A 写了 B，B 就必须写 A（E121）。光有边没有用——用户同时需要两种方法时，模型会随机倒向一边。所以每一对都必须配一条可执行裁决：

```jsonc
{
  "pair": ["first-principles", "reverse-engineering"],
  "rule": "问「为什么必须这么贵/有没有别的物理路径」用第一性原理；问「这个成品怎么实现/成本构成是什么」用逆向工程。",
  "preferred": "reverse-engineering",
  "preferWhen": "用户手上有可拆解的实物、代码或流程，且目标是把成本或结构讲清楚。"
}
```

- `rule` ≥ 20 字，必须是**判断条件**（问什么问题选哪个），不是"两者互补，可结合使用"这种废话（E136）；
- `preferred` 必须是 `pair` 中的一方，或 `null`（表示看条件，不预设倾向）；
- 声明集合与规则集合必须**严格互相覆盖**（E140/E141）——多一条少一条都算错，防止有人加了新互斥却忘了写裁决。

当前 43 组。第一批示例：`first-principles × analogy`（要重建成因时用前者，要快速借他域解法时用后者）、
`expected-value × minimax-regret`（概率可估用前者，概率不可估且不可承受损失用后者）、
`eisenhower × rice`（先分象限再排序，同一轮只用一个，避免两套打分互相污染）。
第二批补的典型裁决：`swot × pestel`（先扫外部再填四格）、`occams-razor × hanlons-razor`（前者定机制、后者定归因）、
`toyota-a3 × five-why`（A3 是载体、五问是根因段手法，可嵌套不可并列）、`design-sprint × design-thinking`
（冲刺内部按双钻走，只输出五天安排）、`user-story-map × jtbd`（先 JTBD 后地图，反了只剩功能）。

## 6. 新增一条方法的清单

1. 选 `category`（六类之一），`id` 用小写 kebab-case，**一旦发布不再改名**——徽章回链与 trace 都存 id；
2. 写 `oneliner`（8–16 个汉字，一句说清"它让你做什么"）；
3. 写 `inject`：定位句 1 句 + 3–5 条动词开头的硬约束 + 骨架 + 篇幅纪律，跑 `--print` 看真实注入文本；
4. 写 `display` 四段，`source` 要能给出来源（书名/论文/提出者），不许写"业界常用";
5. 补 `aliases`，至少一个口语说法；
6. 若要声明互斥，**两边都写** `conflicts`，并在 `conflictRules` 加一条带判断条件的裁决；
7. 跑校验，0 error 才算完成。

## 7. 校验

```bash
node scripts/validate-catalog.mjs                # 全量报告（分类分布、token 分布、错误/警告）
node scripts/validate-catalog.mjs --print mece   # 打印某条方法的真实注入文本与 token 估算
node scripts/validate-catalog.mjs --json         # 机器可读，CI 用；有 error 时 exit 1
```

错误码分段：`E0xx` 顶层与分类、`E02x` 方法骨架、`E04x` aliases、`E05x` oneliner、
`E06x–E08x` 注入层（含预算与泄漏）、`E09x` 展示层、`E1xx` 互斥与裁决。`W0xx` 全部是可以带着发的提示。

## 8. 与 Host 的集成契约（给 T2）

- **只注入 `inject` 四段**，顺序固定 `positioning → constraints… → skeleton → lengthDiscipline`，用 `\n` 连接（`--print` 的输出就是标准形态）；
- 包裹标签由 Host 加，方法数据里**不含**任何 `<methodology>` 字样（E082 会拦住）；
- 渲染结果必须对同一方法**逐字节稳定**：框架用文本快照去重，多一个空格就会每轮重新注入；
- `catalog` 与 `trace` 只暴露 `id/zh/aliases/category/oneliner` 与 `display`，`inject` 只在注入时用，不要经 API 回传；
- 构建时需把本文件带到 `lib/` 旁边（`tsc` 默认不复制 JSON）：`cp catalog/methods.json lib/catalog/`，
  或 Host 侧用 `readFileSync(join(__dirname, 'catalog/methods.json'))` 读取；两处路径以 T2 的构建脚本为准。
