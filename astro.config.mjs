import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import mermaid from 'astro-mermaid';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkBracketMath from './src/plugins/remark-bracket-math.mjs';
import localLearning from './src/plugins/local-learning.mjs';

export default defineConfig({
  site: 'https://dyingcowboy.github.io',
  devToolbar: { enabled: false },
  integrations: [mermaid()],
  vite: {
    plugins: [localLearning()],
    server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/local-data/**'] } },
  },
  markdown: {
    processor: unified({
      remarkPlugins: [remarkBracketMath, remarkMath],
      rehypePlugins: [rehypeKatex],
    }),
  },
});
