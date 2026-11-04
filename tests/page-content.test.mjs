import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSchema, selectFeaturedProjects } from '../src/lib/page-content.ts';

test('普通页面只需要语义元数据，首页不能缺少其必需内容', () => {
  assert.equal(pageSchema.safeParse({ kind: 'page', title: '关于我', description: '学习方向' }).success, true);
  assert.equal(pageSchema.safeParse({ kind: 'page', title: ' ', description: '学习方向' }).success, false);
  const result = pageSchema.safeParse({ kind: 'home', title: '学习档案', description: '学习方向' });
  assert.equal(result.success, false);
  assert.ok(result.error.issues.some((issue) => issue.path[0] === 'featuredCourseIds'));
});

test('精选课程保留内容声明的顺序，直接使用公开来源的最新信息', () => {
  const projects = [{ id: 'os', title: '更新后的课程名' }, { id: 'gse', title: '生成式软件工程' }];
  const before = structuredClone(projects);
  const selected = selectFeaturedProjects(['gse', 'os'], projects);
  assert.deepEqual(selected.map((item) => item.id), ['gse', 'os']);
  assert.equal(selected[1], projects[0]);
  assert.equal(selected[1].title, '更新后的课程名');
  assert.deepEqual(projects, before);
});

test('不存在的精选课程明确报错，不能生成指向不存在课程的首页卡片', () => {
  assert.throws(() => selectFeaturedProjects(['missing-course'], []), /featuredCourseIds.*missing-course/);
});
