import type { Category, Trajectory } from './types';
import { icon } from './icons';

export const categoryLabels: Record<Category, string> = {
  project: '项目',
  study: '学习',
  knowledge: '思考',
};
export const sourceLabels = { codex: 'Codex', deepseek: 'DeepSeek harness' };
export const checkpointLabels = {
  question: '提出问题',
  decision: '作出选择',
  insight: '理解转折',
  verification: '完成验证',
};
export const escapeHtml = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
export const trajectoryUrl = (id: string) => `/trajectories/view/?id=${encodeURIComponent(id)}`;
export function formatDate(value: string | null, short = false): string {
  if (!value || Number.isNaN(new Date(value).valueOf())) return '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    year: short ? undefined : 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'Asia/Shanghai',
  }).format(new Date(value));
}
export function modelsOf(trajectory: Trajectory): string[] {
  return [...new Set(trajectory.sessions.flatMap((session) => session.models))];
}
export function messageCount(trajectory: Trajectory): number {
  return trajectory.sessions.reduce(
    (count, session) =>
      count + session.messages.filter((message) => message.role !== 'tool').length,
    0,
  );
}
export function cardHtml(trajectory: Trajectory, query = ''): string {
  const source = [
    ...new Set(trajectory.sessions.map((session) => sourceLabels[session.source])),
  ].join(' / ');
  const body = trajectory.sessions
    .flatMap((session) => session.messages)
    .find(
      (message) => query && message.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
  let excerpt = '';
  if (body && query) {
    const start = Math.max(
      0,
      body.content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) - 30,
    );
    excerpt = `<p class="search-excerpt">${start ? '…' : ''}${escapeHtml(body.content.slice(start, start + 130))}</p>`;
  }
  return `<article class="trajectory-card" data-trajectory-id="${escapeHtml(trajectory.id)}">
    <div class="card-eyebrow"><span class="category-dot ${trajectory.category}"></span><span>${categoryLabels[trajectory.category]}<span class="meta-divider">/</span>${escapeHtml(trajectory.topic)}</span><span class="card-date">${formatDate(trajectory.updatedAt, true)}</span></div>
    <h3><a href="${trajectoryUrl(trajectory.id)}${body ? `#${encodeURIComponent(body.id)}` : ''}">${escapeHtml(trajectory.title)}</a>${icon('upRight', 17)}</h3>
    <p class="card-description">${escapeHtml(trajectory.description)}</p>${excerpt}
    <div class="tag-list">${trajectory.tags
      .slice(0, 3)
      .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
      .join('')}${trajectory.demo ? '<span class="tag demo-tag">演示</span>' : ''}</div>
    <div class="card-footer"><span>${icon('terminal', 14)}${escapeHtml(source || '未记录来源')}</span><span>${icon('route', 14)}${messageCount(trajectory)} 条交互<span class="status-mini ${trajectory.status}">${trajectory.status === 'completed' ? '已完成' : '进行中'}</span></span></div>
  </article>`;
}

export function renderContent(content: string): string {
  return content
    .split(/(```[\s\S]*?```)/g)
    .map((part) => {
      if (part.startsWith('```')) {
        const lines = part.slice(3, -3).split('\n');
        const language = lines.shift() ?? '';
        return `<div class="message-code"><span>${escapeHtml(language || 'code')}</span><pre><code>${escapeHtml(lines.join('\n'))}</code></pre></div>`;
      }
      return `<div class="message-text">${escapeHtml(part.trim()).replace(/`([^`\n]+)`/g, '<code>$1</code>')}</div>`;
    })
    .join('');
}
