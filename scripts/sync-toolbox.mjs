/**
 * 把 Obsidian「人生工具箱」vault 同步成站点数据。
 *
 *   node scripts/sync-toolbox.mjs [--vault <目录>] [--out <文件>]
 *
 * 默认读取 ~/Dev/Notes/人工工具箱，写出 src/data/toolbox.json。
 *
 * 为什么是「同步到仓库」而不是构建时直读 vault：GitHub Actions 是干净 checkout，
 * 拿不到本机路径。把解析结果固化进仓库，构建才是可复现的；vault 仍是唯一编辑入口。
 *
 * 输出里只有标题、字数、链接和摘要，不搬运图片，也不打印正文。
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { resolve, join, relative, basename, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import {
  extractModules,
  groupNotes,
  moduleSlug,
  parseFrontmatter,
  parseNote,
  maturityOf,
} from '../src/lib/toolbox-parse.mjs';

const args = process.argv.slice(2);
const usage = [
  '用法：node scripts/sync-toolbox.mjs [--vault <目录>] [--out <文件>]',
  '默认 vault：~/Dev/Notes/人工工具箱',
  '默认输出：src/data/toolbox.json',
].join('\n');

const DEFAULT_VAULT = join(homedir(), 'Dev/Notes/人工工具箱');
const DEFAULT_OUT = 'src/data/toolbox.json';
const INDEX_CANDIDATES = ['人生工具箱.md', '人工工具箱.md', 'index.md'];
/** 这些目录是素材收件箱，不当作模块正文统计。 */
const INBOX_DIRS = ['raw', '.obsidian', '.trash'];

/** 递归收集 markdown 文件。 */
async function collectMarkdown(root, dir = root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (dir === root && INBOX_DIRS.includes(entry.name)) continue;
      files.push(...(await collectMarkdown(root, full)));
      continue;
    }
    if (extname(entry.name).toLowerCase() === '.md') files.push(full);
  }
  return files;
}

/** 读出索引笔记里的模块清单。 */
async function readIndex(vault) {
  for (const candidate of INDEX_CANDIDATES) {
    const path = join(vault, candidate);
    try {
      const markdown = await readFile(path, 'utf8');
      const { data, body } = parseFrontmatter(markdown);
      const modules = extractModules(body);
      if (modules.length) {
        return {
          path: relative(vault, path),
          title: typeof data.title === 'string' && data.title ? data.title : basename(candidate, '.md'),
          modules,
        };
      }
    } catch {
      // 换下一个候选名
    }
  }
  return null;
}

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }

  let vault = DEFAULT_VAULT;
  let output = DEFAULT_OUT;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--vault') {
      if (!args[index + 1]) throw new Error('--vault 后需要目录路径。');
      vault = resolve(args[++index]);
    } else if (arg === '--out') {
      if (!args[index + 1]) throw new Error('--out 后需要文件路径。');
      output = args[++index];
    } else if (arg.startsWith('-')) {
      throw new Error(`未知参数：${arg}`);
    }
  }

  const index = await readIndex(vault);
  if (!index) throw new Error(`没有在 ${vault} 找到带模块清单的索引笔记。`);

  const files = await collectMarkdown(vault);
  const indexPath = join(vault, index.path);
  const notes = [];

  for (const file of files) {
    if (file === indexPath) continue;
    const markdown = await readFile(file, 'utf8');
    const path = relative(vault, file);
    notes.push(parseNote(markdown, { path }));
  }

  const { groups, unfiled } = groupNotes(index.modules, notes);

  const modules = groups.map((group, position) => {
    const memberNotes = group.notes
      .filter((note) => note.chars > 0 || note.excerpt)
      .sort((a, b) => b.chars - a.chars);
    const chars = memberNotes.reduce((total, note) => total + note.chars, 0);
    return {
      index: position + 1,
      slug: moduleSlug(group.name, position + 1),
      name: group.name,
      noteCount: memberNotes.length,
      chars,
      maturity: maturityOf(chars),
      notes: memberNotes.map((note) => ({
        title: note.title,
        path: note.path,
        chars: note.chars,
        links: note.links,
        excerpt: note.excerpt,
        updated: note.updated,
      })),
    };
  });

  // 未归类的空文件（Obsidian 新建还没写的）不进素材统计。
  const inbox = unfiled.filter((note) => note.chars > 0);
  const totals = {
    modules: modules.length,
    modulesWithContent: modules.filter((module) => module.chars > 0).length,
    notes: modules.reduce((total, module) => total + module.noteCount, 0),
    chars: modules.reduce((total, module) => total + module.chars, 0),
    inbox: inbox.length,
    inboxChars: inbox.reduce((total, note) => total + note.chars, 0),
  };

  const payload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    vault: basename(vault),
    title: index.title,
    modules,
    totals,
  };

  const destination = resolve(output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(`已同步 ${totals.modules} 个模块，${totals.notes} 篇笔记，共 ${totals.chars} 字。`);
  console.log(`未归类素材 ${totals.inbox} 篇（${totals.inboxChars} 字，不计入模块统计）。`);
  console.log(`输出：${relative(process.cwd(), destination)}`);
  const pending = modules.filter((module) => module.chars === 0).map((module) => module.name);
  if (pending.length) console.log(`待填充模块：${pending.join('、')}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
