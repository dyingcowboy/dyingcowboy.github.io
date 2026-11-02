/**
 * Obsidian「人生工具箱」vault 的纯解析层。
 *
 * 这里只做文本 → 结构的转换，不碰文件系统，方便单元测试直接 import。
 * 文件遍历与落盘在 scripts/sync-toolbox.mjs。
 */

/** 模块短名 → URL slug。按子串匹配，顺序敏感（先匹配「基础认知」再轮到「认知」之类）。 */
const MODULE_SLUGS = [
  ['基础认知', 'foundations'],
  ['人性', 'foundations'],
  ['思维', 'thinking'],
  ['目标', 'execution'],
  ['执行', 'execution'],
  ['决策', 'decisions'],
  ['关系', 'relationships'],
  ['心理', 'resilience'],
];

/** 去掉 YAML 里常见的包裹引号。 */
function unquote(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * 解析 Obsidian 笔记的 frontmatter（只支持本站用得到的 YAML 子集：
 * 标量键值 + `- item` 列表）。
 * @param {string} markdown
 * @returns {{ data: Record<string, string | string[]>, body: string }}
 */
export function parseFrontmatter(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(markdown);
  if (!match) return { data: {}, body: markdown };

  /** @type {Record<string, string | string[]>} */
  const data = {};
  let key = null;

  for (const raw of match[1].split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(raw);
    if (pair) {
      key = pair[1];
      const value = pair[2].trim();
      data[key] = value === '' ? [] : unquote(value);
      continue;
    }
    const item = /^[ \t]*-[ \t]*(.*)$/.exec(raw);
    if (item && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(unquote(item[1]));
    }
  }

  return { data, body: markdown.slice(match[0].length) };
}

/**
 * 按标题切分 markdown，保留每节正文行。
 * @param {string} markdown
 * @returns {{ heading: string | null, level: number, lines: string[] }[]}
 */
export function splitSections(markdown) {
  const sections = [];
  let current = { heading: null, level: 0, lines: [] };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(.*)$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { heading: heading[2].trim(), level: heading[1].length, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);

  // 丢掉第一个标题之前的空段（文件开头的空白行），只保留有标题或有正文的小节。
  return sections.filter((section) => section.heading !== null || section.lines.some((line) => line.trim()));
}

/**
 * 从索引笔记里读出模块清单。
 *
 * 优先用「概述 / 模块 / 目录 / 结构」那一节下的有序列表；找不到就退回全文扫描。
 * @param {string} markdown
 * @returns {{ name: string, raw: string }[]}
 */
export function extractModules(markdown) {
  const sections = splitSections(markdown);
  const section = sections.find((item) => item.heading && /概述|模块|目录|结构|框架/.test(item.heading));
  const lines = section ? section.lines : markdown.split(/\r?\n/);

  /** @type {{ name: string, raw: string }[]} */
  const modules = [];
  const seen = new Set();

  for (const line of lines) {
    const ordered = /^[ \t]*\d+[.、)][ \t]*(.*)$/.exec(line);
    if (!ordered) continue;

    const wikilink = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/.exec(ordered[1]);
    const name = (wikilink ? wikilink[1] : ordered[1]).trim();
    if (!name || seen.has(name)) continue;

    seen.add(name);
    modules.push({ name, raw: line.trim() });
  }

  return modules;
}

/**
 * 给模块名配一个稳定的 URL slug。
 * @param {string} name
 * @param {number} index 1 起
 */
export function moduleSlug(name, index) {
  for (const [needle, slug] of MODULE_SLUGS) {
    if (name.includes(needle)) return slug;
  }
  return `module-${String(index).padStart(2, '0')}`;
}

/**
 * 抽出正文里的 wikilink 目标（忽略 `![[图片]]` 嵌入），去重保序。
 * @param {string} markdown
 * @returns {string[]}
 */
export function extractLinks(markdown) {
  const links = [];
  const seen = new Set();

  for (const match of markdown.matchAll(/(!?)\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    if (match[1] === '!') continue;
    const target = match[2].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    links.push(target);
  }

  return links;
}

/**
 * 统计正文字数（去掉空白，中文按字算）。
 * @param {string} text
 */
export function countChars(text) {
  return text.replace(/\s+/g, '').length;
}

/**
 * 取一段可直接展示的摘要：正文里第一段非标题、非列表、非图片的普通文字。
 * @param {string} body
 * @param {number} limit
 */
export function extractExcerpt(body, limit = 96) {
  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const text = block
      .split(/\r?\n/)
      .filter((line) => line.trim() && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.、)]\s|>|\||!\[|```|---)/.test(line))
      .join('')
      .trim();
    if (!text) continue;
    const plain = text.replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_all, target, alias) => alias || target);
    return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
  }
  return '';
}

/**
 * 按字数给模块一个成熟度档位。
 * @param {number} chars
 * @returns {'empty' | 'stub' | 'growing' | 'mature'}
 */
export function maturityOf(chars) {
  if (chars <= 0) return 'empty';
  if (chars < 400) return 'stub';
  if (chars < 2000) return 'growing';
  return 'mature';
}

/**
 * 解析单篇笔记。
 * @param {string} markdown
 * @param {{ path: string, fallbackTitle?: string }} options
 */
export function parseNote(markdown, { path, fallbackTitle } = {}) {
  const { data, body } = parseFrontmatter(markdown);
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(body);
  const title =
    (typeof data.title === 'string' && data.title) ||
    (heading && heading[1].trim()) ||
    fallbackTitle ||
    path.replace(/\.md$/i, '').split('/').pop();

  const chars = countChars(body);

  return {
    path,
    title,
    chars,
    tags: Array.isArray(data.tags) ? data.tags : [],
    links: extractLinks(body),
    excerpt: extractExcerpt(body),
    maturity: maturityOf(chars),
    updated: typeof data.updated === 'string' ? data.updated : (typeof data.created === 'string' ? data.created : ''),
  };
}

/**
 * 把笔记按模块名归堆。模块名与笔记标题做「包含」匹配（Obsidian 的
 * `[[基础认知：人性与社会的知识经验]]` 指向同名文件）。
 * @param {{ name: string }[]} modules
 * @param {{ title: string, path: string }[]} notes
 */
export function groupNotes(modules, notes) {
  const groups = modules.map((module) => ({ name: module.name, notes: [] }));
  const unfiled = [];

  for (const note of notes) {
    const stem = note.path.replace(/\.md$/i, '').split('/').pop();
    const hit = groups.find(
      (group) => group.name === note.title || group.name === stem || stem.includes(group.name) || group.name.includes(stem),
    );
    if (hit) hit.notes.push(note);
    else unfiled.push(note);
  }

  return { groups, unfiled };
}
