/**
 * lib/recall.mjs —— 分层召回 + 60 秒 episode（M1 版：L1 常驻 / L2 热区 / L3 长期库 / 规则联想）
 * ============================================================================
 * 一次回忆 = 一个最多 60 秒的 episode：
 *   第 0 层（同步，~几十 ms）倒排检索，命中就答；
 *   没命中 → 返回 pending 让人先开口，后台按 2s/6s/15s/30s/45s/57s 逐级放宽再找；
 *   到 60 秒还没命中 → forgotten，写 miss，按约定"当作忘了"。
 * ⚠️ M1 没有 L4（历史会话全文）与跨会话扫描，那是 M2；这里先把 60 秒的骨架和账立起来。
 * ============================================================================
 */
import { randomUUID } from 'node:crypto'
import { appendJsonl } from './paths.mjs'
import { indexTokens, normalize } from './tokenize.mjs'
import { describeEntry, isFaded, layerOf, scoreEntry, strengthAt } from './model.mjs'

const ESCALATION = [2000, 6000, 15000, 30000, 45000, 57000]
const BASE_THRESHOLD = 0.18
/** 相关度底线：不随阶梯下降。宁可"想不起来"，也不许编造。 */
const MIN_MATCH = 0.08
/** 命中"罕见词"（df ≤ 全库 30%）时，底线可以放宽到这里 */
const MIN_MATCH_WEAK = 0.04
/** 线性扫的相关度底线（它的 textScore 口径不同：包含=1，部分重合=0.6×比例） */
const MIN_MATCH_SCAN = 0.12

export class RecallEngine {
  constructor({ store, cfg, stats, paths, log, synonyms = {}, deep = null }) {
    this.store = store
    this.cfg = cfg
    this.stats = stats
    this.paths = paths
    this.log = log
    this.synonyms = synonyms || {}
    this.deep = deep
    this.episodes = new Map()
    this.timers = new Set()
    this.disposed = false
  }

  setSynonyms(map) { this.synonyms = map && typeof map === 'object' ? map : {} }

  /** 同义词/别名扩展（D2：只查本地词表，不调模型） */
  expand(cue) {
    const low = String(cue || '').toLowerCase()
    const extra = []
    for (const [key, alts] of Object.entries(this.synonyms)) {
      const group = [key, ...(Array.isArray(alts) ? alts : [])]
      if (group.some((w) => w && low.includes(String(w).toLowerCase()))) {
        for (const w of group) if (w && !low.includes(String(w).toLowerCase())) extra.push(String(w))
      }
    }
    return extra.length ? `${cue} ${extra.join(' ')}` : cue
  }

  /**
   * 查询变体：原句 + 每个同义词单独拼一次。
   * ⚠️ 不能把所有同义词一次性拼进去 —— 分母（查询总 idf）被稀释，
   *    原本 0.2 的匹配会被摊薄到 0.05，反而查不到（2026-10-25 踩过）。
   */
  variants(cue) {
    const low = String(cue || '').toLowerCase()
    const out = [{ text: cue, weight: 1 }]
    for (const [key, alts] of Object.entries(this.synonyms)) {
      const group = [key, ...(Array.isArray(alts) ? alts : [])]
      if (!group.some((w) => w && low.includes(String(w).toLowerCase()))) continue
      for (const w of group) {
        if (!w || low.includes(String(w).toLowerCase())) continue
        out.push({ text: `${cue} ${w}`, weight: 0.85 })
        if (out.length >= 6) return out
      }
    }
    return out
  }

  allow(entry, { includeFaded, includeArchived, now }) {
    if (entry.status === 'superseded') return false
    if (entry.status === 'archived') return !!includeArchived
    if (!includeFaded && isFaded(entry, now)) return false
    return true
  }

  /** 单次检索：level 越大越宽（放宽强度门槛 → 全库线性扫） */
  run(cue, level = 0, opts = {}) {
    const now = Date.now()
    const includeFaded = !!opts.includeFaded || level >= 1
    const includeArchived = !!opts.includeArchived
    const threshold = level === 0 ? BASE_THRESHOLD : Math.max(0.08, BASE_THRESHOLD - 0.02 * level)
    const limit = Math.max(1, Number(opts.limit) || Number(this.cfg.recallLimit) || 8)
    const scored = []

    // 相关度闸门：光"新鲜/强度高"不算命中。
    // 没有这道闸，任何刚写进来的条目都能靠 0.25 强度 + 0.15 熟练 + 0.05 新鲜拿到 ~0.45 的基线分，
    // 于是问"电饭煲放哪"也会把"记忆存在 D 盘"塞给你 —— 那是噪声，不是回忆。
    //
    // ⚠️ 2026-10-25 第二次事故：一开始这道闸会随阶梯一起放松（0.08 → 0.04 → 0.02），
    //    结果 6 秒后拿两条 text_match≈0.02 的**无关**记忆当答案返回了 —— 那叫编造，比想不起来更糟。
    //    结论：**阶梯只放宽"搜哪里"（含淡忘/线性扫/换线索），绝不放宽"相关度底线"。**
    const minMatch = MIN_MATCH

    if (level < 3) {
      // 多变体取最大值：原句权重 1，同义词变体 0.85
      const best = new Map()
      for (const v of this.variants(cue)) {
        for (const { id, score, strong } of this.store.index.search(v.text, { limit: 40 })) {
          const s = score * v.weight
          const prev = best.get(id)
          if (!prev || s > prev.score) best.set(id, { score: s, strong })
        }
      }
      for (const [id, hit] of best) {
        const entry = this.store.get(id)
        if (!entry || !this.allow(entry, { includeFaded, includeArchived, now })) continue
        // 强信号（命中了罕见词）可以放宽到 0.04；否则守 0.08
        const accept = hit.score >= minMatch || (hit.strong && hit.score >= MIN_MATCH_WEAK)
        if (!accept) continue
        const total = scoreEntry(entry, hit.score, now)
        if (total < threshold) continue
        scored.push({ entry, textScore: hit.score, score: total, layer: layerOf(entry, now) })
      }
    } else {
      // 线性扫：索引没捞到时的最后手段（用索引里现成的 token 集，避免重复分词）
      const needle = normalize(cue)
      const q = indexTokens(cue)
      const N = this.store.index.docs.size || 1
      const rareDf = Math.max(1, Math.floor(N * 0.3))
      for (const entry of (includeArchived ? this.store.every() : this.store.live())) {
        if (!this.allow(entry, { includeFaded, includeArchived, now })) continue
        const norm = normalize(entry.text)
        let textScore = 0
        let rareHit = false
        if (needle.length >= 2 && norm.includes(needle)) { textScore = 1; rareHit = true }
        else {
          const docTokens = this.store.index.docs.get(entry.id)?.tf
          const et = docTokens ? docTokens.keys() : new Set(indexTokens(entry.text))
          let hit = 0
          for (const t of q) {
            const has = docTokens ? docTokens.has(t) : et.has(t)
            if (!has) continue
            hit++
            if ((this.store.index.df.get(t) || 0) <= rareDf && [...t].length >= 2) rareHit = true
          }
          textScore = q.length ? (hit / q.length) * 0.6 : 0
        }
        const accept = textScore >= MIN_MATCH_SCAN || (rareHit && textScore >= MIN_MATCH_WEAK)
        if (!accept) continue
        const total = scoreEntry(entry, textScore, now)
        if (total < threshold) continue
        scored.push({ entry, textScore, score: total, layer: layerOf(entry, now) })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  toHits(items, latencyMs) {
    const now = Date.now()
    return items.map(({ entry, score, textScore, layer }) => ({
      ...describeEntry(entry, now),
      score: Number(score.toFixed(3)),
      text_match: Number(textScore.toFixed(3)),
      layer_used: layer,
      why: `匹配 ${textScore.toFixed(2)} · 强度 ${strengthAt(entry, now).toFixed(2)} · 熟练 ${Number(entry.fluency ?? 0.5).toFixed(2)}`,
      recall_ms: latencyMs,
    }))
  }

  /** 开始一次回忆（同步跑第 0 层，命中即返回；否则挂起后台阶梯） */
  start(cue, opts = {}) {
    const now = Date.now()
    const ep = {
      id: `ep_${randomUUID().replace(/-/g, '').slice(0, 10)}`,
      cue: String(cue || '').slice(0, 200),
      sessionId: opts.sessionId || null,
      startedAt: now,
      deadlineAt: now + Math.min(60_000, Math.max(1000, Number(opts.deadlineMs) || Number(this.cfg.recallDeadlineMs) || 60_000)),
      status: 'searching',
      level: 0,
      attempts: 0,
      result: null,
      waiters: [],
    }
    this.episodes.set(ep.id, ep)
    this.prune(now)

    // 硬窗兜底：不管阶梯走到哪，到 deadline 一定结算（否则短 deadline 会被下一级阶梯拖晚）
    this.arm(ep, () => this.forget(ep, opts), Math.max(0, ep.deadlineAt - Date.now()))

    const items = this.run(ep.cue, 0, opts)
    if (items.length) this.settle(ep, items, 0)
    else {
      this.schedule(ep, 1, opts)
      // L4 与阶梯**并发**跑：历史检索 1–3s，通常比阶梯第 2 级（6s）先回来
      this.dig(ep, opts)
    }
    return ep
  }

  /**
   * L4：去历史会话原文里翻。
   * 命中就结算，并把这段原文沉淀成一条 episode —— 下次不用再挖 60 秒。
   */
  dig(ep, opts = {}) {
    const deep = this.deep
    if (!deep || typeof deep.search !== 'function') return
    try { if (typeof deep.available === 'function' && !deep.available()) return } catch { return }
    Promise.resolve()
      .then(() => deep.search(ep.cue))
      .then((rows) => {
        if (this.disposed || ep.status !== 'searching' || !rows?.length) return
        const hits = rows.map((r) => ({
          id: `hist_${String(r.sessionId || '').slice(-8)}_${r.seq ?? 0}`,
          kind: 'episode',
          text: r.snippet,
          tags: ['历史'],
          importance: 3,
          strength: 1,
          fluency: 0.5,
          layer: 'history',
          status: 'active',
          pinned: false,
          recallCount: 0,
          mentionCount: 0,
          ageDays: 0,
          role: r.role || 'unknown',
          source: { sessionId: r.sessionId, seq: r.seq, quote: r.snippet },
          score: Number((0.45 + 0.5 * r.sim).toFixed(3)),
          text_match: Number(r.sim.toFixed(3)),
          layer_used: 'history',
          from_history: true,
          why: `历史会话命中（匹配 ${r.sim.toFixed(2)}${r.role ? ` · ${r.role}` : ''}）`,
        }))
        this.settleHistory(ep, hits, opts)
      })
      .catch((e) => this.log(`L4 异常：${e?.message || e}`))
  }

  /** 历史命中：结算 + 沉淀成条目（importance 3，会跟着衰减） */
  settleHistory(ep, hits, opts = {}) {
    if (ep.status !== 'searching') return ep.result
    const now = Date.now()
    const latency = now - ep.startedAt
    ep.status = 'found'
    ep.level = 'history'
    this.clearTimers(ep)

    const best = hits[0]
    let entryId = null
    // 只把**人说过的话**沉淀成记忆：我自己当时的解释/分析不是"事实"，
    // 2026-10-25 出过事 —— L4 把三条助手长文记成了"记忆"，还在之后的回忆里被当成答案。
    const storable = best.role !== 'assistant' && this.cfg.distillHistory !== false
      && (best.text_match || 0) >= 0.2 && (best.text || '').length >= 8
    if (storable) {
      try {
        const r = this.store.add({
          kind: 'episode',
          subject: 'user',
          text: best.text.slice(0, 140),
          tags: ['历史'],
          importance: 3,
          confidence: 0.6,
          why: '从历史会话想起',
          signalId: 'deep',
          source: { sessionId: best.source?.sessionId, seq: best.source?.seq, quote: best.text },
          createdAt: now,
        }, { at: now })
        entryId = r.entry?.id || null
      } catch (e) { this.log(`沉淀历史命中失败：${e?.message || e}`) }
    }

    ep.result = {
      state: 'found',
      forgotten: false,
      episode_id: ep.id,
      took_ms: latency,
      layer_used: 'history',
      level: 'history',
      hits: hits.map((h) => ({ ...h, recall_ms: latency })),
      note: entryId ? '这段是从历史会话原文里翻出来的，已经顺手记下，下次会更快' : '从历史会话原文里翻出来的',
      stored_entry_id: entryId,
    }
    this.stats.noteRecall({ latencyMs: latency, found: true })
    appendJsonl(this.paths.recallLog, {
      at: now, cue: ep.cue, status: 'found', level: 'history', latency_ms: latency,
      ids: [entryId].filter(Boolean), from_history: true,
    })
    this.resolve(ep)
    return ep.result
  }

  schedule(ep, level, opts) {
    if (this.disposed || ep.status !== 'searching') return
    const targetAt = ep.startedAt + ESCALATION[Math.min(level - 1, ESCALATION.length - 1)]
    const delay = Math.max(0, targetAt - Date.now())
    this.arm(ep, () => {
      if (this.disposed || ep.status !== 'searching') return
      if (Date.now() >= ep.deadlineAt) return this.forget(ep, opts)
      ep.level = level
      ep.attempts++
      const items = this.run(ep.cue, level, opts)
      if (items.length) return this.settle(ep, items, level)
      if (level < ESCALATION.length) this.schedule(ep, level + 1, opts)
      else this.arm(ep, () => this.forget(ep, opts), Math.max(0, ep.deadlineAt - Date.now()))
    }, delay)
  }

  arm(ep, fn, delay = 0) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      try { fn() } catch (e) { this.log(`联想阶梯异常：${e?.message || e}`) }
    }, Math.max(0, delay))
    this.timers.add(t)
    ep.timers = ep.timers || []
    ep.timers.push(t)
  }

  settle(ep, items, level = 0) {
    if (ep.status !== 'searching') return ep.result
    const now = Date.now()
    const latency = now - ep.startedAt
    ep.status = 'found'
    ep.level = level
    this.clearTimers(ep)
    ep.result = {
      state: 'found',
      forgotten: false,
      episode_id: ep.id,
      took_ms: latency,
      layer_used: items[0]?.layer || 'longterm',
      level,
      hits: this.toHits(items, latency),
    }
    // 只强化前 3 条，免得一次回忆把整页都写成"复习"
    for (const it of items.slice(0, 3)) {
      try { this.store.touchRecall(it.entry, latency, now) } catch (e) { this.log(`复习失败：${e?.message || e}`) }
    }
    // 费劲才想起来（走了阶梯）→ 把这个问法记成别名，下次同问法更快。
    // ⚠️ 只认**真匹配上**的（text_match ≥ 0.5）：2026-10-25 出过事 ——
    //    一次错误命中把「电饭煲放哪了」写成了"记忆存在 D 盘"的别名，
    //    之后同样的问法就会以 0.82 的匹配度"想起来"，错误自我强化。
    if (level > 0 && ep.cue.length <= 16 && (items[0].textScore || 0) >= 0.5) {
      try { this.store.addCue(items[0].entry, ep.cue, now) } catch { /* 别名失败不影响结果 */ }
    }
    this.stats.noteRecall({ latencyMs: latency, found: true })
    appendJsonl(this.paths.recallLog, {
      at: now, cue: ep.cue, status: 'found', level, latency_ms: latency,
      ids: items.slice(0, 5).map((i) => i.entry.id),
    })
    this.resolve(ep)
    return ep.result
  }

  forget(ep, opts = {}) {
    if (ep.status !== 'searching') return ep.result
    const now = Date.now()
    const latency = now - ep.startedAt
    ep.status = 'forgotten'
    this.clearTimers(ep)
    ep.result = {
      state: 'forgotten',
      forgotten: true,
      episode_id: ep.id,
      took_ms: latency,
      level: ep.attempts,
      hits: [],
      hint: '60 秒内没想起来 —— 按约定当作忘了。换个说法、或过一会儿再问，可能另一条线索能捞到。',
    }
    this.stats.noteRecall({ latencyMs: latency, found: false })
    this.stats.noteForgotten()
    appendJsonl(this.paths.misses, {
      at: now, cue: ep.cue, session: ep.sessionId, attempts: ep.attempts, took_ms: latency,
    })
    appendJsonl(this.paths.recallLog, { at: now, cue: ep.cue, status: 'forgotten', level: ep.attempts, latency_ms: latency })
    this.resolve(ep)
    return ep.result
  }

  snapshot(ep) {
    if (ep.result) return ep.result
    return {
      state: 'pending',
      forgotten: false,
      episode_id: ep.id,
      deadline_at: ep.deadlineAt,
      remaining_ms: Math.max(0, ep.deadlineAt - Date.now()),
      hint: '还在想。稍后用 memory_recall_wait 收结果；到点仍未命中就算忘了。',
    }
  }

  /** 等结果：到 ms 或到 deadline 为止（不会超过 60 秒硬窗） */
  wait(id, ms = 60_000) {
    const ep = this.episodes.get(id)
    if (!ep) return Promise.resolve({ state: 'unknown', error: '没有这个 episode（可能已过期）', episode_id: id })
    if (ep.result) return Promise.resolve(ep.result)
    const timeout = Math.max(0, Math.min(Number(ms) || 0, ep.deadlineAt - Date.now() + 800))
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        ep.waiters = ep.waiters.filter((w) => w.t !== t)
        resolve(this.snapshot(ep))
      }, timeout)
      ep.waiters.push({ t, resolve })
    })
  }

  resolve(ep) {
    for (const w of ep.waiters || []) {
      clearTimeout(w.t)
      try { w.resolve(ep.result) } catch { /* 调用方已放弃 */ }
    }
    ep.waiters = []
  }

  clearTimers(ep) {
    for (const t of ep.timers || []) {
      clearTimeout(t)
      this.timers.delete(t)
    }
    ep.timers = []
  }

  /** 只留最近 10 分钟的 episode（wait 过期后重试能给出明确错误） */
  prune(now = Date.now()) {
    for (const [id, ep] of this.episodes) {
      if (now - ep.startedAt > 10 * 60_000) {
        this.clearTimers(ep)
        this.episodes.delete(id)
      }
    }
  }

  dispose() {
    this.disposed = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    for (const ep of this.episodes.values()) this.clearTimers(ep)
    this.episodes.clear()
  }
}
