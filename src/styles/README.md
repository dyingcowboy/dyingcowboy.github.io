# 样式与字体

| 文件 | 职责 |
| --- | --- |
| `typography.css` | 自托管字体声明与 `--sans`、`--heading`、`--mono`；中文使用明确的系统字体回退 |
| `global.css` | 色彩、尺寸、共享布局与通用界面样式 |
| `home.css` | 首页专用布局 |
| `prose.css` | Markdown 正文、代码、表格、公式与图示的排版 |
| `learning.css` | 课程与仓库信息的展示 |

字体入口由 `BaseLayout.astro` 统一加载；使用已有字体变量，避免在页面重复声明字体栈。调整排版时检查中英文混排、移动端断行、键盘焦点，以及 KaTeX 和 Mermaid 的专用样式。

字号也集中在 `typography.css`：辅助文字 `--text-xs` 为 14px，次级文字 `--text-sm` 为 16px，正文 `--text-base` 为 18px，文章正文 `--text-reading` 为 20px（手机为 18px）。页面使用这些变量，保持整体调整一致。

字体来源、文件与许可见 [`public/fonts/README.md`](../../public/fonts/README.md)。正文与页面元数据的编辑入口见[内容说明](../content/README.md)。
