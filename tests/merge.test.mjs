import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTrajectory } from '../src/lib/merge.ts';

const message = (id, content, timestamp = '2026-10-01T01:00:00.000Z') => ({ id, content, timestamp, role: 'user', model: null });
const session = (id, messages) => ({ id, source: 'codex', messages, models: [], warnings: [], startedAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-01T02:00:00.000Z' });
const trajectory = (sessions) => ({ version: 1, id: 'learning-os', title: '我整理过的标题', description: '我的理解', category: 'study', topic: 'JYY OS', status: 'ongoing', tags: ['并发'], sessions, startedAt: '2026-10-01T01:00:00.000Z', updatedAt: '2026-10-01T02:00:00.000Z', checkpoints: [{ id: 'checkpoint', messageId: 'm1', kind: 'insight', title: '一次转折', body: '保留我的回顾' }], links: [] });

test('重复导入保留整理和旧消息，更新同ID消息并添加后续消息', () => {
  const previous = trajectory([session('s1', [message('m1', '旧问题'), message('m2', '曾经看到的答案')])]);
  const incoming = { ...trajectory([session('s1', [message('m1', '更新的问题'), message('m3', '新问题', '2026-10-02T01:00:00.000Z')])]), title: '原始自动标题', topic: '未分类', checkpoints: [] };
  incoming.sessions[0].updatedAt = '2026-10-02T01:00:00.000Z';
  const merged = mergeTrajectory(previous, incoming);
  assert.equal(merged.title, previous.title);
  assert.equal(merged.topic, 'JYY OS');
  assert.deepEqual(merged.checkpoints, previous.checkpoints);
  assert.deepEqual(merged.sessions[0].messages.map(({id}) => id), ['m1', 'm2', 'm3']);
  assert.equal(merged.sessions[0].messages[0].content, '更新的问题');
});

test('跨来源会话接到同一目标，保留目标ID和模型记录', () => {
  const previous = trajectory([session('codex-s1', [message('m1', '问题')])]);
  const incoming = trajectory([{ ...session('deepseek-s2', [message('m2', '接着讨论')]), source: 'deepseek', models: ['recorded-model'] }]);
  const merged = mergeTrajectory(previous, incoming);
  assert.equal(merged.id, 'learning-os');
  assert.equal(merged.sessions.length, 2);
  assert.deepEqual(merged.sessions[1].models, ['recorded-model']);
});

test('重复导入是幂等的，并不修改输入对象', () => {
  const original = trajectory([session('s1', [message('m1', '问题')])]);
  const snapshot = structuredClone(original);
  const once = mergeTrajectory(original, original);
  assert.deepEqual(mergeTrajectory(once, original), once);
  assert.deepEqual(original, snapshot);
});

test('导入备份带来的新回顾和成果也会合并，同ID回顾保留本地版本', () => {
  const previous = trajectory([session('s1', [message('m1', '问题')])]);
  const incoming = trajectory([session('s1', [message('m1', '问题'), message('m2', '新的实验')])]);
  incoming.checkpoints = [{ ...previous.checkpoints[0], body: '备份中的旧版本' }, { id: 'new-checkpoint', messageId: 'm2', kind: 'verification', title: '新证据', body: '不能丢掉备份带来的回顾' }];
  incoming.links = [{ title: '实验笔记', href: '/notes/experiment/' }];
  const merged = mergeTrajectory(previous, incoming);
  assert.equal(merged.checkpoints.length, 2);
  assert.equal(merged.checkpoints[0].body, '保留我的回顾');
  assert.equal(merged.checkpoints[1].messageId, 'm2');
  assert.deepEqual(merged.links, incoming.links);
});

test('旧备份不会回滚更新过的正文，无论两个快照以何种顺序导入', () => {
  const older = trajectory([session('s1', [message('m1', '较旧正文')])]);
  const newer = trajectory([session('s1', [message('m1', '较新正文')])]);
  newer.sessions[0].updatedAt = '2026-10-02T01:00:00.000Z';
  const forward = mergeTrajectory(older, newer);
  const reverse = mergeTrajectory(newer, older);
  assert.equal(forward.sessions[0].messages[0].content, '较新正文');
  assert.equal(reverse.sessions[0].messages[0].content, '较新正文');
  assert.ok(reverse.sessions[0].warnings.some((warning) => warning.includes('旧快照')));
});

test('来源水位优先于机器时间和采集时间，旧水位不能覆盖新正文', () => {
  const older = trajectory([{ ...session('s1', [message('m1', '旧正文')]), source: 'deepseek' }]);
  const newer = structuredClone(older);
  older.sessions[0].provenance = { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 4, eventCount: 5, observedAt: '2099-01-01T00:00:00.000Z' };
  older.sessions[0].updatedAt = '2099-01-01T00:00:00.000Z';
  newer.sessions[0].provenance = { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 8, eventCount: 9, observedAt: '2026-10-02T00:00:00.000Z' };
  newer.sessions[0].messages[0].content = '新水位正文';
  const merged = mergeTrajectory(newer, older);
  assert.equal(merged.sessions[0].messages[0].content, '新水位正文');
  assert.equal(merged.sessions[0].provenance.lastSequence, 8);
  assert.equal(merged.sessions[0].provenance.observedAt, newer.sessions[0].provenance.observedAt);
});

test('缺少可比较新旧依据时保留当前正文，并明确提示冲突', () => {
  const previous = trajectory([{ ...session('s1', [message('m1', '当前正文', null)]), updatedAt: null }]);
  const incoming = structuredClone(previous);
  incoming.sessions[0].messages[0].content = '无法确认的新内容';
  const merged = mergeTrajectory(previous, incoming);
  assert.equal(merged.sessions[0].messages[0].content, '当前正文');
  assert.ok(merged.sessions[0].warnings.some((warning) => warning.includes('无法确定')));
});

test('旧全量快照可以补齐压缩前消息，顺序来自源序号而非时钟', () => {
  const at = (id, seq, timestamp) => ({ ...message(id, id, timestamp), origin: { id, sequence: seq, line: seq + 2 } });
  const m0 = at('m0', 0, '2026-10-03T00:00:00.000Z');
  const m1 = at('m1', 1, '2026-10-02T00:00:00.000Z');
  const m2 = at('m2', 2, '2026-10-01T00:00:00.000Z');
  const oldFull = trajectory([{ ...session('s1', [m0, m1, m2]), source: 'deepseek', provenance: { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 2, eventCount: 3 } }]);
  const latest = trajectory([{ ...session('s1', [m0, m2]), source: 'deepseek', provenance: { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 5, eventCount: 6 } }]);
  const merged = mergeTrajectory(latest, oldFull);
  assert.deepEqual(merged.sessions[0].messages.map(({ id }) => id), ['m0', 'm1', 'm2']);
  assert.equal(merged.sessions[0].provenance.lastSequence, 5);
});

test('没有序号的旧消息按共同锚点补入，不按时间重新排序', () => {
  const a = message('a', 'a', '2026-10-03T00:00:00.000Z');
  const b = message('b', 'b', '2026-10-02T00:00:00.000Z');
  const c = message('c', 'c', '2026-10-01T00:00:00.000Z');
  const previous = trajectory([session('s1', [a, c])]);
  const incoming = trajectory([session('s1', [a, b, c])]);
  assert.deepEqual(mergeTrajectory(previous, incoming).sessions[0].messages.map(({ id }) => id), ['a', 'b', 'c']);
});

test('两个来源的相同会话ID保持独立，不会混合消息或来源标签', () => {
  const previous = trajectory([session('shared-id', [message('codex-message', 'Codex')])]);
  const incoming = trajectory([{ ...session('shared-id', [message('deepseek-message', 'DeepSeek')]), source: 'deepseek' }]);
  const merged = mergeTrajectory(previous, incoming);
  assert.equal(merged.sessions.length, 2);
  assert.deepEqual(merged.sessions.map(({ source }) => source), ['codex', 'deepseek']);
  assert.equal(merged.sessions[0].messages.length, 1);
  assert.equal(merged.sessions[1].messages.length, 1);
});

test('不同来源格式版本的事件水位不可直接比较，使用来源时间', () => {
  const previous = trajectory([{ ...session('s1', [message('m1', 'V4')]), source: 'deepseek', provenance: { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 100 } }]);
  const incoming = trajectory([{ ...session('s1', [message('m1', '迁移后的记录')]), source: 'deepseek', updatedAt: '2026-10-02T00:00:00.000Z', provenance: { format: 'deepseek-session', formatVersion: 5, parserVersion: 2, lastSequence: 2 } }]);
  assert.equal(mergeTrajectory(previous, incoming).sessions[0].messages[0].content, '迁移后的记录');
});

test('消息的后续源序号能证明更新，不依赖会回退的墙上时间', () => {
  const previous = trajectory([{ ...session('s1', [{ ...message('m1', '先前内容'), origin: { id: 'original', sequence: 2 } }]), source: 'deepseek', provenance: { format: 'deepseek-session', formatVersion: 4, parserVersion: 2, lastSequence: 9 } }]);
  const incoming = structuredClone(previous);
  incoming.sessions[0].messages[0] = { ...message('m1', '后续源事件内容', '2020-01-01T00:00:00.000Z'), origin: { id: 'original', sequence: 6 } };
  assert.equal(mergeTrajectory(previous, incoming).sessions[0].messages[0].content, '后续源事件内容');
});

test('同一来源水位可以用新版解析器重建，旧解析器导出不回滚正文', () => {
  const before = trajectory([session('s1', [message('m1', '旧解析结果')])]);
  before.sessions[0].provenance = { format: 'codex-rollout', formatVersion: null, parserVersion: 1, eventCount: 4 };
  const after = structuredClone(before);
  after.sessions[0].provenance.parserVersion = 2;
  after.sessions[0].messages[0].content = '修复后的解析结果';
  assert.equal(mergeTrajectory(before, after).sessions[0].messages[0].content, '修复后的解析结果');
  assert.equal(mergeTrajectory(after, before).sessions[0].messages[0].content, '修复后的解析结果');
  assert.equal(mergeTrajectory(before, after).sessions[0].provenance.parserVersion, 2);
});
