import { loadArchive, showToast } from '../lib/archive';
import { cardHtml } from '../lib/presentation';

loadArchive().then((records) => {
  const list = document.getElementById('recent-trajectories');
  if (list) list.innerHTML = records.slice(0, 4).map((record) => cardHtml(record)).join('');
  const notice = document.getElementById('home-archive-notice');
  if (notice && records.some((record) => !record.demo) && notice.dataset.localNotice) {
    notice.textContent = notice.dataset.localNotice;
  }
}).catch((error) => showToast(error instanceof Error ? error.message : '本地记录加载失败。', true));
