/**
 * lib/inbox.mjs —— 抖音私信（只收使用者）→ 桌面记忆的收件箱
 * ============================================================================
 * 2026-10-30 使用者说：抖音那边我说话也走桌面记忆这条路吧。
 *
 * 为什么用「文件收件箱」而不是让 dm-watch 直接写 entries.jsonl：
 *   · entries.jsonl 是 dsh-memory 进程独占的 append-only 库，两个进程同时写会互相踩；
 *   · 桌面没开的时候 dm-watch 也能先投递，等桌面起来再收；
 *   · 每条消息带上**当时的情绪快照**，收取时按那一刻的深度入账，不是按收取时的心情。
 *
 * 格式：`<root>/inbox/douyin-owner.jsonl`，一行一条：
 *   { at, text, sessionId, source, emotion: { mood, energy, closeness, emotions, updatedAt } }
 *
 * 收取用字节偏移（<root>/inbox/douyin-owner.offset.json），只读新增的完整行；
 * dm-watch 只追加、不重写，桌面这边单进程读，天然不打架。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { extract } from './extract.mjs'
import { normalizeEmotionState } from './emotion-bridge.mjs'

export const INBOX_DIR = 'inbox'
export const INBOX_FILE = 'douyin-owner.jsonl'
export const OFFSET_FILE = 'douyin-owner.offset.json'

export function inboxPaths(root) {
  const dir = join(root, INBOX_DIR)
  return { dir, file: join(dir, INBOX_FILE), offsetFile: join(dir, OFFSET_FILE) }
}

/**
 * 收一次：把收件箱里新增的完整行喂给同一套抽取 + store.add。
 * @returns {{processed:number, written:number, deduped:number, bad:number}}
 */
export function drainInbox({ root, store, cfg, log, stats, at = Date.now() }) {
  const { file, offsetFile } = inboxPaths(root)
  const empty = { processed: 0, written: 0, deduped: 0, bad: 0 }
  if (!existsSync(file)) return empty

  let buf
  try { buf = readFileSync(file) } catch { return empty }

  let offset = 0
  try {
    const saved = JSON.parse(readFileSync(offsetFile, 'utf8'))
    offset = Math.max(0, Number(saved.offset) || 0)
  } catch { offset = 0 }
  if (offset > buf.length) offset = 0          // 文件被截断/换过：从头再收（去重兜底）

  const chunk = buf.subarray(offset)
  const lastNl = chunk.lastIndexOf(0x0a)        // 只处理完整行，半行留到下轮
  if (lastNl < 0) return empty
  const complete = chunk.subarray(0, lastNl + 1).toString('utf8')

  const result = { ...empty }
  for (const line of complete.split('\n')) {
    if (!line.trim()) continue
    let rec
    try { rec = JSON.parse(line) } catch { result.bad++; continue }
    const text = String(rec?.text || '').trim()
    result.processed++
    if (!text || text.length < 4) continue
    const recAt = Number(rec.at) || at
    const emo = rec.emotion ? normalizeEmotionState(rec.emotion) : null
    if (cfg?.extractMode === 'off') continue
    let candidates = []
    try {
      candidates = extract(text, { sessionId: rec.sessionId || 'douyin-dm-owner', seq: null, at: recAt })
    } catch (e) {
      log(`收件箱抽取失败：${e?.message || e}`)
      continue
    }
    const minImp = Number(cfg?.minImportance) || 2
    for (const cand of candidates) {
      if ((cand.importance || 3) < minImp) continue
      try {
        const r = store.add(cand, { at: recAt, emotion: emo })
        if (!r?.entry) continue
        if (r.deduped) { result.deduped++; stats?.inc?.('deduped') }
        else { result.written++; stats?.inc?.('extracted') }
      } catch (e) {
        log(`收件箱写入失败：${e?.message || e}`)
      }
    }
  }

  try {
    mkdirSync(dirname(offsetFile), { recursive: true })
    writeFileSync(offsetFile, JSON.stringify({ offset: offset + lastNl + 1, at: Date.now(), processed: result.processed }, null, 2), 'utf8')
  } catch (e) {
    log(`收件箱偏移写不进去（下轮会重收，去重兜底）：${e?.message || e}`)
  }

  if (result.processed) log(`收件箱：处理 ${result.processed} 条使用者 DM，新记 ${result.written} 条（合并 ${result.deduped}，坏行 ${result.bad}）`)
  return result
}
