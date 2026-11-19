/**
 * lib/stats.mjs —— 统计（给 memory_stats 和夜间巩固看账）
 * ============================================================================
 * 只记"能回答三个问题"的数：
 *   ① 我到底记了多少、多少已经淡了 ② 回忆命中率/平均耗时 ③ 今天往上下文里塞了多少 token
 * 写盘做 5 秒节流：统计丢了不心疼，主库不能丢。
 * ============================================================================
 */
import { readJson, writeJsonAtomic } from './paths.mjs'

/**
 * 多进程共写 stats.json 时的合并：同一天/总账的计数**只增不减**（取较大值）。
 * 这样刚启动、还没注入的实例不会把别人的账清成 0。
 */
function mergeStats(mine, disk) {
  if (!disk || typeof disk !== 'object') return mine
  const maxNum = (a, b) => Math.max(Number(a) || 0, Number(b) || 0)
  const out = { ...disk, ...mine }
  const totals = {}
  for (const k of new Set([...Object.keys(disk.totals || {}), ...Object.keys(mine.totals || {})])) {
    const a = disk.totals?.[k]
    const b = mine.totals?.[k]
    totals[k] = (typeof a === 'number' || typeof b === 'number') ? maxNum(a, b) : (b ?? a)
  }
  out.totals = totals
  const days = {}
  for (const k of new Set([...Object.keys(disk.days || {}), ...Object.keys(mine.days || {})])) {
    const a = disk.days?.[k] || {}
    const b = mine.days?.[k] || {}
    days[k] = {
      injectedTokens: maxNum(a.injectedTokens, b.injectedTokens),
      recalls: maxNum(a.recalls, b.recalls),
      hits: maxNum(a.hits, b.hits),
      misses: maxNum(a.misses, b.misses),
    }
  }
  out.days = days
  const la = disk.latency || {}
  const lb = mine.latency || {}
  out.latency = (Number(la.count) || 0) > (Number(lb.count) || 0) ? { ...la } : { ...lb }
  out.updatedAt = Math.max(Number(disk.updatedAt) || 0, Number(mine.updatedAt) || 0)
  out.lastFlush = mine.lastFlush
  return out
}

export class Stats {
  constructor({ paths, log }) {
    this.paths = paths
    this.log = log
    this.data = {
      version: 1,
      updatedAt: 0,
      totals: {
        extracted: 0, deduped: 0, superseded: 0,
        recalls: 0, hits: 0, misses: 0, forgotten: 0,
        injectedTokens: 0, modelCalls: 0,
      },
      latency: { count: 0, sumMs: 0, maxMs: 0 },
      days: {},
      lastFlush: 0,
      dirty: false,
    }
    this.load()
  }

  load() {
    const d = readJson(this.paths.stats, null)
    if (d && d.version === 1) this.data = { ...this.data, ...d, totals: { ...this.data.totals, ...(d.totals || {}) } }
  }

  today(now = Date.now()) {
    const d = new Date(now)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!this.data.days[key]) this.data.days[key] = { injectedTokens: 0, recalls: 0, hits: 0, misses: 0 }
    return this.data.days[key]
  }

  inc(key, n = 1) {
    this.data.totals[key] = (Number(this.data.totals[key]) || 0) + n
    this.data.dirty = true
    this.maybeFlush()
  }

  noteInject(tokens) {
    if (!tokens) return
    this.data.totals.injectedTokens += tokens
    this.today().injectedTokens += tokens
    this.data.dirty = true
    this.maybeFlush()
  }

  noteRecall({ latencyMs = 0, found = false } = {}) {
    this.data.totals.recalls++
    if (found) this.data.totals.hits++
    else this.data.totals.misses++
    this.today().recalls++
    if (found) this.today().hits++
    else this.today().misses++
    if (found) {
      this.data.latency.count++
      this.data.latency.sumMs += Math.max(0, latencyMs)
      this.data.latency.maxMs = Math.max(this.data.latency.maxMs, latencyMs)
    }
    this.data.dirty = true
    this.maybeFlush()
  }

  noteForgotten() {
    this.data.totals.forgotten++
    this.data.dirty = true
    this.maybeFlush()
  }

  maybeFlush(force = false) {
    const now = Date.now()
    if (!this.data.dirty) return
    if (!force && now - this.data.lastFlush < 5000) return
    this.flush()
  }

  flush() {
    this.data.lastFlush = Date.now()
    this.data.updatedAt = this.data.lastFlush
    // 只留最近 60 天
    const keys = Object.keys(this.data.days).sort()
    for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete this.data.days[k]
    const { dirty, ...rest } = this.data
    /**
     * 🔴 2026-11-19（面板「今日注入 0 token」）：桌面 / 心跳 / 无头是**几个进程各写一份**
     *   stats.json，谁后写谁赢 —— 于是某天会被刚启动、还没注入的实例覆盖成 0。
     *   落盘前先跟盘上的旧账合并：同一天的计数取**较大值**（只增不减），总账也取大。
     */
    let disk = null
    try { disk = readJson(this.paths.stats) } catch { disk = null }
    const merged = mergeStats(rest, disk)
    const ok = writeJsonAtomic(this.paths.stats, merged)
    if (ok) this.data.dirty = false
    return ok
  }

  snapshot() {
    const { count, sumMs, maxMs } = this.data.latency
    return {
      totals: { ...this.data.totals, modelCalls: this.data.totals.modelCalls || 0 },
      latency: {
        count,
        avgMs: count ? Math.round(sumMs / count) : null,
        maxMs: maxMs || null,
      },
      today: this.today(),
      days: Object.keys(this.data.days).sort().slice(-7).map((k) => ({ date: k, ...this.data.days[k] })),
    }
  }
}
