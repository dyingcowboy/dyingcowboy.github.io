import {
  loadArchive,
  publicTrajectories,
  readLocal,
  saveLocal,
  removeLocal,
  downloadArchive,
  showToast,
} from '../lib/archive';
import {
  escapeHtml as e,
  categoryLabels,
  checkpointLabels,
  sourceLabels,
  modelsOf,
  formatDate,
  messageCount,
  renderContent,
} from '../lib/presentation';
import { icon } from '../lib/icons';
import { siteTitle } from '../data/site';
import type { Trajectory, Message, Checkpoint, Category, Session } from '../lib/types';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const root = el('trajectory-detail');
const id = new URLSearchParams(location.search).get('id');
let current: Trajectory;
let isLocal = false;
let mode = 'all';
let query = '';
let toolsVisible = false;
let activeMessage = '';
const editDialog = el<HTMLDialogElement>('edit-dialog');
const checkpointDialog = el<HTMLDialogElement>('checkpoint-dialog');
const editForm = el<HTMLFormElement>('edit-form');
const checkpointForm = el<HTMLFormElement>('checkpoint-form');

function safeHref(value: string): boolean {
  if (/[\u0000-\u0020]/.test(value)) return false;
  if (value.startsWith('/') && !value.startsWith('//')) return true;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}
const isTool = (message: Message) => message.role === 'tool' || Boolean(message.toolName);
function checkpointHtml(checkpoint: Checkpoint): string {
  return `<div class="checkpoint-note"><span>${icon('flag', 12)}${checkpointLabels[checkpoint.kind]} · 我的回顾</span><h4>${e(checkpoint.title)}</h4>${checkpoint.body ? `<p>${e(checkpoint.body)}</p>` : ''}</div>`;
}
function provenanceHtml(session: Session): string {
  const p = session.provenance;
  if (!p) return '<p class="meta">来源版本未记录。</p>';
  return `<p class="meta">${e(p.format)}${p.formatVersion === null ? '' : ` · 格式 v${p.formatVersion}`} · 解析 v${p.parserVersion}</p>
    ${p.appVersion ? `<p class="meta">来源应用 ${e(p.appVersion)}</p>` : ''}
    ${p.lastSequence !== undefined ? `<p class="meta">已读取至事件 ${p.lastSequence}</p>` : ''}
    ${p.git?.commit ? `<p class="meta">来源仓库版本<br /><code>${e(p.git.commit)}</code></p>` : ''}
    ${p.sha256 ? `<p class="meta">原始文件指纹<br /><code>${e(p.sha256)}</code></p>` : ''}`;
}
function messageHtml(message: Message): string {
  const checkpoints = current.checkpoints.filter(
    (checkpoint) => checkpoint.messageId === message.id,
  );
  const tool = isTool(message);
  const date = message.timestamp
    ? new Intl.DateTimeFormat('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai',
      }).format(new Date(message.timestamp))
    : '';
  return `<article class="timeline-message ${message.role === 'user' ? 'is-user' : ''}" id="${e(message.id)}"><span class="timeline-dot"></span>
    <div class="message-header"><strong>${message.role === 'user' ? '我' : tool ? '工具操作' : 'AI'}</strong><span class="message-model">${e(message.model || (tool ? message.toolName || '' : message.role === 'assistant' ? '模型未记录' : ''))}</span><time>${date}</time><div class="message-tools"><button class="icon-button" data-mark="${e(message.id)}" aria-label="标记关键节点" title="标记关键节点">${icon('flag', 13)}</button><button class="icon-button" data-copy="${e(message.id)}" aria-label="复制此处链接" title="复制此处链接">${icon('link', 13)}</button></div></div>
    ${tool ? `<details class="tool-message"><summary>${icon('terminal', 13)}${e(message.toolName || '工具结果')}<span class="meta"> · 点击展开</span></summary><pre>${e(message.content)}</pre>${message.callId ? `<span class="meta">调用 ${e(message.callId)}</span>` : ''}</details>` : `<div class="message-content">${renderContent(message.content)}</div>`}
    ${checkpoints.map(checkpointHtml).join('')}</article>`;
}

function renderTimeline(): void {
  const normalized = query.toLocaleLowerCase().trim();
  const timeline = el('timeline');
  let count = 0;
  timeline.innerHTML = current.sessions
    .map((session, index) => {
      const messages = session.messages.filter((message) => {
        const checkpoints = current.checkpoints.filter(
          (checkpoint) => checkpoint.messageId === message.id,
        );
        if (mode === 'checkpoints' && !checkpoints.length) return false;
        if (isTool(message) && !toolsVisible && !normalized) return false;
        return (
          !normalized ||
          [
            message.content,
            ...checkpoints.flatMap((checkpoint) => [checkpoint.title, checkpoint.body]),
          ].some((text) => text.toLocaleLowerCase().includes(normalized))
        );
      });
      count += messages.length;
      if (!messages.length) return '';
      return `<div class="session-header">${icon('terminal', 13)}<span class="session-source">${sourceLabels[session.source]}</span><span>会话 ${index + 1}</span><time>${formatDate(session.startedAt)}</time></div>${messages.map(messageHtml).join('')}`;
    })
    .join('');
  if (!count)
    timeline.innerHTML = `<div class="timeline-empty">${mode === 'checkpoints' && !current.checkpoints.length ? '还没有关键节点。点击交互右侧的旗标，写下这一步带来的变化。' : '没有匹配的交互。试试其他关键词或查看全部交互。'}</div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((button) => {
    const active = button.dataset.view === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function render(): void {
  const sources = [...new Set(current.sessions.map((session) => sourceLabels[session.source]))];
  const tools = current.sessions.reduce(
    (total, session) => total + session.messages.filter(isTool).length,
    0,
  );
  const models = modelsOf(current);
  root.innerHTML = `<header class="detail-heading"><div class="detail-badges"><span class="badge">${categoryLabels[current.category]}<span class="meta-divider">/</span>${e(current.topic)}</span><span class="badge neutral">${current.status === 'completed' ? '已完成' : '进行中'}</span>${current.demo ? '<span class="tag demo-tag">演示轨迹</span>' : ''}<span class="tag">${isLocal ? '本地保存' : publicTrajectories.some((record) => record.id === current.id) ? '公开档案' : '本机同步'}</span></div>
    <h1 class="page-title">${e(current.title)}</h1><p class="page-intro">${e(current.description)}</p><div class="detail-meta"><span>${icon('clock', 13)}${formatDate(current.startedAt)}</span><span>${icon('terminal', 13)}${e(sources.join(' / '))}</span><span>${icon('route', 13)}${messageCount(current)} 条交互 · ${current.sessions.length} 段会话</span><span>${icon('flag', 13)}${current.checkpoints.length} 个关键节点</span></div></header>
    <div class="detail-actions"><button class="button" data-action="edit">${icon('edit', 14)}整理轨迹</button><button class="button" data-action="export">${icon('download', 14)}导出这一条</button>${isLocal ? `<button class="button ghost" data-action="delete">${icon('trash', 13)}移除本地副本</button>` : ''}</div>
    ${current.demo ? `<div class="notice detail-notice">${icon('note', 15)}<span>这是合成的功能演示，不是真实对话或能力证明。模型信息未作假设；导入真实会话后会按记录显示。</span></div>` : ''}
    <div class="detail-layout"><div class="trajectory-body"><div class="timeline-toolbar"><div class="view-tabs" role="group" aria-label="阅读模式"><button class="active" data-view="all" aria-pressed="true">全部交互</button><button data-view="checkpoints" aria-pressed="false">关键节点 <span class="meta">${current.checkpoints.length}</span></button></div><label class="check-label"><input id="show-tools" type="checkbox" ${toolsVisible ? 'checked' : ''} />显示工具操作${tools ? ` (${tools})` : ''}</label></div><label class="detail-search"><span class="sr-only">在这段轨迹中搜索</span>${icon('search', 15)}<input id="detail-search" data-archive-search type="search" placeholder="在这段轨迹中寻找一个问题…" value="${e(query)}" /></label><div id="timeline"></div></div>
    <aside class="detail-aside"><div class="aside-sticky"><section class="aside-section"><h2>这段轨迹</h2><div class="aside-property"><span>主题</span><strong>${e(current.topic)}</strong></div><div class="aside-property"><span>来源</span><strong>${e(sources.join(' / '))}</strong></div><div class="aside-property"><span>模型</span><strong>${e(models.join(' / ') || '未记录')}</strong></div><div class="aside-property"><span>最近交互</span><strong>${formatDate(current.updatedAt)}</strong></div><div class="tag-list">${current.tags.map((tag) => `<a class="tag" href="/trajectories/?q=${encodeURIComponent(tag)}">${e(tag)}</a>`).join('')}</div></section>
    <section class="aside-section"><h2>关键转折</h2><div class="checkpoint-index">${current.checkpoints.length ? current.checkpoints.map((checkpoint, index) => `<a href="#${encodeURIComponent(checkpoint.messageId)}" data-jump="${e(checkpoint.messageId)}"><span>${String(index + 1).padStart(2, '0')}</span>${e(checkpoint.title)}</a>`).join('') : '<span class="meta">留下一次理解的变化。</span>'}</div></section>
    ${
      current.links.length
        ? `<section class="aside-section"><h2>沉淀与成果</h2>${current.links
            .filter((link) => safeHref(link.href))
            .map(
              (link) =>
                `<a class="related-link" href="${e(link.href)}">${icon('note', 13)}${e(link.title)}${icon('upRight', 13)}</a>`,
            )
            .join('')}</section>`
        : ''
    }
    <section class="aside-section"><h2>原始来源</h2>${current.sessions.map((session) => `<details class="source-provenance"><summary>${e(sourceLabels[session.source])} · ${session.messages.length} 条记录</summary><p class="meta">会话 ID<br /><code>${e(session.id)}</code></p><p class="meta">模型：${e(session.models.join(' / ') || '未记录')}</p>${provenanceHtml(session)}${session.warnings.map((warning) => `<p class="source-warning">${e(warning)}</p>`).join('')}</details>`).join('')}</section></div></aside></div>`;
  root.setAttribute('aria-busy', 'false');
  document.title = siteTitle(current.title);
  el<HTMLInputElement>('show-tools').addEventListener('change', (event) => {
    toolsVisible = (event.target as HTMLInputElement).checked;
    renderTimeline();
  });
  el<HTMLInputElement>('detail-search').addEventListener('input', (event) => {
    query = (event.target as HTMLInputElement).value;
    renderTimeline();
  });
  renderTimeline();
}

function jump(messageId: string): void {
  mode = 'all';
  query = '';
  toolsVisible = true;
  el<HTMLInputElement>('detail-search').value = '';
  el<HTMLInputElement>('show-tools').checked = true;
  renderTimeline();
  const target = document.getElementById(messageId);
  if (target) {
    target.scrollIntoView({ block: 'center' });
    target.classList.add('message-target');
    setTimeout(() => target.classList.remove('message-target'), 2200);
  }
}

function fillForm(form: HTMLFormElement, values: Record<string, string>): void {
  for (const [name, value] of Object.entries(values)) {
    const field = form.elements.namedItem(name);
    if (
      field instanceof HTMLInputElement ||
      field instanceof HTMLTextAreaElement ||
      field instanceof HTMLSelectElement
    )
      field.value = value;
  }
}
async function persist(next: Trajectory): Promise<void> {
  await saveLocal([next]);
  current = next;
  isLocal = true;
  render();
}
root.addEventListener('click', async (event) => {
  const target = (event.target as Element).closest<HTMLElement>(
    '[data-action],[data-mark],[data-copy],[data-view],[data-jump]',
  );
  if (!target) return;
  if (target.dataset.view) {
    mode = target.dataset.view;
    renderTimeline();
  }
  if (target.dataset.jump) {
    event.preventDefault();
    history.replaceState(null, '', `#${encodeURIComponent(target.dataset.jump)}`);
    jump(target.dataset.jump);
  }
  if (target.dataset.copy) {
    const url = new URL(location.href);
    url.hash = encodeURIComponent(target.dataset.copy);
    try {
      await navigator.clipboard.writeText(url.href);
      showToast('已复制这段交互的定位链接。');
    } catch {
      history.replaceState(null, '', url);
      showToast('已定位到这段交互，可从地址栏复制链接。');
    }
  }
  if (target.dataset.mark) {
    activeMessage = target.dataset.mark;
    const existing = current.checkpoints.find(
      (checkpoint) => checkpoint.messageId === activeMessage,
    );
    fillForm(checkpointForm, {
      kind: existing?.kind ?? 'insight',
      title: existing?.title ?? '',
      body: existing?.body ?? '',
    });
    el('remove-checkpoint').hidden = !existing;
    el('checkpoint-error').hidden = true;
    checkpointDialog.showModal();
  }
  if (target.dataset.action === 'export') downloadArchive([current], `${current.id}.json`);
  if (target.dataset.action === 'delete') el<HTMLDialogElement>('delete-dialog').showModal();
  if (target.dataset.action === 'edit') {
    fillForm(editForm, {
      title: current.title,
      description: current.description,
      category: current.category,
      status: current.status,
      topic: current.topic,
      tags: current.tags.join(', '),
      links: current.links.map((link) => `${link.title} | ${link.href}`).join('\n'),
    });
    el('edit-error').hidden = true;
    editDialog.showModal();
  }
});
document
  .querySelectorAll('[data-close-dialog]')
  .forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close()));
editForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(editForm);
  try {
    const title = String(data.get('title') ?? '').trim();
    const topic = String(data.get('topic') ?? '').trim();
    if (!title || !topic) throw new Error('标题和主题不能为空。');
    const links = String(data.get('links') ?? '')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        const separator = line.indexOf('|');
        const title = line.slice(0, separator).trim();
        const href = line.slice(separator + 1).trim();
        if (separator < 0 || !title || !safeHref(href))
          throw new Error('关联成果请使用「标题 | /站内路径/」或「标题 | https://地址」。');
        return { title, href };
      });
    await persist({
      ...current,
      title,
      topic,
      description: String(data.get('description') ?? '').trim(),
      category: data.get('category') as Category,
      status: data.get('status') as 'ongoing' | 'completed',
      tags: [
        ...new Set(
          String(data.get('tags') ?? '')
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
      links,
    });
    editDialog.close();
    showToast('已保存你的整理。');
  } catch (error) {
    el('edit-error').textContent = error instanceof Error ? error.message : '保存失败。';
    el('edit-error').hidden = false;
  }
});
checkpointForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(checkpointForm);
  try {
    const title = String(data.get('title') ?? '').trim();
    if (!title) throw new Error('请写一句话说明这个节点。');
    const checkpoint: Checkpoint = {
      id: `checkpoint-${activeMessage}`,
      messageId: activeMessage,
      kind: data.get('kind') as Checkpoint['kind'],
      title,
      body: String(data.get('body') ?? '').trim(),
    };
    await persist({
      ...current,
      checkpoints: [
        ...current.checkpoints.filter((item) => item.messageId !== activeMessage),
        checkpoint,
      ],
    });
    checkpointDialog.close();
    showToast('已留下这个关键节点。');
  } catch (error) {
    el('checkpoint-error').textContent = error instanceof Error ? error.message : '保存失败。';
    el('checkpoint-error').hidden = false;
  }
});
el('remove-checkpoint').addEventListener('click', async () => {
  try {
    await persist({
      ...current,
      checkpoints: current.checkpoints.filter((item) => item.messageId !== activeMessage),
    });
    checkpointDialog.close();
    showToast('已移除标记。');
  } catch (error) {
    el('checkpoint-error').textContent = error instanceof Error ? error.message : '保存失败。';
    el('checkpoint-error').hidden = false;
  }
});
el('confirm-delete').addEventListener('click', async () => {
  try {
    await removeLocal(current.id);
    location.href = '/trajectories/';
  } catch (error) {
    showToast(error instanceof Error ? error.message : '移除失败。', true);
  }
});

async function initialize(): Promise<void> {
  try {
    const records = await loadArchive();
    const found = records.find((record) => record.id === id);
    if (!found) {
      root.setAttribute('aria-busy', 'false');
      root.innerHTML = `<div class="empty-state">${icon('route', 28)}<h2>还找不到这段轨迹</h2><p>它可能保存在另一个浏览器中。返回列表导入备份，即可继续阅读。</p><a class="button" href="/trajectories/">返回轨迹列表</a></div>`;
      return;
    }
    current = found;
    isLocal = (await readLocal()).some((record) => record.id === id);
    render();
    if (location.hash) {
      try {
        jump(decodeURIComponent(location.hash.slice(1)));
      } catch {
        /* A malformed fragment does not prevent reading the record. */
      }
    }
  } catch (error) {
    const found = publicTrajectories.find((record) => record.id === id);
    if (found) {
      current = found;
      render();
    } else {
      root.setAttribute('aria-busy', 'false');
      root.innerHTML = `<div class="empty-state"><h2>本地档案暂时无法读取</h2><p>${e(error instanceof Error ? error.message : '请刷新后重试。')}</p><a href="/trajectories/">返回列表</a></div>`;
    }
    showToast(error instanceof Error ? error.message : '本地存储不可用。', true);
  }
}
initialize();
