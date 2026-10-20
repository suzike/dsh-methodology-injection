#!/usr/bin/env node
/**
 * 方法论目录校验器（T4）
 *
 * 只做一件事：证明 catalog/methods.json 可以安全地被 Host 注入。
 * 零依赖，Node ≥ 18。
 *
 *   node scripts/validate-catalog.mjs                 # 全量校验 + 报告
 *   node scripts/validate-catalog.mjs --print mece     # 打印该方法真实注入文本
 *   node scripts/validate-catalog.mjs --json           # 机器可读报告
 *
 * 校验项（错误即 exit 1）：
 *   1. 结构：顶层字段、六大类齐全、方法数 ≥ 42、每类 ≥ 5
 *   2. 字段：id/zh/en/category/aliases/oneliner/inject/display/conflicts 齐全，且
 *      - 方法对象不允许出现 inject/display 之外的"裸字段"（防止展示层漏到注入层）
 *      - inject 与 display 的键必须精确匹配，不许多也不许少
 *   3. id：kebab-case、全局唯一
 *   4. aliases：≥3、单条 ≤20 字、方法内不重复、全局不冲突（大小写/空格归一化），
 *      且不能等于任何方法的 id；至少一条不是中英文正式名（保证口语别名可搜）
 *   5. oneliner：8–16 个汉字
 *   6. inject：约束 3–5 条、每条 ≤28 字；骨架 ≤80 字且 ≤6 行；篇幅纪律 ≤30 字
 *   7. 注入层 token 估算 ≤ injectionBudget.maxTokens（保守估算，汉字每字 1 token）
 *   8. 注入层不得包含展示层原文、不得包含占位符/代码块/包裹标签
 *   9. conflicts 双向一致：A 声明 B ⇔ B 声明 A ⇔ conflictRules 恰有一条对应裁决
 *  10. 每条裁决规则 ≥20 字，preferred 必须是 pair 中的一方
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CATALOG_PATH = resolve(HERE, '../catalog/methods.json')

const REQUIRED_CATEGORIES = ['expression', 'understanding', 'reasoning', 'decision', 'innovation', 'interaction']
const METHOD_KEYS = ['id', 'zh', 'en', 'category', 'aliases', 'oneliner', 'inject', 'display', 'conflicts']
const INJECT_KEYS = ['positioning', 'constraints', 'skeleton', 'lengthDiscipline']
const DISPLAY_KEYS = ['what', 'whenToUse', 'misuse', 'source']
const VERB_PREFIXES = [
  '先', '把', '用', '给', '写', '列', '标', '排', '删', '查', '检', '量', '注', '禁', '只', '每', '按',
  '从', '以', '在', '不', '分', '让', '做', '留', '说', '读', '追', '问', '答', '比', '对', '推', '反',
  '重', '补', '圈', '画', '定', '收', '算', '取', '逐', '确', '判', '假', '设', '摊', '接', '拆', '控',
  '识', '固', '归', '统', '回', '保', '落', '引', '选', '挑', '描', '勾', '换', '证', '核', '抽', '摊',
]

/** CJK 与全角标点按 1 token 计；其余每 4 字符计 1 token。刻意保守。 */
function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    const isWide =
      (cp >= 0x3000 && cp <= 0x303f) || // CJK 标点
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) || // 汉字
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef) || // 全角
      (cp >= 0x2000 && cp <= 0x206f) // 通用标点（…—等）
    if (isWide) cjk += 1
    else other += 1
  }
  return cjk + Math.ceil(other / 4)
}

function cjkCount(text) {
  let n = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) n += 1
  }
  return n
}

function charLen(s) {
  return [...s].length
}

function normAlias(s) {
  return s.trim().toLowerCase().replace(/[\s\u3000_\-·]/g, '')
}

function buildInjectText(method) {
  const i = method.inject
  return [i.positioning, ...i.constraints, i.skeleton, i.lengthDiscipline].join('\n')
}

function sortedPair(a, b) {
  return [a, b].slice().sort().join(' + ')
}

function loadCatalog() {
  const raw = readFileSync(CATALOG_PATH, 'utf8')
  return JSON.parse(raw)
}

function validate(catalog) {
  const errors = []
  const warnings = []
  const stats = {}

  const err = (code, where, msg) => errors.push({ code, where, msg })
  const warn = (code, where, msg) => warnings.push({ code, where, msg })

  // ---------- 1. 顶层结构 ----------
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    err('E001', 'root', '目录必须是 JSON 对象')
    return { errors, warnings, stats }
  }
  for (const key of ['schemaVersion', 'injectionBudget', 'categories', 'methods', 'conflictRules']) {
    if (!(key in catalog)) err('E002', 'root', `缺少顶层字段 ${key}`)
  }
  if (catalog.schemaVersion !== 1) err('E003', 'root', 'schemaVersion 必须为 1')

  const budget = catalog.injectionBudget
  const maxTokens = budget && typeof budget.maxTokens === 'number' ? budget.maxTokens : NaN
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    err('E004', 'injectionBudget', 'injectionBudget.maxTokens 必须是正数')
  }
  stats.maxTokens = maxTokens

  // ---------- 2. 分类 ----------
  const categories = Array.isArray(catalog.categories) ? catalog.categories : []
  const catIds = new Set()
  for (const [i, c] of categories.entries()) {
    const where = `categories[${i}]`
    if (!c || typeof c !== 'object') { err('E010', where, '分类必须是对象'); continue }
    if (typeof c.id !== 'string' || !c.id) err('E011', where, '分类缺少 id')
    else if (catIds.has(c.id)) err('E012', where, `分类 id 重复：${c.id}`)
    else catIds.add(c.id)
    for (const k of ['zh', 'en', 'intent']) {
      if (typeof c[k] !== 'string' || !c[k].trim()) err('E013', where, `分类缺少 ${k}`)
    }
  }
  for (const id of REQUIRED_CATEGORIES) {
    if (!catIds.has(id)) err('E014', 'categories', `缺少必备分类 ${id}`)
  }
  for (const id of catIds) {
    if (!REQUIRED_CATEGORIES.includes(id)) warn('W010', 'categories', `额外分类 ${id}（确认不是拼写错误）`)
  }

  // ---------- 3. 方法 ----------
  const methods = Array.isArray(catalog.methods) ? catalog.methods : []
  if (methods.length < 42) err('E020', 'methods', `方法数 ${methods.length} < 42`)

  const byId = new Map()
  const aliasIndex = new Map()
  const perCategory = new Map()
  const tokenStats = []

  for (const [idx, m] of methods.entries()) {
    const where = `methods[${idx}]${m && m.id ? `(${m.id})` : ''}`
    if (!m || typeof m !== 'object' || Array.isArray(m)) { err('E021', where, '方法必须是对象'); continue }

    // 3.1 键集合
    for (const k of Object.keys(m)) {
      if (!METHOD_KEYS.includes(k)) err('E022', where, `不允许的顶层键 ${k}（两层必须分开存：展示内容只能放 display）`)
    }
    for (const k of METHOD_KEYS) {
      if (!(k in m)) err('E023', where, `缺少字段 ${k}`)
    }

    // 3.2 id
    if (typeof m.id !== 'string' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(m.id)) {
      err('E024', where, 'id 必须是小写 kebab-case')
    } else if (byId.has(m.id)) {
      err('E025', where, `id 重复：${m.id}`)
    } else {
      byId.set(m.id, m)
    }

    // 3.3 名称
    if (typeof m.zh !== 'string' || !m.zh.trim()) err('E030', where, '缺少中文名 zh')
    else if (cjkCount(m.zh) === 0) err('E031', where, 'zh 必须包含汉字')
    if (typeof m.en !== 'string' || !m.en.trim()) err('E032', where, '缺少英文名 en')

    // 3.4 分类
    if (!catIds.has(m.category)) err('E033', where, `category 不存在：${m.category}`)
    else perCategory.set(m.category, (perCategory.get(m.category) ?? 0) + 1)

    // 3.5 aliases
    if (!Array.isArray(m.aliases)) {
      err('E040', where, 'aliases 必须是数组')
    } else {
      if (m.aliases.length < 3) err('E041', where, `aliases 至少 3 条（当前 ${m.aliases.length}）`)
      if (m.aliases.length > 8) warn('W040', where, `aliases 过多（${m.aliases.length}），检索会变噪音`)
      const local = new Set()
      let hasColloquial = false
      for (const a of m.aliases) {
        if (typeof a !== 'string' || !a.trim()) { err('E042', where, 'alias 必须是非空字符串'); continue }
        if (charLen(a.trim()) > 20) err('E043', where, `alias 过长（${charLen(a.trim())} 字）：${a}`)
        const n = normAlias(a)
        if (!n) { err('E044', where, 'alias 归一化后为空'); continue }
        if (local.has(n)) err('E045', where, `alias 方法内重复：${a}`)
        local.add(n)
        if (n !== normAlias(m.zh ?? '') && n !== normAlias(m.en ?? '')) hasColloquial = true
        const owner = aliasIndex.get(n)
        if (owner && owner !== m.id) err('E046', where, `alias 与 ${owner} 冲突：${a}`)
        else if (!owner) aliasIndex.set(n, m.id)
      }
      if (!hasColloquial) warn('W041', where, 'aliases 全是正式名，用户用口语搜不到')
    }
    for (const a of m.aliases ?? []) {
      if (typeof a === 'string' && byId.has(normAlias(a)) && normAlias(a) !== m.id) {
        // 只有当 alias 恰好等于另一个方法的 id 时才可疑
        err('E047', where, `alias 与另一个方法的 id 同名：${a}`)
      }
    }

    // 3.6 oneliner
    if (typeof m.oneliner !== 'string' || !m.oneliner.trim()) {
      err('E050', where, '缺少 oneliner')
    } else {
      if (/[\r\n]/.test(m.oneliner)) err('E051', where, 'oneliner 必须单行')
      const n = cjkCount(m.oneliner)
      if (n < 8 || n > 16) err('E052', where, `oneliner 汉字数 ${n}，要求 8–16：${m.oneliner}`)
    }

    // 3.7 inject
    const inj = m.inject
    if (!inj || typeof inj !== 'object' || Array.isArray(inj)) {
      err('E060', where, '缺少 inject 对象')
    } else {
      for (const k of Object.keys(inj)) {
        if (!INJECT_KEYS.includes(k)) err('E061', where, `inject 不允许的键 ${k}`)
      }
      for (const k of INJECT_KEYS) if (!(k in inj)) err('E062', where, `inject 缺少 ${k}`)

      if (typeof inj.positioning !== 'string' || !inj.positioning.trim()) err('E063', where, 'positioning 为空')
      else if (charLen(inj.positioning) > 40) err('E064', where, `positioning 过长（${charLen(inj.positioning)} 字）`)

      if (!Array.isArray(inj.constraints)) {
        err('E065', where, 'constraints 必须是数组')
      } else {
        if (inj.constraints.length < 3 || inj.constraints.length > 5) {
          err('E066', where, `constraints 数量 ${inj.constraints.length}，要求 3–5`)
        }
        const seen = new Set()
        for (const c of inj.constraints) {
          if (typeof c !== 'string' || !c.trim()) { err('E067', where, 'constraint 必须是非空字符串'); continue }
          const s = c.trim()
          if (charLen(s) > 28) err('E068', where, `constraint 过长（${charLen(s)} 字）：${s}`)
          if (seen.has(s)) err('E069', where, `constraint 重复：${s}`)
          seen.add(s)
          if (!VERB_PREFIXES.includes(s[0])) warn('W060', where, `constraint 可能不是动词开头：${s}`)
          if (/[。；;]$/.test(s)) warn('W061', where, `constraint 结尾有句读，浪费 token：${s}`)
        }
      }

      if (typeof inj.skeleton !== 'string' || !inj.skeleton.trim()) {
        err('E070', where, 'skeleton 为空')
      } else {
        if (charLen(inj.skeleton) > 80) err('E071', where, `skeleton 过长（${charLen(inj.skeleton)} 字）`)
        const lines = inj.skeleton.split('\n').length
        if (lines > 6) err('E072', where, `skeleton 行数 ${lines} > 6`)
      }

      if (typeof inj.lengthDiscipline !== 'string' || !inj.lengthDiscipline.trim()) {
        err('E073', where, 'lengthDiscipline 为空')
      } else if (charLen(inj.lengthDiscipline) > 30) {
        err('E074', where, `lengthDiscipline 过长（${charLen(inj.lengthDiscipline)} 字）`)
      }

      // 3.8 注入层预算
      if (errors.every((e) => !e.where.startsWith(where))) {
        const text = buildInjectText(m)
        const tokens = estimateTokens(text)
        tokenStats.push({ id: m.id, tokens, chars: charLen(text) })
        if (tokens > maxTokens) {
          err('E080', where, `注入层估算 ${tokens} token > 上限 ${maxTokens}`)
        }
        if (/\n{3,}/.test(text)) err('E081', where, '注入层出现连续空行')
        for (const bad of ['{{', '}}', 'TODO', '```', '<methodology', '</methodology>']) {
          if (text.includes(bad)) err('E082', where, `注入层包含禁止内容：${bad}`)
        }
        // 展示层原文不得出现在注入层
        for (const k of DISPLAY_KEYS) {
          const v = m.display?.[k]
          if (typeof v === 'string' && v.length >= 12) {
            const probe = v.slice(0, Math.min(24, v.length))
            if (text.includes(probe)) err('E083', where, `注入层包含展示层内容（${k}）`)
          }
        }
      }
    }

    // 3.9 display
    const disp = m.display
    if (!disp || typeof disp !== 'object' || Array.isArray(disp)) {
      err('E090', where, '缺少 display 对象')
    } else {
      for (const k of Object.keys(disp)) {
        if (!DISPLAY_KEYS.includes(k)) err('E091', where, `display 不允许的键 ${k}`)
      }
      for (const k of DISPLAY_KEYS) {
        const v = disp[k]
        if (typeof v !== 'string' || !v.trim()) err('E092', where, `display.${k} 为空`)
        else if (charLen(v.trim()) < 14) err('E093', where, `display.${k} 太短（${charLen(v.trim())} 字），像占位符`)
      }
    }

    // 3.10 conflicts
    if (!Array.isArray(m.conflicts)) {
      err('E100', where, 'conflicts 必须是数组')
    } else {
      const seen = new Set()
      for (const c of m.conflicts) {
        if (typeof c !== 'string') { err('E101', where, 'conflicts 元素必须是 id 字符串'); continue }
        if (c === m.id) err('E102', where, 'conflicts 不能包含自己')
        if (seen.has(c)) err('E103', where, `conflicts 重复：${c}`)
        seen.add(c)
      }
    }
  }

  // 4. 每类方法数
  for (const id of REQUIRED_CATEGORIES) {
    const n = perCategory.get(id) ?? 0
    if (n < 5) err('E110', 'categories', `分类 ${id} 只有 ${n} 条方法（要求 ≥5）`)
  }

  // 5. conflicts 双向一致 + 裁决表完全覆盖
  const declared = new Set()
  for (const m of methods) {
    if (!m || !m.id || !Array.isArray(m.conflicts)) continue
    for (const other of m.conflicts) {
      const o = byId.get(other)
      if (!o) { err('E120', `methods(${m.id})`, `conflicts 指向不存在的方法 ${other}`); continue }
      const back = Array.isArray(o.conflicts) ? o.conflicts : []
      if (!back.includes(m.id)) err('E121', `methods(${m.id})`, `${m.id} 声明与 ${other} 互斥，但 ${other} 未反向声明`)
      declared.add(sortedPair(m.id, other))
    }
  }

  const rules = Array.isArray(catalog.conflictRules) ? catalog.conflictRules : []
  const ruleKeys = new Set()
  for (const [idx, r] of rules.entries()) {
    const where = `conflictRules[${idx}]`
    if (!r || typeof r !== 'object') { err('E130', where, '规则必须是对象'); continue }
    if (!Array.isArray(r.pair) || r.pair.length !== 2) { err('E131', where, 'pair 必须是两个 id'); continue }
    const [a, b] = r.pair
    if (!byId.has(a)) err('E132', where, `pair 中的 ${a} 不存在`)
    if (!byId.has(b)) err('E133', where, `pair 中的 ${b} 不存在`)
    if (a === b) err('E134', where, 'pair 不能是同一个方法')
    const key = sortedPair(a, b)
    if (ruleKeys.has(key)) err('E135', where, `裁决重复：${key}`)
    ruleKeys.add(key)
    if (typeof r.rule !== 'string' || charLen(r.rule.trim()) < 20) {
      err('E136', where, '裁决规则必须是 ≥20 字的可执行判断，不能只写"互斥"')
    }
    if (r.preferred !== null && r.preferred !== undefined) {
      if (r.preferred !== a && r.preferred !== b) err('E137', where, 'preferred 必须是 pair 中的一方')
    }
    if (r.preferWhen !== null && typeof r.preferWhen !== 'string') {
      err('E138', where, 'preferWhen 必须是字符串或 null')
    }
    if ((r.preferred === null || r.preferred === undefined) && r.preferWhen) {
      warn('W130', where, 'preferWhen 存在但没有 preferred，规则会含糊')
    }
  }
  for (const key of declared) {
    if (!ruleKeys.has(key)) err('E140', 'conflictRules', `互斥对 ${key} 缺少裁决规则`)
  }
  for (const key of ruleKeys) {
    if (!declared.has(key)) err('E141', 'conflictRules', `裁决规则 ${key} 没有对应的方法 conflicts 声明`)
  }

  // 6. 统计
  stats.methodCount = methods.length
  stats.categoryCount = Object.fromEntries([...perCategory.entries()].sort())
  stats.aliasCount = aliasIndex.size
  stats.conflictPairCount = declared.size
  stats.token = {
    max: tokenStats.length ? Math.max(...tokenStats.map((t) => t.tokens)) : 0,
    min: tokenStats.length ? Math.min(...tokenStats.map((t) => t.tokens)) : 0,
    mean: tokenStats.length ? Math.round((tokenStats.reduce((s, t) => s + t.tokens, 0) / tokenStats.length) * 10) / 10 : 0,
    top: tokenStats.slice().sort((x, y) => y.tokens - x.tokens).slice(0, 5),
  }
  stats.perMethodTokens = tokenStats

  return { errors, warnings, stats, byId }
}

function printReport(result, catalog) {
  const { errors, warnings, stats } = result
  console.log('方法论目录校验')
  console.log(`  文件：${CATALOG_PATH}`)
  console.log(`  方法 ${stats.methodCount} 条｜分类 ${Object.keys(stats.categoryCount).length} 个｜互斥对 ${stats.conflictPairCount} 组｜别名 ${stats.aliasCount} 个`)
  console.log('  分类分布：')
  for (const [id, n] of Object.entries(stats.categoryCount)) console.log(`    ${id.padEnd(14)} ${n}`)
  console.log(`  注入层 token（汉字=1 保守估算，上限 ${stats.maxTokens}）：min ${stats.token.min}｜mean ${stats.token.mean}｜max ${stats.token.max}`)
  console.log('  最长五条：')
  for (const t of stats.token.top) console.log(`    ${t.id.padEnd(22)} ${String(t.tokens).padStart(3)} token / ${t.chars} 字`)

  if (warnings.length) {
    console.log(`\n警告 ${warnings.length} 条：`)
    for (const w of warnings) console.log(`  [${w.code}] ${w.where} — ${w.msg}`)
  }
  if (errors.length) {
    console.log(`\n错误 ${errors.length} 条：`)
    for (const e of errors) console.log(`  [${e.code}] ${e.where} — ${e.msg}`)
  } else {
    console.log('\n结果：通过（0 error）')
  }
  return errors.length === 0
}

function printContract(result, id) {
  const m = result.byId.get(id)
  if (!m) {
    console.error(`找不到方法：${id}`)
    process.exit(2)
  }
  const text = buildInjectText(m)
  const tokens = estimateTokens(text)
  console.log(`# ${m.zh} (${m.id})｜${m.category}｜估算 ${tokens} token`)
  console.log('# 下面这段之外，Host 只允许加一层包裹标签，不得再拼任何展示层字段。')
  console.log('--- injected text ---')
  console.log(text)
  console.log('--- end ---')
}

const args = process.argv.slice(2)
let catalog
try {
  catalog = loadCatalog()
} catch (e) {
  console.error(`[E000] 无法读取或解析 ${CATALOG_PATH}\n${e.message}`)
  process.exit(1)
}

const result = validate(catalog)

if (args.includes('--json')) {
  const out = {
    ok: result.errors.length === 0,
    errors: result.errors,
    warnings: result.warnings,
    stats: { ...result.stats, perMethodTokens: undefined },
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  process.exit(out.ok ? 0 : 1)
}

const printIdx = args.indexOf('--print')
if (printIdx !== -1) {
  const ok = printReport(result, catalog)
  console.log('')
  printContract(result, args[printIdx + 1])
  process.exit(ok ? 0 : 1)
}

const ok = printReport(result, catalog)
process.exit(ok ? 0 : 1)
