import { notesHtml, projectHtml, repositoryHtml, trajectorySummaryHtml } from '../lib/learning-presentation';
import type { LearningView, LearningNote } from '../lib/learning';
import { showToast } from '../lib/archive';

if (import.meta.env.DEV) {
  fetch('/__learning/view.json', { cache: 'no-store' }).then(async (response) => {
    if (response.status === 404) return;
    if (!response.ok) throw new Error('本机同步视图暂不可读，仍显示上一次公开快照。');
    const view = await response.json() as LearningView;
    const grid = document.querySelector('[data-learning-grid]');
    if (grid) grid.innerHTML = view.projects.map((project) => projectHtml(project, true)).join('');
    const detail = document.querySelector<HTMLElement>('[data-learning-detail]');
    if (detail) {
      const project = view.projects.find((item) => item.id === detail.dataset.learningDetail);
      if (project) {
        document.getElementById('learning-repositories')!.innerHTML = repositoryHtml(project);
        document.getElementById('learning-notes')!.innerHTML = notesHtml(view, project.id, true);
        document.getElementById('learning-trajectories')!.innerHTML = trajectorySummaryHtml(project, true);
        const warnings = document.getElementById('learning-warnings');
        if (warnings && project.warnings.length) {
          warnings.hidden = false;
          warnings.textContent = project.warnings.join('；');
        }
      }
    }
    const allNotes = document.querySelector('[data-learning-notes]');
    if (allNotes) allNotes.innerHTML = notesHtml(view, undefined, true);
    const status = document.querySelector('[data-learning-sync]');
    if (status) status.textContent = view.generatedAt ? `本机同步 · ${new Date(view.generatedAt).toLocaleString('zh-CN')}` : '等待首次同步';
  }).catch((error: Error) => showToast(error.message, true));

  const noteTarget = document.querySelector<HTMLElement>('[data-local-note]');
  if (noteTarget) {
    const id = new URLSearchParams(location.search).get('id');
    if (id) fetch(`/__learning/notes/${encodeURIComponent(id)}.json`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('这篇笔记尚未同步，或已不在选入范围内。');
      const note = await response.json() as LearningNote;
      document.getElementById('local-note-title')!.textContent = note.title;
      document.getElementById('local-note-source')!.textContent = `${note.repoId} / ${note.path} · ${note.commit?.slice(0, 10) ?? '未提交版本'}`;
      noteTarget.innerHTML = note.html ?? '';
      document.title = `${note.title} — Xuanshi Xi`;
    }).catch((error: Error) => { noteTarget.textContent = error.message; });
  }
}
