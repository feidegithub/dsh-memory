/**
 * tools/smoke.mjs —— 自检（不装宿主也能跑）
 * ============================================================================
 * 覆盖 M1 的六件事：
 *   ① 抽取（纯规则）② 去重/合并 ③ 倒排召回 ④ 60 秒窗（用 1.5s 版测超时）
 *   ⑤ 衰减与遗忘（旧条目默认搜不到、include_faded 能捞）⑥ 重启后仍在
 * 用法：node tools/smoke.mjs
 * ============================================================================
 */
import { mkdtempSync, readFileSync, rmSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layout, ensureLayout } from '../lib/paths.mjs'
import { MemoryStore } from '../lib/store.mjs'
import { RecallEngine } from '../lib/recall.mjs'
import { Stats } from '../lib/stats.mjs'
import { extract, looksLikeDocument } from '../lib/extract.mjs'
import { DAY, halfLifeDays, isFaded, strengthAt } from '../lib/model.mjs'
import { resolveConfig } from '../lib/config.mjs'
import { DEFAULT_STORAGE_DIR, resolveStorageDir } from '../lib/paths.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-mem-smoke-'))
const paths = layout(root)
ensureLayout(paths)
const cfg = { recallLimit: 8, recallDeadlineMs: 60_000 }
const quiet = () => {}
const stats = new Stats({ paths, log: quiet })
const store = new MemoryStore({ cfg, paths, log: quiet }).load()
const engine = new RecallEngine({ store, cfg, stats, paths, log: quiet, synonyms: { 主存: ['主存储', '记忆放哪'] } })

let pass = 0
let fail = 0
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ` — ${extra}` : ''}`) }
  else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`) }
}

console.log(`\n[1] 启发式抽取（纯规则，0 token）`)
const samples = [
  '以后都用 pwsh，不要用 cmd。',
  '我不喜欢在回复里堆一堆表情。',
  '记住：使用者的女朋友叫小满。',
  '决定把记忆存到 D 盘，E 盘只做冷备。',
]
for (const s of samples) {
  const cands = extract(s, { sessionId: 'session-smoke', seq: 1 })
  for (const c of cands) store.add(c)
  console.log(`  · «${s}» → ${cands.map((c) => `${c.kind}/${c.importance}`).join(', ') || '（无）'}`)
}
check('抽到了 4 句里的至少 3 句', store.size() >= 3, `共 ${store.size()} 条`)

console.log(`\n[1b] 文档段落不自动记（2026-10-25 真事故的回归测试）`)
const doc = [
  '## 排片权',
  '- 每轮最多看 12 条候选（`maxPerRun`），挑几条由当天剩余额度决定。',
  '- 夜里（23:00–09:00）不排。',
].join('\n')
check('识别为文档样式', looksLikeDocument(doc) === true)
check('整段文档 → 0 条', extract(doc).length === 0, `抽到 ${extract(doc).length} 条`)
check('文档里显式"记住"仍生效', extract(`${doc}\n记住：E 盘拔了不影响主存。`).length >= 1)

console.log(`\n[1c] volatile 配置包装器必须拆开（同一天的根因）`)
const wrapped = {
  enabled: { get: () => false },
  storageDir: { get: () => 'D:\\memory-test' },
  recallLimit: { get: () => 5 },
  allowModel: { get: () => false },
}
const merged = resolveConfig({ enabled: true, storageDir: 'x', recallLimit: 8, allowModel: true }, wrapped)
check('布尔 false 没被包装器变成 true', merged.enabled === false && merged.allowModel === false)
check('数字/字符串解包正确', merged.recallLimit === 5 && merged.storageDir === 'D:\\memory-test')
check('非字符串 storageDir 回退默认值', resolveStorageDir({}) === DEFAULT_STORAGE_DIR)

console.log(`\n[2] 去重：同一句再说一遍`)
const before = store.size()
const again = extract('记住：使用者的女朋友叫小满。', { sessionId: 'session-smoke', seq: 2 })
const r1 = store.add(again[0])
check('没有新增条目', store.size() === before, `仍为 ${store.size()} 条`)
check('识别为合并', r1.deduped === true)

console.log(`\n[3] 倒排召回（走完整 episode：L3 → 命中即答）`)
const ask = async (q, opts = {}) => {
  const e = engine.start(q, opts)
  if (e.result) return e.result
  return engine.wait(e.id, 900)
}
const h1 = await ask('pwsh 用什么 shell')
check('能想起 pwsh 那条', h1.state === 'found' && h1.hits.some((h) => h.text.includes('pwsh')), h1.hits[0]?.text)
const h2 = await ask('小满是谁')
check('能想起小满那条', h2.state === 'found' && h2.hits.some((h) => h.text.includes('小满')), h2.hits[0]?.text)
const h3 = await ask('记忆放哪儿')
check('同义词表生效（记忆放哪 → 主存）', h3.state === 'found' && h3.hits.some((h) => h.text.includes('D 盘')), h3.hits[0]?.text)
check('快命中不拖时间（<300ms）', h1.took_ms < 300, `${h1.took_ms}ms`)
check('命中会加深印象（recallCount>0）', (store.get(h1.hits[0].id)?.recallCount || 0) > 0)

// 精度：问 pwsh 时不许把"小满"这种无关但新鲜的条目塞进来
const pwshOnly = engine.run('pwsh 用什么 shell', 0, {})
check('无关条目不会被硬塞（precision）', pwshOnly.every((h) => !h.entry.text.includes('小满')), `${pwshOnly.length} 条命中`)
const nanxiOnly = engine.run('小满是谁', 0, {})
check('问小满时也只回小满', nanxiOnly.every((h) => h.entry.text.includes('小满')), `${nanxiOnly.length} 条命中`)

console.log(`\n[4] 60 秒硬窗（这里用 1.5s 版测"忘了"）`)
const t0 = Date.now()
const ep = engine.start('量子计算机的退相干时间是多少', { deadlineMs: 1500 })
check('首次没有命中 → pending', !ep.result && ep.status === 'searching', ep.status)
const pending = await engine.wait(ep.id, 200)
check('短等返回 pending', pending.state === 'pending', pending.state)
// 阶梯放宽的是"搜哪里"，不是"相关度底线"：跑到最高级也不许拿无关条目凑答案
check('最高级也不许编造（level 5 仍为空）', engine.run('量子计算机的退相干时间是多少', 5, {}).length === 0)
const done = await engine.wait(ep.id, 5000)
check('到点判为 forgotten', done.state === 'forgotten' && done.forgotten === true, `${done.took_ms}ms`)
check('确实等到了 deadline（≥1.4s）', Date.now() - t0 >= 1400, `${Date.now() - t0}ms`)

console.log(`\n[5] 衰减：三十天前提过的一件小事`)
const oldAt = Date.now() - 30 * DAY
const r2 = store.add({
  kind: 'fact', subject: 'user', text: '桌上那支笔是蓝色的', importance: 2,
  why: '测试衰减', signalId: 'identity', createdAt: oldAt,
  source: { sessionId: 'session-smoke', seq: 3, quote: '桌上那支笔是蓝色的' },
}, { at: oldAt })
const e2 = r2.entry
check('30 天后强度已低于 0.2', strengthAt(e2) < 0.2, `strength=${strengthAt(e2).toFixed(3)} 半衰期=${halfLifeDays(e2).toFixed(1)}天`)
check('标记为 faded', isFaded(e2) === true)
const penMiss = engine.run('笔什么颜色', 0, {})
check('默认搜不到（已淡忘）', penMiss.every((h) => h.entry.id !== e2.id))
const penDeep = engine.run('桌上那支笔是什么颜色', 0, { includeFaded: true })
check('include_faded 能捞到', penDeep.some((h) => h.entry.id === e2.id), penDeep[0]?.entry.text)

console.log(`\n[6] 复习的间隔效应（同一分钟内反复说，几乎不涨）`)
const e3 = store.add({
  kind: 'preference', subject: 'user', text: '喜欢用表格说明问题', importance: 3,
  why: '测试复习', signalId: 'preference', createdAt: Date.now() - 2 * DAY,
  source: null,
}, { at: Date.now() - 2 * DAY }).entry
const s0 = strengthAt(e3)
store.touchMention(e3)
const s1 = strengthAt(e3)
store.touchMention(e3)
const s2 = strengthAt(e3)
check('第一次复习明显加深', s1 > s0, `${s0.toFixed(3)} → ${s1.toFixed(3)}`)
check('紧接着再来一次几乎不涨', Math.abs(s2 - s1) < 0.02, `${s1.toFixed(3)} → ${s2.toFixed(3)}`)

console.log(`\n[7] 落盘与重启`)
const countBefore = store.size()
const linesBefore = store.lines
const store2 = new MemoryStore({ cfg, paths, log: quiet }).load()
check('重启后条目数一致', store2.size() === countBefore, `${store2.size()} / ${countBefore}`)
check('索引重建成功', store2.index.size > 0, `${store2.index.size} 条进索引`)
store2.compactIfNeeded(true)
check('压缩后行数下降', store2.lines < linesBefore, `${linesBefore} → ${store2.lines} 行`)
check('entries.jsonl 存在', statSync(paths.entries).size > 0, `${statSync(paths.entries).size} bytes`)

console.log(`\n[8] 账本`)
const snap = stats.snapshot()
check('记录了回忆次数', snap.totals.recalls >= 4, `recalls=${snap.totals.recalls}`)
check('记录了命中率', snap.totals.hits >= 3, `hits=${snap.totals.hits}`)
check('记录了遗忘', snap.totals.forgotten >= 1, `forgotten=${snap.totals.forgotten}`)
check('联想段 0 次模型调用', snap.totals.modelCalls === 0, `modelCalls=${snap.totals.modelCalls}`)

/* ─────────────── M2：L4 深挖 + 夜间巩固 ─────────────── */

const mockDeep = {
  available: () => true,
  async search(cue) {
    if (!String(cue).includes('量子')) return []
    return [{ sessionId: 'session-old-1', seq: 42, snippet: '量子退相干的时间尺度在毫秒到秒之间，室温下更短', sim: 0.42, live: false, role: 'user' }]
  },
  async recentSessions() {
    return [{ header: { id: 'session-today-1', createdAt: Date.now() } }]
  },
  async titles() {
    return new Map([['session-today-1', '记忆系统 M1 落地与三次事故复盘']])
  },
}

console.log(`\n[9] L4 深挖（历史会话原文）`)
const engine2 = new RecallEngine({ store, cfg, stats, paths, log: quiet, synonyms: {}, deep: mockDeep })
const ep9 = engine2.start('量子退相干还记得吗', { deadlineMs: 5000 })
const r9 = ep9.result || await engine2.wait(ep9.id, 2000)
check('L3 没有，L4 翻到了', r9.state === 'found' && r9.layer_used === 'history', r9.layer_used)
check('带原文与出处', r9.hits?.[0]?.source?.sessionId === 'session-old-1' && r9.hits?.[0]?.from_history === true)
check('顺手沉淀成条目（下次更快）', !!r9.stored_entry_id, r9.stored_entry_id)
check('沉淀的条目打了「历史」标签', !!store.get(r9.stored_entry_id)?.tags?.includes('历史'))

// 助手自己说过的话：可以当线索返回，但不许沉淀成"记忆"
const mockDeepAsst = {
  available: () => true,
  async search() { return [{ sessionId: 'session-old-2', seq: 9, snippet: '这是助手当时的一段解释，不是事实陈述', sim: 0.6, role: 'assistant' }] },
}
const engine3 = new RecallEngine({ store, cfg, stats, paths, log: quiet, synonyms: {}, deep: mockDeepAsst })
const epA = engine3.start('助手当时怎么解释的', { deadlineMs: 3000 })
const rA = epA.result || await engine3.wait(epA.id, 2000)
check('助手的话能当线索返回', rA.state === 'found' && rA.layer_used === 'history', rA.layer_used)
check('但不会被沉淀成记忆', !rA.stored_entry_id)
engine3.dispose()

console.log(`\n[9b] L4 兜底：直接扫会话日志文件（宿主索引被关掉时走这条）`)
const { FileLogSearch } = await import('../lib/l4files.mjs')
const sdir = join(root, 'sessions', '--ws--', 'session-abc')
mkdirSync(sdir, { recursive: true })
writeFileSync(join(sdir, 'session.v4.jsonl'), [
  JSON.stringify({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '我们讨论过紫色电饭煲放在厨房北边第二个柜子里' }] } } }),
  JSON.stringify({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '记住了，北边第二个柜子' }] } } }),
  'not-json-line',
].join('\n'), 'utf8')
const fl = new FileLogSearch({ sessionsDir: join(root, 'sessions'), log: quiet })
check('扫得到日志文件里的原文', fl.search('电饭煲放哪').some((r) => r.snippet.includes('电饭煲')))
check('能对上会话 id', fl.search('电饭煲放哪')[0]?.sessionId === 'abc')
check('无关的问法不会硬凑', fl.search('量子退相干时间尺度').length === 0)
check('坏行不会让扫描炸掉', fl.search('柜子').length >= 1)

// 真实布局是 zstd 压缩的：session.v4.jsonl.zstd
const sdir2 = join(root, 'sessions', '--ws2--', 'session-zzz')
mkdirSync(sdir2, { recursive: true })
const zline = JSON.stringify({ type: 'user/message', data: { message: { role: 'user', content: [{ type: 'text', text: '我们把记忆主存放在 D 盘，E 盘只做冷备' }] } } })
writeFileSync(join(sdir2, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${zline}\n`, 'utf8')))
check('能解 zstd 压缩的日志', fl.search('记忆主存放哪').some((r) => r.sessionId === 'zzz'))

console.log(`\n[10] 夜间巩固：归档 / 合并 / 情景 / 事后反挖`)
const { Consolidator } = await import('../lib/consolidate.mjs')
const { appendJsonl } = await import('../lib/paths.mjs')
// 造两条近似重复（直接 save，绕过写入去重，专测巩固阶段的合并）
const mk = (id, text) => ({
  id, kind: 'fact', subject: 'user', text, tags: [], importance: 3, confidence: 0.7,
  strengthBase: 1, strengthAt: Date.now() - DAY, fluency: 0.5, mentionCount: 1, recallCount: 0,
  status: 'active', createdAt: Date.now() - DAY, updatedAt: Date.now() - DAY, source: null, cues: [],
})
store.save(mk('mem_smoke_merge_a', '周五下午三点在会议室开例会'))
store.save(mk('mem_smoke_merge_b', '周五下午三点在二楼会议室开例会'))
// 造一条"当时没想起来"的 miss
appendJsonl(paths.misses, { at: Date.now() - 1000, cue: '量子退相干', session: 'session-smoke', attempts: 6, took_ms: 60000 })

const cons = new Consolidator({ store, stats, paths, deep: mockDeep, cfg: { archiveAfterDays: 0, archiveBelowStrength: 0.5, remineMisses: true }, log: quiet })
const rep = await cons.run({ reason: 'smoke', now: Date.now() })
check('归档了淡掉的条目', rep.archived >= 1, `archived=${rep.archived}`)
check('合并了近似重复', rep.merged >= 1, `merged=${rep.merged}`)
check('压出了每日情景', rep.episodes >= 1, `episodes=${rep.episodes}`)
check('把 miss 反挖回来了', rep.remined >= 1, `remined=${rep.remined}`)
check('巩固报告落盘', statSync(paths.consolidate).size > 0)

const archived = [...store.every()].find((e) => e.status === 'archived')
check('归档的默认搜不到', archived ? engine2.run(archived.text, 0, {}).every((h) => h.entry.id !== archived.id) : false)
check('归档的 include_archived 能捞到', archived ? engine2.run(archived.text, 0, { includeArchived: true }).some((h) => h.entry.id === archived.id) : false)

console.log(`\n[11] 设置页用的那几个动作（列表 / 置顶 / 忘记 / 恢复）`)
const one = store.add({ kind: 'fact', text: '面板测试用的条目：阳台的灯是暖光', importance: 3, signalId: 'explicit', createdAt: Date.now(), source: null }).entry
const found = store.list({ q: '阳台 灯', limit: 5 })
check('列表能按词搜到', found.some((e) => e.id === one.id), found[0]?.text)
store.setPinned(one, true)
check('置顶生效', store.get(one.id).pinned === true)
check('置顶后排在最前', store.list({ limit: 3 })[0]?.id === one.id)
store.forget(one, 'archive')
check('归档后默认列表里没有', !store.list({ limit: 50 }).some((e) => e.id === one.id))
check('归档后按状态能筛出来', store.list({ status: 'archived', limit: 50 }).some((e) => e.id === one.id))
store.restore(one)
check('恢复后回到活跃', store.list({ limit: 50 }).some((e) => e.id === one.id))
store.forget(one, 'fade')
check('fade 把强度压低', (store.get(one.id)?.strengthBase ?? 1) <= 0.05)
store.restore(one)

console.log(`\n[12] 容量上限与分页（"消息多了会不会打不开"的那部分）`)
const p1 = store.page({ limit: 2, offset: 0 })
check('分页：返回总数 + 首页 2 条', p1.total >= 3 && p1.items.length === 2, `total=${p1.total}`)
const p2 = store.page({ limit: 2, offset: 2 })
check('第二页不重复', p2.items.length > 0 && !p1.items.some((x) => p2.items.some((y) => y.id === x.id)))
const capBefore = [...store.live()].length
const trimmed = store.enforceCap(3, Date.now())
check('超过上限会归档最弱的', [...store.live()].length <= 3, `${capBefore} → ${[...store.live()].length}（裁掉 ${trimmed}）`)
check('裁剪只是归档，总数没少', store.size() >= capBefore, `总数 ${store.size()}`)
const capReport = await new Consolidator({ store, stats, paths, deep: null, cfg: { maxEntries: 3, remineMisses: false }, log: quiet }).run({ reason: 'smoke-cap' })
check('巩固报告里带 trimmed', 'trimmed' in capReport, `trimmed=${capReport.trimmed}`)

console.log(`\n[13] 纠正 / 真删 / 导入`)
const c = store.add({ kind: 'fact', text: '原来的说法：周三下午开会', importance: 3, signalId: 'explicit', createdAt: Date.now(), source: null }).entry
store.update(c, { text: '纠正后的说法：周四上午开会', importance: 4 })
check('纠正后内容变了', store.get(c.id).text.includes('周四'))
check('保留了改动历史', (store.get(c.id).history || []).length === 1, JSON.stringify(store.get(c.id).history?.[0]?.from))
check('纠正也算一次提及（强度回血）', (store.get(c.id).mentionCount || 0) >= 1)

const imported = store.importEntries([
  { id: 'mem_import_a', text: '导入进来的一条：备用钥匙在门口花盆下面', kind: 'fact', importance: 3 },
  { id: 'mem_import_a', text: '同一个 id 的第二条（应被跳过）' },
], { mode: 'merge' })
check('导入新增一条、同 id 跳过', imported.added === 1 && imported.skipped === 1, JSON.stringify(imported))
const againImport = store.importEntries([{ id: 'mem_import_a', text: '重复导入' }], { mode: 'merge' })
check('重复导入不会翻倍', againImport.added === 0 && againImport.skipped === 1, JSON.stringify(againImport))
const replaced = store.importEntries([{ id: 'mem_import_a', text: '覆盖后的内容：钥匙改放鞋柜', importance: 5 }], { mode: 'replace' })
check('replace 覆盖同 id', replaced.replaced === 1 && store.get('mem_import_a').text.includes('鞋柜'))

const doomed = store.add({ kind: 'fact', text: '这条待会儿要真删的独特句子', importance: 3, signalId: 'explicit', createdAt: Date.now(), source: null }).entry
check('真删返回成功', store.purge(doomed.id) === true)
check('真删后内存里没有了', !store.get(doomed.id))
check('真删写了墓碑', statSync(paths.purged).size > 0)
check('真删后文件里也不留原文', !readFileSync(paths.entries, 'utf8').includes('这条待会儿要真删的独特句子'))

engine2.dispose()
engine.dispose()
stats.flush()
rmSync(root, { recursive: true, force: true })

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
