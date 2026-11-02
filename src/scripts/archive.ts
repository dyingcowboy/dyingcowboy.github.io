import { parseImport } from '../lib/importers.mjs';
import {
  loadArchive,
  publicTrajectories,
  readLocal,
  saveLocal,
  downloadArchive,
  showToast,
} from '../lib/archive';
import { cardHtml, escapeHtml, modelsOf } from '../lib/presentation';
import { mergeTrajectory } from '../lib/merge';
import type { Category, Trajectory } from '../lib/types';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const search = element<HTMLInputElement>('archive-search');
const source = element<HTMLSelectElement>('source-filter');
const model = element<HTMLSelectElement>('model-filter');
const status = element<HTMLSelectElement>('status-filter');
const hideDemos = element<HTMLInputElement>('hide-demos');
const dialog = element<HTMLDialogElement>('import-dialog');
const fileInput = element<HTMLInputElement>('import-files');
const importTarget = element<HTMLSelectElement>('import-target');
let records: Trajectory[] = publicTrajectories;
let category = ['project', 'study', 'knowledge'].includes(params.get('category') ?? '')
  ? params.get('category')!
  : '';
let topic = params.get('topic') ?? '';
search.value = params.get('q') ?? '';
source.value = params.get('source') ?? '';
status.value = params.get('status') ?? '';
hideDemos.checked = params.get('hideDemo') === '1';

function render(): void {
  const query = search.value.trim().toLocaleLowerCase();
  const visible = records.filter((record) => {
    if (category && record.category !== category) return false;
    if (topic && record.topic !== topic) return false;
    if (source.value && !record.sessions.some((session) => session.source === source.value))
      return false;
    if (model.value && !modelsOf(record).includes(model.value)) return false;
    if (status.value && record.status !== status.value) return false;
    if (hideDemos.checked && record.demo) return false;
    if (!query) return true;
    const searchable = [
      record.title,
      record.description,
      record.topic,
      ...record.tags,
      ...modelsOf(record),
      ...record.sessions.flatMap((session) => session.messages.map((message) => message.content)),
      ...record.checkpoints.flatMap((checkpoint) => [checkpoint.title, checkpoint.body]),
    ];
    return searchable.some((value) => value.toLocaleLowerCase().includes(query));
  });
  element('archive-results').innerHTML = visible
    .map((record) => cardHtml(record, search.value.trim()))
    .join('');
  element('archive-empty').hidden = visible.length > 0;
  element('result-count').textContent =
    `${visible.length} 条轨迹${visible.some((record) => record.demo) ? ` · 含 ${visible.filter((record) => record.demo).length} 条演示` : ''}`;
  document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) => {
    const active = button.dataset.category === category;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    const count = button.querySelector('span');
    if (count)
      count.textContent = String(
        records.filter(
          (record) =>
            (!button.dataset.category || record.category === button.dataset.category) &&
            (!hideDemos.checked || !record.demo),
        ).length,
      );
  });
  document.querySelectorAll<HTMLAnchorElement>('[data-nav-path]').forEach((link) => {
    const active =
      link.dataset.navPath === '/trajectories/'
        ? !category
        : Boolean(link.dataset.navCategory && link.dataset.navCategory === category);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  const topicNotice = element('active-topic');
  topicNotice.hidden = !topic;
  topicNotice.textContent = `当前主题：${topic}`;
  const next = new URLSearchParams();
  for (const [key, value] of Object.entries({
    category,
    topic,
    q: search.value.trim(),
    source: source.value,
    model: model.value,
    status: status.value,
    hideDemo: hideDemos.checked ? '1' : '',
  }))
    if (value) next.set(key, value);
  history.replaceState(null, '', `${location.pathname}${next.size ? `?${next}` : ''}`);
}

function updateOptions(): void {
  const selected = model.value || params.get('model') || '';
  const models = [...new Set(records.flatMap(modelsOf))].sort();
  model.innerHTML =
    '<option value="">全部模型</option>' +
    models
      .map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
      .join('');
  model.value = models.includes(selected) ? selected : '';
  importTarget.innerHTML =
    '<option value="">每段会话单独建一条轨迹</option>' +
    records
      .filter((record) => !record.demo)
      .map(
        (record) =>
          `<option value="${escapeHtml(record.id)}">接到：${escapeHtml(record.title)}</option>`,
      )
      .join('');
}

function reset(): void {
  search.value = '';
  source.value = '';
  model.value = '';
  status.value = '';
  category = '';
  topic = '';
  hideDemos.checked = false;
  render();
}
function openImport(): void {
  updateOptions();
  dialog.showModal();
}
document.querySelectorAll<HTMLButtonElement>('[data-category]').forEach((button) =>
  button.addEventListener('click', () => {
    category = button.dataset.category ?? '';
    topic = '';
    render();
  }),
);
search.addEventListener('input', render);
for (const filter of [source, model, status, hideDemos]) filter.addEventListener('change', render);
element('reset-filters').addEventListener('click', reset);
element('empty-reset').addEventListener('click', reset);
element('open-import').addEventListener('click', openImport);
document
  .querySelectorAll('[data-close-dialog]')
  .forEach((button) => button.addEventListener('click', () => dialog.close()));
fileInput.addEventListener('change', () => {
  element('selected-files').textContent =
    Array.from(fileInput.files ?? [])
      .map((file) => file.name)
      .join('、') || '可以一次导入多个文件';
});
const drop = element('file-drop');
drop.addEventListener('dragover', (event) => {
  event.preventDefault();
  drop.classList.add('dragging');
});
drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
drop.addEventListener('drop', (event) => {
  event.preventDefault();
  drop.classList.remove('dragging');
  if (event.dataTransfer?.files.length) {
    fileInput.files = event.dataTransfer.files;
    fileInput.dispatchEvent(new Event('change'));
  }
});

element('import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = element<HTMLButtonElement>('import-submit');
  const errorRegion = element('import-error');
  errorRegion.hidden = true;
  submit.disabled = true;
  submit.textContent = '正在解析…';
  try {
    const files = Array.from(fileInput.files ?? []);
    if (!files.length) throw new Error('请先选择记录文件。');
    const imported: Trajectory[] = [];
    for (const file of files) {
      if (file.size > 16 * 1024 * 1024)
        throw new Error(`${file.name} 超过当前浏览器单文件导入的 16 MB 上限。`);
      try {
        imported.push(...parseImport(new Uint8Array(await file.arrayBuffer()), file.name));
      } catch (error) {
        throw new Error(`${file.name}：${error instanceof Error ? error.message : '无法读取记录'}`);
      }
    }
    const pickedCategory = element<HTMLSelectElement>('import-category').value as Category | '';
    const pickedTopic = element<HTMLInputElement>('import-topic').value.trim();
    const current = new Map(records.map((record) => [record.id, record]));
    const updated = new Map<string, Trajectory>();
    const targetId = importTarget.value;
    for (const incoming of imported) {
      let next: Trajectory;
      const id = targetId || incoming.id;
      const previous = updated.get(id) ?? current.get(id);
      next = previous ? mergeTrajectory(previous, incoming) : incoming;
      if (pickedCategory) next = { ...next, category: pickedCategory };
      if (pickedTopic) next = { ...next, topic: pickedTopic };
      updated.set(next.id, next);
    }
    await saveLocal([...updated.values()]);
    records = await loadArchive();
    updateOptions();
    category = '';
    topic = '';
    search.value = '';
    source.value = '';
    model.value = '';
    status.value = '';
    hideDemos.checked = true;
    render();
    dialog.close();
    element<HTMLFormElement>('import-form').reset();
    element('selected-files').textContent = '可以一次导入多个文件';
    showToast(`已保存 ${updated.size} 条本地轨迹，原始会话文件未改动。`);
  } catch (error) {
    errorRegion.textContent =
      error instanceof Error ? error.message : '导入失败，请检查文件后重试。';
    errorRegion.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = '导入并保存';
  }
});

element('export-records').addEventListener('click', async () => {
  try {
    const local = await readLocal();
    if (!local.length) {
      showToast('当前没有本地记录。先导入一段会话，或在轨迹详情中保存整理。');
      return;
    }
    downloadArchive(local);
    showToast(`已导出 ${local.length} 条本地轨迹。`);
  } catch (error) {
    showToast(error instanceof Error ? error.message : '导出失败。', true);
  }
});

const shouldOpen = params.has('import');
loadArchive()
  .then((archive) => {
    records = archive;
    updateOptions();
    render();
    if (shouldOpen) openImport();
    if (params.has('search')) search.focus();
  })
  .catch((error) => {
    updateOptions();
    render();
    showToast(error instanceof Error ? error.message : '本地记录读取失败。', true);
  });
