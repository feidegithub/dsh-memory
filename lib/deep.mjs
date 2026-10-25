/**
 * lib/deep.mjs —— L4：到历史会话的原始日志里翻（sessionQuery 的全文索引）
 * ============================================================================
 * 这是"深挖硬盘"那一层：提炼条目里没有的东西，原文里可能还留着。
 * 用宿主现成的 `ctx.sessionQuery`（sqlite FTS），不自己建索引、不调模型。
 *
 * 两条纪律：
 *   ① 可选依赖：拿不到 sessionQuery 就静默降级（只返回 []），绝不让插件起不来。
 *   ② 命中也要过相关度：FTS 只保证"词出现过"，不保证"是这件事"。
 *      这里用拼句 token 的 Jaccard 复核，低于阈值就当没找到。
 * ============================================================================
 */
import { tokenSet, jaccard } from './tokenize.mjs'

const MAX_SNIPPET = 160

/** 把 FTS 片段洗干净：去标签、压空白、截断 */
export function cleanSnippet(raw) {
  return String(raw || '')
    .replace(/<[^>]{1,40}>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SNIPPET)
}

export class DeepSearch {
  constructor({ getService, log, sessionLimit = 3, fallback = null }) {
    this.getService = getService
    this.log = log
    this.sessionLimit = sessionLimit
    this.fallback = fallback
    this.lastBackend = 'none'
    this.serviceDisabled = false
  }

  service() {
    try { return this.getService?.() || null } catch { return null }
  }

  available() {
    if (this.fallback && typeof this.fallback.available === 'function' && this.fallback.available()) return true
    const sq = this.service()
    return !!(sq && typeof sq.searchSessions === 'function')
  }

  /** 这台机器上真正在用哪条路：宿主的全文索引，还是自己扫日志文件 */
  backend() {
    if (this.lastBackend !== 'none') return this.lastBackend
    if (this.serviceDisabled) return this.fallback?.available?.() ? 'file-log' : 'none'
    const sq = this.service()
    const canService = !!(sq && typeof sq.searchSessions === 'function')
    const canFallback = !!this.fallback?.available?.()
    // 还没检索过：宿主索引"看起来在"不代表真能用（openAt never 要调一次才炸），所以标 auto
    if (canService && canFallback) return 'auto'
    if (canService) return 'session-query'
    if (canFallback) return 'file-log'
    return 'none'
  }

  /**
   * 在历史会话里找这个 cue。
   * 先走宿主的 sessionQuery；不可用/报错/空结果 → 自己扫日志文件。
   * @returns {Promise<Array<{sessionId, seq, snippet, sim, live}>>}
   */
  async search(cue, { limit = this.sessionLimit } = {}) {
    const q = String(cue || '').trim()
    if (q.length < 2) return []

    const sq = this.serviceDisabled ? null : this.service()
    if (sq && typeof sq.searchSessions === 'function') {
      try {
        const page = await sq.searchSessions({ query: q, limit })
        const hits = this.fromPage(page, q, limit)
        if (hits.length) { this.lastBackend = 'session-query'; return hits }
      } catch (e) {
        // 典型：openAt "never" → "session search is disabled…"；记下来，别再反复试
        this.serviceDisabled = true
        this.log?.(`L4 宿主索引不可用，改扫日志文件：${e?.message || e}`)
      }
    }

    if (this.fallback && this.fallback.available?.()) {
      try {
        const rows = this.fallback.search(q, { limit })
        if (rows.length) this.lastBackend = 'file-log'
        return rows
      } catch (e) {
        this.log?.(`L4 文件扫描失败：${e?.message || e}`)
      }
    }
    return []
  }

  fromPage(page, query, limit) {
    const qt = tokenSet(query)
    const out = []
    for (const hit of page?.items || []) {
      const snippet = cleanSnippet(hit?.bestMatch?.snippet)
      if (snippet.length < 4) continue
      const sim = jaccard(qt, tokenSet(snippet))
      if (sim < 0.12) continue
      out.push({
        sessionId: hit?.header?.id || hit?.bestMatch?.sessionId || null,
        seq: hit?.bestMatch?.seq ?? null,
        snippet,
        sim,
        live: !!hit?.live,
      })
    }
    return out.sort((a, b) => b.sim - a.sim).slice(0, limit)
  }

  /** 近 24h 的会话（给"每日情景"用） */
  async recentSessions({ sinceMs = 24 * 3600_000, limit = 20 } = {}) {
    const sq = this.service()
    if (!sq || typeof sq.listSessions !== 'function') return []
    try {
      const list = await sq.listSessions()
      const since = Date.now() - sinceMs
      return list
        .filter((r) => (r?.header?.createdAt || 0) >= since)
        .sort((a, b) => (b.header.createdAt || 0) - (a.header.createdAt || 0))
        .slice(0, limit)
    } catch (e) {
      this.log?.(`列会话失败：${e?.message || e}`)
      return []
    }
  }

  /** 批量取标题（一次调用，别 N 次） */
  async titles(ids) {
    const sq = this.service()
    if (!sq || typeof sq.readTitleSnapshots !== 'function' || !ids?.length) return new Map()
    try {
      const rows = await sq.readTitleSnapshots(ids)
      const map = new Map()
      for (const r of rows || []) {
        if (r?.status === 'fulfilled' && r.value?.title?.title) map.set(r.sessionId, r.value.title.title)
      }
      return map
    } catch (e) {
      this.log?.(`取标题失败：${e?.message || e}`)
      return new Map()
    }
  }
}
