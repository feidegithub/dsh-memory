/**
 * dsh-memory —— host 半端
 * ============================================================================
 * 一个"会遗忘、但永不删除"的记忆插件。设计见 docs/memory-system-design.md。
 *
 * 五层里 M1 已实现：
 *   L1 常驻核心   → systemPrompt.context 每步注入（≤600 token）
 *   L2 热区/复习  → 7 天内碰过的条目加权 + 提及/想起的间隔复习
 *   L3 长期库     → bigram 倒排 + 强度/熟练度排序
 *   L5 规则联想   → 2s/6s/15s/30s/45s/57s 逐级放宽（**不调模型**）
 *   ⏰ 60 秒硬窗  → 到点没命中 = forgotten，写 miss
 *   L4 原始日志（sessionQuery 深挖）留给 M2。
 *
 * 不变量：
 *   - 遗忘 ≠ 删除：条目永远留在 entries.jsonl，只是 strength 变低、默认搜不到。
 *   - 写入不同步调模型：抽取是纯正则，写入是 append，turn 不因此变慢。
 *   - 记忆不是指令：注入文本明确声明"以章程与使用者为准"。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const hostDeps = await loadHostDeps()
const z = hostDeps.z
const defineTool = hostDeps.defineTool

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_STORAGE_DIR, ensureLayout, layout, logLine, readJson, resolveStorageDir, writeJsonAtomic } from './lib/paths.mjs'
import { MemoryStore } from './lib/store.mjs'
import { RecallEngine } from './lib/recall.mjs'
import { Stats } from './lib/stats.mjs'
import { extract, SENSITIVE } from './lib/extract.mjs'
import { clamp, describeEntry, layerOf, strengthAt } from './lib/model.mjs'
import { estimateTokens } from './lib/tokenize.mjs'
import { resolveConfig, toBool, toNum, toStr } from './lib/config.mjs'
import { DeepSearch } from './lib/deep.mjs'
import { FileLogSearch } from './lib/l4files.mjs'
import { Consolidator, readLastReport } from './lib/consolidate.mjs'
import { readBody, parseUrl, sendJson } from './lib/http.mjs'

export const name = 'memory'
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULTS = {
  enabled: true,
  storageDir: DEFAULT_STORAGE_DIR,
  autoRecall: 'fast',
  coreBudgetTokens: 600,
  warmBudgetTokens: 1200,
  recallLimit: 8,
  recallDeadlineMs: 60000,
  extractMode: 'heuristic',   // heuristic | off
  minImportance: 2,
  allowModel: false,          // D2：联想段只许规则
  debug: false,
  // ── M2 ──
  deepSearch: true,           // L4：历史会话原文深挖（用宿主 sessionQuery）
  distillHistory: true,       // L4 命中后沉淀成条目，下次更快
  remineMisses: true,         // 夜间拿 miss 反挖
  archiveAfterDays: 180,
  archiveBelowStrength: 0.12,
  consolidateAt: '03:30',
  maxEntries: 20000,          // 活条目上限：超了在巩固时归档最弱的
  maxFileMB: 8,               // entries.jsonl 超过就压缩
  catchUpOnStart: true,       // 启动时补跑错过的巩固
  coldBackupDir: '',          // 冷备目录（外挂盘）；留空 = 不做冷备
}

const num = (v, d) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : d
}

/** 设置页表单：每个字段都必须 .extra('volatile', true)，否则写设置会被拒 */
export const Config = z ? z.object({
  enabled: z.boolean().default(true).extra('volatile', true),
  storageDir: z.string().default(DEFAULT_STORAGE_DIR).extra('volatile', true),
  autoRecall: z.string().default('fast').extra('volatile', true),
  coreBudgetTokens: z.natural().default(600).extra('volatile', true),
  warmBudgetTokens: z.natural().default(1200).extra('volatile', true),
  recallLimit: z.natural().default(8).extra('volatile', true),
  recallDeadlineMs: z.natural().default(60000).extra('volatile', true),
  extractMode: z.string().default('heuristic').extra('volatile', true),
  minImportance: z.natural().default(2).extra('volatile', true),
  allowModel: z.boolean().default(false).extra('volatile', true),
  debug: z.boolean().default(false).extra('volatile', true),
  deepSearch: z.boolean().default(true).extra('volatile', true),
  distillHistory: z.boolean().default(true).extra('volatile', true),
  remineMisses: z.boolean().default(true).extra('volatile', true),
  archiveAfterDays: z.natural().default(180).extra('volatile', true),
  archiveBelowStrength: z.number().default(0.12).extra('volatile', true),
  consolidateAt: z.string().default('03:30').extra('volatile', true),
  maxEntries: z.natural().default(20000).extra('volatile', true),
  maxFileMB: z.natural().default(8).extra('volatile', true),
  catchUpOnStart: z.boolean().default(true).extra('volatile', true),
  coldBackupDir: z.string().default('').extra('volatile', true),
}) : undefined

const DEFAULT_SYNONYMS = {
  显卡: ['GPU', 'gpu', '显示卡'],
  记忆: ['memory', '记住的事', '记得'],
  工作盘: ['硬盘', '磁盘', '存储', '放东西的地方'],
  删除: ['删掉', '清掉', '移除'],
  抖音: ['douyin', '短视频'],
  主存: ['主存储', '主目录'],
  冷备: ['备份', '冷备份'],
  // 使用者自己的说法（2026-10-25 加）：问"E 盘拔了会怎样"要能想到"外挂/冷备盘/不在"
  'E 盘': ['外挂', '冷备盘', '外挂盘'],
  拔了: ['不在', '离线', '拔掉', '没插'],
}

function loadSynonyms(paths, log) {
  const existing = readJson(paths.synonyms, null)
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) return existing
  writeJsonAtomic(paths.synonyms, DEFAULT_SYNONYMS)
  log('写入默认同义词表 synonyms.json')
  return { ...DEFAULT_SYNONYMS }
}

/** 从 UserMessage 里取纯文本 */
function messageText(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

const shortId = (id) => String(id || '').replace(/^session-/, '').slice(0, 8)

export function apply(ctx, rawConfig) {
  // ⚠️ 必须解包：volatile 字段在 apply 里是 { get() } 包装器（见 lib/config.mjs 的注释）
  const cfg = resolveConfig(DEFAULTS, rawConfig)

  const root = resolveStorageDir(toStr(cfg.storageDir, DEFAULT_STORAGE_DIR))
  // 数字/布尔/字符串统一收成纯值，后面就不必到处 Number()/!! 了
  cfg.enabled = toBool(cfg.enabled, true)
  cfg.coreBudgetTokens = toNum(cfg.coreBudgetTokens, 600)
  cfg.warmBudgetTokens = toNum(cfg.warmBudgetTokens, 1200)
  cfg.recallLimit = toNum(cfg.recallLimit, 8)
  cfg.recallDeadlineMs = Math.min(60000, Math.max(1000, toNum(cfg.recallDeadlineMs, 60000)))
  cfg.minImportance = toNum(cfg.minImportance, 2)
  cfg.extractMode = toStr(cfg.extractMode, 'heuristic')
  cfg.autoRecall = toStr(cfg.autoRecall, 'fast')
  cfg.allowModel = toBool(cfg.allowModel, false)
  cfg.deepSearch = toBool(cfg.deepSearch, true)
  cfg.distillHistory = toBool(cfg.distillHistory, true)
  cfg.remineMisses = toBool(cfg.remineMisses, true)
  cfg.archiveAfterDays = toNum(cfg.archiveAfterDays, 180)
  cfg.archiveBelowStrength = toNum(cfg.archiveBelowStrength, 0.12)
  cfg.consolidateAt = toStr(cfg.consolidateAt, '03:30')
  cfg.maxEntries = Math.max(1000, toNum(cfg.maxEntries, 20000))
  cfg.maxFileMB = Math.max(1, toNum(cfg.maxFileMB, 8))
  cfg.maxFileBytes = cfg.maxFileMB * 1024 * 1024
  cfg.catchUpOnStart = toBool(cfg.catchUpOnStart, true)
  cfg.coldBackupDir = toStr(cfg.coldBackupDir, '')

  const paths = layout(root)
  ensureLayout(paths)

  const bootLog = (msg) => logLine(paths.log, msg)
  bootLog(`启动：root=${root}；hostdeps=${[...new Set(hostDeps.notes)].join(' | ') || 'ok'}`)

  if (!toBool(cfg.enabled, true)) {
    bootLog('enabled=false → 不加载记忆（条目仍在磁盘上）')
    return
  }

  const stats = new Stats({ paths, log: bootLog })
  const store = new MemoryStore({ cfg, paths, log: bootLog }).load()
  const synonyms = loadSynonyms(paths, bootLog)

  // L4：可选依赖 —— 拿不到 sessionQuery 就自己扫日志文件；两条都不行就只剩 L1/L3/阶梯
  const deep = cfg.deepSearch
    ? new DeepSearch({
      getService: () => (typeof ctx.get === 'function' ? ctx.get('sessionQuery') : ctx.sessionQuery),
      log: bootLog,
      fallback: new FileLogSearch({ log: bootLog }),
    })
    : null
  const engine = new RecallEngine({ store, cfg, stats, paths, log: bootLog, synonyms, deep })
  const consolidator = new Consolidator({ store, stats, paths, deep, cfg, log: bootLog })

  // 补跑：App 没开到 03:30 的话，那颗定时器就错过了；启动后补一次（15 秒后，别拖慢启动）
  if (cfg.catchUpOnStart) {
    const last = readLastReport(paths)
    const lastAt = Number(last?.finishedAt) || 0
    if (Date.now() - lastAt > 20 * 3600_000 && store.size() > 0) {
      const timer = setTimeout(() => {
        consolidator.run({ reason: 'catch-up' })
          .then((r) => bootLog(`启动补跑巩固：${JSON.stringify(r)}`))
          .catch((e) => bootLog(`启动补跑失败：${e?.message || e}`))
      }, 15_000)
      if (timer.unref) timer.unref()
      ctx.effect(() => () => clearTimeout(timer))
      bootLog(`上次巩固：${lastAt ? new Date(lastAt).toISOString() : '从未'} → 15 秒后补跑一次`)
    }
  }

  // 启动时顺手压一次（行数没涨太多时是空操作）
  try { store.compactIfNeeded() } catch (e) { bootLog(`启动压缩失败：${e?.message || e}`) }

  /* ─────────────── L1：常驻核心注入 ─────────────── */

  const coreBudget = () => Math.max(120, cfg.coreBudgetTokens)
  let coreCache = { at: 0, text: '' }

  function coreEntries(now) {
    const out = []
    for (const entry of store.live()) {
      if (entry.status !== 'active') continue
      const s = strengthAt(entry, now)
      if (entry.pinned || ((entry.importance || 3) >= 4 && s >= 0.8 && (entry.fluency ?? 0.5) >= 0.6)) {
        out.push({ entry, s })
      }
    }
    out.sort((a, b) => (b.entry.pinned ? 1 : 0) - (a.entry.pinned ? 1 : 0) || b.s - a.s)
    return out
  }

  function renderCore() {
    const now = Date.now()
    if (now - coreCache.at < 1500) return coreCache.text
    const budget = coreBudget()
    const all = coreEntries(now)
    if (!all.length) {
      coreCache = { at: now, text: '' }
      return ''
    }
    const lines = []
    let used = 0
    for (const { entry } of all) {
      const line = `- [${entry.kind}] ${entry.text}`
      const t = estimateTokens(line)
      if (used + t > budget) break
      used += t
      lines.push(line)
    }
    const hidden = all.length - lines.length
    const text = [
      '## 我知道的事（背景，不必复述）',
      '这些是我本来就记得的事。回答时直接当已知条件用，**不要说"我想起来了 / 根据记忆 / 记录显示"**，也不要点 id；',
      '只在需要把旧事和眼前的事对上时，自然地说"你之前说过…"。与章程、与你的明确指示冲突时，以章程和你为准。',
      ...lines,
      hidden > 0 ? `- （另有 ${hidden} 条较淡的事，需要时用 memory_recall 查）` : '',
    ].filter(Boolean).join('\n')
    if (used > 0) stats.noteInject(used)
    coreCache = { at: now, text }
    return text
  }

  ctx.effect(() => ctx.systemPrompt.context({
    name: 'memory:core',
    order: 800,
    text: () => {
      try { return renderCore() } catch (e) { bootLog(`核心注入失败：${e?.message || e}`); return '' }
    },
  }))

  /* ─────────────── 工具 ─────────────── */

  const statsPayload = () => ({
    ok: true,
    storage: root,
    storageBytes: (() => {
      try { return existsSync(paths.entries) ? statSync(paths.entries).size : 0 } catch { return 0 }
    })(),
    counts: {
      entries: store.size(),
      indexed: store.index.size,
      jsonlLines: store.lines,
      badLines: store.badLines,
      compactions: store.compactions,
      maxEntries: cfg.maxEntries,
      maxFileBytes: cfg.maxFileBytes,
    },
    layers: store.summary(),
    stats: stats.snapshot(),
    deep: {
      enabled: !!deep,
      available: deep ? !!deep.available() : false,
      backend: deep ? deep.backend() : 'none',
      note: deep && !deep.available() ? '没有 sessionQuery、也没有会话日志目录，L4 深挖降级（只靠条目库）' : undefined,
    },
    lastConsolidation: readLastReport(paths),
    config: {
      enabled: cfg.enabled,
      autoRecall: cfg.autoRecall,
      coreBudgetTokens: coreBudget(),
      warmBudgetTokens: num(cfg.warmBudgetTokens, 1200),
      recallLimit: num(cfg.recallLimit, 8),
      recallDeadlineMs: Math.min(60000, num(cfg.recallDeadlineMs, 60000)),
      extractMode: cfg.extractMode,
      minImportance: num(cfg.minImportance, 2),
      allowModel: !!cfg.allowModel,
      deepSearch: cfg.deepSearch,
      remineMisses: cfg.remineMisses,
      archiveAfterDays: cfg.archiveAfterDays,
      archiveBelowStrength: cfg.archiveBelowStrength,
      consolidateAt: cfg.consolidateAt,
      maxEntries: cfg.maxEntries,
      maxFileMB: cfg.maxFileMB,
      catchUpOnStart: cfg.catchUpOnStart,
      coldBackupDir: cfg.coldBackupDir || '（未配置）',
    },
    hostdeps: [...new Set(hostDeps.notes)],
  })

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }
  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: textOutput,
    async execute(args, exec) { return safe(await spec.execute(args, exec)) },
  }))

  tool({
    name: 'memory_recall',
    description: '从长期记忆里回忆一件事（分层：常驻 → 热区 → 长期库 → 历史会话原文 → 规则联想）。**先给快答案**：命中就直接返回；没命中会返回 pending —— 这时先照常说话（"这个我想想"），稍后用 memory_recall_wait 收结果。超过 60 秒还没命中就算忘了。\n\n⭐ 拿到命中结果后：**当成"我本来就知道"直接用来回答**——把旧事和眼前的事对上，自然地说"你之前说过…"，**不要说"我想起来了 / 根据记忆 / 记录显示"**，也不要点 id。忘了（forgotten）就直说想不起来，别编。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆什么，用原本的说法即可（支持别名/同义词扩展）' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '最多返回几条（默认 8）' },
        include_faded: { type: 'boolean', description: '连已经淡忘（强度<0.2）的也翻出来' },
        include_archived: { type: 'boolean', description: '连已经归档（长期没想起）的也翻出来 —— 遗忘不等于删除' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: '没命中时最多先等多久再返回（默认 900ms；0 = 立刻返回 pending）' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      const cue = String(args?.query || '').trim()
      if (!cue) return { ok: false, error: 'query 不能为空' }
      const ep = engine.start(cue, {
        includeFaded: !!args.include_faded,
        includeArchived: !!args.include_archived,
        limit: args.limit,
        sessionId: exec?.agent?.id,
      })
      if (ep.result) return { ok: true, ...ep.result }
      const waitMs = clamp(num(args.wait_ms, 900), 0, 60000)
      const res = waitMs > 0 ? await engine.wait(ep.id, waitMs) : engine.snapshot(ep)
      return { ok: true, ...res }
    },
  })

  tool({
    name: 'memory_recall_wait',
    description: '收一次还没结束的回忆（memory_recall 返回 pending 时用）。等到命中或 60 秒硬窗到点；到点返回 forgotten=true，就当忘了。⚠️ 拿到了就直接当"我本来就知道"用，别把"我想起来了"说出口。',
    parameters: {
      type: 'object',
      properties: {
        episode_id: { type: 'string', description: 'memory_recall 返回的 episode_id' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 60000, description: '最多等多久（默认 5000；想看满 60 秒就传 60000）' },
      },
      required: ['episode_id'],
      additionalProperties: false,
    },
    async execute(args) {
      const id = String(args?.episode_id || '').trim()
      if (!id) return { ok: false, error: 'episode_id 不能为空' }
      const res = await engine.wait(id, clamp(num(args.wait_ms, 5000), 0, 60000))
      return { ok: true, ...res }
    },
  })

  tool({
    name: 'memory_remember',
    description: '明确记住一件事（比自动抽取更可靠）。适用于：使用者说"记住 X"、或你自己判断某件事以后一定用得上。同义/同事实会自动合并，不会记成两条。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记住的那件事，一句话说清（≤140 字最好）' },
        kind: { type: 'string', enum: ['fact', 'preference', 'episode', 'procedure', 'commitment'], description: '事实 / 偏好 / 经历 / 做法 / 约定（默认 fact）' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签，便于以后按类别找' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1–5（默认 3）' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args, exec) {
      let text = String(args?.text || '').trim()
      if (text.length < 4) return { ok: false, error: 'text 太短' }
      if (SENSITIVE.test(text)) return { ok: false, error: '看起来像凭证/敏感信息，按章程不记' }
      if (text.length > 300) text = `${text.slice(0, 299)}…`
      const at = Date.now()
      const res = store.add({
        kind: args?.kind || 'fact',
        subject: 'user',
        text,
        tags: Array.isArray(args?.tags) ? args.tags : [],
        importance: clamp(num(args?.importance, 3), 1, 5),
        confidence: 0.95,
        why: '显式记住',
        signalId: 'explicit',
        source: { sessionId: exec?.agent?.id || null, seq: null, quote: text },
        createdAt: at,
      }, { at })
      if (!res.entry) return { ok: false, error: '写入失败' }
      stats.inc('extracted')
      if (res.deduped) stats.inc('deduped')
      if (res.superseded) stats.inc('superseded')
      return {
        ok: true,
        id: res.entry.id,
        deduped: res.deduped,
        superseded: res.superseded,
        text: res.entry.text,
        importance: res.entry.importance,
        layer: layerOf(res.entry, at),
        hint: res.deduped ? '这条以前就记过，已合并（顺便复习了一次）' : '记下了',
      }
    },
  })

  tool({
    name: 'memory_consolidate',
    description: '立刻跑一次记忆巩固：归档淡忘的、合并重复的、把近 24h 会话压成情景、拿 miss 日志去历史里反挖。全部纯规则，0 次模型调用。夜里 03:30 会自动跑，这个工具用来手动触发。',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么现在跑（写进报告，方便回看）' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const report = await consolidator.run({ reason: String(args?.reason || 'manual').slice(0, 60) })
      return { ok: true, ...report }
    },
  })

  tool({
    name: 'memory_stats',
    description: '看记忆系统的账：记了多少、多少已经淡了、命中率/平均回忆耗时、今天往上下文注入多少 token、存在哪、上次巩固做了什么。只读。',
    parameters: {
  type: 'object',
  properties: {},
  additionalProperties: false,},
    execute() { return statsPayload() },
  })

  tool({
    name: 'memory_pin',
    description: '把一条记忆置顶或取消置顶。置顶的条目不衰减，会一直出现在"长期记忆"里。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目 id（memory_recall 返回的 id）' },
        pinned: { type: 'boolean', description: 'true = 置顶，false = 取消（默认 true）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute(args) {
      const entry = store.get(String(args?.id || ''))
      if (!entry) return { ok: false, error: '没有这条记忆' }
      store.setPinned(entry, args?.pinned !== false)
      return { ok: true, entry: describeEntry(entry) }
    },
  })

  tool({
    name: 'memory_update',
    description: '纠正一条记忆（原地改，保留改动历史）。用户说"不对，是 X / 记错了"时用它；比新记一条更干净——旧的不会留下来捣乱。可用 id，也可用 query 让我按内容找最像的那条。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目 id（优先用这个）' },
        query: { type: 'string', description: '没有 id 时，用它找最像的一条来改' },
        text: { type: 'string', description: '改成什么（≤300 字）' },
        kind: { type: 'string', enum: ['fact', 'preference', 'episode', 'procedure', 'commitment'], description: '顺便改类型（可省）' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '顺便改重要度（可省）' },
        tags: { type: 'array', items: { type: 'string' }, description: '顺便改标签（可省）' },
      },
      additionalProperties: false,
    },
    execute(args) {
      let entry = args?.id ? store.get(String(args.id)) : null
      if (!entry && args?.query) {
        const hits = engine.run(String(args.query), 0, { limit: 3 })
        entry = hits[0]?.entry || null
      }
      if (!entry) return { ok: false, error: '没找到要改的那条（给个 id 更稳）' }
      const before = entry.text
      const updated = store.update(entry, {
        text: args?.text,
        kind: args?.kind,
        importance: args?.importance,
        tags: Array.isArray(args?.tags) ? args.tags : undefined,
      })
      return { ok: true, before, entry: describeEntry(updated), hint: '改好了；旧内容留在 history 里，可回溯' }
    },
  })

  tool({
    name: 'memory_forget',
    description: '忘记一条记忆。默认 archive（移出默认检索，可恢复）；fade = 把强度压到最低慢慢淡出；**purge = 真删**（唯一的破坏性操作，但记忆归我自己维护，不需要事先请示）。真删只留一条不含原文的墓碑，面板里人类侧仍保留两段点击防手滑。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆条目 id' },
        mode: { type: 'string', enum: ['archive', 'fade', 'purge'], description: 'archive（默认）| fade | purge（真删）' },
        reason: { type: 'string', description: '为什么删（写进墓碑日志，方便以后回看）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute(args) {
      const entry = store.get(String(args?.id || ''))
      if (!entry) return { ok: false, error: '没有这条记忆' }
      if (args?.mode === 'purge') {
        store.purge(entry.id, Date.now(), String(args?.reason || '').slice(0, 120))
        return { ok: true, purged: true, id: entry.id, hint: '已真删，只留了一条不含原文的墓碑' }
      }
      store.forget(entry, args?.mode === 'fade' ? 'fade' : 'archive')
      return { ok: true, entry: describeEntry(entry), hint: '没有真删：include_archived 还能翻到' }
    },
  })

  tool({
    name: 'memory_import',
    description: '从导出的 JSON 文件恢复记忆（合并导入）。默认 merge：同 id 跳过；mode=replace：同 id 覆盖。文件就是「导出 JSON」出来的那份。',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '导出文件的绝对路径，例如 <记忆目录>/export-....json' },
        mode: { type: 'string', enum: ['merge', 'replace'], description: 'merge（默认，跳过已有）| replace（覆盖同 id）' },
      },
      required: ['file'],
      additionalProperties: false,
    },
    execute(args) {
      const file = String(args?.file || '').trim()
      if (!file) return { ok: false, error: 'file 不能为空' }
      if (!existsSync(file)) return { ok: false, error: `文件不存在：${file}` }
      let payload
      try {
        const size = statSync(file).size
        if (size > 20 * 1024 * 1024) return { ok: false, error: `文件太大（${(size / 1024 / 1024).toFixed(1)} MB），上限 20 MB` }
        payload = JSON.parse(readFileSync(file, 'utf8'))
      } catch (e) {
        return { ok: false, error: `读不动这个文件：${e?.message || e}` }
      }
      const rows = Array.isArray(payload) ? payload : payload?.entries
      if (!Array.isArray(rows)) return { ok: false, error: '这不是记忆导出文件（缺少 entries 数组）' }
      const report = store.importEntries(rows, { mode: args?.mode === 'replace' ? 'replace' : 'merge' })
      return { ok: true, ...report, hint: `合并完成：新增 ${report.added}、覆盖 ${report.replaced}、跳过 ${report.skipped}` }
    },
  })

  /* ─────────────── 设置页接口：/api/memory ─────────────── */

  const route = async (req, res) => {
    const url = parseUrl(req.url)
    const path = url.pathname.replace(/^\/api\/memory/, '') || '/'
    const method = req.method || 'GET'

    if (method === 'GET' && (path === '/stats' || path === '/')) return sendJson(res, 200, statsPayload())
    if (method === 'GET' && path === '/entries') {
      const page = store.page({
        q: url.searchParams.get('q') || '',
        status: url.searchParams.get('status') || '',
        limit: Math.min(200, Number(url.searchParams.get('limit')) || 100),
        offset: Math.max(0, Number(url.searchParams.get('offset')) || 0),
      })
      return sendJson(res, 200, { ok: true, entries: page.items, total: page.total })
    }
    if (method === 'GET' && path === '/entry') {
      const entry = store.get(String(url.searchParams.get('id') || ''))
      return entry ? sendJson(res, 200, { ok: true, entry: describeEntry(entry) }) : sendJson(res, 404, { ok: false, error: '没有这条' })
    }
    if (method === 'POST' && path === '/pin') {
      const body = await readBody(req)
      const entry = store.get(String(body.id || ''))
      if (!entry) return sendJson(res, 404, { ok: false, error: '没有这条' })
      store.setPinned(entry, !!body.pinned)
      return sendJson(res, 200, { ok: true, entry: describeEntry(entry) })
    }
    if (method === 'POST' && path === '/update') {
      const body = await readBody(req)
      const entry = store.get(String(body.id || ''))
      if (!entry) return sendJson(res, 404, { ok: false, error: '没有这条' })
      const before = entry.text
      const updated = store.update(entry, {
        text: body.text,
        kind: body.kind,
        importance: body.importance,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      })
      return sendJson(res, 200, { ok: true, before, entry: describeEntry(updated) })
    }
    if (method === 'POST' && path === '/purge') {
      const body = await readBody(req)
      const entry = store.get(String(body.id || ''))
      if (!entry) return sendJson(res, 404, { ok: false, error: '没有这条' })
      // 面板上的两步确认已经问过用户了；这里再要求显式 confirm，防止脚本误调
      if (body.confirm !== true) return sendJson(res, 400, { ok: false, error: '真删需要 confirm:true（调用方要先问用户）' })
      store.purge(entry.id)
      return sendJson(res, 200, { ok: true, purged: true, id: entry.id })
    }
    if (method === 'POST' && path === '/import') {
      const body = await readBody(req, 20 * 1024 * 1024)
      const rows = Array.isArray(body.entries) ? body.entries : (Array.isArray(body.payload) ? body.payload : null)
      if (!rows) return sendJson(res, 400, { ok: false, error: '导入内容缺少 entries 数组' })
      const report = store.importEntries(rows, { mode: body.mode === 'replace' ? 'replace' : 'merge' })
      return sendJson(res, 200, { ok: true, ...report })
    }
    if (method === 'POST' && path === '/forget') {
      const body = await readBody(req)
      const entry = store.get(String(body.id || ''))
      if (!entry) return sendJson(res, 404, { ok: false, error: '没有这条' })
      store.forget(entry, body.mode === 'fade' ? 'fade' : 'archive')
      return sendJson(res, 200, { ok: true, entry: describeEntry(entry) })
    }
    if (method === 'POST' && path === '/restore') {
      const body = await readBody(req)
      const entry = store.get(String(body.id || ''))
      if (!entry) return sendJson(res, 404, { ok: false, error: '没有这条' })
      store.restore(entry)
      return sendJson(res, 200, { ok: true, entry: describeEntry(entry) })
    }
    if (method === 'POST' && path === '/consolidate') {
      const body = await readBody(req)
      const report = await consolidator.run({ reason: String(body.reason || 'panel').slice(0, 40) })
      return sendJson(res, 200, { ok: true, report })
    }
    if (method === 'POST' && path === '/backup') {
      // 冷备到 coldBackupDir；没配就退到本地 backups/（至少有一份），盘不在就跳过，绝不阻塞
      const cold = toStr(cfg.coldBackupDir, '') || join(root, 'backups')
      const day = new Date()
      const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}`
      const dest = join(cold, stamp)
      try {
        mkdirSync(dest, { recursive: true })
        const copied = []
        for (const f of [paths.entries, paths.stats, paths.synonyms, paths.consolidate]) {
          if (!existsSync(f)) continue
          const name = f.split('\\').pop()
          copyFileSync(f, join(dest, name))
          copied.push(name)
        }
        writeJsonAtomic(join(dest, 'backup.json'), { at: Date.now(), files: copied })
        return sendJson(res, 200, { ok: true, dest, files: copied })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }
    if (method === 'POST' && path === '/export') {
      const day = new Date()
      const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(day.getDate()).padStart(2, '0')}-${String(day.getHours()).padStart(2, '0')}${String(day.getMinutes()).padStart(2, '0')}`
      const file = join(root, `export-${stamp}.json`)
      const payload = {
        version: 1,
        at: Date.now(),
        entries: [...store.every()].map((e) => ({ ...e })),
        stats: stats.snapshot(),
      }
      try {
        writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
        return sendJson(res, 200, { ok: true, file, count: payload.entries.length })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }
    return sendJson(res, 404, { ok: false, error: `unknown route ${method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/memory',
      handler: async (req, res) => {
        try { await route(req, res) } catch (e) {
          bootLog(`/api/memory 处理失败：${e?.stack || e?.message || e}`)
          try { sendJson(res, 500, { ok: false, error: e?.message || String(e) }) } catch { /* 头已发 */ }
        }
      },
    }))
  } catch (e) {
    bootLog(`设置页接口没挂上：${e?.message || e}`)
  }

  /* ─────────────── 写入：用户消息 → 启发式抽取 ─────────────── */

  const seenSeq = new Map() // sessionId -> 最近处理过的 seq，防重复
  const markSeen = (sid, seq) => {
    if (!sid || seq == null) return false
    let set = seenSeq.get(sid)
    if (!set) { set = new Set(); seenSeq.set(sid, set) }
    if (set.has(seq)) return true
    set.add(seq)
    if (set.size > 200) { const first = set.values().next().value; set.delete(first) }
    return false
  }

  const ingest = (text, { sessionId, seq, at }) => {
    if (cfg.extractMode === 'off') return
    const now = at || Date.now()
    const candidates = extract(text, { sessionId, seq, at: now })
    for (const cand of candidates) {
      if ((cand.importance || 3) < num(cfg.minImportance, 2)) continue
      try {
        const r = store.add(cand, { at: now })
        stats.inc('extracted')
        if (r.deduped) stats.inc('deduped')
        if (r.superseded) stats.inc('superseded')
        if (cfg.debug) bootLog(`抽取：${cand.kind} «${cand.text}» → ${r.deduped ? '合并' : r.entry?.id}`)
      } catch (e) {
        bootLog(`写入失败：${e?.message || e}`)
      }
    }
  }

  ctx.on('session/event', (session, event) => {
    try {
      if (!event || event.type !== 'user/message') return
      const sid = session?.id ?? session?.header?.id ?? null
      const origin = session?.origin ?? session?.header?.origin
      if (origin === 'subagent') return                   // 子 agent 的任务书不当记忆
      if (markSeen(sid, event.seq)) return
      const text = messageText(event.data)
      if (!text || text.length < 4) return
      ingest(text, { sessionId: sid, seq: event.seq, at: event.time })
    } catch (e) {
      bootLog(`session/event 处理失败：${e?.message || e}`)
    }
  })

  /* ─────────────── 夜间巩固：每天 consolidateAt 跑一次 ─────────────── */

  const scheduleDaily = (hhmm, fn) => {
    let timer = null
    let stopped = false
    const delayToNext = () => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '03:30'))
      const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 3
      const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 30
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0)
      if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
      return next.getTime() - now.getTime()
    }
    const loop = () => {
      if (stopped) return
      timer = setTimeout(async () => {
        try {
          const report = await fn()
          bootLog(`夜间巩固：${JSON.stringify(report)}`)
        } catch (e) {
          bootLog(`夜间巩固失败：${e?.message || e}`)
        }
        loop()
      }, delayToNext())
      if (timer.unref) timer.unref()   // 不因为一个定时器把宿主拖住
    }
    loop()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }

  ctx.effect(() => scheduleDaily(cfg.consolidateAt, () => consolidator.run({ reason: 'nightly' })))

  /* ─────────────── 收尾：卸载时清定时器、落盘统计 ─────────────── */

  ctx.effect(() => () => {
    try { engine.dispose() } catch { /* 已释放 */ }
    try { stats.flush() } catch { /* 统计丢了不心疼 */ }
    try { store.compactIfNeeded() } catch { /* 下次再来 */ }
    bootLog('卸载：定时器已清、统计已落盘')
  })

  bootLog(`就绪：${store.size()} 条 · 索引 ${store.index.size} · deadline ${Math.min(60000, num(cfg.recallDeadlineMs, 60000))}ms · L4=${deep ? (deep.available() ? 'on' : '不可用') : 'off'} · allowModel=${!!cfg.allowModel}`)
}
