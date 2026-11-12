/**
 * lib/privacy.mjs —— 私密词表：让某些话只留在桌面记忆，不进对外提示词
 * ============================================================================
 * 2026-11-02：使用者亲口说了真名，要求「记好、不能告诉别人」。
 * 记忆插件可以记住，但**私信 / 评论区**这些对外通道不能把它塞进提示词。
 *
 * 做法：
 *   · `<memory root>/private-terms.txt` 一行一个词，`#` 开头是注释
 *   · 写入记忆时，文本命中词表 → 自动打上「私密」标签
 *   · `_shims/mem-recall.mjs`（私信看守用的无头检索）默认跳过「私密」标签，
 *     也直接按词表匹配文本兜底（旧条目、漏打标签的条目都挡得住）
 *
 * 这个词表本身也只在本机；不要把它贴进公开仓库或发给别人。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PRIVATE_TAG = '私密'

/** 即使词表丢了，这类说法也按私密处理（真名/本名/真实姓名） */
const PRIVATE_HINT = /真名|本名|真实姓名/

export function privateTermsFile(root) {
  return join(root, 'private-terms.txt')
}

/** 读词表；读不到就是空（不影响记忆功能） */
export function loadPrivateTerms(root) {
  try {
    return readFileSync(privateTermsFile(root), 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
      .slice(0, 500)
  } catch {
    return []
  }
}

export function isPrivateText(text, terms) {
  const t = String(text || '')
  return (terms || []).some((term) => term && t.includes(term))
}

/** 命中词表就给条目补上「私密」标签（原地改） */
export function tagPrivate(entry, terms) {
  if (!entry) return entry
  const tags = Array.isArray(entry.tags) ? entry.tags : []
  const hit = isPrivateText(entry.text, terms) || PRIVATE_HINT.test(String(entry.text || ''))
  if (!hit && !tags.includes(PRIVATE_TAG)) return entry
  entry.tags = [...new Set([...tags, PRIVATE_TAG])].slice(0, 12)
  return entry
}
