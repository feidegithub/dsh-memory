/**
 * lib/consolidate.mjs —— 夜间巩固（03:30 跑一次，也可手动）
 * ============================================================================
 * 人类的记忆在睡眠里做四件事，这里一件一件对应：
 *   ① 归档：淡到没人想得起来的，收进 archive（**不删**，深挖还能捞）
 *   ② 合并：同一件事攒了好几条的，合成一条（回忆计数相加）
 *   ③ 情景：把近 24h 的会话按标题压成"那天干了什么"
 *   ④ 事后想起：拿 miss 日志里的问法去 L4 再挖一次，挖到就沉淀成条目 + 补别名
 * 全部纯规则，0 次模型调用（D2）。
 * ============================================================================
 */
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from './paths.mjs'
import { tokenSet, jaccard } from './tokenize.mjs'
import { DAY, strengthAt } from './model.mjs'

// 0.70 而不是 0.80：写入去重管的是"一模一样"，巩固要收拾的是"改了几个字又记了一遍"。
// 合并不会丢信息 —— 被并的那条只是 status=superseded，原文仍在 JSONL 里。
const MERGE_SIM = 0.70

export class Consolidator {
  constructor({ store, stats, paths, deep, cfg, log }) {
    this.store = store
    this.stats = stats
    this.paths = paths
    this.deep = deep
    this.cfg = cfg
    this.log = log
  }

  async run({ reason = 'manual', now = Date.now() } = {}) {
    const report = {
      at: now,
      reason,
      before: this.store.size(),
      archived: 0,
      trimmed: 0,
      merged: 0,
      episodes: 0,
      remined: 0,
      missesResolved: 0,
    }
    try { this.archive(now, report) } catch (e) { this.log(`归档失败：${e?.message || e}`) }
    try { report.trimmed = this.store.enforceCap(Number(this.cfg.maxEntries) || 20_000, now) } catch (e) { this.log(`容量裁剪失败：${e?.message || e}`) }
    try { this.merge(now, report) } catch (e) { this.log(`合并失败：${e?.message || e}`) }
    try { await this.episodes(now, report) } catch (e) { this.log(`情景失败：${e?.message || e}`) }
    if (this.cfg.remineMisses !== false) {
      try { await this.remine(now, report) } catch (e) { this.log(`反挖失败：${e?.message || e}`) }
    }
    report.after = this.store.size()
    report.finishedAt = Date.now()
    writeJsonAtomic(this.paths.consolidate, report)
    try { this.store.compactIfNeeded(true) } catch { /* 压缩失败不影响结果 */ }
    try { this.stats.inc('consolidations') } catch { /* 统计而已 */ }
    this.log(`巩固完成：归档 ${report.archived}、合并 ${report.merged}、情景 ${report.episodes}、反挖 ${report.remined}`)
    return report
  }

  /** ① 归档：不删，只移出默认检索 */
  archive(now, report) {
    const minStrength = Number(this.cfg.archiveBelowStrength ?? 0.12)
    const minDays = Number(this.cfg.archiveAfterDays ?? 180)
    for (const e of this.store.live()) {
      if (e.pinned) continue
      const ageDays = (now - (Number(e.createdAt) || now)) / DAY
      if (ageDays < minDays) continue
      if (strengthAt(e, now) > minStrength) continue
      e.status = 'archived'
      e.archivedAt = now
      e.archiveReason = `strength<${minStrength} 且 ${Math.round(ageDays)} 天没复习`
      this.store.save(e)
      report.archived++
    }
  }

  /** ② 合并近似重复（同 kind + Jaccard ≥ 0.75） */
  merge(now, report) {
    const touched = new Set()
    const pairs = []
    let budget = 400
    for (const e of this.store.live()) {
      if (budget-- <= 0) break
      if (touched.has(e.id)) continue
      for (const { id } of this.store.index.search(e.text, { limit: 4 })) {
        if (id === e.id || touched.has(id)) continue
        const other = this.store.get(id)
        if (!other || other.status !== 'active' || other.kind !== e.kind) continue
        const sim = jaccard(tokenSet(e.text), tokenSet(other.text))
        if (sim < MERGE_SIM) continue
        pairs.push([e, other, sim])
        touched.add(e.id)
        touched.add(id)
        break
      }
    }
    for (const [a, b] of pairs) {
      if (a.status !== 'active' || b.status !== 'active') continue
      const keep = (Number(b.importance) || 0) > (Number(a.importance) || 0) ? b : a
      const drop = keep === a ? b : a
      keep.tags = [...new Set([...(keep.tags || []), ...(drop.tags || [])])].slice(0, 12)
      keep.mentionCount = (keep.mentionCount || 0) + (drop.mentionCount || 0)
      keep.recallCount = (keep.recallCount || 0) + (drop.recallCount || 0)
      keep.strengthBase = Math.max(Number(keep.strengthBase) || 0, Number(drop.strengthBase) || 0)
      keep.cues = [...new Set([...(keep.cues || []), ...(drop.cues || [])])].slice(-8)
      keep.mergedFrom = [...(keep.mergedFrom || []), drop.id].slice(-10)
      drop.status = 'superseded'
      drop.supersededBy = keep.id
      this.store.save(keep)
      this.store.save(drop)
      report.merged++
    }
  }

  /** ③ 近 24h 会话 → 一条 episode（凭标题，不读全文） */
  async episodes(now, report) {
    const deep = this.deep
    if (!deep || typeof deep.recentSessions !== 'function') return
    const sessions = await deep.recentSessions({ sinceMs: DAY, limit: 20 })
    if (!sessions.length) return
    const ids = sessions.map((s) => s.header?.id).filter(Boolean)
    const titles = await deep.titles(ids)
    const have = new Set()
    for (const e of this.store.every()) {
      if (e.source?.sessionId) have.add(e.source.sessionId)
    }
    let made = 0
    for (const s of sessions) {
      if (made >= 8) break                       // 一天最多 8 条，别把记忆塞满目录
      const sid = s.header?.id
      if (!sid || have.has(sid)) continue
      if (s.header?.origin === 'subagent') continue   // 子 agent 的会话不是"我们那天干了什么"
      const title = String(titles.get(sid) || '').trim()
      if (title.length < 2) continue
      if (/^(greeting|hello|new chat|新会话|未命名)$/i.test(title)) continue
      if (/^你是|^请作为|^帮我写一个/.test(title)) continue   // 标题就是一句提示词，没信息量
      const day = new Date(s.header?.createdAt || now)
      const dayKey = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
      const added = this.store.add({
        kind: 'episode',
        subject: 'user',
        text: `会话「${title.slice(0, 60)}」（${dayKey}）`,
        tags: ['会话', dayKey],
        importance: 2,
        confidence: 0.8,
        why: '每日情景',
        signalId: 'consolidate',
        source: { sessionId: sid, seq: null, quote: title.slice(0, 120) },
        createdAt: now,
      }, { at: now })
      made++
      if (!added.deduped) report.episodes++
    }
  }

  /** ④ 拿 miss 的 cue 去 L4 再挖：挖到就沉淀 + 补别名（"事后想起"） */
  async remine(now, report) {
    const deep = this.deep
    if (!deep || typeof deep.search !== 'function') return
    try { if (typeof deep.available === 'function' && !deep.available()) return } catch { return }

    const { rows } = readJsonl(this.paths.misses)
    const last = new Map()
    for (const r of rows) {
      if (!r?.cue) continue
      last.set(r.cue, r)           // 后写覆盖先写：最后一条决定 resolved 与否
    }
    const pending = [...last.values()].filter((r) => !r.resolved).slice(-20)
    for (const miss of pending) {
      const found = await deep.search(miss.cue, { limit: 2 })
      const hit = found?.find((x) => x.sim >= 0.25)
      if (!hit) continue
      // 已经有近似条目的，只补一个别名；没有的，沉淀成新条目
      let entryId = null
      const near = this.store.index.search(hit.snippet, { limit: 3 })
        .map((x) => this.store.get(x.id))
        .find((e) => e && e.status === 'active' && jaccard(tokenSet(hit.snippet), tokenSet(e.text)) >= 0.4)
      if (near) {
        this.store.addCue(near, miss.cue, now)
        entryId = near.id
      } else {
        const r = this.store.add({
          kind: 'episode',
          subject: 'user',
          text: hit.snippet.slice(0, 140),
          tags: ['历史', '事后想起'],
          importance: 3,
          confidence: 0.55,
          why: `miss 反挖：${miss.cue}`,
          signalId: 'deep',
          source: { sessionId: hit.sessionId, seq: hit.seq, quote: hit.snippet },
          createdAt: now,
        }, { at: now })
        entryId = r.entry?.id || null
      }
      appendJsonl(this.paths.misses, { at: now, cue: miss.cue, resolved: true, entry_id: entryId, how: 'remine' })
      report.missesResolved++
      report.remined++
    }
  }
}

/** 读上次巩固报告（给 memory_stats 看） */
export function readLastReport(paths) {
  return readJson(paths.consolidate, null)
}
