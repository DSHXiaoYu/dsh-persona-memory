# Changelog

## 0.1.0 — 2026-11-03

首个可用版本。

- 系统提示注入：≤900 字的人设 + 事实卡片，支持 `cardMaxChars` / `cardMaxFacts` / `profile` 占比控制。
- 四个工具：`memory_remember`、`memory_recall`、`memory_forget`、`memory_status`。
- `/memory` 命令：`status / card / search / remember / forget / decay / export`。
- 事实库：六种 kind、四档 tier、保守合并（只合并重述）、BM25-lite 中文检索。
- 每日衰减：core 不衰减，其余按 tier 半衰期降权，低于 0.12 归档（不删除）。
- 迁移脚本 `scripts/import.mjs`，支持 `--dry`。
- 零运行时依赖；数据全部为本地 JSON / Markdown。
