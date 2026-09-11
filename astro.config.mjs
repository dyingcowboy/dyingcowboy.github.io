import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mermaid from 'astro-mermaid';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkBracketMath from './src/plugins/remark-bracket-math.mjs';

export default defineConfig({
  site: 'https://dyingcowboy.github.io',
  integrations: [mermaid()],
  markdown: {
    processor: unified({
      remarkPlugins: [remarkBracketMath, remarkMath],
      rehypePlugins: [rehypeKatex],
    }),
  },
});
