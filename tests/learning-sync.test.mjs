import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm, rename, unlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { syncLearning } from '../src/lib/learning-sync.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const instant = '2026-11-02T08:00:00.000Z';
function git(directory, ...args) { return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function repository(directory, body = '# A note\n\nAn explanation.\n') {
  await mkdir(join(directory, 'notes'), { recursive: true });
  git(directory, 'init', '-q', '-b', 'main');
  git(directory, 'config', 'user.name', 'Learning Test');
  git(directory, 'config', 'user.email', 'learning@example.invalid');
  await writeFile(join(directory, 'notes', 'one.md'), body);
  git(directory, 'add', '.'); git(directory, 'commit', '-qm', 'Initial fixture');
  git(directory, 'remote', 'add', 'origin', 'git@example.invalid:student/course.git');
}
function log(cwd, { id = 'test-session', message = 'Private fixture question', suffix = [] } = {}) {
  return [
    { timestamp: instant, type: 'session_meta', payload: { id, cwd, timestamp: instant } },
    { timestamp: instant, type: 'turn_context', payload: { model: 'fixture-model' } },
    { timestamp: instant, type: 'response_item', payload: { type: 'message', id: 'first-user', role: 'user', content: [{ type: 'input_text', text: message }] } },
    { timestamp: instant, type: 'response_item', payload: { type: 'message', id: 'first-answer', role: 'assistant', content: [{ type: 'output_text', text: 'Private fixture answer' }] } },
    ...suffix,
  ].map((row) => JSON.stringify(row)).join('\n') + '\n';
}
async function fixture(t, { publish = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'learning-sync-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const learningRoot = join(base, 'learning');
  const repo = join(learningRoot, 'course');
  const records = join(base, 'records');
  await repository(repo);
  await mkdir(records, { recursive: true });
  const config = { version: 1, projects: [{ id: 'os', title: 'Operating Systems', description: 'A fixture course.', status: 'active', repositories: [{ id: 'main', path: 'course' }], notes: [{ repoId: 'main', path: 'notes' }], publishNotes: publish }] };
  let renders = 0;
  const renderNote = async (body) => { renders += 1; return { title: body.split('\n')[0].replace(/^#\s*/, ''), html: `<p>${body.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</p>` }; };
  const options = { config, learningRoot, codexRoots: [records], deepseekRoots: [], outputDir: join(base, 'private'), publicFile: join(base, 'public', 'learning.json'), renderNote, now: instant };
  const source = join(records, 'session.jsonl');
  return { base, repo, records, source, options, renders: () => renders };
}

test('first sync builds full notes and matched sessions, keeps immutable raw snapshots private, and is idempotent', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, log(join(f.repo, 'notes')));
  await writeFile(join(f.records, 'unrelated.jsonl'), log(join(f.base, 'unrelated'), { id: 'unrelated', message: 'Unrelated private material' }));
  const result = await syncLearning(f.options);
  assert.equal(result.changed, true);
  assert.equal(result.view.projects[0].state, 'ready');
  assert.equal(result.view.notes.length, 1);
  assert.equal(result.archive.trajectories.length, 1);
  const session = result.archive.trajectories[0].sessions[0];
  assert.equal(session.provenance.repoId, 'main');
  assert.equal(session.provenance.cwd, join(f.repo, 'notes'));
  assert.equal(result.archive.trajectories[0].category, 'study');
  assert.equal(result.archive.trajectories[0].topic, 'Operating Systems');
  const rawFiles = (await readdir(join(f.options.outputDir, 'raw'))).filter((name) => name.endsWith('.bin'));
  assert.equal(rawFiles.length, 2);
  for (const file of rawFiles) {
    const bytes = await readFile(join(f.options.outputDir, 'raw', file));
    assert.equal(file, `${sha(bytes)}.bin`);
    assert.equal((await stat(join(f.options.outputDir, 'raw', file))).mode & 0o777, 0o600);
  }
  assert.equal(result.publicView.projects[0].trajectoryCount, 0);
  assert.deepEqual(result.publicView.projects[0].trajectoryIds, []);
  assert.equal(result.publicView.notes[0].body, '# A note\n\nAn explanation.\n');
  const publicText = JSON.stringify(result.publicView);
  for (const privateValue of [f.base, 'Private fixture question', 'Unrelated private material', session.id]) assert.equal(publicText.includes(privateValue), false);
  const saved = await readFile(join(f.options.outputDir, 'state.json'), 'utf8');
  assert.equal(saved.includes('Unrelated private material'), false);
  const before = await stat(join(f.options.outputDir, 'state.json'), { bigint: true });
  const again = await syncLearning({ ...f.options, now: '2026-11-02T09:00:00.000Z' });
  assert.equal(again.changed, false);
  assert.equal(again.stats.parsedFiles, 0);
  assert.equal(again.view.generatedAt, result.view.generatedAt);
  assert.equal(f.renders(), 1);
  assert.equal((await stat(join(f.options.outputDir, 'state.json'), { bigint: true })).mtimeNs, before.mtimeNs);
});

test('append and rewritten source snapshots preserve earlier messages and existing reviews', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, log(f.repo));
  const first = await syncLearning(f.options);
  const statePath = join(f.options.outputDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  state.archive.trajectories[0].checkpoints.push({ id: 'a-review', messageId: first.archive.trajectories[0].sessions[0].messages[0].id, kind: 'insight', title: 'Keep this review', body: 'My explanation.' });
  await writeFile(statePath, JSON.stringify(state));
  const extra = { timestamp: '2026-11-02T08:10:00.000Z', type: 'response_item', payload: { type: 'message', id: 'second-answer', role: 'assistant', content: [{ type: 'output_text', text: 'A later answer' }] } };
  await writeFile(f.source, log(f.repo, { suffix: [extra] }));
  const second = await syncLearning(f.options);
  assert.equal(second.archive.trajectories[0].sessions[0].messages.length, 3);
  assert.equal(second.archive.trajectories[0].checkpoints[0].title, 'Keep this review');
  await writeFile(f.source, [JSON.stringify({ timestamp: instant, type: 'session_meta', payload: { id: 'test-session', cwd: f.repo } }), JSON.stringify(extra)].join('\n') + '\n');
  const third = await syncLearning(f.options);
  assert.equal(third.archive.trajectories[0].sessions[0].messages.length, 3);
  assert.equal(third.archive.trajectories[0].checkpoints.length, 1);
  assert.ok((await readdir(join(f.options.outputDir, 'raw'))).filter((name) => name.endsWith('.bin')).length >= 4);
});

test('bad or disappeared matching sources preserve the last successful archive', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, log(f.repo));
  const first = await syncLearning(f.options);
  await writeFile(f.source, JSON.stringify({ timestamp: instant, type: 'session_meta', payload: { id: 'test-session', cwd: f.repo } }) + '\nnot-json\n');
  const failed = await syncLearning(f.options);
  assert.equal(failed.archive.trajectories[0].sessions[0].messages.length, first.archive.trajectories[0].sessions[0].messages.length);
  assert.equal(failed.view.projects[0].state, 'partial');
  assert.ok(failed.errors.length);
  assert.equal(JSON.stringify(failed.errors).includes(f.source), false);
  await unlink(f.source);
  const missing = await syncLearning(f.options);
  assert.equal(missing.archive.trajectories.length, 1);
  assert.ok(missing.view.projects[0].warnings.length);
});

test('note deletion updates the view but a missing repository retains the prior note snapshot', async (t) => {
  const f = await fixture(t);
  const first = await syncLearning(f.options);
  const noteId = first.view.notes[0].id;
  await rename(f.repo, `${f.repo}-offline`);
  const offline = await syncLearning(f.options);
  assert.equal(offline.view.projects[0].state, 'missing');
  assert.equal(offline.view.notes[0].id, noteId);
  await rename(`${f.repo}-offline`, f.repo);
  await unlink(join(f.repo, 'notes', 'one.md'));
  const deleted = await syncLearning(f.options);
  assert.deepEqual(deleted.view.notes, []);
  assert.deepEqual(deleted.publicView.notes, []);
});

test('partial clones and unconfigured courses remain explicit without crashing other courses', async (t) => {
  const f = await fixture(t);
  const preparing = join(f.options.learningRoot, 'preparing');
  await mkdir(preparing); git(preparing, 'init', '-q', '-b', 'main');
  f.options.config.projects.push({ id: 'gse', title: 'GSE', description: '', status: 'active', repositories: [{ id: 'main', path: 'preparing' }], notes: [], publishNotes: false });
  f.options.config.projects.push({ id: 'cmu', title: 'CMU', description: '', status: 'active', repositories: [], notes: [], publishNotes: false });
  const result = await syncLearning(f.options);
  assert.equal(result.view.projects.find((p) => p.id === 'gse').state, 'missing');
  assert.equal(result.view.projects.find((p) => p.id === 'cmu').state, 'unconfigured');
  assert.equal(result.view.projects.find((p) => p.id === 'os').state, 'ready');
});

test('cwd association uses the longest repository prefix, not a title or neighboring path', async (t) => {
  const f = await fixture(t);
  const nested = join(f.repo, 'nested');
  await repository(nested);
  f.options.config.projects.push({ id: 'nested', title: 'A nested course', description: '', status: 'active', repositories: [{ id: 'inner', path: 'course/nested' }], notes: [], publishNotes: false });
  await writeFile(f.source, log(join(nested, 'notes'), { message: 'Operating Systems' }));
  await writeFile(join(f.records, 'neighbor.jsonl'), log(`${f.repo}-neighbor`, { id: 'neighbor' }));
  const result = await syncLearning(f.options);
  assert.equal(result.archive.trajectories.length, 1);
  assert.equal(result.archive.trajectories[0].topic, 'A nested course');
  assert.equal(result.archive.trajectories[0].sessions[0].provenance.repoId, 'inner');
  assert.equal(result.view.projects.find((p) => p.id === 'os').trajectoryCount, 0);
});

test('parser and renderer cache watermarks invalidate without losing raw source identity', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, log(f.repo));
  await syncLearning(f.options);
  const statePath = join(f.options.outputDir, 'state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const entry = Object.values(state.sources).find((source) => source.kind === 'session');
  entry.parserVersion = 1;
  await writeFile(statePath, JSON.stringify(state));
  const result = await syncLearning(f.options);
  assert.equal(result.stats.parsedFiles, 1);
  assert.equal(result.stats.rawSnapshots, 0);
  const rerendered = await syncLearning({ ...f.options, renderNote: async () => ({ title: 'A revised renderer', html: '<p>Rendered differently.</p>' }) });
  assert.equal(rerendered.stats.parsedFiles, 1);
  assert.equal(rerendered.view.notes[0].title, 'A revised renderer');
});

test('path traversal and symlink escape are refused without overwriting the last good view', async (t) => {
  const f = await fixture(t);
  await syncLearning(f.options);
  const publicBefore = await readFile(f.options.publicFile, 'utf8');
  const invalid = structuredClone(f.options.config);
  invalid.projects[0].repositories[0].path = '../outside';
  await assert.rejects(syncLearning({ ...f.options, config: invalid }), /不能越界|相对路径/);
  const outside = join(f.base, 'outside');
  await mkdir(outside); await writeFile(join(outside, 'secret.md'), 'Do not import this.');
  await symlink(outside, join(f.repo, 'notes', 'escape'));
  await assert.rejects(syncLearning(f.options), /符号链接/);
  assert.equal(await readFile(f.options.publicFile, 'utf8'), publicBefore);
});

test('private note bodies, local paths and unrelated sessions never enter the public view', async (t) => {
  const f = await fixture(t, { publish: false });
  const secret = 'A synthetic private note body';
  await writeFile(join(f.repo, 'notes', 'one.md'), `# Private\n${secret}\n${f.repo}\n`);
  await writeFile(f.source, log(f.repo));
  const result = await syncLearning(f.options);
  assert.ok(result.view.notes[0].body.includes(secret));
  assert.deepEqual(result.publicView.notes, []);
  assert.deepEqual(result.publicView.projects[0].noteIds, []);
  for (const value of [f.base, secret, 'Private fixture', result.archive.trajectories[0].id]) assert.equal(JSON.stringify(result.publicView).includes(value), false);
});

test('collector shares source ordering rules and course renames invalidate the view', async (t) => {
  const f = await fixture(t);
  await writeFile(f.source, log(f.repo));
  const first = await syncLearning(f.options);
  const extra = { timestamp: '2020-01-01T00:00:00.000Z', type: 'response_item', payload: { type:'message', id:'late-event', role:'user', content:[{type:'input_text',text:'Later in file, earlier wall clock'}] } };
  await writeFile(f.source, log(f.repo, {suffix:[extra]}));
  const second = await syncLearning(f.options);
  assert.deepEqual(second.archive.trajectories[0].sessions[0].messages.slice(0,2).map((message)=>message.id), first.archive.trajectories[0].sessions[0].messages.map((message)=>message.id));
  assert.equal(second.archive.trajectories[0].sessions[0].messages.at(-1).origin.id,'late-event');
  f.options.config.projects[0].title = 'A renamed course';
  assert.equal((await syncLearning(f.options)).archive.trajectories[0].topic,'A renamed course');
});

test('a regular subdirectory is not mistaken for a separate repository, SSH remotes are sanitized', async (t) => {
  const f = await fixture(t);
  f.options.config.projects[0].repositories[0].path = 'course/notes';
  const invalid = await syncLearning(f.options);
  assert.equal(invalid.view.projects[0].state, 'error');
  f.options.config.projects[0].repositories[0].path = 'course';
  git(f.repo,'remote','set-url','origin','ssh://git@example.invalid/student/course.git');
  assert.equal((await syncLearning(f.options)).view.projects[0].repositories[0].remoteUrl,'https://example.invalid/student/course');
});
