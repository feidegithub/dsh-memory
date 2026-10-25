/**
 * lib/paths.mjs —— 存储位置、目录布局、JSON/JSONL 读写
 * ============================================================================
 * 位置：默认本地主存（$DSH_HOME/memory；若存在约定目录则优先用它），外挂盘仅做可选冷备
 *   本地主存：$DSH_HOME/memory（可用 Config.storageDir 改）
 *   外挂盘：仅夜间可选冷备；盘不在就跳过
 *
 * 主库是 append-only JSONL：
 *   更新 = 再追加一条同 id 的记录（load 时后写覆盖先写），
 *   这样不需要重写整库、掉电最多丢最后一行、坏行可跳过。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, statSync, truncateSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 本插件目录（lib/ 的上一级） */
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 默认主存：
 *   - 插件装在 `<主盘>/plugins/<插件名>` 时，用 `<主盘>/memory`（不写死盘符，靠自身位置反推）
 *   - 其他情况（clone 到任意目录）落到 `$DSH_HOME/memory`（默认 `~/.dsh/memory`）
 * 任何情况下都可以用 Config.storageDir 覆盖。
 */
export const DEFAULT_STORAGE_DIR = (() => {
  try {
    const root = join(PLUGIN_DIR, '..', '..')
    if (basename(root).toLowerCase() === 'deepseek') return join(root, 'memory')
  } catch { /* 反推失败就按通用路径 */ }
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'memory')
})()

/** 展开 ~ / %VAR% / 相对路径，并给出绝对目录（非字符串一律回默认值，防 [object Object]） */
export function resolveStorageDir(input) {
  let p = typeof input === 'string' ? input.trim() : ''
  if (!p) p = DEFAULT_STORAGE_DIR
  p = p.replace(/^~(?=$|[\\/])/, homedir())
  p = p.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? `%${k}%`)
  if (!p || p === '[object Object]') p = DEFAULT_STORAGE_DIR
  return p
}

/** 目录布局：一次算好，后面都从这里取 */
export function layout(root) {
  return {
    root,
    entries: join(root, 'entries.jsonl'),
    misses: join(root, 'misses.jsonl'),
    purged: join(root, 'purged.jsonl'),
    recallLog: join(root, 'recall-log.jsonl'),
    index: join(root, 'index.json'),
    synonyms: join(root, 'synonyms.json'),
    stats: join(root, 'stats.json'),
    consolidate: join(root, 'consolidate.json'),
    config: join(root, 'config.json'),
    episodes: join(root, 'episodes'),
    archive: join(root, 'archive'),
    backups: join(root, 'backups'),
    log: join(root, 'memory.log'),
  }
}

export function ensureLayout(l) {
  for (const d of [l.root, l.episodes, l.archive, l.backups]) {
    try { mkdirSync(d, { recursive: true }) } catch { /* 已存在 */ }
  }
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch { return fallback }
}

/** 原子写：先写 .tmp 再 rename（Windows 上 rename 覆盖已存在文件是允许的） */
export function writeJsonAtomic(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch { return false }
}

/** 追加一行 JSON（O_APPEND，单进程内足够安全） */
export function appendJsonl(file, value) {
  try {
    appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8')
    return true
  } catch { return false }
}

/** 读整个 JSONL：跳过坏行（坏行计数返回，便于体检） */
export function readJsonl(file) {
  const rows = []
  let bad = 0
  try {
    if (!existsSync(file)) return { rows, bad }
    const text = readFileSync(file, 'utf8')
    for (const line of text.split('\n')) {
      const s = line.trim()
      if (!s) continue
      try { rows.push(JSON.parse(s)) } catch { bad++ }
    }
  } catch { /* 读不了就当空 */ }
  return { rows, bad }
}

/** 整库压缩：把"最新快照"重写成 JSONL（先写 tmp 再 rename） */
export function compactJsonl(file, rows) {
  try {
    const tmp = `${file}.compact-${process.pid}`
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8')
    renameSync(tmp, file)
    return true
  } catch { return false }
}

/** 简单的滚动日志：超过 2MB 截掉前半（保留最近的一半） */
export function logLine(file, msg) {
  try {
    if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) {
      const text = readFileSync(file, 'utf8')
      writeFileSync(file, text.slice(Math.floor(text.length / 2)), 'utf8')
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8')
  } catch { /* 日志失败不能影响主流程 */ }
}

export { truncateSync }
