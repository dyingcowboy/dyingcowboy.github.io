import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodex, parseDeepSeek, parseImport } from '../src/lib/importers.mjs';

const time = '2026-01-01T00:00:00.000Z';
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
const codexMessage = (id, role, content, timestamp = time) => ({
  type: 'response_item', timestamp,
  payload: { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: content }] },
});
const codexRows = [
  { type: 'session_meta', timestamp: time, payload: { id: 'codex-session', timestamp: time } },
  { type: 'turn_context', timestamp: time, payload: { model: 'example-model-a' } },
  codexMessage('u1', 'user', '为什么测试没有调用我的实现？'),
  codexMessage('a1', 'assistant', '先检查测试 adapter。'),
];
const deepHeader = { type: 'session', version: 4, id: 'deep-session', createdAt: 1767225600000 };
const deepEvent = (type, data, seq, extra = {}) => ({ type, seq, time: 1767225600000 + seq * 1000, data, surfaceOp: 'append', ...extra });
const deepRows = [
  deepHeader,
  deepEvent('user/message', { id: 'du1', role: 'user', content: [{ type: 'text', text: '这个插件怎样保留任务进度？' }], source: { kind: 'user' } }, 0),
  deepEvent('assistant/message', { message: { id: 'da1', role: 'assistant', content: [{ type: 'text', text: '把持久状态和显示状态分开。' }], source: { kind: 'model', provider: 'example', model: 'example-deep-model' } } }, 1),
];

test('source provenance and physical positions survive normalized export round trips', () => {
  const rows = structuredClone(codexRows);
  rows[0].payload = { ...rows[0].payload, cwd: '/fixture/course', cli_version: '0.99-test', parent_thread_id: 'parent', git: { commit_hash: 'abc123', branch: 'study', repository_url: 'https://github.com/example/course.git' } };
  const records = parseImport(lines(rows), 'rollout.jsonl');
  const session = records[0].sessions[0];
  assert.equal(session.provenance.cwd, '/fixture/course');
  assert.equal(session.provenance.appVersion, '0.99-test');
  assert.equal(session.provenance.parentSessionId, 'parent');
  assert.equal(session.provenance.git.commit, 'abc123');
  assert.equal(session.provenance.eventCount, rows.length);
  assert.equal(session.messages[0].origin.id, 'u1');
  assert.equal(session.messages[0].origin.line, 3);
  assert.deepEqual(parseImport(JSON.stringify({version:1,trajectories:records}), 'backup.json'), records);
});

test('automatic titles use the question while retaining workspace context in the timeline', () => {
  const context = '# AGENTS.md instructions for /fixture/course\n<INSTRUCTIONS>Read first</INSTRUCTIONS>';
  const records = parseImport(lines([codexRows[0], codexMessage('context','user',context), codexMessage('env','user','<environment_context>fixture</environment_context>'), codexMessage('question','user','<in-app-browser-context>fixture</in-app-browser-context>\n\n## My request:\n为什么 yield 能保存执行位置？')]));
  assert.equal(records[0].title,'为什么 yield 能保存执行位置？');
  assert.equal(records[0].sessions[0].messages[0].content,context);
  assert.equal(records[0].sessions[0].messages.length,3);
});

test('DSH format identity is explicit and unknown surface events remain visible as warnings', () => {
  const session = parseDeepSeek(lines([...deepRows, deepEvent('future/message', {text:'not a known surface'}, 2), deepEvent('assistant/message', {message:{id:'replacement',role:'assistant',content:'model-only context'}}, 3, {surfaceOp:{op:'replace',startSeq:0,endSeq:1}})]));
  assert.equal(session.provenance.formatVersion, 4);
  assert.equal(session.provenance.lastSequence, 3);
  assert.equal(session.messages[1].origin.sequence, 1);
  assert.ok(session.warnings.some((warning) => warning.includes('未支持的可见事件')));
  assert.ok(session.warnings.some((warning) => warning.includes('上下文替换')));
  assert.doesNotMatch(JSON.stringify(session.messages), /model-only context|not a known surface/);
  assert.throws(() => parseDeepSeek(lines([{...deepHeader,version:5},deepRows[1]])), /支持.*版本 5/);
});

test('Codex preserves user text and turn models, filters system/developer roles and reasoning, and deduplicates IDs', () => {
  const raw = lines([
    ...codexRows,
    codexMessage('u-injected', 'user', '# AGENTS.md instructions\n用户自己粘贴的说明'),
    codexMessage('system', 'system', 'private system instruction'),
    codexMessage('developer', 'developer', 'private developer instruction'),
    { type: 'response_item', timestamp: time, payload: { type: 'reasoning', content: [{ type: 'text', text: 'internal reasoning' }] } },
    codexMessage('a1', 'assistant', '先检查测试 adapter。'),
    { type: 'event_msg', timestamp: time, payload: { type: 'agent_message', message: '先检查测试 adapter。' } },
    { type: 'turn_context', timestamp: time, payload: { model: 'example-model-b' } },
    codexMessage('u2', 'user', 'adapter 中确实还没有转发函数。'),
    codexMessage('a2', 'assistant', '接通后重新运行相关测试。'),
  ]);
  const session = parseCodex(raw);
  assert.equal(session.source, 'codex');
  assert.equal(session.messages.length, 5);
  assert.deepEqual(session.models, ['example-model-a', 'example-model-b']);
  assert.equal(session.messages[0].model, 'example-model-a');
  assert.equal(session.messages.at(-1).model, 'example-model-b');
  assert.ok(session.messages.some((message) => message.content.includes('用户自己粘贴的说明')));
  assert.doesNotMatch(JSON.stringify(session), /private|internal reasoning/);
});

test('Codex associates tool outputs with the calling tool and model', () => {
  const session = parseCodex(lines([
    ...codexRows,
    { type: 'response_item', timestamp: time, payload: { type: 'function_call', id: 'tool-in', call_id: 'call-1', name: 'run_test', arguments: '{"target":"adapter"}' } },
    { type: 'turn_context', timestamp: time, payload: { model: 'example-model-b' } },
    { type: 'response_item', timestamp: time, payload: { type: 'function_call_output', id: 'tool-out', call_id: 'call-1', output: '1 test passed' } },
  ]));
  const tools = session.messages.filter((message) => message.role === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools[1].callId, 'call-1');
  assert.equal(tools[1].toolName, 'run_test');
  assert.equal(tools[1].model, 'example-model-a');
});

test('older Codex event messages are supported without duplicating response items', () => {
  const session = parseCodex(lines([
    codexRows[0],
    { type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: 'How does a mask work?' } },
    { type: 'event_msg', timestamp: time, payload: { type: 'agent_message', message: 'It controls which positions can be read.' } },
  ]));
  assert.deepEqual(session.messages.map((message) => message.role), ['user', 'assistant']);
});

test('mixed Codex logs preserve event-only messages and remove only identifiable mirrors', () => {
  const later = '2026-01-01T00:01:00.000Z';
  const session = parseCodex(lines([
    ...codexRows,
    { type: 'event_msg', timestamp: time, payload: { type: 'user_message', message: codexRows[2].payload.content[0].text } },
    { type: 'event_msg', timestamp: later, payload: { type: 'agent_message', message: '这一条只有可见事件，没有 response_item。' } },
  ]));
  assert.equal(session.messages.length, 3);
  assert.equal(session.messages.at(-1).content, '这一条只有可见事件，没有 response_item。');
  assert.ok(session.warnings.some((warning) => warning.includes('可见事件')));
});

test('identical questions and answers in different turns are not removed as duplicates', () => {
  const later = '2026-01-01T00:01:00.000Z';
  const session = parseCodex(lines([
    ...codexRows,
    codexMessage('u-repeat', 'user', codexRows[2].payload.content[0].text, later),
    codexMessage('a-repeat', 'assistant', codexRows[3].payload.content[0].text, later),
    { type: 'event_msg', timestamp: later, payload: { type: 'user_message', message: codexRows[2].payload.content[0].text } },
    { type: 'event_msg', timestamp: later, payload: { type: 'agent_message', message: codexRows[3].payload.content[0].text } },
  ]));
  assert.equal(session.messages.length, 4);
  assert.equal(session.messages.filter((message) => message.role === 'user').length, 2);
  assert.notEqual(session.messages[0].id, session.messages[2].id);
});

test('reimporting an appended source keeps earlier locations stable and updates revised source IDs', () => {
  const noId = codexMessage(undefined, 'user', '没有源消息 ID 的提问');
  const initial = parseCodex(lines([...codexRows, noId]));
  const updated = parseCodex(lines([
    ...codexRows,
    noId,
    codexMessage('a1', 'assistant', '同一个源消息的最终完整回答。'),
    codexMessage('new-answer', 'assistant', '新增的一轮回答。'),
  ]));
  assert.deepEqual(updated.messages.slice(0, initial.messages.length).map((message) => message.id), initial.messages.map((message) => message.id));
  assert.equal(updated.messages[1].content, '同一个源消息的最终完整回答。');
  assert.match(updated.messages[0].id, /codex-session-u1$/);
  assert.ok(updated.warnings.some((warning) => warning.includes('最新内容')));
});

test('attachment-only and unknown content messages retain placeholders and explain omissions', () => {
  const session = parseCodex(lines([
    codexRows[0],
    { type: 'response_item', timestamp: time, payload: { type: 'message', id: 'image-only', role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,example' }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', id: 'unknown-only', role: 'user', content: [{ type: 'future-block', data: 'opaque attachment' }] } },
    { type: 'response_item', timestamp: time, payload: { type: 'message', id: 'file-only', role: 'user', content: [{ type: 'input_file', file_data: 'example' }] } },
  ]));
  assert.equal(session.messages.length, 3);
  assert.match(session.messages[0].content, /图片附件/);
  assert.match(session.messages[1].content, /future-block/);
  assert.ok(session.warnings.some((warning) => warning.includes('图片')));
  assert.ok(session.warnings.some((warning) => warning.includes('future-block')));
  assert.ok(session.warnings.some((warning) => warning.includes('文件、音频或视频')));
  assert.doesNotMatch(JSON.stringify(session), /base64|opaque attachment/);
});

test('DeepSeek imports visible surface messages and ignores inbox splices and replacements', () => {
  const session = parseDeepSeek(lines([
    ...deepRows,
    deepEvent('agent/inbox/spliced', { start: 0, removedCount: 2, inserted: [{ id: 'internal', role: 'system', content: [{ type: 'text', text: 'internal replacement' }] }] }, 2, { surfaceOp: undefined }),
    deepEvent('assistant/message', { message: { id: 'replacement', role: 'assistant', content: [{ type: 'text', text: 'model-only copy' }], source: { kind: 'model', model: 'example-deep-model' } } }, 3, { surfaceOp: 'replace' }),
    deepEvent('assistant/attempt', { stream: [{ type: 'text-chunks', chunks: ['unfinished'] }] }, 4),
    deepEvent('system/message', { message: { id: 'sys', role: 'system', content: [{ type: 'text', text: 'private instruction' }] } }, 5),
  ]));
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].timestamp, time);
  assert.equal(session.messages[1].timestamp, '2026-01-01T00:00:01.000Z');
  assert.deepEqual(session.models, ['example-deep-model']);
  assert.doesNotMatch(JSON.stringify(session.messages), /internal|model-only|unfinished|private/);
});

test('DeepSeek extracts assembled text and tool calls without replaying stream chunks or reasoning', () => {
  const session = parseDeepSeek(lines([
    ...deepRows,
    deepEvent('assistant/message', {
      message: { id: 'da2', role: 'assistant', content: [
        { type: 'reasoning', text: 'internal chain' },
        { type: 'text', text: '检查状态恢复。' },
        { type: 'tool-call', id: 'deep-call', name: 'check_state', arguments: '{"mode":"read"}' },
      ], source: { kind: 'model', model: 'example-deep-model-2' } },
      stream: [{ type: 'text-chunks', chunks: ['检查状态恢复。'] }],
    }, 2),
    deepEvent('tool/result', { message: { id: 'dt1', role: 'tool', toolCallId: 'deep-call', content: [{ type: 'text', text: 'state restored' }], source: { kind: 'tool', callId: 'deep-call' } } }, 3),
  ]));
  assert.equal(session.messages.filter((message) => message.content === '检查状态恢复。').length, 1);
  assert.equal(session.messages.at(-1).toolName, 'check_state');
  assert.equal(session.messages.at(-1).callId, 'deep-call');
  assert.equal(session.messages.at(-1).model, 'example-deep-model-2');
  assert.doesNotMatch(JSON.stringify(session), /internal chain/);
});

test('a trailing partial JSONL write is warned about while malformed complete lines fail', () => {
  const session = parseCodex(lines(codexRows) + '{"type":"response_item"');
  assert.equal(session.messages.length, 2);
  assert.match(session.warnings[0], /尚未写完/);
  assert.throws(() => parseCodex(lines(codexRows) + '{bad}\n'), /第 5 行/);
  assert.throws(() => parseCodex(lines(codexRows) + '{"type":\n'), /第 5 行/);
});

test('imports produce stable URL-safe identities and unknown models remain null', () => {
  const input = lines([codexRows[0], codexMessage('id / with spaces', 'user', 'A goal')]);
  const first = parseImport(input)[0];
  const second = parseImport(input)[0];
  assert.equal(first.id, second.id);
  assert.match(first.id, /^[a-zA-Z0-9_-]+$/);
  assert.match(first.sessions[0].messages[0].id, /^[a-zA-Z0-9_-]+$/);
  assert.equal(first.sessions[0].messages[0].model, null);
  assert.equal(first.category, 'knowledge');
  assert.equal(first.topic, '未分类');
});

test('a compressed DeepSeek import reads all concatenated Zstandard frames', () => {
  const headerFrame = zstdCompressSync(Buffer.from(lines([deepHeader])));
  const eventFrame = zstdCompressSync(Buffer.from(lines([deepRows[1]])));
  const appendedFrame = zstdCompressSync(Buffer.from(lines([deepRows[2]])));
  const archive = Buffer.concat([headerFrame, eventFrame, appendedFrame]);
  const trajectories = parseImport(archive, 'session.v4.jsonl.zstd');
  assert.equal(trajectories.length, 1);
  assert.equal(trajectories[0].sessions[0].messages.length, 2);
});

test('invalid compression, invalid UTF-8, unsupported sessions and empty inputs fail clearly', () => {
  assert.throws(() => parseImport(new Uint8Array([1, 2, 3]), 'broken.zstd'), /无法解压/);
  assert.throws(() => parseImport(new Uint8Array([0xc3, 0x28])), /UTF-8/);
  assert.throws(() => parseImport(''), /文件为空/);
  assert.throws(() => parseImport('{"other":true}'), /无法识别/);
  assert.throws(() => parseDeepSeek(lines([{ ...deepHeader, version: 99 }, deepRows[1]])), /版本 99/);
});

test('normalized exports round-trip, reject unsafe links and reject broken references', () => {
  const trajectory = parseImport(lines(codexRows))[0];
  trajectory.checkpoints = [{ id: 'checkpoint-1', messageId: trajectory.sessions[0].messages[0].id, kind: 'question', title: '问题', body: '需要定位测试入口。' }];
  trajectory.links = [{ title: 'Related note', href: '/notes/example/' }];
  const serialized = JSON.stringify({ version: 1, trajectories: [trajectory] });
  assert.deepEqual(parseImport(serialized), [trajectory]);
  const unsafe = structuredClone(trajectory);
  unsafe.links[0].href = 'javascript:alert(1)';
  assert.throws(() => parseImport(JSON.stringify({ version: 1, trajectories: [unsafe] })), /安全的网站链接/);
  const broken = structuredClone(trajectory);
  broken.checkpoints[0].messageId = 'not-found';
  assert.throws(() => parseImport(JSON.stringify({ version: 1, trajectories: [broken] })), /不存在的消息/);
  assert.throws(() => parseImport(JSON.stringify({ version: 1, trajectories: [trajectory, trajectory] })), /重复轨迹标识/);
});

test('message identities remain unambiguous when separate sessions reuse local IDs', () => {
  const original = parseImport(lines(codexRows))[0];
  const otherRows = structuredClone(codexRows);
  otherRows[0].payload.id = 'second-session';
  const other = parseImport(lines(otherRows))[0];
  original.sessions.push(other.sessions[0]);
  assert.notEqual(original.sessions[0].messages[0].id, original.sessions[1].messages[0].id);
  assert.equal(parseImport(JSON.stringify({ version: 1, trajectories: [original] }))[0].sessions.length, 2);
});

test('CLI writes a normalized archive and refuses to overwrite source files, existing exports, or symlinks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trajectory-import-test-'));
  const input = join(directory, 'input.jsonl');
  const output = join(directory, 'nested', 'archive.json');
  const script = fileURLToPath(new URL('../scripts/import-trajectories.mjs', import.meta.url));
  try {
    await writeFile(input, lines(codexRows));
    const success = spawnSync(process.execPath, [script, input, '--out', output], { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    assert.match(success.stdout, /1 条轨迹/);
    assert.doesNotMatch(success.stdout, /为什么测试/);
    const originalOutput = await readFile(output, 'utf8');
    assert.equal(JSON.parse(originalOutput).trajectories.length, 1);
    const existingRejected = spawnSync(process.execPath, [script, input, '--out', output], { encoding: 'utf8' });
    assert.equal(existingRejected.status, 1);
    assert.match(existingRejected.stderr, /输出文件已存在/);
    assert.equal(await readFile(output, 'utf8'), originalOutput);
    const rejected = spawnSync(process.execPath, [script, input, '--out', input], { encoding: 'utf8' });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /不能覆盖/);
    const alias = join(directory, 'alias.jsonl');
    await symlink(input, alias);
    const aliasRejected = spawnSync(process.execPath, [script, input, '--out', alias], { encoding: 'utf8' });
    assert.equal(aliasRejected.status, 1);
    assert.match(aliasRejected.stderr, /不能覆盖/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
