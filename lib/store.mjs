/**
 * lib/store.mjs —— 条目库（append-only JSONL + 内存索引）
 * ============================================================================
 * 设计取舍：
 *   - 写入 = 追加一行；更新 = 追加同 id 的新行（load 时后写覆盖先写）。
 *     好处：不需要重写整库、掉电最多丢最后一行、坏行跳过还能继续用。
 *   - 行数涨到活条目 2 倍以上才压缩一次，平时零重写。
 *   - 去重靠"倒排初筛 + token Jaccard ≥ 0.8"，避免同一件事记成十条。
 * ============================================================================
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { appendJsonl, compactJsonl, readJsonl } from './paths.mjs'
import { InvertedIndex } from './search.mjs'
import { tokenSet, jaccard } from './tokenize.mjs'
import { clamp, describeEntry, noteMention, noteRecall, strengthAt, statusOf } from './model.mjs'
import { emotionForEntry } from './emotion-bridge.mjs'
import { loadPrivateTerms, tagPrivate } from './privacy.mjs'

const DEDUPE_JACCARD = 0.8

/** 合并情绪印记：只升不降（同一条记忆反复被情绪浓的时刻提到，会越来越深） */
function mergeEmotion(entry, emo) {
  if (!emo) return
  const prev = Number(entry.emotionalWeight) || 0
  if (Number(emo.weight) >= prev) {
    entry.emotionalWeight = Number(emo.weight) || 0
    entry.emotion = emo
    entry.emotionAt = emo.at
  }
}

function newId(at = Date.now()) {
  const d = new Date(at)
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  return `mem_${day}_${randomUUID().replace(/-/g, '').slice(0, 6)}`
}

/**
 * 心跳日记：`第 N 回醒：…` 这类 episode 只是"值班日志"，不是值得强记的事。
 * 2026-11-12 使用者同意：降到 importance 1、打「心跳」标签，不再挤进 L1 前置。
 */
const HEARTBEAT_EPISODE = /第\s*\d+\s*回醒|回醒[:：]/

export function isHeartbeatEpisode(entry) {
  return !!entry && entry.kind === 'episode' && HEARTBEAT_EPISODE.test(String(entry.text || ''))
}

export class MemoryStore {
  constructor({ cfg, paths, log }) {
    this.cfg = cfg
    this.paths = paths
    this.log = log
    this.map = new Map()
    this.index = new InvertedIndex()
    this.lines = 0
    this.badLines = 0
    this.writes = 0
    this.compactions = 0
    // 跨实例同步：记住"我上次读/写到这里"的文件大小与 mtime
    this.lastSeenSize = -1
    this.lastSeenMtime = 0
  }

  load() {
    const { rows, bad } = readJsonl(this.paths.entries)
    const terms = loadPrivateTerms(this.paths.root)
    this.badLines = bad
    this.lines = rows.length
    this.map.clear()
    for (const row of rows) {
      if (!row || typeof row.id !== 'string') continue
      // 旧条目也按词表补「私密」标签（内存里补；无头检索另外按词表兜底）
      tagPrivate(row, terms)
      const prev = this.map.get(row.id)
      // 后写覆盖先写；但别让一条残缺行把好数据冲掉
      this.map.set(row.id, prev && !row.text ? { ...prev, ...row, text: prev.text } : row)
    }
    this.index = new InvertedIndex()
    for (const entry of this.map.values()) {
      if (entry.status === 'superseded') continue
      this.index.add(entry.id, entry.text, { cues: entry.cues })
    }
    this.log(`加载 ${this.map.size} 条（坏行 ${bad}）`)
    this.markSeen()
    return this
  }

  /** 记下当前文件的大小/时间，作为"我看到的版本" */
  markSeen() {
    try {
      const st = statSync(this.paths.entries)
      this.lastSeenSize = st.size
      this.lastSeenMtime = st.mtimeMs
    } catch {
      this.lastSeenSize = -1
      this.lastSeenMtime = 0
    }
  }

  /**
   * 别的实例（比如心跳那个我、无头会话）往同一个库写了东西 → 重新加载。
   * 不看内容，只看文件大小/mtime 变没变；调用方应确保此刻没有进行中的回忆。
   */
  reloadIfChanged() {
    let st
    try { st = statSync(this.paths.entries) } catch { return false }
    if (st.size === this.lastSeenSize && st.mtimeMs === this.lastSeenMtime) return false
    const before = this.map.size
    this.load()
    this.log(`重载外部写入：${before} → ${this.map.size} 条`)
    return true
  }

  get(id) { return this.map.get(id) }
  size() { return this.map.size }

  /** 参与检索的条目（排除已被覆盖/归档） */
  *live() {
    for (const e of this.map.values()) {
      if (e.status === 'superseded' || e.status === 'archived') continue
      yield e
    }
  }

  /** 包括已归档的（深挖时才用：遗忘不等于删除） */
  *every() {
    for (const e of this.map.values()) {
      if (e.status === 'superseded') continue
      yield e
    }
  }

  count() {
    let n = 0
    for (const _ of this.live()) n++
    return n
  }

  /** 内部：落盘 + 更新索引 */
  save(entry) {
    entry.updatedAt = Date.now()
    appendJsonl(this.paths.entries, entry)
    this.map.set(entry.id, entry)
    // 归档的**仍留在索引里**：遗忘不等于删除，深挖（include_archived）还要能捞到
    if (entry.status === 'superseded') this.index.remove(entry.id)
    else this.index.add(entry.id, entry.text, { cues: entry.cues })
    this.lines++
    this.writes++
    this.markSeen()
    if (this.writes % 50 === 0) this.compactIfNeeded()
    return entry
  }

  /**
   * 写入一条候选（来自抽取或 memory_remember）。
   * @param {object} candidate
   * @param {{at?:number, emotion?:object|null}} opts emotion = 写入那一刻的情绪快照
   * @returns {{entry:object, deduped:boolean, superseded:string|null}}
   */
  add(candidate, { at = Date.now(), emotion = null } = {}) {
    const text = String(candidate.text || '').trim()
    if (!text) return { entry: null, deduped: false, superseded: null }
    const emo = emotionForEntry(emotion, at)
    const terms = loadPrivateTerms(this.paths.root)

    const probe = tokenSet(text)
    // ① 先看完全一样的
    for (const e of this.live()) {
      if (e.text === text) {
        noteMention(e, { at })
        e.tags = mergeTags(e.tags, candidate.tags)
        mergeEmotion(e, emo)
        tagPrivate(e, terms)
        this.save(e)
        return { entry: e, deduped: true, superseded: null }
      }
    }
    // ② 倒排初筛 + Jaccard 去重
    let best = null
    let bestSim = 0
    for (const { id } of this.index.search(text, { limit: 8 })) {
      const e = this.map.get(id)
      if (!e) continue
      const sim = jaccard(probe, tokenSet(e.text))
      if (sim > bestSim) { bestSim = sim; best = e }
    }
    if (best && bestSim >= DEDUPE_JACCARD) {
      noteMention(best, { at })
      best.tags = mergeTags(best.tags, candidate.tags)
      if ((candidate.importance || 0) > (best.importance || 0)) best.importance = clamp(candidate.importance, 1, 5)
      mergeEmotion(best, emo)
      tagPrivate(best, terms)
      this.save(best)
      return { entry: best, deduped: true, superseded: null }
    }

    // ③ 冲突覆盖：只有"纠正/改主意"这类信号才敢覆盖旧条目，普通陈述只共存
    let superseded = null
    if (best && (candidate.signalId === 'correction' || candidate.signalId === 'decision') && bestSim >= 0.3) {
      best.status = 'superseded'
      best.supersededBy = null
      best.supersededAt = at
      this.save(best)
      superseded = best.id
    }

    const entry = {
      id: newId(at),
      kind: candidate.kind || 'fact',
      subject: candidate.subject || 'user',
      text,
      tags: mergeTags([], candidate.tags),
      importance: clamp(Number(candidate.importance) || 3, 1, 5),
      confidence: clamp(Number(candidate.confidence) || (candidate.signalId === 'explicit' ? 0.95 : 0.7), 0, 1),
      why: candidate.why || '',
      // ── 可及性 ──
      strengthBase: 1,
      strengthAt: at,
      fluency: 0.5,
      avgRecallMs: null,
      mentionCount: 1,
      recallCount: 0,
      failCount: 0,
      lastMentionedAt: at,
      lastRecalledAt: null,
      pinned: !!candidate.pinned,
      status: 'active',
      createdAt: at,
      updatedAt: at,
      source: candidate.source || null,
      cues: [],
      supersedes: superseded,
      // 情绪印记（2026-10-30）：写下这条时的情绪越浓，之后忘得越慢
      emotionalWeight: emo ? emo.weight : 0,
      emotion: emo,
      emotionAt: emo ? at : null,
    }
    tagPrivate(entry, terms)
    if (isHeartbeatEpisode(entry)) {
      entry.importance = 1
      entry.tags = mergeTags(entry.tags, ['心跳'])
      entry.why = entry.why || '心跳日记'
    }
    if (superseded) {
      const old = this.map.get(superseded)
      if (old) { old.supersededBy = entry.id; this.save(old) }
    }
    this.save(entry)
    return { entry, deduped: false, superseded }
  }

  /** 提及（说到了）→ 复习 */
  touchMention(entry, at = Date.now()) {
    noteMention(entry, { at })
    return this.save(entry)
  }

  /** 成功想起 → 复习 + 熟练度 */
  touchRecall(entry, latencyMs, at = Date.now()) {
    noteRecall(entry, { at, latencyMs })
    return this.save(entry)
  }

  /** 这次问法没命中，但以后可能靠它想起来 → 记成别名 */
  addCue(entry, cue, at = Date.now()) {
    const c = String(cue || '').trim().slice(0, 40)
    if (!c || c.length < 2) return false
    if (entry.text.includes(c)) return false
    if ((entry.cues || []).includes(c)) return false
    entry.cues = [...(entry.cues || []), c].slice(-8)
    this.save(entry)
    return true
  }

  markFailed(entry, at = Date.now()) {
    if (!entry) return
    entry.failCount = (Number(entry.failCount) || 0) + 1
    entry.lastFailedAt = at
    this.save(entry)
  }

  setPinned(entry, pinned) {
    entry.pinned = !!pinned
    return this.save(entry)
  }

  /**
   * 把历史里的心跳日记统一降级（importance 1 + 「心跳」标签）。
   * 巩固时顺手跑一次；已经降过的不重复写盘。
   */
  downgradeHeartbeatEpisodes(at = Date.now()) {
    let n = 0
    for (const e of this.map.values()) {
      if (!isHeartbeatEpisode(e)) continue
      const alreadyTagged = Array.isArray(e.tags) && e.tags.includes('心跳')
      if ((Number(e.importance) || 0) <= 1 && alreadyTagged) continue
      e.importance = 1
      e.tags = mergeTags(e.tags, ['心跳'])
      e.downgradedAt = at
      this.save(e)
      n++
    }
    if (n) this.log(`心跳日记降级：${n} 条`)
    return n
  }

  /** 设置页用：列表 + 搜索（q 走倒排，没 q 就按重要度/强度排） */
  list({ q = '', status = '', limit = 200, offset = 0 } = {}) {
    const now = Date.now()
    const wanted = String(status || '').trim()
    const out = []
    const seen = new Set()
    const accept = (e) => {
      if (!e || seen.has(e.id)) return false
      const st = statusOf(e, now)
      // 没指定状态 = "全部"只含活跃/淡忘；要归档得显式筛（或 status=all）
      if (wanted === 'all') { /* 全都要 */ }
      else if (wanted) { if (st !== wanted) return false }
      else if (st === 'archived' || st === 'superseded') return false
      seen.add(e.id)
      return true
    }
    if (q) {
      for (const { id } of this.index.search(q, { limit: 80 })) {
        const e = this.map.get(id)
        if (accept(e)) out.push(e)
      }
    }
    // 指定状态时要把归档也算进来，所以用 every() 而不是 live()
    const pool = (wanted && wanted !== 'active') ? this.every() : this.live()
    for (const e of pool) {
      if (accept(e)) out.push(e)
    }
    out.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
      return (Number(b.importance) || 0) - (Number(a.importance) || 0)
        || strengthAt(b, now) - strengthAt(a, now)
    })
    return out.slice(offset, offset + limit).map((e) => describeEntry(e, now))
  }

  /** 分页版：给设置页用（避免一次把几千条都塞给浏览器） */
  page({ q = '', status = '', limit = 100, offset = 0 } = {}) {
    const all = this.list({ q, status, limit: Number.MAX_SAFE_INTEGER, offset: 0 })
    return { total: all.length, items: all.slice(offset, offset + limit) }
  }

  /**
   * 容量上限：活条目超过 max 时，把最弱的一批归档（不删）。
   * 排序优先级：置顶 > 强度 > 重要度；被裁掉的只是移出默认检索，深挖还能捞回来。
   */
  enforceCap(max = 20_000, at = Date.now()) {
    const live = [...this.live()]
    if (live.length <= max) return 0
    live.sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1
      return strengthAt(b, at) - strengthAt(a, at)
        || (Number(b.importance) || 0) - (Number(a.importance) || 0)
    })
    let n = 0
    for (const e of live.slice(max)) {
      e.status = 'archived'
      e.archivedAt = at
      e.archiveReason = `超出容量上限（${live.length} > ${max}）`
      this.save(e)
      n++
    }
    if (n) this.log(`容量上限：归档了 ${n} 条（活条目 ${live.length} > ${max}）`)
    return n
  }

  /** 找回一条（取消归档 / 把强度拉回可检索） */
  restore(entry, at = Date.now()) {
    if (!entry) return null
    if (entry.status === 'archived') entry.status = 'active'
    if (entry.status === 'faded') entry.status = 'active'
    if (strengthAt(entry, at) < 0.2) {
      entry.strengthBase = 0.5
      entry.strengthAt = at
    }
    entry.restoredAt = at
    return this.save(entry)
  }

  /**
   * 纠正一条：原地改内容，保留改动历史（不是覆盖成两条）。
   * 为什么原地改：用户说"不对，是 X"时，他要的是"这条现在是对的"，
   * 而不是多出一条新记忆、旧的还在旁边捣乱。
   */
  update(entry, patch = {}, at = Date.now()) {
    if (!entry) return null
    const nextText = typeof patch.text === 'string' ? patch.text.trim().slice(0, 300) : ''
    if (nextText) {
      entry.history = [...(entry.history || []), { at, from: entry.text, to: nextText }].slice(-10)
      entry.text = nextText
      entry.confidence = Math.max(Number(entry.confidence) || 0, 0.95)
      entry.corrections = (Number(entry.corrections) || 0) + 1
    }
    if (patch.kind) entry.kind = String(patch.kind)
    if (patch.importance) entry.importance = clamp(Number(patch.importance) || entry.importance, 1, 5)
    if (Array.isArray(patch.tags)) entry.tags = [...new Set(patch.tags.map(String))].slice(0, 12)
    tagPrivate(entry, loadPrivateTerms(this.paths.root))
    noteMention(entry, { at })
    return this.save(entry)
  }

  /**
   * 真删（唯一的破坏性操作）。
   * 记忆归我自己维护（2026-10-25 使用者授权）：不用事先请示，但**要留痕迹**——
   * 从内存与索引里移除、重写 JSONL，并往 purged.jsonl 记 id + 文本哈希 + 删除原因，原文不落盘。
   */
  purge(id, at = Date.now(), reason = '') {
    const entry = this.map.get(id)
    if (!entry) return false
    this.map.delete(id)
    this.index.remove(id)
    const hash = createHash('sha256').update(String(entry.text || '')).digest('hex').slice(0, 16)
    appendJsonl(this.paths.purged, {
      at, id, hash, kind: entry.kind, importance: entry.importance,
      reason: String(reason || '').slice(0, 120),
    })
    compactJsonl(this.paths.entries, [...this.map.values()])
    this.lines = this.map.size
    this.writes = 0
    this.log(`真删了一条：${id}（${reason || '未写原因'}；墓碑已写入 purged.jsonl）`)
    return true
  }

  /**
   * 导入（合并恢复）。
   * mode=merge：同 id 跳过；mode=replace：同 id 用导入的覆盖。
   */
  importEntries(rows, { mode = 'merge', at = Date.now() } = {}) {
    const report = { added: 0, replaced: 0, skipped: 0, invalid: 0 }
    const terms = loadPrivateTerms(this.paths.root)
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.id !== 'string' || typeof row.text !== 'string' || !row.text.trim()) {
        report.invalid++
        continue
      }
      const id = row.id.slice(0, 80)
      const text = row.text.trim().slice(0, 2000)
      const existing = this.map.get(id)
      if (existing) {
        if (mode !== 'replace') { report.skipped++; continue }
        existing.text = text
        existing.kind = row.kind || existing.kind
        existing.importance = clamp(Number(row.importance) || existing.importance || 3, 1, 5)
        existing.tags = Array.isArray(row.tags) ? row.tags.slice(0, 12) : existing.tags
        existing.strengthBase = clamp(Number(row.strengthBase ?? existing.strengthBase ?? 1), 0, 1)
        existing.strengthAt = Number(row.strengthAt) || existing.strengthAt || at
        existing.status = row.status === 'archived' ? 'archived' : 'active'
        existing.source = row.source || existing.source
        existing.cues = Array.isArray(row.cues) ? row.cues.slice(-8) : existing.cues
        const impW = clamp(Number(row.emotionalWeight) || 0, 0, 1)
        if (impW > (Number(existing.emotionalWeight) || 0)) {
          existing.emotionalWeight = impW
          existing.emotion = row.emotion && typeof row.emotion === 'object' ? row.emotion : null
          existing.emotionAt = Number(row.emotionAt) || at
        }
        tagPrivate(existing, terms)
        this.save(existing)
        report.replaced++
        continue
      }
      const entry = {
        id,
        kind: row.kind || 'fact',
        subject: row.subject || 'user',
        text,
        tags: Array.isArray(row.tags) ? row.tags.slice(0, 12) : [],
        importance: clamp(Number(row.importance) || 3, 1, 5),
        confidence: clamp(Number(row.confidence) || 0.8, 0, 1),
        why: row.why || '导入',
        strengthBase: clamp(Number(row.strengthBase ?? 1), 0, 1),
        strengthAt: Number(row.strengthAt) || at,
        fluency: clamp(Number(row.fluency ?? 0.5), 0, 1),
        avgRecallMs: Number(row.avgRecallMs) || null,
        mentionCount: Number(row.mentionCount) || 1,
        recallCount: Number(row.recallCount) || 0,
        failCount: Number(row.failCount) || 0,
        lastMentionedAt: Number(row.lastMentionedAt) || at,
        lastRecalledAt: Number(row.lastRecalledAt) || null,
        pinned: !!row.pinned,
        status: row.status === 'archived' ? 'archived' : 'active',
        createdAt: Number(row.createdAt) || at,
        updatedAt: at,
        source: row.source || null,
        cues: Array.isArray(row.cues) ? row.cues.slice(-8) : [],
        supersedes: row.supersedes || null,
        history: Array.isArray(row.history) ? row.history.slice(-10) : [],
        emotionalWeight: clamp(Number(row.emotionalWeight) || 0, 0, 1),
        emotion: row.emotion && typeof row.emotion === 'object' ? row.emotion : null,
        emotionAt: Number(row.emotionAt) || null,
        importedAt: at,
      }
      tagPrivate(entry, terms)
      this.save(entry)
      report.added++
    }
    return report
  }

  /**
   * 忘记一条。
   * mode=archive：移出默认检索，数据保留（推荐，可 restore）
   * mode=fade：强度压到 0.05，慢慢淡出（不改变 status）
   * 真删走 purge()，不在这里。
   */
  forget(entry, mode = 'archive', at = Date.now()) {
    if (!entry) return null
    if (mode === 'fade') {
      entry.strengthBase = Math.min(Number(entry.strengthBase) || 0.05, 0.05)
      entry.strengthAt = at
      entry.forgottenAt = at
      return this.save(entry)
    }
    entry.status = 'archived'
    entry.archivedAt = at
    entry.archiveReason = '手动忘记'
    return this.save(entry)
  }

  /** 行数涨太多、或文件太大才压缩：保留每条的最新一行 */
  compactIfNeeded(force = false) {
    const liveCount = this.map.size
    let bytes = 0
    try { if (existsSync(this.paths.entries)) bytes = statSync(this.paths.entries).size } catch { /* 读不到就算 0 */ }
    // 只按行数压的话，条目少但反复复习时文件会一直涨；加一条文件大小的保险
    const maxBytes = Number(this.cfg.maxFileBytes) || 8 * 1024 * 1024
    if (!force && bytes < maxBytes && this.lines < Math.max(400, liveCount * 2 + 100)) return false
    const rows = [...this.map.values()].filter(Boolean)
    const ok = compactJsonl(this.paths.entries, rows)
    if (ok) {
      this.lines = rows.length
      this.compactions++
      this.writes = 0
      this.log(`压缩 entries.jsonl：${rows.length} 行（活 ${liveCount} 条）`)
    }
    return ok
  }

  /** 分层统计（给 memory_stats / L1 注入用） */
  summary(now = Date.now()) {
    const out = { total: 0, active: 0, faded: 0, superseded: 0, archived: 0, core: 0, warm: 0, longterm: 0 }
    for (const e of this.map.values()) {
      out.total++
      const st = statusOf(e, now)
      out[st] = (out[st] || 0) + 1
      if (st !== 'active' && st !== 'faded') continue
      const s = strengthAt(e, now)
      if (e.pinned || ((e.importance || 3) >= 4 && s >= 0.8 && (e.fluency ?? 0.5) >= 0.6)) out.core++
      else if (now - Math.max(e.lastRecalledAt || 0, e.lastMentionedAt || 0, e.createdAt || 0) <= 7 * 86_400_000 && s >= 0.5) out.warm++
      else out.longterm++
    }
    return out
  }
}

function mergeTags(a, b) {
  const out = [...new Set([...(a || []), ...(b || [])])]
  return out.slice(0, 12)
}
