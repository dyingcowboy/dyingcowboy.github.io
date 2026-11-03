# dyingcowboy.github.io

席轩石的个人学习档案，基于 Astro 构建为静态网站，沿用 GitHub Pages 部署。

网站把项目、学习与日常思考组织为轨迹：阅读交互、标记理解的变化，再关联笔记和成果。现有笔记保留；轨迹已于 2026 年 11 月 3 日清空，重新开始记录。

## 本地开发

需要 Node.js 24 或更高版本。在仓库目录运行：

```sh
npm install
ASTRO_TELEMETRY_DISABLED=1 npm run dev
```

在浏览器打开终端打印的本地地址。开发服务器启动时同步一次，之后每 30 秒检查课程仓库、选入的笔记及相关 Codex / DSH 会话。它只归档工作目录属于已配置仓库的会话，不收集其他聊天。网页本地导入仍可用于补充记录。

## 仓库是来源，主页是视图

当前课程为 CMU Agent、JYY GSE 2026 和 JYY OS 2026。CS336 的旧笔记保留在历史笔记中。

`learning.config.json` 声明课程、仓库相对路径和选入的个人笔记。本机学习目录默认是 `~/Dev/Learning`；可通过 `LEARNING_ROOT` 指定。OS 主仓库与 `lab/os2026` 分别读取，使用工作目录的最长路径匹配关联会话。CMU 已接入 `cmu-agents`，`notes/` 中的个人笔记在本机同步，默认不公开。GSE 已连接；其中的课程讲义不会自动算作个人笔记。

```sh
npm run sync:learning
npm run sync:learning -- --watch
npm run sync:learning -- --root /absolute/Learning --dsh-root /absolute/dsh/sessions
```

同步从 `~/.codex/sessions`、`~/.codex/archived_sessions` 和 `~/.dsh/sessions` 读取记录；`--codex-root` / `--dsh-root` 可重复指定其他位置。`LEARNING_SYNC=0 npm run dev` 可关闭开发服务器的定时采集。它只在本次进程运行时检查，不安装常驻服务、不自动提交或推送。

`learning.config.json` 的 `sessionsSince` 当前设为北京时间 `2026-11-03T00:00:00+08:00`。自动同步仅收录从此时开始的新会话；旧会话即使继续追加消息也不会重新进入档案，无法确定起始时间的会话也不自动收录。手动导入仍可自行选择记录。浏览器档案升级到 v2 时会一次性清空旧导入；刷新后导入的新记录会正常保留。原始聊天和笔记不受影响，重置前的本机档案保存在 Git 忽略的 `local-data/backups/`。

| 数据 | 保存在哪里 | 用途 |
| --- | --- | --- |
| 原始会话与笔记快照 | `local-data/learning/raw/` | 按 SHA-256 保存，不覆盖同一内容 |
| 来源指纹、解析版本、本机归档与视图 | `local-data/learning/state.json` | 增量检查与故障恢复；不提交 Git |
| 公开仓库状态及选入笔记 | `src/data/learning.json` | GitHub Pages 构建输入 |
| 个人标题、回顾与关键节点 | 当前浏览器 IndexedDB | 在自动同步结果之上继续整理、导出备份 |

`publishNotes` 只公开配置中列出的笔记。当前选入 OS 的 `notes/concurrency.md`；不扫描公开整个笔记目录。原始会话正文、绝对路径和来源文件清单不进入公开视图。公开轨迹按下文流程单独选入 `src/data/trajectories.json`；主题名称与课程一致时，课程页也会显示对应的公开会话。

本机开发预览通过仅限本机来源的 `/__learning/` 接口读取私有档案；生产构建不包含这个接口或 `local-data/`。课程、笔记与轨迹可分别在 `/learning/`、`/notes/`、`/trajectories/` 查看。定时采集完成后，刷新页面即可读取最新会话；笔记和公开状态改变会触发开发页面更新。

## 从 DSH 借鉴的工程约束

参考源码固定在 [DeepSeek Harness `ce7073d`](https://github.com/deepseek-ai/DeepSeek-Harness/tree/ce7073d51254c26cd63b22a60835b8f948deb447)，采用其中适合本项目的几项约束：

- **保留事实，再生成视图。** [Session 的 surface 规则](https://github.com/deepseek-ai/DeepSeek-Harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/core/session/src/surface.ts)区分原始追加记录与替换后的模型上下文。这里按来源顺序保留可见交互，工具折叠只影响阅读；不会把压缩、替换或 inbox 内部事件凭空还原成用户对话。
- **缓存带身份和水位。** 参考 [projection cache](https://github.com/deepseek-ai/DeepSeek-Harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/session/session-projection-cache/src/index.ts)，缓存关联源文件指纹、格式与解析器版本；变化后从完整文件重建，不以压缩文件字节偏移续读。相同输入不会制造一次新更新。
- **验证成功才发布。** 参考 [generation persistence](https://github.com/deepseek-ai/DeepSeek-Harness/blob/ce7073d51254c26cd63b22a60835b8f948deb447/packages/session/session-persistence-jsonl/src/generation.ts)，输出先写临时文件、校验再替换。读取过程中源文件改变、写入失败或记录损坏时，保留上次成功结果并给出提示。
- **来源与个人理解分开。** 导入保留来源会话 ID、事件序号、格式、模型、应用版本以及可获得的 Git 信息。旧备份不会回滚更新的消息；个人回顾继续按独立标识合并。解析器版本及笔记渲染器的 `cacheVersion` 改变时重新生成视图。

这里的“关键节点”是你写的学习回顾；DSH 的 checkpoint 指持久化边界，两者语义不同。SHA-256 能检查内容是否一致，不能证明作者身份，也不能让轨迹变成不可造假的履历。它的价值是把具体问题、尝试、代码版本和后续理解连接起来，便于追问和核对。

检查与构建：

```sh
npm test
ASTRO_TELEMETRY_DISABLED=1 npm run check
ASTRO_TELEMETRY_DISABLED=1 npm run build
```

构建结果位于 `dist/`。运行 `ASTRO_TELEMETRY_DISABLED=1 npm run preview` 可预览构建结果。

## 导入自己的记录

在「轨迹」页面点击「导入记录」，选择或拖入一个或多个文件：

| 格式 | 支持内容 |
| --- | --- |
| Codex `.jsonl` | 本地 rollout 会话记录 |
| DeepSeek harness `.jsonl.zstd` | v4 会话记录，包含可见消息和工具操作 |
| 档案 `.json` | 本站导出的 `{ "version": 1, "trajectories": [...] }` 数据 |

导入时可以选择「项目 / 学习 / 思考」类别和所属主题，也可以把会话接到已有轨迹中。例如，将两种工具里关于同一个 OS 问题的会话连接起来。

导入内容在本机解析，保存在**当前浏览器、当前网站地址的 IndexedDB** 中，不会自动上传，也不会写回仓库。换浏览器、更换网站地址或清除网站数据后，本地记录不会随之迁移；使用「导出本地」保存 JSON 备份，再在目标浏览器导入。

重复导入同一会话时，按来源与稳定 ID 合并，优先依据来源事件水位判断新旧，保留原始顺序。无法确认的新旧冲突会保留旧内容并提示，不用导入时间冒充事件时间。备份中的新增回顾也会合并；回顾 ID 相同时，以本地已有版本为准。

## 阅读与整理

- 在列表中搜索标题、主题、消息正文和回顾，按类别、来源、模型和状态筛选。
- 在详情中阅读交互时间线；工具操作默认折叠，可按需展开。
- 标记问题、选择、理解转折和验证结果，为对应消息补充自己的回顾。
- 点击「整理」修改标题、目标、主题、状态、标签，以及关联的笔记或成果链接。
- 导出单条轨迹，或从列表导出全部本地记录，供备份或继续整理。

整理仍保存在浏览器本地。修改公开示例也只会生成本地版本，直到手动将导出的数据加入仓库。

## 命令行批量导入

也可以先在终端把记录转换为本站 JSON，再从网页导入：

```sh
npm run import:records -- /absolute/input.jsonl --out local-data/new-name.json
```

一次转换多个文件：

```sh
npm run import:records -- /absolute/codex.jsonl /absolute/session.v4.jsonl.zstd --out local-data/batch-001.json
```

省略 `--out` 时，默认写入 `local-data/trajectories.json`。**输出文件已存在时会拒绝覆盖**；每次使用新的输出路径，然后从网页导入合并。源会话文件不会被改动，终端仅输出数量统计和输出路径，不打印正文。

`local-data/` 已加入 `.gitignore`。不要把私人原始会话提交到 Git。

## 记录的边界

网页导入生成的是**可检索、可整理的文本视图**；自动同步另在本机保存匹配来源的原始快照。仍应保留源工具自己的记录：

- 隐藏推理、系统与开发者指令不进入展示；DeepSeek 内部 attempt 流不作为独立消息展示。
- 图片、文件、音视频只保留占位；未知内容块会给出警告，不会假定其内容已完整导入。
- 会话包含压缩、替换或不完整记录时，会在来源信息中提示相应边界。
- 来源工具与模型分别记录；没有明确模型信息时显示「未记录」，不根据当前配置猜测历史模型。
- 单个压缩输入上限 16 MiB，普通文本和解压后文本上限 64 MiB；超出或损坏的来源会提示并保留上次成功档案。原始快照按每个内容版本完整保存，暂不自动清理历史版本。

本机定时同步是只读采集；GitHub Pages 无法直接读取你的 Mac。公开网页随选定的生成文件和 Git 提交更新，浏览器中的个人整理不会自动跨设备同步。

## 将整理后的轨迹公开

浏览器导入不会改变公开网站。准备公开时：

1. 从详情或列表导出准备展示的轨迹，检查消息、回顾、关联链接，以及来源元数据中的工作目录等私人信息。
2. 将选定数据替换或合并到 `src/data/trajectories.json`，保留顶层 `version` 和 `trajectories` 结构。
3. 运行测试、类型检查与构建，查看本地结果。
4. 将改动按自己的 Git 流程合入并推送到 `main`。

现有 `.github/workflows/deploy.yml` 会在 `main` 推送后执行测试、类型检查和构建，再部署到 GitHub Pages。开发分支和浏览器中的本地整理不会自动发布。

## 主要文件

| 路径 | 用途 |
| --- | --- |
| `src/data/trajectories.json` | 构建时载入的公开轨迹；已清空，等待重新选入 |
| `learning.config.json` | 课程、仓库和笔记选择；路径相对于本机学习目录 |
| `src/data/learning.json` | 可重新生成的公开课程与笔记视图 |
| `src/lib/learning-sync.mjs` | 只读采集、来源匹配、缓存与原子发布 |
| `scripts/sync-learning.mjs` | 手动或定时同步入口 |
| `src/content/notes/` | 原有 Markdown 笔记 |
| `src/lib/importers.mjs` | 记录解析与统一格式校验 |
| `scripts/import-trajectories.mjs` | 命令行导入入口 |
| `tests/` | 导入、合并等行为的测试 |
| `local-data/` | 本地转换结果，Git 忽略 |
