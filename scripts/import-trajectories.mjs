import { readFile, writeFile, mkdir, link, realpath, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parseImport } from '../src/lib/importers.mjs';
import { mergeTrajectory } from '../src/lib/merge.ts';

const args = process.argv.slice(2);
const usage = '用法：node scripts/import-trajectories.mjs <input...> [--out <file>]\n默认输出：local-data/trajectories.json';

async function main() {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  const inputs = [];
  let output = 'local-data/trajectories.json';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--out') {
      if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error('--out 后需要文件路径。');
      output = args[++index];
    } else if (arg.startsWith('-')) throw new Error(`未知参数：${arg}`);
    else inputs.push(arg);
  }
  if (!inputs.length) throw new Error(usage);
  const destination = resolve(output);
  const resolvedDestination = await realpath(destination).catch(() => destination);
  const trajectories = new Map();
  for (const input of inputs) {
    const source = await realpath(resolve(input));
    if (source === resolvedDestination || resolve(input) === destination) throw new Error('输出路径不能覆盖源会话文件。');
    const bytes = await readFile(source);
    for (const trajectory of parseImport(bytes, input)) {
      const previous = trajectories.get(trajectory.id);
      trajectories.set(trajectory.id, previous ? mergeTrajectory(previous, trajectory) : trajectory);
    }
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify({ version: 1, trajectories: [...trajectories.values()] }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('输出文件已存在，未覆盖已有轨迹或回顾。请用 --out 指定新的文件路径。');
      throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  let sessions = 0;
  let messages = 0;
  for (const trajectory of trajectories.values()) {
    sessions += trajectory.sessions.length;
    messages += trajectory.sessions.reduce((total, session) => total + session.messages.length, 0);
  }
  console.log(`已导入 ${trajectories.size} 条轨迹、${sessions} 个会话、${messages} 条消息。`);
  console.log(`已写入 ${destination}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '导入失败。');
  process.exitCode = 1;
});
