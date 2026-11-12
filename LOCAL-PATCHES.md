# LOCAL-PATCHES —— dsh-memory 本地改动

> 和 `plugins/dsh-douyin-scroll/LOCAL-PATCHES.md` 一个规矩：改哪儿、为什么、备份叫什么都写在这儿。
> 升级插件后按这份重做。

## 2026-11-08　心跳任务书不再被当成"用户说的话"

**现象**：headless 心跳会话的任务书是以 user 角色投进来的，`extract()` 把它当使用者发言抽取，
长出一条 importance=5 的假记忆 `3. **在电脑里转转**：翻自己的笔记/待办/日记…`；
之后每半小时心跳又"提"它一次，mentionCount 一路涨到 28，比真事还牢。
另有三条当天库记忆（`mem_daily_20261107_*`）也是这份任务书被提炼出来的。

**改法**：

- `lib/extract.mjs`：在 `SYSTEM_TEXT` 旁边加 `HEARTBEAT_TEXT`（`现在是一次**心跳唤醒**` /
  `【本次是第几次】`），`extract()` 开头一并挡掉，返回 `[]`。
- `../_shims/promote-daily.mjs`（当天库 → 长期库的提炼脚本）：`scoreFragment` 里同样跳过这类片段，
  免得任务书靠日期数字和长度拿高分混进长期库。

**验证**：`node --check` 两个文件都过；用 `prompts/heartbeat.md` 原文喂 `extract()` 返回 0 条，
普通句子 `记住：明天下午三点去医院拿报告。` 仍能抽出来；`promote-daily.mjs --dry` 正常跑完。

**清理**：真删了 5 条假记忆（墓碑在 `memory/purged.jsonl`，不含原文）：
`mem_20261107_b6e882`、`mem_daily_20261107_9d19bd6445`、`_1a6892f4e7`、`_72b2a2dbec`、
以及脚手架重复的 `mem_20261106_ae4120`（原条 `mem_20261106_c3770f` 保留）。

**备份**：`lib/extract.mjs.bak-20261108`、`_shims/promote-daily.mjs.bak-20261108`。

**生效**：下一次启动的会话（心跳是独立进程，下一轮就生效）。

## 2026-11-09　心跳任务书还是从另一个口子漏进了当天库

**现象**：11-08 那道口子只堵了「长期库提炼」和 `extract()`，但
`../_shims/session-to-daily.mjs`（把 DSH 各会话写进 `memory/daily/*.jsonl`）没堵。
它把 headless 心跳的任务书当成「他说的话」写进当天库，`them` 里就是整段
「你是小鲤（李鲤）…现在是一次**心跳唤醒**…」。后果是桌面会话的
「今天跨会话聊过的」里会出现 `他：你是小鲤（李鲤）…`——把任务书冒充成使用者的话，
而且昨天（11-08）那批也没被清掉。

**改法**：`../_shims/session-to-daily.mjs` 里加 `HEARTBEAT_TEXT`（和 promote-daily 同一套正则），
`exchanges()` 遇到匹配的 user 文本直接 `continue`，不配成对子。

**清理**：用临时 node 脚本按行过滤当天库，删掉 `them` 命中 HEARTBEAT_TEXT 的片段：
11-07 删 16 条、11-08 删 3 条、11-09 删 1 条（14:37 那条）；其余行原样保留。

**验证**：`node --check` 过；改完翻记忆注入，`今天跨会话` 那一节已经没有任务书原文。

**备份**：无 `.bak`（改之前忘了留）；改动只有两处：新增 `HEARTBEAT_TEXT` 常量、
`exchanges()` 里多一行 `if (HEARTBEAT_TEXT.test(txt)) continue`。
