import type { APIRoute } from 'astro';
import { toolbox } from '../../lib/toolbox';

/**
 * /toolbox/data.json —— 人生工具箱的机器可读快照。
 *
 * 构建时静态生成，内容与页面同源（都来自 src/data/toolbox.json），
 * 方便以后接别的消费方，不用爬 HTML。
 */
export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(toolbox, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
