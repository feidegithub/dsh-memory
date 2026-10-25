/**
 * lib/extract.mjs —— 启发式抽取（纯规则，0 token）
 * ============================================================================
 * M1 只做"信号词 + 所在那一小句 + 短句模板"，**不抄整段**：
 *   - 写入 0 token；条目短（≤140 字），注入时也不占地方
 *   - 宁可漏，不可脏：抽不到就靠 memory_remember 显式补
 * 只在**用户消息**上跑：我自己说的话不当作事实来源（要记就用 memory_remember）。
 * ============================================================================
 */
import { splitSentences } from './tokenize.mjs'

/** 碰这些就不记（凭证类）——与章程红线一致 */
export const SENSITIVE = /(cookie|set-cookie|token|bearer|authorization|api[_-]?key|secret|密码|口令|私钥|身份证|银行卡|支付密码)/i

const MAX_TEXT = 140

const SIGNALS = [
  {
    id: 'explicit', kind: 'fact', importance: 5, why: '显式要求记住',
    re: /(记住|记一下|记着|别忘了|帮我记|记下来|备忘|存一下这个|记进记忆)/,
  },
  {
    id: 'preference', kind: 'preference', importance: 3, why: '偏好',
    re: /(我|俺|咱)(?:很|挺|比较|最|特别|也|就)?(?:喜欢|不喜欢|讨厌|偏爱|爱用|习惯|想要|不要|希望|受不了|爱吃|爱看|常用)/,
  },
  {
    id: 'commitment', kind: 'commitment', importance: 4, why: '约定/习惯',
    re: /(以后|今后|从现在起|往后|每次|一律|统统|都)(?:要|别|不要|必须|得|给我|用|走)/,
  },
  {
    id: 'decision', kind: 'fact', importance: 4, why: '已定的事',
    re: /(决定|定了|就这么|改成|换成|定为|统一用|以后都|从今天起)/,
  },
  {
    id: 'correction', kind: 'fact', importance: 4, why: '纠正',
    re: /(不对|不是这样|我说的是|纠正一下|搞错了|应该是|说错了)/,
  },
  {
    id: 'identity', kind: 'fact', importance: 3, why: '身份/归属',
    // 只认"我的X是/在/叫..."这种有主语的陈述；"我是/我在"太容易误报（我在看、我是在等）
    re: /我的[^\s，。]{1,8}(?:是|在|叫|放在|存在)/,
  },
]

/** 一些看着像信号、其实不是的说法 */
const FALSE_POSITIVE = /(我是说|不是说|我是在想|我在想|你是谁|我是谁|假设|假如|如果|比如|例如|测试一下|举个例子)/

function clip(s, n = MAX_TEXT) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

function stripCode(text) {
  return String(text || '').replace(/```[\s\S]*?```/g, ' ')
}

/** 抽取可能与该句相关的标签（用于以后按字段换角度检索） */
function tagsOf(text) {
  const tags = []
  if (/[A-Za-z]:\\|\\\\|https?:\/\//.test(text)) tags.push('路径')
  if (/\d{4}[-/年]\d{1,2}/.test(text)) tags.push('时间')
  if (/(抖音|微信|B站|GitHub|Gitee|DeepSeek)/i.test(text)) tags.push('平台')
  return tags
}

/**
 * 一眼像"整段粘贴的文档"吗（章程 / README / 表格 / 目录清单）？
 * 2026-10-25 真事故：AGENTS.md 被当成用户消息喂进来，
 * 一行「挑几条由当天剩余额度**决定**」命中了"已定的事"信号，被记成事实。
 * 所以：文档样式的文本，只允许"显式要求记住"这一种信号。
 */
export function looksLikeDocument(text) {
  const s = String(text || '')
  if (s.length > 600) return true
  if (/^\s*#{1,6}\s/m.test(s)) return true          // 有 markdown 标题
  if (/^\s*\|.*\|/m.test(s)) return true            // 有表格
  const lines = s.split('\n')
  const structural = lines.filter((l) => /^\s*(#{1,6}\s|[-*+]\s|\|\s*|>\s|\d+\.\s)/.test(l)).length
  return lines.length >= 5 && structural >= 3
}

const STRUCTURAL_LINE = /^\s*(#{1,6}\s|[-*+]\s|\|\s*|>\s|\d+\.\s)/

/**
 * @returns {Array<{kind,subject,text,importance,tags,why,signalId,source,createdAt}>}
 */
export function extract(text, { sessionId = null, seq = null, at = Date.now() } = {}) {
  const raw = stripCode(text)
  if (!raw || raw.length < 4) return []
  // 超长粘贴只看两头，别让一整篇文档变成记忆
  const body = raw.length > 4000 ? `${raw.slice(0, 1200)}\n${raw.slice(-400)}` : raw
  const docLike = looksLikeDocument(raw)

  const out = []
  const seen = []
  for (const rawSentence of splitSentences(body)) {
    if (rawSentence.length > 1200) continue
    if (SENSITIVE.test(rawSentence)) continue
    if (FALSE_POSITIVE.test(rawSentence) && !/记住|备忘/.test(rawSentence)) continue
    const structural = STRUCTURAL_LINE.test(rawSentence)

    for (const sig of SIGNALS) {
      // 文档段落 / 列表项里的"决定""改成"多半是别人的条款，不是使用者的话
      if ((docLike || structural) && sig.id !== 'explicit') continue
      if (!sig.re.test(rawSentence)) continue
      let text = clip(rawSentence.replace(/^[-*•\s]+/, ''))
      // "记住：X" → 只留 X，别把指令本身记进去
      if (sig.id === 'explicit') {
        const m = text.match(/(?:记住|记一下|记下来|帮我记|备忘)[：:，,\s]*(.+)$/)
        if (m && m[1].length >= 4) text = clip(m[1])
      }
      if (text.length < 4) continue
      if (seen.some((prev) => prev === text)) continue
      seen.push(text)

      const bonus = /[A-Za-z]:\\|https?:\/\//.test(text) ? 1 : 0
      out.push({
        kind: sig.kind,
        subject: 'user',
        text,
        importance: Math.min(5, sig.importance + bonus),
        tags: tagsOf(text),
        why: sig.why,
        signalId: sig.id,
        source: { sessionId, seq, quote: clip(rawSentence, 200) },
        createdAt: at,
      })
      break // 一句只记一次，取第一个命中的信号
    }
    if (out.length >= 5) break
  }
  return out.sort((a, b) => b.importance - a.importance).slice(0, 5)
}
