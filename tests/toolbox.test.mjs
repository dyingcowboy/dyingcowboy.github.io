import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countChars,
  extractExcerpt,
  extractLinks,
  extractModules,
  groupNotes,
  maturityOf,
  moduleSlug,
  parseFrontmatter,
  parseNote,
  splitSections,
} from '../src/lib/toolbox-parse.mjs';

const INDEX = `### 工具箱的意义

- 人活在两个世界里：
\t- 外部的功利世界
\t- 内部的精神世界

### 工具箱的功能

1. 提高实践水平，更好地做事获得成就
2. 提高处理关系的能力，包括亲密关系和功利关系

### 工具箱概述

1. [[基础认知：人性与社会的知识经验]]
2. [[思维工具]]
3. [[目标规划与执行]]
4. [[决策能力]]
5. [[处理关系]]
6. [[心理能力]]

![[Pasted image 20260519192823.png]]
`;

test('从索引笔记的「概述」一节读出六个模块，忽略前面的功能列表', () => {
  const modules = extractModules(INDEX);
  assert.deepEqual(
    modules.map((module) => module.name),
    ['基础认知：人性与社会的知识经验', '思维工具', '目标规划与执行', '决策能力', '处理关系', '心理能力'],
  );
});

test('没有概述小节时退回全文扫描有序列表', () => {
  const modules = extractModules('1. [[甲]]\n2. [[乙]]\n');
  assert.deepEqual(modules.map((module) => module.name), ['甲', '乙']);
});

test('模块 slug 稳定且带序号兜底', () => {
  assert.equal(moduleSlug('基础认知：人性与社会的知识经验', 1), 'foundations');
  assert.equal(moduleSlug('思维工具', 2), 'thinking');
  assert.equal(moduleSlug('目标规划与执行', 3), 'execution');
  assert.equal(moduleSlug('决策能力', 4), 'decisions');
  assert.equal(moduleSlug('处理关系', 5), 'relationships');
  assert.equal(moduleSlug('心理能力', 6), 'resilience');
  assert.equal(moduleSlug('完全未知的模块', 7), 'module-07');
});

test('按标题切分保留小节正文，并丢掉空的前导段', () => {
  const sections = splitSections('## 甲\na\n## 乙\nb\n');
  assert.deepEqual(sections.map((section) => section.heading), ['甲', '乙']);
  assert.deepEqual(sections[0].lines, ['a']);
  assert.deepEqual(splitSections('## 甲\n').map((section) => section.heading), ['甲']);
});

test('frontmatter 解析标量与列表，正文不包含分隔符', () => {
  const { data, body } = parseFrontmatter('---\ntitle: "标题"\ntags:\n  - clippings\n---\n正文\n');
  assert.equal(data.title, '标题');
  assert.deepEqual(data.tags, ['clippings']);
  assert.equal(body, '正文\n');
});

test('wikilink 提取去重、忽略图片嵌入、支持别名', () => {
  const links = extractLinks('见 [[思维工具]] 与 [[决策能力|决策]]，图 ![[x.png]]，重复 [[思维工具]]');
  assert.deepEqual(links, ['思维工具', '决策能力']);
});

test('字数按非空白字符计，成熟度按阈值分档', () => {
  assert.equal(countChars('一二 三四\n五六'), 6);
  assert.equal(maturityOf(0), 'empty');
  assert.equal(maturityOf(120), 'stub');
  assert.equal(maturityOf(900), 'growing');
  assert.equal(maturityOf(5000), 'mature');
});

test('摘要跳过标题与列表，优先取普通段落', () => {
  const body = '## 小标题\n\n- 列表项\n\n这是第一段正文，讲了一些道理。\n\n第二段。\n';
  assert.equal(extractExcerpt(body), '这是第一段正文，讲了一些道理。');
  assert.equal(extractExcerpt('## 只有标题\n'), '');
});

test('解析笔记：标题回退顺序为 frontmatter > 一级标题 > 文件名', () => {
  assert.equal(parseNote('# 正文标题\n\n内容', { path: 'a/b.md' }).title, '正文标题');
  assert.equal(parseNote('---\ntitle: 元数据标题\n---\n# 正文标题', { path: 'b.md' }).title, '元数据标题');
  assert.equal(parseNote('内容', { path: 'dir/文件名.md' }).title, '文件名');
});

test('空笔记仍能被解析出来，成熟度为 empty', () => {
  const note = parseNote('\n', { path: 'LIfe tools/未命名.md' });
  assert.equal(note.chars, 0);
  assert.equal(note.maturity, 'empty');
});

test('笔记按模块名归堆，不匹配的落到 unfiled', () => {
  const modules = [{ name: '思维工具' }, { name: '处理关系' }];
  const notes = [
    { title: '思维工具', path: 'LIfe tools/思维工具.md' },
    { title: '处理关系', path: 'LIfe tools/处理关系.md' },
    { title: '零散想法', path: 'raw/零散想法.md' },
  ];
  const { groups, unfiled } = groupNotes(modules, notes);
  assert.deepEqual(groups.map((group) => group.notes.map((note) => note.title)), [['思维工具'], ['处理关系']]);
  assert.deepEqual(unfiled.map((note) => note.title), ['零散想法']);
});

test('模块名带长后缀时，笔记仍能按文件名匹配到模块', () => {
  const modules = [{ name: '基础认知：人性与社会的知识经验' }];
  const notes = [{ title: '基础认知', path: 'LIfe tools/基础认知：人性与社会的知识经验.md' }];
  const { groups } = groupNotes(modules, notes);
  assert.equal(groups[0].notes.length, 1);
});
