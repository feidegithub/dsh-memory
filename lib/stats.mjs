/**
 * lib/stats.mjs —— 统计（给 memory_stats 和夜间巩固看账）
 * ============================================================================
 * 只记"能回答三个问题"的数：
 *   ① 我到底记了多少、多少已经淡了 ② 回忆命中率/平均耗时 ③ 今天往上下文里塞了多少 token
 * 写盘做 5 秒节流：统计丢了不心疼，主库不能丢。
 * ============================================================================
 */
import { readJson, writeJsonAtomic } from './paths.mjs'

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
    const ok = writeJsonAtomic(this.paths.stats, rest)
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
