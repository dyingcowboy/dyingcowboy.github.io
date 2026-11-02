import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLearningNote } from '../src/lib/learning-markdown.mjs';

const context = { path: 'notes/concurrency.md', remoteUrl: 'https://github.com/example/course', commit: 'abc123' };
test('笔记保留表格、代码和公式，仓库相对链接固定到来源版本', async () => {
  const {title,html} = await renderLearningNote('# 并发\n\n[代码](../code/main.c#L2)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```c\nint x;\n```\n\n$x^2$\n', context);
  assert.equal(title, '并发');
  assert.doesNotMatch(html, /<h1/);
  assert.match(html, /https:\/\/github.com\/example\/course\/blob\/abc123\/code\/main.c#L2/);
  assert.match(html, /<table>/);
  assert.match(html, /<code class="language-c">int x;/);
  assert.match(html, /class="katex"/);
});
test('笔记中的HTML、危险链接和逃逸路径不会成为可执行内容', async () => {
  const {html} = await renderLearningNote('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert%281%29)\n\n[x](../../private.md)\n\n![x](data:image/svg+xml,evil)', context);
  assert.doesNotMatch(html, /<script|<img|href="javascript:|src="data:|href="[^\"]*private.md/);
  assert.match(html, /(?:&lt;|&#x3C;)script/);
});
test('引用式图片使用原图地址，链接同时保留query与anchor', async () => {
  const {html} = await renderLearningNote('![plot][figure]\n\n[figure]: ../images/diagram.png\n\n[link](other.md?raw=1#section)', context);
  assert.match(html, /src="https:\/\/raw.githubusercontent.com\/example\/course\/abc123\/images\/diagram.png"/);
  assert.match(html, /other.md\?raw=1#section/);
});
