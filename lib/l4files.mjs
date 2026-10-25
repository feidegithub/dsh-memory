/**
 * lib/l4files.mjs —— L4 的兜底实现：直接翻会话日志文件
 * ============================================================================
 * 为什么需要它（2026-10-25 实测）：
 *   这台机器的 `session-query-sqlite` 被配置成 `openAt: "never"`，
 *   调 `ctx.sessionQuery.searchSessions()` 直接抛
 *   "session search is disabled: this deployment configures the session-query index with openAt never"。
 *   不去改宿主的全局配置（那是使用者的部署决定），改成插件自己扫
 *   `~/.dsh/sessions/<工作区>/session-<id>/session.v4.jsonl`。
 *
 * 脾气：
 *   - 只读，不写、不改、不移动任何日志
 *   - 按文件 mtime+size 缓存解析结果（同一份日志只解析一次）
 *   - 有总字节上限，超了只扫最新的那部分；永远有界
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { normalize, tokenSet } from './tokenize.mjs'

const MAX_FILES = 2000
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
const MAX_CACHE_BYTES = 64 * 1024 * 1024

/** zstd 帧头魔数：0x28 B5 2F FD */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 注入进来的章程 / 运行时上下文 / 别的插件的人设 —— 都不是"我们说过的话" */
const BOILERPLATE = /Instructions from:|Current runtime context|workspace instructions|<system-reminder>|不透露\s*API\s*key|任何对象都适用/i


/**
 * 会话日志是**多帧拼接**的 zstd（每批追加写一帧）。
 * 2026-10-25 实测：一个 3MB 的会话有 2842 帧，
 * `zstdDecompressSync(整个文件)` 只肯解第一帧 —— 结果只读到 202 字节的 session 头。
 * 这里按魔数切开，一帧一帧解，再拼起来。
 * @returns {{text: string, frames: number, badFrames: number}}
 */
export function zstdFramesToString(buf) {
  const offsets = []
  let i = 0
  while (true) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j < 0) break
    offsets.push(j)
    i = j + 1
  }
  if (!offsets.length) return { text: '', frames: 0, badFrames: 0 }
  const parts = []
  let badFrames = 0
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end), { maxOutputLength: 16 * 1024 * 1024 }))
    } catch {
      badFrames++   // 魔数可能出现在压缩数据内部，切开失败就丢这一帧
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: offsets.length, badFrames }
}

/**
 * 从一条 session 事件里抽出**真正的对话文本**。
 * 2026-10-25 事故：一开始用"递归找 text 字段"，把 reasoning 块和工具参数也捞出来了，
 * 于是"回忆"翻回来的是我自己的分析长文。现在只认 content 里 type === 'text' 的块。
 */
export function eventText(ev) {
  const msg = ev?.data?.message || ev?.data
  const content = msg?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim())
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 6000)
}

/** 从长文本里截一段"命中最强"的窗口 */
function windowAround(text, tokens) {
  let at = -1
  for (const t of tokens) {
    const i = text.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return text.slice(0, 160)
  const start = Math.max(0, at - 40)
  return text.slice(start, start + 160)
}

export class FileLogSearch {
  constructor({ sessionsDir, log, maxFiles = MAX_FILES }) {
    this.log = log
    this.maxFiles = maxFiles
    this.root = sessionsDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
    this.cache = new Map()      // path -> { mtime, size, lines: string[] }
    this.cacheBytes = 0
  }

  available() {
    try { return existsSync(this.root) } catch { return false }
  }

  /** 列出会话日志文件（最多 maxFiles 个，按 mtime 新→旧） */
  listFiles() {
    const out = []
    try {
      for (const ws of readdirSync(this.root, { withFileTypes: true })) {
        if (!ws.isDirectory()) continue
        const wsDir = join(this.root, ws.name)
        let sessions
        try { sessions = readdirSync(wsDir, { withFileTypes: true }) } catch { continue }
        for (const s of sessions) {
          if (!s.isDirectory()) continue
          const dir = join(wsDir, s.name)
          let files
          try { files = readdirSync(dir, { withFileTypes: true }) } catch { continue }
          for (const f of files) {
            // 真实布局是 session.v4.jsonl.zstd（2026-10-25 实测）；也兼容未压缩的 .jsonl
            const zstd = f.name.endsWith('.jsonl.zstd')
            if (!f.isFile() || (!zstd && !f.name.endsWith('.jsonl'))) continue
            const path = join(dir, f.name)
            let st
            try { st = statSync(path) } catch { continue }
            out.push({ path, sessionId: s.name.replace(/^session-/, ''), mtime: st.mtimeMs, size: st.size, zstd })
          }
        }
      }
    } catch (e) {
      this.log?.(`扫会话目录失败：${e?.message || e}`)
    }
    out.sort((a, b) => b.mtime - a.mtime)
    return out.slice(0, this.maxFiles)
  }

  /** 读一个文件的可读文本行（带缓存）：只留用户/助手的对话，工具输出一律不要 */
  linesOf(file) {
    const hit = this.cache.get(file.path)
    if (hit && hit.mtime === file.mtime && hit.size === file.size) return hit.lines
    let lines = []
    try {
      const buf = readFileSync(file.path)
      const raw = file.zstd ? zstdFramesToString(buf).text : buf.toString('utf8')
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue
        try {
          const ev = JSON.parse(line)
          const type = ev?.type
          if (type !== 'user/message' && type !== 'assistant/message') continue
          const text = eventText(ev)
          if (text.length < 4) continue
          if (BOILERPLATE.test(text)) continue
          // 超长的"用户消息"多半是别人插件的提示词/整篇文档（实测把人格设定翻出来当记忆），跳过
          if (text.length > 1500) continue
          // 纯文本块的助手消息可以是长解释；超过 2000 字的只是噪音
          if (type === 'assistant/message' && text.length > 2000) continue
          lines.push({ text, role: type === 'user/message' ? 'user' : 'assistant' })
        } catch { /* 坏行跳过 */ }
      }
    } catch (e) {
      this.log?.(`读会话日志失败：${e?.message || e}`)
    }
    const bytes = lines.reduce((n, x) => n + x.text.length, 0)
    this.cache.set(file.path, { mtime: file.mtime, size: file.size, lines, bytes })
    this.cacheBytes += bytes
    // 简单的 LRU 上限：超了就从最早放进来的开始丢
    while (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size > 8) {
      const first = this.cache.keys().next().value
      const v = this.cache.get(first)
      this.cacheBytes -= v?.bytes || 0
      this.cache.delete(first)
    }
    return lines
  }

  /**
   * 在日志里找这个 cue。
   * @returns {Array<{sessionId, seq, snippet, sim, live, file}>}
   */
  search(cue, { limit = 3 } = {}) {
    if (!this.available()) return []
    const q = normalize(cue)
    if (q.length < 2) return []
    const qt = [...tokenSet(cue)]
    if (!qt.length) return []
    // 只用最长的一批 token 做包含判断，避免每条都全量比
    const probes = qt.sort((a, b) => b.length - a.length).slice(0, 8)

    const best = []
    let scanned = 0
    for (const file of this.listFiles()) {
      if (scanned > MAX_TOTAL_BYTES) break
      scanned += file.size
      const lines = this.linesOf(file)
      let fileBest = null
      for (let i = 0; i < lines.length; i++) {
        const { text, role } = lines[i]
        if (!text) continue
        let hit = 0
        for (const t of probes) if (text.includes(t)) hit++
        if (!hit) continue
        // 用户亲口说的权重略高：那是"发生过的事"，助手说的是"我当时的说法"
        const raw = text.includes(q) ? 1 : hit / Math.max(1, probes.length)
        const sim = raw * (role === 'user' ? 1 : 0.9)
        if (sim < 0.22) continue
        if (!fileBest || sim > fileBest.sim) {
          fileBest = {
            sessionId: file.sessionId, seq: i + 1, snippet: windowAround(text, probes),
            sim, role, live: false, file: file.path,
          }
          if (raw >= 1 && role === 'user') break
        }
      }
      if (fileBest) best.push(fileBest)
    }
    return best.sort((a, b) => b.sim - a.sim).slice(0, limit)
  }
}
