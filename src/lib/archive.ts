import publicData from '../data/trajectories.json';
import type { Trajectory } from './types';
import { mergeTrajectory } from './merge';

export const publicTrajectories = publicData.trajectories as Trajectory[];

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('xuanshi-trajectories', 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore('trajectories', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地档案。请检查浏览器是否允许本地存储。'));
    request.onblocked = () => reject(new Error('本地档案正在另一标签页中使用，请刷新后再试。'));
  });
}

export async function readLocal(): Promise<Trajectory[]> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('trajectories', 'readonly');
      const request = transaction.objectStore('trajectories').getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('读取本地轨迹失败，请刷新后重试。'));
    });
  } finally {
    db.close();
  }
}

export async function saveLocal(trajectories: Trajectory[]): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('trajectories', 'readwrite');
      const store = transaction.objectStore('trajectories');
      for (const trajectory of trajectories) store.put(trajectory);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('保存失败。本地空间可能不足，请先导出备份。'));
      transaction.onabort = () => reject(new Error('保存未完成，原有档案未改动。'));
    });
  } finally {
    db.close();
  }
}

export async function removeLocal(id: string): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('trajectories', 'readwrite');
      transaction.objectStore('trajectories').delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error('删除失败，请重试。'));
    });
  } finally {
    db.close();
  }
}

export async function loadArchive(): Promise<Trajectory[]> {
  // Human annotations remain local; newer source events still flow into the view.
  const records = new Map((await readLocal()).map((trajectory) => [trajectory.id, trajectory]));
  const incoming = [...publicTrajectories];
  if (import.meta.env.DEV) {
    try {
      const response = await fetch('/__learning/archive.json', { cache: 'no-store' });
      if (response.ok) {
        const archive = await response.json() as { version: number; trajectories: Trajectory[] };
        if (archive.version !== 1 || !Array.isArray(archive.trajectories)) throw new Error('本机同步档案格式不可读。');
        incoming.push(...archive.trajectories);
      } else if (response.status !== 404) throw new Error('本机同步档案暂不可读，仍显示已保存的内容。');
    } catch (error) {
      showToast(error instanceof Error ? error.message : '本机同步暂不可读。', true);
    }
  }
  for (const trajectory of incoming) {
    const local = records.get(trajectory.id);
    records.set(trajectory.id, local ? mergeTrajectory(local, trajectory) : trajectory);
  }
  return [...records.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

export function downloadArchive(trajectories: Trajectory[], filename = 'trajectories.json'): void {
  const blob = new Blob([JSON.stringify({ version: 1, trajectories }, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function showToast(message: string, error = false): void {
  const region = document.getElementById('toast');
  if (!region) return;
  region.textContent = message;
  region.classList.toggle('is-error', error);
  region.hidden = false;
  window.setTimeout(
    () => {
      if (region.textContent === message) region.hidden = true;
    },
    error ? 10000 : 4500,
  );
}
