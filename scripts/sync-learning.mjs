import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { syncLearning } from '../src/lib/learning-sync.mjs';
import { renderLearningNote } from '../src/lib/learning-markdown.mjs';

const usage = `用法：node scripts/sync-learning.mjs [--root <目录>] [--config <JSON>]\n  [--codex-root <目录>] [--dsh-root <目录>] [--out <目录>] [--public <JSON>] [--watch [毫秒]]\n--codex-root 和 --dsh-root 可重复；--watch 默认每 30000 毫秒串行同步。`;

function options(args) {
  const result = {
    learningRoot: join(homedir(), 'Dev/Learning'), configFile: 'learning.config.json',
    codexRoots: [], deepseekRoots: [], outputDir: 'local-data/learning', publicFile: 'src/data/learning.json', watch: 0,
  };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--watch') {
      result.watch = /^\d+$/.test(args[index + 1] ?? '') ? Number(args[++index]) : 30000;
      if (!Number.isSafeInteger(result.watch) || result.watch < 100) throw new Error('监听间隔应为至少 100 毫秒的整数。');
      continue;
    }
    const fields = { '--root': 'learningRoot', '--config': 'configFile', '--out': 'outputDir', '--public': 'publicFile' };
    if (!fields[key] && !['--codex-root', '--dsh-root'].includes(key)) throw new Error(`未知参数：${key}`);
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${key} 后需要路径。`);
    if (key === '--codex-root') result.codexRoots.push(resolve(value));
    else if (key === '--dsh-root') result.deepseekRoots.push(resolve(value));
    else result[fields[key]] = resolve(value);
  }
  if (!result.codexRoots.length) result.codexRoots = [join(homedir(), '.codex/sessions'), join(homedir(), '.codex/archived_sessions')];
  if (!result.deepseekRoots.length) result.deepseekRoots = [join(homedir(), '.dsh/sessions')];
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return; }
  const settings = options(args);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    do {
      try {
        const config = JSON.parse(await readFile(settings.configFile, 'utf8'));
        const result = await syncLearning({ ...settings, config, renderNote: renderLearningNote });
        if (result.changed || !settings.watch) console.log(`学习档案：${result.stats.projects} 个课程，${result.stats.notes} 篇笔记，${result.stats.trajectories} 条轨迹；本轮解析 ${result.stats.parsedFiles} 个文件。`);
        for (const error of result.errors) console.error(error);
      } catch (error) {
        console.error(error instanceof Error ? error.message : '学习同步失败，已保留最后成功快照。');
        if (!settings.watch) { process.exitCode = 1; return; }
      }
      if (!settings.watch || controller.signal.aborted) break;
      await delay(settings.watch, undefined, { signal: controller.signal }).catch((error) => { if (error.name !== 'AbortError') throw error; });
    } while (!controller.signal.aborted);
  } finally {
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(() => { console.error('学习同步失败，已保留最后成功快照。'); process.exitCode = 1; });
