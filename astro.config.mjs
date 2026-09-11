import { defineConfig } from 'astro/config';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import remarkBracketMath from './src/plugins/remark-bracket-math.mjs';

export default defineConfig({
  site: 'https://dyingcowboy.github.io',
  markdown: {
    remarkPlugins: [remarkBracketMath, remarkMath],
    rehypePlugins: [rehypeKatex],
  },
});
