import { escapeHtml as e, formatDate } from './presentation';
import type { LearningProject, LearningView } from './learning';

const states = { ready: '已连接', partial: '部分可用', missing: '等待仓库', unconfigured: '待配置路径', error: '等待恢复' };
const safeHttps = (url: string | null) => url && /^https:\/\/[^\s@]+$/i.test(url) ? url : null;

export function projectHtml(project: LearningProject, local = false): string {
  return `<article class="learning-card" data-learning-project="${e(project.id)}">
    <div class="learning-card-top"><span class="eyebrow">${project.status === 'active' ? '正在推进' : '暂时搁置'}</span><span class="tag">${states[project.state]}</span></div>
    <h2><a href="/learning/${encodeURIComponent(project.id)}/">${e(project.title)}</a></h2>
    <p>${e(project.description)}</p>
    <div class="learning-counts"><span>${project.repositories.length} 个仓库</span><span>${project.noteIds.length} 篇笔记</span><span>${local ? `${project.sessionCount} 段本机会话` : project.sessionCount ? `${project.sessionCount} 段公开会话` : '公开精选待整理'}</span></div>
    <a class="learning-open" href="/learning/${encodeURIComponent(project.id)}/">查看课程记录 →</a>
  </article>`;
}

export function repositoryHtml(project: LearningProject): string {
  if (!project.repositories.length) return '<p class="page-intro">课程已列入当前学习计划。确认本机仓库路径后，即可关联笔记和会话。</p>';
  return project.repositories.map((repo) => {
    const remote = safeHttps(repo.remoteUrl);
    return `<article class="repo-row"><div><strong>${e(repo.id)}</strong>${remote ? `<a href="${e(remote)}" target="_blank" rel="noreferrer">查看仓库 ↗</a>` : ''}</div><div class="repo-meta"><span>${repo.state === 'ready' ? e(repo.branch ?? '游离版本') : '仓库暂不可读'}</span><code>${e(repo.commit?.slice(0, 10) ?? '尚无版本')}</code>${repo.dirty ? '<span class="tag">有未提交修改</span>' : ''}</div></article>`;
  }).join('');
}

export function notesHtml(view: LearningView, projectId?: string, local = false): string {
  const notes = view.notes.filter((note) => !projectId || note.projectId === projectId);
  if (!notes.length) return '<p class="page-intro">还没有选入的个人笔记。课程讲义与个人笔记分别保留。</p>';
  return notes.map((note) => {
    const href = local && !note.html ? `/learning/local-note/?id=${encodeURIComponent(note.id)}` : `/learning/notes/${encodeURIComponent(note.id)}/`;
    return `<article class="archive-item"><div class="archive-title"><a href="${href}">${e(note.title)}</a><small class="learning-note-source">${e(note.repoId)} / ${e(note.path)}${note.modified ? ' · 含未提交修改' : ''}</small></div><time class="archive-date">${formatDate(note.observedAt, true)}</time></article>`;
  }).join('');
}

export function trajectorySummaryHtml(project: LearningProject, local = false): string {
  if (!local) return project.sessionCount
    ? `<p class="page-intro">已公开 ${project.sessionCount} 段整理后的会话。</p><a class="button" href="/trajectories/?category=study&topic=${encodeURIComponent(project.title)}&hideDemo=1">浏览公开轨迹 →</a>`
    : '<p class="page-intro">完整对话保存在本机。整理后的公开轨迹会在这里展示。</p>';
  return `<p class="page-intro">已归档 ${project.sessionCount} 段会话，来自 ${e(project.models.join('、') || '尚未记录的模型')}。内容仅在本机预览中可见。</p><a class="button" href="/trajectories/?category=study&topic=${encodeURIComponent(project.title)}">检索这门课的轨迹 →</a>`;
}
