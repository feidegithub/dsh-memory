/**
 * lib/search.mjs —— bigram 倒排索引（内存里，启动时从 JSONL 重建）
 * ============================================================================
 * 2 万条这个量级完全不需要数据库：
 *   倒排 ≈ 20–40 MB 内存，一次查询是几次 Map 查找，几十毫秒。
 * 分数用 BM25 的 idf 加权，再除以"查询总 idf"归一化到 0..1，
 * 这样 0.4 这个阈值在任何查询长度下都还有意义。
 * ============================================================================
 */
import { indexTokens, normalize } from './tokenize.mjs'

export class InvertedIndex {
  constructor() {
    /** id -> { tf: Map<token,count>, norm: 归一化原文, title: string } */
    this.docs = new Map()
    /** token -> Set<id> */
    this.postings = new Map()
    /** token -> 文档频率 */
    this.df = new Map()
  }

  get size() { return this.docs.size }

  add(id, text, { cues = [] } = {}) {
    this.remove(id)
    const body = [text, ...(cues || [])].filter(Boolean).join(' \n ')
    const tf = new Map()
    for (const t of indexTokens(body)) tf.set(t, (tf.get(t) || 0) + 1)
    this.docs.set(id, { tf, norm: normalize(body).slice(0, 4000), len: [...tf.values()].reduce((a, b) => a + b, 0) })
    for (const t of tf.keys()) {
      let set = this.postings.get(t)
      if (!set) { set = new Set(); this.postings.set(t, set) }
      set.add(id)
      this.df.set(t, (this.df.get(t) || 0) + 1)
    }
  }

  remove(id) {
    const doc = this.docs.get(id)
    if (!doc) return
    for (const t of doc.tf.keys()) {
      const set = this.postings.get(t)
      if (set) {
        set.delete(id)
        if (!set.size) this.postings.delete(t)
      }
      const n = (this.df.get(t) || 0) - 1
      if (n <= 0) this.df.delete(t)
      else this.df.set(t, n)
    }
    this.docs.delete(id)
  }

  /** 查询：返回 [{ id, score(0..1), strong }]，按分降序 */
  search(query, { limit = 30 } = {}) {
    const q = [...new Set(indexTokens(query))]
    if (!q.length) return []
    const N = this.docs.size || 1
    // "罕见词"线：df 不超过全库 30% 的词算强信号。
    // 为什么需要它：中文里"的/在/放"这种字命中不算回忆，
    // 但"冷备"只出现在一条记忆里 —— 命中它基本就对了。
    const rareDf = Math.max(1, Math.floor(N * 0.3))
    const idfOf = (t) => {
      const df = this.df.get(t) || 0
      return Math.log(1 + (N - df + 0.5) / (df + 0.5))
    }
    const raw = new Map()
    const strong = new Set()
    let totalIdf = 0
    for (const t of q) {
      const idf = idfOf(t)
      totalIdf += idf
      const set = this.postings.get(t)
      if (!set) continue
      // "强信号"= 罕见的**多字词**。单字命中不算（"放/在/的"这种到处都是），
      // 否则小语料库里每个字都只出现在一两条里，全成了"罕见词"。
      const rare = (this.df.get(t) || 0) <= rareDf && [...t].length >= 2
      for (const id of set) {
        const tf = this.docs.get(id)?.tf.get(t) || 0
        raw.set(id, (raw.get(id) || 0) + idf * (tf / (tf + 1.2)))
        if (rare) strong.add(id)
      }
    }
    if (!totalIdf) return []
    const qn = normalize(query)
    const out = []
    for (const [id, s] of raw) {
      let score = s / totalIdf
      const doc = this.docs.get(id)
      // 原文包含整句 → 明显更强的信号（"E 盘拔了会怎样"这种长问句靠它）
      if (qn.length >= 2 && doc?.norm.includes(qn)) score = Math.min(1, score + 0.35)
      out.push({ id, score: Math.min(1, score), strong: strong.has(id) })
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit)
  }
}
