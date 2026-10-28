/**
 * tools/review.mjs —— 记忆体检（只读）
 * ============================================================================
 * 试运行几天后用它看一眼：记了多少、最近记了什么、有没有重复、
 * 哪些条目被反复想起、哪些问法一直想不起来。
 * 用法：node tools/review.mjs [数据目录]
 * ============================================================================
 */
import { layout } from '../lib/paths.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { tokenSet, jaccard } from '../lib/tokenize.mjs'
import { strengthAt, statusOf } from '../lib/model.mjs'
import { readJsonl } from '../lib/paths.mjs'

const root = process.argv[2] || 'D:\\APP\\deepseek\\memory'
const store = new MemoryStore({ cfg: {}, paths: layout(root), log: () => {} }).load()
const now = Date.now()

const live = [...store.live()]
const all = [...store.every()]
const byStrength = [...live].sort((a, b) => strengthAt(b, now) - strengthAt(a, now))
const recent = [...all].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
const topRecalled = [...live].sort((a, b) => (b.recallCount || 0) - (a.recallCount || 0))

console.log(`\n数据目录：${root}`)
console.log(`条目：${all.length}（活跃 ${live.length}，归档 ${all.filter((e) => statusOf(e, now) === 'archived').length}）`)
console.log(`索引：${store.index.size} 条，JSONL ${store.lines} 行，压缩 ${store.compactions} 次`)

console.log('\n最近 8 条：')
for (const e of recent.slice(0, 8)) {
  const d = new Date(e.createdAt || now).toISOString().slice(5, 16).replace('T', ' ')
  console.log(`  [${d}] ${e.kind}/${e.importance} ${statusOf(e, now)} | ${String(e.text).slice(0, 64)}`)
}

console.log('\n最常被想起的 5 条：')
for (const e of topRecalled.slice(0, 5)) {
  console.log(`  想起 ${e.recallCount || 0} 次 · 强度 ${strengthAt(e, now).toFixed(2)} | ${String(e.text).slice(0, 56)}`)
}

let dup = 0
for (let i = 0; i < all.length; i++) {
  for (let j = i + 1; j < all.length; j++) {
    const sim = jaccard(tokenSet(all[i].text), tokenSet(all[j].text))
    if (sim >= 0.7) {
      dup++
      if (dup <= 5) console.log(`\n疑似重复 ${sim.toFixed(2)}：${String(all[i].text).slice(0, 30)} ／ ${String(all[j].text).slice(0, 30)}`)
    }
  }
}
console.log(`\n疑似重复：${dup} 对`)

const miss = readJsonl(layout(root).misses)
const unresolved = new Map()
for (const r of miss.rows) if (r.cue) unresolved.set(r.cue, r)
const pending = [...unresolved.values()].filter((r) => !r.resolved)
console.log(`没想起来的问法：${pending.length} 条（已反挖 ${miss.rows.filter((r) => r.resolved).length} 条）`)
for (const r of pending.slice(-5)) console.log(`  · ${r.cue}`)

console.log('\n分布：')
for (const [layer, n] of Object.entries(store.summary(now))) console.log(`  ${layer}: ${n}`)
