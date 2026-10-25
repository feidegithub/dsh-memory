/**
 * lib/tokenize.mjs —— 中英混排分词（无依赖）
 * ============================================================================
 * 中文没有空格，又装不动分词库，所以用 **bigram 倒排**：
 *   "记忆系统" → 记忆 / 忆系 / 系统
 * 查询同样切 bigram，重合两个以上就说明"说的是一回事"。
 * 英文/数字按词切（长度 ≥2），路径、URL 这种长串靠"原文包含"额外加分。
 * ============================================================================
 */

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/
const CJK_RUN = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g
const LATIN = /[a-z0-9][a-z0-9_\-.]*/g

/** 归一化：全角→半角、小写、标点变空格 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[，。！？；：、“”‘’（）【】《》〈〉…—～·!?,.;:"'()\[\]{}<>/\\|`~^*+=&#@$%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 中文 bigram（单字成词则保留单字；短串额外保留整串，提升精确匹配） */
function cjkTokens(run) {
  const out = []
  if (run.length === 1) { out.push(run); return out }
  for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2))
  if (run.length <= 4) out.push(run)
  return out
}

/** 切 token（可能重复，调用方自己数 tf） */
export function tokens(text) {
  const s = normalize(text)
  if (!s) return []
  const out = []
  for (const run of s.match(CJK_RUN) || []) out.push(...cjkTokens(run))
  const latin = s.replace(CJK_RUN, ' ').match(LATIN) || []
  for (const w of latin) {
    const w2 = w.replace(/^[.\-]+|[.\-]+$/g, '')
    if (w2.length >= 2) out.push(w2)
  }
  return out
}

/**
 * 索引专用 token：在 bigram 基础上**再加单字**。
 * 为什么必须加：问"笔什么颜色"时，"笔什/什么"和原文"支笔/笔是"一个都对不上，
 * 只靠 bigram 会漏；单字的 idf 很低（"的/是"这种几乎没有权重），
 * 但"笔""色"这种实词能把它捞回来。
 * 去重仍然用 tokens()（bigram），避免单字把两句不同的话算成同一句。
 */
export function indexTokens(text) {
  const s = normalize(text)
  if (!s) return []
  const out = []
  for (const run of s.match(CJK_RUN) || []) {
    out.push(...cjkTokens(run))
    if (run.length > 1) for (const ch of run) out.push(ch)
  }
  const latin = s.replace(CJK_RUN, ' ').match(LATIN) || []
  for (const w of latin) {
    const w2 = w.replace(/^[.\-]+|[.\-]+$/g, '')
    if (w2.length >= 2) out.push(w2)
  }
  return out
}

/** 去重 token 列表（保序） */
export function tokenSet(text) {
  return [...new Set(tokens(text))]
}

/** Jaccard 相似度（用于写入去重） */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a)
  const B = b instanceof Set ? b : new Set(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const t of A) if (B.has(t)) inter++
  return inter / (A.size + B.size - inter)
}

/** 粗估 token 数（中文 1 字≈1 token，英文 4 字符≈1 token） */
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (!s) return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (CJK.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/** 按句切（保留标点），用于抽取"信号词所在的那一句" */
export function splitSentences(text) {
  return String(text ?? '')
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export { CJK }
