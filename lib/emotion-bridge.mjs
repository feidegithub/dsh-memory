/**
 * lib/emotion-bridge.mjs —— 情绪 → 记忆深度的桥（只读）
 * ============================================================================
 * 2026-10-30 使用者要求：把情绪插件和记忆插件绑起来，情绪影响记忆的深度；
 * 但**要不要记下这条记忆，仍由小鲤自己判断**（本文件只读情绪，不写任何记忆）。
 *
 * 绑定方式故意做得很松：
 *   · 不 import 情绪插件的代码，只读它维护的 emotion.json（同一个文件，dm-watch 也用它）
 *   · 文件不在 / 坏了 → 当作"平静"，记忆照常按原来的半衰期走，不报错、不阻塞
 *   · 情绪只影响：写入时的深度（半衰期 ×1~×2.5）、排序里一点点加权、结果里的情绪印记
 *
 * 深度公式：
 *   weight = 0.8 × 最浓的那种情绪 + 0.2 × |心情|
 *   depth  = 1 + 1.5 × weight        （半衰期最多拉长到 2.5 倍）
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const EMO_LABELS = {
  joy: '开心', sulk: '委屈', miss: '想念', worry: '心疼',
  shy: '害羞', proud: '小得意', coax: '撒娇', anger: '生气',
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n

/** 默认和 dsh-persona / dm-watch 看同一个文件；可用 DSH_PERSONA_EMOTION_FILE 覆盖 */
export function defaultEmotionFile() {
  if (process.env.DSH_PERSONA_EMOTION_FILE) return process.env.DSH_PERSONA_EMOTION_FILE
  const home = process.env.DOUYIN_HOME
    || join(process.env.USERPROFILE || process.env.HOME || homedir(), '.dsh', 'douyin-duty')
  return join(home, 'emotion.json')
}

/** 把 emotion.json 归一成只读快照（坏文件 = 平静，绝不抛） */
export function normalizeEmotionState(raw, file = '') {
  const emo = raw && typeof raw.emotions === 'object' ? raw.emotions : {}
  let topKey = ''
  let top = 0
  for (const [k, v] of Object.entries(emo)) {
    const n = Number(v) || 0
    if (n > top) { top = n; topKey = k }
  }
  const mood = clamp(Number(raw?.mood) || 0, -1, 1)
  const weight = clamp(0.8 * top + 0.2 * Math.abs(mood), 0, 1)
  return {
    file,
    dominant: top >= 0.2 ? topKey : 'calm',
    label: top >= 0.2 ? (EMO_LABELS[topKey] || topKey) : '平静',
    v: round(top),
    mood: round(mood, 2),
    energy: round(clamp(Number(raw?.energy) || 0, 0, 1), 2),
    closeness: round(clamp(Number(raw?.closeness) || 0, 0, 1), 2),
    weight: round(weight, 2),
    depth: round(1 + 1.5 * weight, 2),
    at: Number(raw?.updatedAt) || 0,
  }
}

export function readEmotion(file = defaultEmotionFile()) {
  try {
    return normalizeEmotionState(JSON.parse(readFileSync(file, 'utf8')), file)
  } catch {
    return normalizeEmotionState(null, file)
  }
}

/** 写进条目里的那份（太淡就不带，省字段） */
export function emotionForEntry(state, at = Date.now()) {
  if (!state || Number(state.weight) < 0.05) return null
  return {
    key: state.dominant || state.key || 'calm',
    label: state.label,
    v: Number(state.v) || 0,
    mood: Number(state.mood) || 0,
    weight: Number(state.weight) || 0,
    at,
  }
}

/** 半衰期倍数（给 model 用；条目没有情绪就是 1） */
export function depthFactor(entry) {
  const w = clamp(Number(entry?.emotionalWeight) || 0, 0, 1)
  return 1 + 1.5 * w
}
