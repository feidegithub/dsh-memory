# Changelog

格式按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-10-25

首个公开版本。给 DSH 的分层记忆：会遗忘、但永不删除。

### Added

- **五层召回**：L1 常驻注入（`systemPrompt.context`，≤600 token）→ L2 热区 → L3 bigram 倒排 →
  L4 历史会话原文深挖 → L5 纯规则联想阶梯。
- **60 秒硬窗**：命中即答；未命中先返回 `pending` 让人先开口，后台按 2s/6s/15s/30s/45s/57s
  逐级放宽，到点判 `forgotten` 并写 miss。
- **复习模型**：提及与成功回忆都加深印象（间隔效应：同一分钟内重复几乎不涨），
  久置按半衰期指数衰减；`fluency` 记录"想起得多轻松"。
- **遗忘 ≠ 删除**：淡忘只是移出默认检索，`include_faded` / `include_archived` 仍可捞出。
- **夜间巩固**（03:30 自动 / `memory_consolidate` 手动）：归档淡忘、合并近似重复、
  按会话标题压每日情景、拿 miss 去 L4 反挖；App 没开时启动 15 秒后补跑。
- **设置页「记忆」**（`settings.section`）：搜索、分页、汇总（命中率/平均耗时/注入 token/磁盘）、
  行内纠正、置顶、忘记、恢复、真删、立即巩固、冷备、导出/导入。
- **工具**：`memory_recall`、`memory_recall_wait`、`memory_remember`、`memory_update`、
  `memory_forget`、`memory_pin`、`memory_import`、`memory_consolidate`、`memory_stats`。
- **自检**：`node tools/smoke.mjs`，75 项。

### Changed

- 默认主存改为按插件自身位置反推：装在 `<主盘>/plugins/<插件名>` 时用 `<主盘>/memory`，
  否则落到 `$DSH_HOME/memory`；仍可用 `storageDir` 覆盖。
- 冷备改为 `coldBackupDir` 配置项；未配置时退回本地 `backups/`，外挂盘不在不影响主流程。
- 命中不播报：回忆到的内容当已知背景直接用，不说"我想起来了/根据记忆"。

### Fixed

- schemastery 的 `.extra('volatile', true)` 会把配置值包成 `{ get() }`，未解包导致
  `storageDir` 变成 `[object Object]`、记忆写进畸形目录。
- 整段粘贴的文档（章程/README）被"决定/改成"等词误抽成事实。
- 联想阶梯把相关度底线一起放松，导致拿无关记忆"编造"答案。
- 错误命中把问法写成别名，造成错误自我强化。
- 同义词一次性拼进查询会稀释匹配分；改为多变体取最大。
- 会话日志是多帧拼接的 zstd，整文件解压只能读到第一帧；改为按帧头逐帧解。
- L4 把 reasoning 块与工具参数当文本、把助手分析沉淀成"记忆"；现在只取 `type=text`
  且只有 `role=user` 的命中才写入条目库。
- 新鲜条目靠 strength/fluency 基线分挤进搜索结果；加入相关度闸门与"罕见多字词"例外。

[0.2.0]: https://github.com/feidegithub/dsh-memory/releases/tag/v0.2.0
