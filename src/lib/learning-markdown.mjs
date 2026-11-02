import path from 'node:path';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkBracketMath from '../plugins/remark-bracket-math.mjs';

function safeUrl(value, context, image = false) {
  const compact = value.replace(/[\u0000-\u0020]/g, '');
  if (/^(https?:|mailto:|#)/i.test(compact)) return value;
  if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(compact) || !context.remoteUrl || !context.commit) return undefined;
  const remote = context.remoteUrl.replace(/\.git\/?$/, '').replace(/\/$/, '');
  if (!/^https:\/\//.test(remote)) return undefined;
  const suffixAt = value.search(/[?#]/);
  const file = suffixAt < 0 ? value : value.slice(0, suffixAt);
  const suffix = suffixAt < 0 ? '' : value.slice(suffixAt);
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(context.path), file));
  if (target === '..' || target.startsWith('../') || target.startsWith('/')) return undefined;
  const encoded = target.split('/').map(encodeURIComponent).join('/');
  if (image && remote.startsWith('https://github.com/')) {
    return `${remote.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/${encodeURIComponent(context.commit)}/${encoded}${suffix}`;
  }
  return `${remote}/blob/${encodeURIComponent(context.commit)}/${encoded}${suffix}`;
}

function safeMarkdown(context) {
  return () => (tree) => {
    const definitions = new Map();
    const collect = (node) => {
      if (node.type === 'definition') definitions.set(node.identifier, node);
      node.children?.forEach(collect);
    };
    collect(tree);
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child) => {
        // Imported notes are Markdown, never executable HTML or MDX.
        if (child.type === 'html') return { type: 'text', value: child.value };
        if (child.type === 'imageReference' || child.type === 'linkReference') {
          const definition = definitions.get(child.identifier);
          if (definition) child = {
            ...child, type: child.type === 'imageReference' ? 'image' : 'link',
            url: definition.url, title: definition.title,
          };
        }
        if (['link', 'image', 'definition'].includes(child.type)) {
          const url = safeUrl(child.url, context, child.type === 'image');
          if (!url) return child.type === 'image'
            ? { type: 'text', value: child.alt || '[图片地址不可用]' }
            : { type: 'text', value: child.children?.map((n) => n.value ?? '').join('') || '[链接地址不可用]' };
          child.url = url;
        }
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}

export async function renderLearningNote(body, context) {
  const content = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.posix.basename(context.path, '.md');
  const renderer = await createMarkdownProcessor({
    syntaxHighlight: false,
    smartypants: false,
    remarkPlugins: [safeMarkdown(context), remarkBracketMath, remarkMath],
    rehypePlugins: [rehypeKatex],
    remarkRehype: { allowDangerousHtml: false },
  });
  const result = await renderer.render(content.replace(/^\s*#\s+[^\n]+(?:\n|$)/, ''));
  return { title, html: result.code };
}

// Bump when rendering helpers or their output contract change.
renderLearningNote.cacheVersion = 2;
