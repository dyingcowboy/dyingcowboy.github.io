# 内容编辑说明

Markdown 保存正文，frontmatter 保存标题和结构化元数据，Astro 模板负责组织和展示。这样改一段介绍不必同时理解页面布局，改布局也不会改动来源内容。这个划分借鉴 [JYY《需求和架构 (2)》](https://jyywiki.cn/GSE/2026/lect7.md)关于关注点分离、事实与派生结果的讨论；实现采用 [Astro 原生内容集合](https://docs.astro.build/en/guides/content-collections/)。

## 去哪里修改

| 要改什么 | 入口 |
| --- | --- |
| 页面正文、标题、介绍与首页展示内容 | 本目录的 `pages/*.md` |
| 姓名、站点说明、GitHub、导航、侧栏和页脚 | [`src/data/site.ts`](../data/site.ts) |
| 内容集合与字段校验 | [`src/content.config.ts`](../content.config.ts)、[`src/lib/page-content.ts`](../lib/page-content.ts) |
| 路由、布局、展示结构与交互 | `src/pages/`、`src/layouts/`、`src/components/`、`src/scripts/` |
| 字体与排版 | [`src/styles/README.md`](../styles/README.md) |

`pages` 中的五个内容入口分别由固定页面模板读取：

| 内容文件 | 页面 | 内容范围 |
| --- | --- | --- |
| [home.md](pages/home.md) | `/` | 首页介绍、步骤、精选课程顺序和板块文案 |
| [about.md](pages/about.md) | `/about/` | 关于我的正文 |
| [learning.md](pages/learning.md) | `/learning/` | 课程索引的标题与介绍 |
| [notes.md](pages/notes.md) | `/notes/` | 笔记索引的标题与介绍 |
| [trajectories.md](pages/trajectories.md) | `/trajectories/` | 轨迹索引的标题与介绍 |

修改这些页面已有的文案只改对应 Markdown。正文可以使用 Markdown 段落、标题、链接和列表；不要为排版在内容中嵌入样式。筛选状态、导入表单和错误提示等交互文案仍由对应界面代码维护。

在 `pages/` 新建 Markdown **不会自动创建路由**。新增页面时需要明确它的模板与 URL，并由 `src/pages/` 中的路由读取内容；不通过 frontmatter 选择任意组件或模板。

## 元数据与首页字段

每个文件开头的 `---` 区域是 frontmatter。所有页面必须有非空的 `title` 和 `description`；普通页面使用 `kind: page`，可选 `eyebrow`。首页使用 `kind: home`，还需要以下字段；准确规则以 [`pageSchema`](../lib/page-content.ts) 为准。

| 字段 | 用途与约束 |
| --- | --- |
| `caption` | 首页介绍下方的短句 |
| `primaryAction.label`、`primaryAction.href` | 主入口文案与站内路径；路径以单个 `/` 开头 |
| `process.label`、`process.description` | 学习步骤区的标题与可访问性说明 |
| `process.steps` | 至少一个步骤；每项有 `title`、`description`，可选 `transition` |
| `featuredCourseIds` | 非空、无重复的课程 ID 列表；使用小写字母、数字和连字符 |
| `sections.courses`、`sections.trajectories`、`sections.notes` | 每个板块的 `title` 与 `eyebrow` |
| `archive.notice`、`archive.localNotice`、`archive.allLabel` | 公开与本机记录提示、查看全部文案 |
| `notes.allLabel`、`notes.repositoryLabel`、`notes.historicalLabel` | 笔记入口及来源说明 |

`featuredCourseIds` 只选择并排序课程，不重复保存课程标题、描述或链接。首页从 [`publicLearning.projects`](../lib/learning.ts) 获取课程数据；不存在的 ID 会使构建报错。课程来源配置在仓库根目录的 `learning.config.json`，公开结果由同步生成，不能为了修改卡片而手工修补 `src/data/learning.json`。

## 笔记与同步数据

`notes/` 仍是独立的历史笔记集合，使用 `title`、`date`、可选 `description`、`tags` 和 `draft`；草稿不会进入公开笔记列表和详情页。现有笔记的公式、KaTeX 与 Mermaid 继续使用 `astro.config.mjs` 中的 Markdown 管线及相应样式，不另建解析器。

课程仓库中的笔记和会话由同步流程管理，不移动到 `pages/`。`src/data/learning.json` 是可重建的公开视图；公开轨迹由用户选入 `src/data/trajectories.json`。私人原始记录、`local-data/`、本机绝对路径以及浏览器 IndexedDB 中的个人整理不属于页面内容集合，不能借内容迁移扩大采集或公开范围。同步与发布步骤见[仓库 README](../../README.md)。
