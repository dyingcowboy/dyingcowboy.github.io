import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile, mkdir, rename, unlink, readdir, realpath, stat, lstat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname, join, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Decompress } from 'fzstd';
import { parseImport, PARSER_VERSION } from './importers.mjs';
import { mergeTrajectory as mergeRecords } from './merge.ts';

const git = promisify(execFile);
const PROJECTION_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const ignoredDirectories = new Set(['node_modules', 'dist', 'build']);
const unmatchedFiles = new Map();

class BoundaryError extends Error {}
const hash = (value) => createHash('sha256').update(value).digest('hex');
const inside = (base, target) => {
  const path = relative(base, target);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
};
const unique = (values) => [...new Set(values)];
const signature = (value) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
const publicRepository = ({ id, state, branch, commit, remoteUrl, dirty }) => ({ id, state, branch, commit, remoteUrl, dirty });

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value) || /^[a-z]:/i.test(value) || value.includes('\\') || value.includes('\0')) {
    throw new BoundaryError(`${label}必须是相对路径。`);
  }
  if (value.split('/').some((part) => part === '..' || part.startsWith('.git'))) throw new BoundaryError(`${label}不能越界或访问 Git 内部目录。`);
  return value;
}

function validateConfig(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.projects)) throw new Error('学习配置需要 version: 1 和 projects 列表。');
  if (config.sessionsSince !== undefined && (typeof config.sessionsSince !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(config.sessionsSince)
    || !Number.isFinite(Date.parse(config.sessionsSince)))) throw new Error('sessionsSince 必须是带时区的有效时间。');
  const ids = new Set();
  for (const project of config.projects) {
    if (!project || !SAFE_ID.test(project.id) || ids.has(project.id)) throw new Error('课程 ID 必须有效且唯一。');
    ids.add(project.id);
    if (typeof project.title !== 'string' || !project.title.trim() || typeof project.description !== 'string' || !['active', 'paused'].includes(project.status)) throw new Error(`课程 ${project.id} 的标题、说明或状态无效。`);
    if (!Array.isArray(project.repositories) || !Array.isArray(project.notes) || typeof project.publishNotes !== 'boolean') throw new Error(`课程 ${project.id} 缺少仓库、笔记或公开配置。`);
    const repositories = new Set();
    for (const repo of project.repositories) {
      if (!repo || !SAFE_ID.test(repo.id) || repositories.has(repo.id)) throw new Error(`课程 ${project.id} 的仓库 ID 无效或重复。`);
      repositories.add(repo.id);
      relativePath(repo.path, '仓库路径');
    }
    for (const note of project.notes) {
      if (!note || !repositories.has(note.repoId)) throw new Error(`课程 ${project.id} 的笔记引用了未知仓库。`);
      relativePath(note.path, '笔记路径');
    }
  }
}

async function existingRealpath(path) {
  try { return await realpath(path); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
}

async function checkedPath(base, path, label) {
  const absolute = resolve(base, relativePath(path, label));
  if (!inside(base, absolute)) throw new BoundaryError(`${label}越过了允许的目录。`);
  const actual = await existingRealpath(absolute);
  if (actual && !inside(base, actual)) throw new BoundaryError(`${label}的符号链接越过了允许的目录。`);
  return { absolute, actual };
}

async function gitOutput(repo, args) {
  const { stdout } = await git('git', ['-C', repo, ...args], {
    encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return stdout.trim();
}

function remoteAddress(raw) {
  if (!raw) return null;
  let candidate = raw;
  const ssh = /^[^/@\s]+@([^:\s]+):(.+)$/.exec(raw);
  if (ssh) candidate = `https://${ssh[1]}/${ssh[2]}`;
  try {
    const url = new URL(candidate);
    if (url.protocol === 'ssh:') return remoteAddress(`https://${url.hostname}${url.pathname}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
    return url.href.replace(/\.git\/?$/, '').replace(/\/$/, '');
  } catch { return null; }
}

async function inspectRepository(project, repo, root) {
  const path = await checkedPath(root, repo.path, '仓库路径');
  const result = { projectId: project.id, id: repo.id, path: path.absolute, actual: path.actual ?? path.absolute, state: 'missing', branch: null, commit: null, remoteUrl: null, dirty: null, warning: '仓库不存在或尚未完成克隆。' };
  if (!path.actual) return result;
  try {
    if (!(await stat(path.actual)).isDirectory()) return result;
    const top = await gitOutput(path.actual, ['rev-parse', '--show-toplevel']).catch(() => null);
    if (!top) return result;
    if (await existingRealpath(top) !== path.actual) {
      result.state = 'error';
      result.warning = '配置目录不是 Git 仓库根目录，请检查仓库位置。';
      return result;
    }
    try {
      result.commit = await gitOutput(path.actual, ['rev-parse', '--verify', 'HEAD']);
      if (!/^[a-f0-9]{40,64}$/.test(result.commit)) throw new Error('head');
    } catch { return result; }
    result.branch = await gitOutput(path.actual, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => null);
    result.remoteUrl = remoteAddress(await gitOutput(path.actual, ['config', '--get', 'remote.origin.url']).catch(() => ''));
    result.dirty = Boolean(await gitOutput(path.actual, ['status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all']));
    result.state = 'ready'; result.warning = null;
  } catch { result.state = 'error'; result.warning = '仓库状态暂不可读取，已保留此前结果。'; }
  return result;
}

async function walkFiles(root, accept, { missing = false } = {}) {
  const actualRoot = await existingRealpath(root);
  if (!actualRoot) {
    if (missing) return null;
    throw new Error('source unavailable');
  }
  const files = [];
  const visited = new Set();
  async function walk(path) {
    const actual = await realpath(path);
    if (!inside(actualRoot, actual)) throw new BoundaryError('来源目录中的符号链接越过了允许范围。');
    const info = await stat(actual);
    if (info.isFile()) { if (accept(path)) files.push(path); return; }
    if (!info.isDirectory() || visited.has(actual)) return;
    visited.add(actual);
    for (const entry of (await readdir(actual, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || ignoredDirectories.has(entry.name)) continue;
      await walk(join(actual, entry.name));
    }
  }
  await walk(actualRoot);
  return files.sort();
}

async function stableBytes(path, expected) {
  const before = await stat(path, { bigint: true });
  if (expected && signature(before) !== expected) throw new Error('active source');
  if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw new Error('source too large');
  const bytes = await readFile(path);
  const after = await stat(path, { bigint: true });
  if (signature(before) !== signature(after)) throw new Error('active source');
  return { bytes, signature: signature(after), sha256: hash(bytes) };
}

// Probe only immutable headers/turn metadata. Ordinary conversation lines are
// discarded without JSON parsing or accumulating an unrelated transcript.
async function probeCwd(path, source) {
  if (source === 'codex') {
    let cwd = null;
    let fallback = null;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"session_meta"') && !line.includes('"turn_context"')) continue;
        try {
          const row = JSON.parse(line);
          if (row.type === 'session_meta' && typeof row.payload?.cwd === 'string') cwd = row.payload.cwd;
          if (row.type === 'turn_context' && typeof row.payload?.cwd === 'string') fallback ??= row.payload.cwd;
        } catch { /* A failed metadata probe must not interpret message content. */ }
      }
    } finally { lines.close(); }
    return cwd ?? fallback;
  }
  let header = '';
  if (path.endsWith('.zstd')) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let done = false;
    const decompressor = new Decompress((chunk) => {
      if (done) return;
      const text = decoder.decode(chunk, { stream: true });
      const end = text.indexOf('\n');
      header += end < 0 ? text : text.slice(0, end);
      if (header.length > 256 * 1024) throw new Error('header too large');
      done = end >= 0;
    });
    for await (const chunk of createReadStream(path, { highWaterMark: 8192 })) {
      decompressor.push(chunk);
      if (done) break;
    }
  } else {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    try { for await (const line of lines) { if (line.trim()) { header = line; break; } } }
    finally { lines.close(); }
  }
  const row = JSON.parse(header.replace(/^\uFEFF/, ''));
  return typeof row.cwd === 'string' ? row.cwd : null;
}

async function matchRepository(cwd, repositories) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return null;
  const absolute = resolve(cwd);
  let current = absolute;
  let actual = null;
  // Resolve an existing ancestor too: a recorded cwd may have been removed,
  // while an alias such as /var → /private/var still identifies its repository.
  while (!actual) {
    actual = await existingRealpath(current);
    if (actual) { actual = resolve(actual, relative(current, absolute)); break; }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return repositories.filter((repo) => repo.state !== 'error' && (inside(repo.path, absolute) || inside(repo.actual, actual ?? absolute)))
    .sort((a, b) => Math.max(b.path.length, b.actual.length) - Math.max(a.path.length, a.actual.length))[0] ?? null;
}

function mergeTrajectory(previous, incoming) {
  return previous ? { ...mergeRecords(previous, incoming), title: incoming.title, category: incoming.category, topic: incoming.topic } : incoming;
}

async function rawSnapshot(outputDir, bytes, sha256, kind, observedAt) {
  const directory = join(outputDir, 'raw');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) throw new BoundaryError('原始快照目录不能是符号链接。');
  const filename = join(directory, `${sha256}.bin`);
  let created = false;
  try {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if ((await lstat(filename)).isSymbolicLink() || hash(await readFile(filename)) !== sha256) throw new Error('原始快照校验失败，未覆盖已有内容。');
  }
  try { await writeFile(join(directory, `${sha256}.json`), `${JSON.stringify({ version: 1, sha256, kind, observedAt })}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return created;
}

async function readJson(path, required = false) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; if (required) throw new Error('私有同步状态无效，请先恢复该文件；本轮未覆盖。'); return null; }
}

async function atomicWrite(path, text, mode) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', mode);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

async function lockDirectory(outputDir) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const path = join(outputDir, '.sync.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); } finally { await handle.close(); }
      return async () => {
        const owner = await readJson(path);
        if (owner?.token === token) await unlink(path).catch(() => {});
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJson(path);
      if (!Number.isSafeInteger(owner?.pid)) throw new Error('同步锁已存在，请检查是否有其他同步进程。');
      try { process.kill(owner.pid, 0); }
      catch (failure) {
        if (failure.code === 'ESRCH' && (await readJson(path))?.token === owner.token) { await unlink(path).catch(() => {}); continue; }
      }
      throw new Error('已有学习同步正在运行，本轮未写入。');
    }
  }
  throw new Error('无法取得学习同步锁。');
}

function timeString(now) {
  const value = typeof now === 'function' ? now() : now ?? new Date();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('同步时间无效。');
  return date.toISOString();
}

function withoutTime(value) { const { generatedAt, ...rest } = value; return rest; }
function timedView(value, previous, now) {
  return { ...value, generatedAt: previous && JSON.stringify(withoutTime(value)) === JSON.stringify(withoutTime(previous)) ? previous.generatedAt : now };
}

/** A local collector. Source files stay authoritative; JSON files are rebuildable views. */
export async function syncLearning({ config, learningRoot, codexRoots = [], deepseekRoots = [], outputDir, publicFile, renderNote, now }) {
  validateConfig(config);
  if (typeof learningRoot !== 'string' || typeof outputDir !== 'string' || typeof publicFile !== 'string' || typeof renderNote !== 'function') throw new Error('同步需要根目录、私有输出、公开文件和笔记渲染器。');
  const root = await existingRealpath(resolve(learningRoot)) ?? resolve(learningRoot);
  const destination = resolve(outputDir);
  const publicDestination = resolve(publicFile);
  const stateFile = join(destination, 'state.json');
  if (publicDestination === stateFile || inside(join(destination, 'raw'), publicDestination)) throw new BoundaryError('公开输出不能覆盖私有状态或原始快照。');
  const timestamp = timeString(now);
  const repositories = [];
  for (const project of config.projects) for (const repo of project.repositories) repositories.push(await inspectRepository(project, repo, root));
  const duplicatePaths = new Set();
  for (const repo of repositories) {
    if (duplicatePaths.has(repo.actual)) throw new Error('两个课程仓库不能使用同一个目录。');
    duplicatePaths.add(repo.actual);
  }
  const release = await lockDirectory(destination);
  try {
    const previous = await readJson(stateFile, true);
    if (previous && (previous.version !== 1 || !previous.sources || !Array.isArray(previous.archive?.trajectories) || !Array.isArray(previous.view?.notes))) throw new Error('私有同步状态结构无效，本轮未覆盖。');
    const previousPublic = await readJson(publicDestination);
    const compatible = previous?.projectionVersion === PROJECTION_VERSION;
    const sources = structuredClone(previous?.sources ?? {});
    const archive = new Map((previous?.archive.trajectories ?? []).map((trajectory) => [trajectory.id, trajectory]));
    const sessionsSince = config.sessionsSince === undefined ? null : Date.parse(config.sessionsSince);
    const includeSession = (session) => sessionsSince === null || (typeof session.startedAt === 'string' && Date.parse(session.startedAt) >= sessionsSince);
    // Apply the boundary to retained records as well as newly parsed sources.
    for (const [id, trajectory] of archive) {
      const sessions = trajectory.sessions.filter(includeSession);
      if (!sessions.length) { archive.delete(id); continue; }
      if (sessions.length === trajectory.sessions.length) continue;
      const messageIds = new Set(sessions.flatMap((session) => session.messages.map((message) => message.id)));
      archive.set(id, { ...trajectory, sessions,
        startedAt: sessions.map((session) => session.startedAt).filter(Boolean).sort()[0] ?? null,
        updatedAt: sessions.map((session) => session.updatedAt).filter(Boolean).sort().at(-1) ?? null,
        checkpoints: trajectory.checkpoints.filter((checkpoint) => messageIds.has(checkpoint.messageId)) });
    }
    for (const [key, source] of Object.entries(sources)) {
      if (source.kind !== 'session') continue;
      source.trajectoryIds = source.trajectoryIds.filter((id) => archive.has(id));
      if (!source.trajectoryIds.length) delete sources[key];
    }
    const notes = new Map((previous?.view.notes ?? []).map((note) => [note.id, note]));
    const errors = [];
    const projectWarnings = new Map(config.projects.map((project) => [project.id, []]));
    const addWarning = (projectId, warning) => { const list = projectWarnings.get(projectId); if (list) list.push(warning); };
    const statistics = { projects: config.projects.length, repositories: repositories.length, sources: 0, parsedFiles: 0, cachedFiles: 0, notes: 0, trajectories: 0, sessions: 0, rawSnapshots: 0 };
    const mapping = hash(JSON.stringify({ sessionsSince, projects: config.projects.map((project) => ({ id: project.id, title: project.title, repositories: project.repositories })) }));
    const renderer = hash(String(renderNote.cacheVersion ?? renderNote));
    const readyNoteRepos = new Set();
    const failedNoteRepos = new Set();
    const seenNotes = new Set();

    for (const project of config.projects) {
      for (const repo of repositories.filter((entry) => entry.projectId === project.id)) {
        if (repo.state !== 'ready') { addWarning(project.id, repo.warning); continue; }
        const group = `${project.id}:${repo.id}`;
        readyNoteRepos.add(group);
        const selected = new Set();
        try {
          for (const selection of project.notes.filter((entry) => entry.repoId === repo.id)) {
            const target = await checkedPath(repo.actual, selection.path, '笔记路径');
            if (!target.actual) continue;
            for (const file of await walkFiles(target.actual, (path) => path.toLowerCase().endsWith('.md'))) {
              if (!inside(repo.actual, await realpath(file))) throw new BoundaryError('笔记符号链接越过了仓库范围。');
              selected.add(file);
            }
          }
          for (const file of [...selected].sort()) {
            const path = relative(repo.actual, file).split(sep).join('/');
            const key = `note-${hash(`${project.id}:${repo.id}:${path}`)}`;
            seenNotes.add(key);
            try {
              const content = await stableBytes(file);
              const before = sources[key];
              const noteId = `${project.id}-${repo.id}-${hash(path).slice(0, 24)}`;
              const modified = Boolean(await gitOutput(repo.actual, ['status', '--porcelain', '--untracked-files=normal', '--', path]));
              const tracked = await gitOutput(repo.actual, ['cat-file', '-e', `${repo.commit}:${path}`]).then(() => true, () => false);
              const sourceUrl = repo.remoteUrl && tracked ? `${repo.remoteUrl}/blob/${repo.commit}/${path.split('/').map(encodeURIComponent).join('/')}` : null;
              if (compatible && before?.sha256 === content.sha256 && before.renderer === renderer && before.commit === repo.commit && before.modified === modified && before.remoteUrl === repo.remoteUrl && notes.has(noteId)) {
                statistics.cachedFiles += 1;
                continue;
              }
              const body = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes);
              const rendered = await renderNote(body, { path, sourceUrl, remoteUrl: repo.remoteUrl, commit: repo.commit });
              if (!rendered || typeof rendered.title !== 'string' || typeof rendered.html !== 'string') throw new Error('renderer');
              if (await rawSnapshot(destination, content.bytes, content.sha256, 'note', timestamp)) statistics.rawSnapshots += 1;
              const note = { id: noteId, projectId: project.id, repoId: repo.id, path, title: rendered.title, body, html: rendered.html, sha256: content.sha256, commit: repo.commit, sourceUrl, observedAt: timestamp, modified };
              notes.set(noteId, note);
              sources[key] = { kind: 'note', path: file, projectId: project.id, repoId: repo.id, noteId, sha256: content.sha256, signature: content.signature, renderer, commit: repo.commit, modified, remoteUrl: repo.remoteUrl, observedAt: timestamp };
              statistics.parsedFiles += 1;
            } catch (error) {
              if (error instanceof BoundaryError) throw error;
              failedNoteRepos.add(group); addWarning(project.id, '一篇笔记暂不可读取或渲染，已保留此前成功结果。');
              errors.push(`课程 ${project.id} 有笔记暂未更新。`);
            }
          }
        } catch (error) {
          if (error instanceof BoundaryError) throw error;
          failedNoteRepos.add(group); addWarning(project.id, '笔记目录暂不可读取，已保留此前成功结果。');
          errors.push(`课程 ${project.id} 的笔记目录暂不可读取。`);
        }
      }
    }
    for (const [key, source] of Object.entries(sources)) {
      if (source.kind !== 'note') continue;
      const group = `${source.projectId}:${source.repoId}`;
      if (readyNoteRepos.has(group) && !failedNoteRepos.has(group) && !seenNotes.has(key)) { notes.delete(source.noteId); delete sources[key]; }
    }

    const seenSessions = new Set();
    for (const [sourceType, roots] of repositories.length ? [['codex', codexRoots], ['deepseek', deepseekRoots]] : []) {
      for (const sourceRoot of unique(roots.map((path) => resolve(path)))) {
        let files;
        try { files = await walkFiles(sourceRoot, (path) => path.endsWith('.jsonl') || path.endsWith('.jsonl.zstd'), { missing: true }); }
        catch (error) {
          if (error instanceof BoundaryError) throw error;
          errors.push('一处会话来源目录暂不可读取，已保留旧档案。');
          continue;
        }
        if (!files) continue;
        for (const file of files) {
          const key = `session-${hash(`${sourceType}:${file}`)}`;
          seenSessions.add(key);
          const before = sources[key];
          let matchedProjectId = null;
          try {
            const observed = signature(await stat(file, { bigint: true }));
            if (compatible && before?.signature === observed && before.parserVersion === PARSER_VERSION && before.mapping === mapping) {
              sources[key] = { ...before, available: true };
              statistics.cachedFiles += 1; statistics.sources += 1;
              continue;
            }
            if (!before && unmatchedFiles.get(`${mapping}:${file}`) === observed) continue;
            const cwd = await probeCwd(file, sourceType);
            const matched = await matchRepository(cwd, repositories);
            if (!matched) {
              unmatchedFiles.set(`${mapping}:${file}`, observed);
              if (before) { sources[key] = { ...before, available: false }; for (const projectId of before.projectIds) addWarning(projectId, '一份来源记录的归属发生变化，已保留此前档案。'); }
              continue;
            }
            matchedProjectId = matched.projectId;
            const content = await stableBytes(file, observed);
            if (compatible && before?.sha256 === content.sha256 && before.parserVersion === PARSER_VERSION && before.mapping === mapping) {
              sources[key] = { ...before, signature: content.signature, available: true };
              statistics.cachedFiles += 1; statistics.sources += 1;
              continue;
            }
            const parsed = parseImport(content.bytes, file);
            const assigned = new Map();
            const projectIds = new Set();
            for (const trajectory of parsed) {
              const groups = new Map();
              for (const session of trajectory.sessions) {
                if (!includeSession(session)) continue;
                const repository = await matchRepository(session.provenance?.cwd, repositories);
                if (!repository) continue;
                const values = groups.get(repository.projectId) ?? [];
                values.push({ ...session, provenance: { ...session.provenance, repoId: repository.id, sha256: content.sha256, observedAt: timestamp } });
                groups.set(repository.projectId, values);
              }
              for (const [projectId, sessions] of groups) {
                const project = config.projects.find((entry) => entry.id === projectId);
                const id = `learning-${projectId}-${hash(trajectory.id).slice(0, 32)}`;
                const messageIds = new Set(sessions.flatMap((session) => session.messages.map((message) => message.id)));
                assigned.set(id, { ...trajectory, id, category: 'study', topic: project.title, sessions, checkpoints: trajectory.checkpoints.filter((checkpoint) => messageIds.has(checkpoint.messageId)) });
                projectIds.add(projectId);
              }
            }
            if (!assigned.size) { unmatchedFiles.set(`${mapping}:${file}`, observed); continue; }
            if (await rawSnapshot(destination, content.bytes, content.sha256, 'session', timestamp)) statistics.rawSnapshots += 1;
            for (const [id, trajectory] of assigned) archive.set(id, mergeTrajectory(archive.get(id), trajectory));
            sources[key] = { kind: 'session', source: sourceType, path: file, root: sourceRoot, sha256: content.sha256, signature: content.signature, parserVersion: PARSER_VERSION, mapping, projectIds: [...projectIds], trajectoryIds: [...assigned.keys()], observedAt: timestamp, available: true };
            statistics.parsedFiles += 1; statistics.sources += 1;
          } catch (error) {
            if (error instanceof BoundaryError) throw error;
            if (before) {
              sources[key] = { ...before, available: false };
              for (const projectId of before.projectIds) addWarning(projectId, '一份会话来源正在变化或暂不可解析，已保留此前档案。');
              errors.push('一份课程会话暂未更新，已保留此前成功结果。');
            } else if (matchedProjectId) {
              addWarning(matchedProjectId, '一份新会话正在变化或暂不可解析，等待下次同步。');
              errors.push('一份新课程会话暂未导入。');
            }
          }
        }
      }
    }
    for (const [key, source] of Object.entries(sources)) {
      if (source.kind !== 'session') continue;
      if (!seenSessions.has(key)) sources[key] = { ...source, available: false };
      if (!sources[key].available) for (const projectId of source.projectIds) addWarning(projectId, '部分原始会话来源当前不可用，保留的档案仍可阅读。');
    }

    const currentProjects = new Set(config.projects.map((project) => project.id));
    const currentNotes = [...notes.values()].filter((note) => currentProjects.has(note.projectId)).sort((a, b) => a.id.localeCompare(b.id));
    const trajectories = [...archive.values()].sort((a, b) => a.id.localeCompare(b.id));
    const projects = config.projects.map((project) => {
      const projectRepos = repositories.filter((repo) => repo.projectId === project.id);
      const trajectoryIds = unique(Object.values(sources).filter((source) => source.kind === 'session' && source.projectIds.includes(project.id)).flatMap((source) => source.trajectoryIds)).filter((id) => archive.get(id)?.topic === project.title || archive.has(id));
      const sessions = trajectoryIds.flatMap((id) => archive.get(id)?.sessions ?? []);
      const warnings = unique(projectWarnings.get(project.id)).sort();
      const ready = projectRepos.filter((repo) => repo.state === 'ready').length;
      let state = !projectRepos.length ? 'unconfigured' : ready === projectRepos.length ? 'ready' : ready ? 'partial' : projectRepos.some((repo) => repo.state === 'error') ? 'error' : 'missing';
      if (state === 'ready' && warnings.length) state = 'partial';
      return { id: project.id, title: project.title, description: project.description, status: project.status, state, repositories: projectRepos.map(publicRepository), noteIds: currentNotes.filter((note) => note.projectId === project.id).map((note) => note.id), trajectoryIds, trajectoryCount: trajectoryIds.length, sessionCount: sessions.length, models: unique(sessions.flatMap((session) => session.models)).sort(), warnings };
    });
    const view = timedView({ version: 1, projectionVersion: PROJECTION_VERSION, projects, notes: currentNotes }, previous?.view, timestamp);
    const publishedNotes = currentNotes.filter((note) => config.projects.find((project) => project.id === note.projectId)?.publishNotes);
    const publishedIds = new Set(publishedNotes.map((note) => note.id));
    let publicView = { version: 1, projectionVersion: PROJECTION_VERSION,
      projects: projects.map((project) => ({ ...project, noteIds: project.noteIds.filter((id) => publishedIds.has(id)), trajectoryIds: [], trajectoryCount: 0, sessionCount: 0, models: [] })), notes: publishedNotes };
    const privatePrefixes = unique([root, destination, ...codexRoots.map((path) => resolve(path)), ...deepseekRoots.map((path) => resolve(path))]).sort((a, b) => b.length - a.length);
    const redact = (value) => {
      if (typeof value === 'string') { for (const prefix of privatePrefixes) if (prefix.length > 1) value = value.split(prefix).join('[本机路径]'); return value; }
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry)]));
      return value;
    };
    publicView = timedView(redact(publicView), previousPublic, timestamp);
    const nextState = { version: 1, projectionVersion: PROJECTION_VERSION, sources, archive: { version: 1, trajectories }, view };
    const stateText = `${JSON.stringify(nextState, null, 2)}\n`;
    const publicText = `${JSON.stringify(publicView, null, 2)}\n`;
    JSON.parse(stateText); JSON.parse(publicText);
    const stateChanged = !previous || JSON.stringify(previous) !== JSON.stringify(nextState);
    const publicChanged = !previousPublic || JSON.stringify(previousPublic) !== JSON.stringify(publicView);
    // State is authoritative; publication is always last and can be rebuilt
    // after an interrupted write without pointing at a half-written archive.
    if (stateChanged) await atomicWrite(stateFile, stateText, 0o600);
    if (publicChanged) await atomicWrite(publicDestination, publicText, 0o644);
    statistics.notes = currentNotes.length; statistics.trajectories = trajectories.length;
    statistics.sessions = trajectories.reduce((total, trajectory) => total + trajectory.sessions.length, 0);
    return { changed: stateChanged || publicChanged, view, publicView, archive: nextState.archive, errors: unique(errors), stats: statistics };
  } finally { await release(); }
}
