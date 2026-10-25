/**
 * lib/config.mjs —— 配置解包（踩过的坑，必须留在这里）
 * ============================================================================
 * 2026-10-25 的真事故：
 *   schemastery 3.18.5 里，`.extra('volatile', true)` 不只是打标记 ——
 *   它会把字段值**包成 `{ get() }` 的 volatile 包装器**：
 *       z.boolean().default(true).extra('volatile', true)  →  { get: () => true }
 *   而 apply(ctx, config) 拿到的就是这些包装器。我没拆就直接用：
 *       storageDir → String(包装器) → "[object Object]"
 *       enabled    → 永远 truthy
 *   于是记忆写进了 `<profile>\[object Object]\entries.jsonl`，D 盘一条都没有。
 *
 * 所以：**任何从 config 取出来的值，先过 unwrapValue()**。
 * 纯值原样返回，包装器取 .get()，其余不动。
 * ============================================================================
 */

/** 是不是 volatile 包装器：只有 get 一个可枚举键，且 get 是函数 */
export function isVolatileWrapper(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  if (typeof v.get !== 'function') return false
  const keys = Object.keys(v)
  return keys.length <= 2 && keys.every((k) => k === 'get' || k === 'set')
}

export function unwrapValue(v) {
  if (isVolatileWrapper(v)) {
    try { return v.get() } catch { return undefined }
  }
  return v
}

/** 把整份 config 拆成纯值；未提供的键不出现（交给 DEFAULTS 兜底） */
export function unwrapConfig(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) out[k] = unwrapValue(v)
  return out
}

/** DEFAULTS + 解包后的覆盖值 */
export function resolveConfig(defaults, raw) {
  return { ...defaults, ...unwrapConfig(raw) }
}

/** 数字字段：容忍字符串/包装器/NaN */
export function toNum(v, fallback) {
  const n = Number(unwrapValue(v))
  return Number.isFinite(n) ? n : fallback
}

/** 布尔字段：只有明确的 true/"true"/1 才算真，别让包装器把 false 变成 true */
export function toBool(v, fallback = false) {
  const u = unwrapValue(v)
  if (typeof u === 'boolean') return u
  if (u === 'true' || u === 1) return true
  if (u === 'false' || u === 0) return false
  return fallback
}

/** 字符串字段：不是字符串就回退（storageDir 这种必须防） */
export function toStr(v, fallback = '') {
  const u = unwrapValue(v)
  return typeof u === 'string' && u.length ? u : fallback
}
