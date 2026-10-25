/**
 * lib/model.mjs —— 记忆的"生理学"：衰减、复习、熟练度、分层
 * ============================================================================
 * 三条规则，全部对应人类的记忆特征：
 *   1) 不用就忘：strength = base × exp(-Δt / 半衰期)
 *   2) 越用越牢：每次提及/想起都复习一次，但**同一分钟内重复几乎不涨**（间隔效应）
 *   3) 轻松想起 = 记得更牢：回忆耗时越短，fluency 越高，下次越容易被优先召回
 * 关键取舍：时间戳是唯一真相，strength 只是"上次结算后的基点"，随时可重算。
 * ============================================================================
 */

export const DAY = 86_400_000

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

export function halfLifeDays(entry) {
  if (entry.pinned) return Number.POSITIVE_INFINITY
  const imp = clamp(Number(entry.importance) || 3, 1, 5)
  const rc = Math.max(0, Number(entry.recallCount) || 0)
  const mc = Math.max(0, Number(entry.mentionCount) || 0)
  return 7 * Math.pow(2, imp - 3) * (1 + 0.5 * Math.log1p(rc)) * (1 + 0.3 * Math.log1p(mc))
}

/** 最近一次"复习"的时间（提及 / 想起 / 建立） */
export function lastTouchedAt(entry) {
  return Math.max(
    Number(entry.lastRecalledAt) || 0,
    Number(entry.lastMentionedAt) || 0,
    Number(entry.createdAt) || 0,
  )
}

/** 当前强度（0..1）：从基点按半衰期指数衰减 */
export function strengthAt(entry, now = Date.now()) {
  if (entry.pinned) return 1
  const base = clamp(Number(entry.strengthBase ?? 1), 0, 1)
  const at = Number(entry.strengthAt) || lastTouchedAt(entry) || now
  const dt = Math.max(0, now - at) / DAY
  const hl = halfLifeDays(entry)
  if (!Number.isFinite(hl)) return 1
  return clamp(base * Math.exp(-dt / hl), 0, 1)
}

/** 回忆耗时 → 这次"想起得多轻松"（0..1） */
export function fluencyFactor(latencyMs) {
  const s = Math.max(0, Number(latencyMs) || 0) / 1000
  return 1 / (1 + s / 2)
}

/**
 * 复习一次（mention 或 recall 都算）。
 * @param {object} entry 直接改字段
 * @param {{at:number, latencyMs?:number}} how
 * @returns {{gain:number, spacing:number, strength:number}}
 */
export function reinforce(entry, { at = Date.now(), latencyMs } = {}) {
  const cur = strengthAt(entry, at)
  const last = lastTouchedAt(entry) || at
  const dtDays = Math.max(0, at - last) / DAY
  // 间隔效应：刚复习完又来一次，几乎不涨（0.02 兜底，避免完全为 0）
  const spacing = clamp(dtDays / (1 + dtDays), 0.02, 1)
  const imp = clamp(Number(entry.importance) || 3, 1, 5)
  const fluencyGain = latencyMs == null ? 1 : clamp(fluencyFactor(latencyMs), 0.05, 1)
  const gain = clamp(0.35 * (imp / 3) * spacing * fluencyGain, 0, 0.6)
  const next = clamp(cur + gain * (1 - cur), 0, 1)
  entry.strengthBase = next
  entry.strengthAt = at
  return { gain, spacing, strength: next }
}

/** 成功回忆：加计数 + 更新熟练度 */
export function noteRecall(entry, { at = Date.now(), latencyMs = 0 } = {}) {
  entry.recallCount = (Number(entry.recallCount) || 0) + 1
  entry.lastRecalledAt = at
  const alpha = 0.3
  const f = clamp(Number(entry.fluency ?? 0.5), 0, 1)
  entry.fluency = clamp((1 - alpha) * f + alpha * fluencyFactor(latencyMs), 0, 1)
  const avg = Number(entry.avgRecallMs)
  entry.avgRecallMs = Number.isFinite(avg) && avg > 0 ? Math.round(0.7 * avg + 0.3 * latencyMs) : Math.round(latencyMs)
  return reinforce(entry, { at, latencyMs })
}

/** 被提及（说到/写到这条）：只加深痕迹，不改熟练度 */
export function noteMention(entry, { at = Date.now() } = {}) {
  entry.mentionCount = (Number(entry.mentionCount) || 0) + 1
  entry.lastMentionedAt = at
  return reinforce(entry, { at })
}

/** 综合排序分（§8.5） */
export function scoreEntry(entry, textScore, now = Date.now()) {
  const strength = strengthAt(entry, now)
  const fluent = clamp(Number(entry.fluency ?? 0.5), 0, 1)
  const imp = clamp(Number(entry.importance) || 3, 1, 5) / 5
  const ageDays = Math.max(0, now - (Number(entry.createdAt) || now)) / DAY
  const fresh = Math.exp(-ageDays / 30)
  const pinned = entry.pinned ? 1 : 0
  return clamp(0.40 * textScore + 0.25 * strength + 0.15 * fluent + 0.10 * imp + 0.05 * fresh + 0.05 * pinned, 0, 1)
}

/** 可及性分层：core（下意识）/ warm（稍想一下）/ longterm（要翻） */
export function layerOf(entry, now = Date.now()) {
  const strength = strengthAt(entry, now)
  const fluent = Number(entry.fluency ?? 0.5)
  if (entry.pinned) return 'core'
  if ((Number(entry.importance) || 3) >= 4 && strength >= 0.8 && fluent >= 0.6) return 'core'
  if (now - lastTouchedAt(entry) <= 7 * DAY && strength >= 0.5) return 'warm'
  return 'longterm'
}

/** 是否已经淡到"默认想不起来" */
export function isFaded(entry, now = Date.now()) {
  return !entry.pinned && strengthAt(entry, now) < 0.2
}

/** 对外状态：superseded/archived 是显式的；faded 是算出来的 */
export function statusOf(entry, now = Date.now()) {
  if (entry.status === 'superseded' || entry.status === 'archived') return entry.status
  return isFaded(entry, now) ? 'faded' : 'active'
}

/** 给结果用的一行摘要 */
export function describeEntry(entry, now = Date.now()) {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    tags: entry.tags || [],
    importance: entry.importance,
    strength: Number(strengthAt(entry, now).toFixed(3)),
    fluency: Number(clamp(Number(entry.fluency ?? 0.5), 0, 1).toFixed(3)),
    layer: layerOf(entry, now),
    status: statusOf(entry, now),
    pinned: !!entry.pinned,
    recallCount: entry.recallCount || 0,
    mentionCount: entry.mentionCount || 0,
    ageDays: Math.round((now - (Number(entry.createdAt) || now)) / DAY),
    source: entry.source || null,
  }
}
