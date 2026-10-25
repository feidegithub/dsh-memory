# dsh-memory

给 DSH 的**分层记忆**：会遗忘、但永不删除。

- 常提的事越提越牢，久不提的小事慢慢变淡；
- 回忆从快到慢逐层下沉；**60 秒内想不起来就当作忘了**；
- 联想只用本地规则（同义词表 + 别名），**不调模型**（零 token）。

完整设计见 [`docs/design.md`](docs/design.md)。

## 安装

要求：DSH ≥ 0.1.7-rc.1，Node ≥ 22（自带 zstd，用于读会话日志）。

1. 把整个目录放到任意位置（例如 `D:\plugins\dsh-memory`）。
2. 在插件管理里装本地包，或等价地：`plugin_manager install_bundle` 指向该目录。
3. **完全退出** DeepSeek Harness 再打开（客户端面板要重新装载模块表），
   之后在 **设置 → 记忆** 里看到这一页。
4. 首次运行会自动建数据目录：默认 `$DSH_HOME/memory`（通常就是 `~/.dsh/memory`），可用 `storageDir` 改。

## 行为规矩（D5：命中不播报）

回忆成功的表现不是"我想起来了"，而是**回答里直接带着那件事**：

- ✅ "记忆在 `~/.dsh/memory`；冷备盘不在也不影响。"
- ❌ "我想起来了，你之前说过记忆放在那里……"

只有你问「你怎么知道」时，才会说"你之前说过"。这条写在两处：L1 注入文案的抬头、
`memory_recall` / `memory_recall_wait` 的工具描述——不靠模型自觉。
忘记时仍然直说"想不起来"，不许编。

## 数据在哪

```
$DSH_HOME/memory\        ← 主存（默认位置，可用 storageDir 改）
  entries.jsonl        # 主库，append-only（更新也是追加，后写覆盖先写）
  misses.jsonl         # 60 秒到点仍没想起来的 cue
  recall-log.jsonl     # 每次回忆：走了几级、耗时、命中与否
  stats.json           # 账本：命中率 / 平均耗时 / 今日注入 token
  synonyms.json        # 同义词/别名表，可手工加
  index.json           # 预留（当前启动时从 entries.jsonl 重建倒排）
  memory.log           # 启动/异常日志
  episodes\ archive\ backups\
```

**遗忘不是删除**：条目永远留在 `entries.jsonl`，只是 `strength` 变低、默认搜不到；
`include_faded` / `include_archived` 或换条线索仍能捞回来。真删只有 `purge`（记忆归我自己维护，
不用请示；面板里人类侧保留两段点击防手滑，删完只留不含原文的墓碑）。

`<冷备目录>/memory` 只做可选冷备（M3 才做），E 盘不在不影响任何功能。

## 工具

| 工具 | 用途 |
|---|---|
| `memory_recall` | 回忆。命中直接回答；没命中返回 `pending` —— 先开口说话，稍后用 `memory_recall_wait` 收结果 |
| `memory_recall_wait` | 等一次回忆的结果，到 60 秒硬窗返回 `forgotten: true` |
| `memory_remember` | 明确记住一件事（比自动抽取可靠） |
| `memory_pin` | 置顶 / 取消置顶（置顶不衰减，一直出现在"我知道的事"里） |
| `memory_update` | **纠正**一条（原地改，保留改动历史；可按 id 或按内容找） |
| `memory_forget` | 忘记：`archive`（可恢复）/ `fade`（压低强度）；**`purge` = 真删**（由我自己判断，不需要事先请示；写墓碑留痕，可带 `reason`） |
| `memory_import` | 从导出 JSON 恢复（默认 merge 跳过已有；`replace` 覆盖同 id） |
| `memory_consolidate` | 立刻跑一次巩固（归档/合并/每日情景/miss 反挖），纯规则 0 模型调用 |
| `memory_stats` | 看账：条数、分层、命中率、平均回忆耗时、今日注入 token、L4 走哪条路、上次巩固做了什么 |

## 设置页「记忆」

`client.js` 挂在 `settings.section`（id `memory`，order 32），打开 **设置 → 记忆** 就能看到：

- 搜索框（走倒排）、状态筛选（全部 / 活跃 / 淡忘 / 已归档）
- 汇总条：活跃 / 淡忘 / 归档 / 常驻、命中率、平均回忆耗时、今日注入 token、模型调用次数、
  磁盘占用、条目上限、当前命中总数
- 每条：kind、层、重要度、强度条、想起/提及次数、来源会话；按钮 **改 / 置顶 / 忘记 / 恢复 / 真删**
  - **改**：行内编辑，保存后原地替换（旧内容进 `history`）
  - **真删**：两段式 —— 先点「真删」变成「确认真删？」，再点一次才执行；只留一条不含原文的墓碑
- 动作：**立即巩固**、**冷备到 E 盘**（盘不在就跳过）、**导出 JSON**、**导入 JSON**（选文件合并）
- 分页：每页 100 条 +「加载更多」

数据走宿主 `/api/memory/*`：`GET /stats /entries /entry`，
`POST /pin /forget /restore /update /purge /import /consolidate /backup /export`。

## 配置（设置页可改）

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | true | 关掉后不写入、不注入（数据仍在磁盘） |
| `storageDir` | `~/.dsh/memory` | 主存目录 |
| `autoRecall` | `fast` | 预留（后续的主动预取） |
| `coreBudgetTokens` | 600 | L1 常驻注入上限 |
| `warmBudgetTokens` | 1200 | L2 预留 |
| `recallLimit` | 8 | 单次返回条数 |
| `recallDeadlineMs` | 60000 | **硬窗**，最大 60 秒 |
| `extractMode` | `heuristic` | 纯规则抽取；`off` 关闭自动记 |
| `minImportance` | 2 | 低于这个重要度不自动记 |
| `allowModel` | false | D2：联想段不许调模型；改成 true 才会放开（当前版本未实现模型判定） |
| `deepSearch` | true | L4：历史会话深挖（先走宿主索引，不可用就自己扫日志） |
| `distillHistory` | true | L4 命中后沉淀成条目（只沉淀人说过的，不沉淀助手自己的分析） |
| `remineMisses` | true | 夜间拿 miss 的 cue 去 L4 反挖 |
| `archiveAfterDays` | 180 | 多少天没复习才考虑归档 |
| `archiveBelowStrength` | 0.12 | 强度低于这个才归档（**不删**） |
| `consolidateAt` | `03:30` | 每天巩固时间 |
| `debug` | false | 往 `memory.log` 写更多 |

## L4 怎么"翻硬盘"

1. 先问宿主的 `ctx.sessionQuery.searchSessions()`（有全文索引时最快，1–3 s）。
2. 这台机器上它被配置成 `openAt: "never"`（搜索禁用），于是自动退回**自己扫 `~/.dsh/sessions/**/session*.jsonl[.zstd]`**：
   - 会话日志是**多帧拼接的 zstd**（一个 3 MB 的会话有 2842 帧），要按帧头 `28 B5 2F FD` 切开逐帧解；
   - 只取 `user/message` / `assistant/message` 里 **`type === 'text'`** 的块 ——
     reasoning 和工具参数不算"说过的话"；
   - 注入的章程 / 运行时上下文（`Instructions from:`）跳过；
   - 按 `mtime+size` 缓存解析结果，重复检索 ~250 ms 扫完 60+ 个会话。
3. 命中后**只把 `role: user` 的原文沉淀成条目**；助手当年的解释可以当线索返回，但不写进记忆。

## 自检

```powershell
cd <插件目录>
node tools/smoke.mjs
```

覆盖：抽取、去重、倒排召回、**相关度精度**、60 秒窗（1.5 秒版）、衰减与 `include_faded`、
间隔效应复习、重启后恢复、账本、L4 深挖（含"助手的话不沉淀"）、压缩日志扫描、
巩固四件事（归档/合并/情景/反挖），以及下面几个坑的回归测试。

## 落地时踩到的三个坑（都已修，都留了回归测试）

**① `volatile` 配置包装器 → 记忆写进 `[object Object]` 目录（2026-10-25 真事故）**

这版 schemastery 里 `.extra('volatile', true)` 不只是打标记，它会把字段值包成 `{ get() }`：

```js
z.boolean().default(true).extra('volatile', true)   // → { get: () => true }
```

`apply(ctx, config)` 拿到的就是包装器。我没拆就直接用，于是 `storageDir` 变成 `"[object Object]"`、
`enabled` 永远 truthy —— 条目写进了 `<profile>\[object Object]\entries.jsonl`，D 盘一条没有。
现在所有配置都过 `lib/config.mjs` 的 `unwrapValue/resolveConfig`；`resolveStorageDir` 也加了非字符串兜底。
事故现场（2 条被误记的 AGENTS.md 条款）已归档到 `memory\archive\broken-path-20261025\`，没删。

**② 整段文档被当成事实（同一天）**

AGENTS.md 被当用户消息喂进来，一行「挑几条由当天剩余额度**决定**」命中了"已定的事"信号。
现在 `looksLikeDocument()` 认出标题/表格/多列表项，这类文本**只认**显式"记住/备忘"，不再自动抽。

**③ 新鲜条目靠基线分硬塞进结果，后来还"编造"过一次**

排序公式里 strength/fluency/importance/新鲜度加起来有 ~0.45 的基线分，于是问"电饭煲放哪"也会把
"记忆存在 D 盘"塞回来。先加了第 0 层 `text_match ≥ 0.08` 的闸门；**但闸门一开始跟着联想阶梯一起放松**
（0.08 → 0.04 → 0.02），结果 6 秒后拿两条 `text_match≈0.02` 的无关记忆当答案返回了。

现在的规矩：**阶梯只放宽"搜哪里"（含淡忘 / 线性扫 / 换线索），绝不放宽"相关度底线"**（恒 0.08；线性扫 0.12）。
例外只有"命中罕见多字词"（如"冷备"）时放宽到 0.04 —— 单字（放/在/的）不算，
否则小语料库里每个字都只出现在一两条里，闸门形同虚设。

**④ 错误命中会把错误写成别名，自我强化**

"费劲想起"时会把这个问法记进条目的 `cues`。上面那次错误命中把「电饭煲放哪了」写成了
"记忆存在 D 盘"的别名，之后同样的问法就以 0.82 的匹配度"想起来了"。
现在只允许 `text_match ≥ 0.5` 的学习；那条脏别名已从 `entries.jsonl` 里清掉（条目本身还在）。

**⑤ 同义词不能一次全拼**

同义词全拼进查询会把分母（总 idf）稀释，0.2 的匹配摊薄成 0.05。改成"原句 + 每个同义词单独拼一次"，
各自查、按 id 取最大分。

**⑥ 宿主的会话搜索可能是关的（M2）**

`ctx.sessionQuery.searchSessions()` 直接抛 `session search is disabled: this deployment configures
the session-query index with openAt "never"`。没有改宿主的全局配置，而是让插件自己扫会话日志文件兜底
（见上面「L4 怎么翻硬盘」）。`memory_stats.deep.backend` 会显示当前实际走的是 `session-query` 还是 `file-log`。

**⑦ 会话日志是多帧 zstd，一次解不完（M2）**

`zstdDecompressSync(整个文件)` 只解第一帧 —— 于是一个 3 MB 的会话只读到 202 字节的 session 头，
搜索永远是空的。要按帧头 `28 B5 2F FD` 切开逐帧解。回归测试 `[9b]` 就是拿 zstd 压缩的日志测的。

**⑧ "翻到的原文"里全是噪声（M2）**

第一版把 reasoning 块和工具参数也抽成了文本，于是"回忆"回来的是我自己的分析长文；
第二版又发现 **助手说过的话** 会被沉淀成"记忆"，之后还被当成事实答出来。
现在的规矩：只取 `type === 'text'` 的块；跳过注入的章程；**只有 `role: user` 的命中才沉淀成条目**，
助手的话只当线索返回。

## 现状

已完成：**M1**（L1 注入、L3 倒排、复习与衰减、60 秒硬窗与两段式、统计、设置页）
+ **M2**（L4 历史深挖与兜底文件扫描、每日巩固：归档/合并/情景/反挖、`memory_consolidate`）
+ **M3**（设置页「记忆」面板、置顶/忘记/恢复、立即巩固、冷备到 E 盘、导出 JSON）
+ **M4**（纠正闭环 `memory_update`、真删 `purge`（自主判断 + 墓碑）、导入、启动补跑、分页与容量上限）。

还没做：关键词扩展与混合检索（可选）、冷备自动同步（现在手动点）、LLM 提炼（Q2 未定）。

已知小项：`@deepseek-ai/dsh-tools` 在本机 profile 里解析不到，`defineTool` 走本地等价实现
（参数本来就是标准 JSON Schema，行为一致；等宿主包可解析就自动切回去）。
另外每日情景目前只凭会话标题，没有读正文——够用来"想起那天干了什么"，但不够细。

## 一句话

> 记忆不删，只变淡。常提的张口就来；久不提的慢慢想不起；一分钟还没想起来，就认了自己忘了。
