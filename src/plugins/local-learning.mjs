import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const loopback = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// A narrow local preview API: no filesystem path is accepted from a request.
export function learningMiddleware(stateFile) {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/__learning/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host ?? '';
    const origin = req.headers.origin;
    if (!loopback.has(req.socket.remoteAddress) || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)
      || (origin && origin !== `http://${host}`) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.statusCode = 403;
      return res.end('Local preview only');
    }
    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      return res.end();
    }
    try {
      const state = JSON.parse(await readFile(stateFile, 'utf8'));
      const url = new URL(req.url, `http://${host}`);
      let result;
      if (url.pathname === '/__learning/archive.json') result = state.archive;
      else if (url.pathname === '/__learning/view.json') {
        const { projects, notes, generatedAt, version, projectionVersion } = state.view;
        result = { projects, generatedAt, version, projectionVersion, notes: notes.map(({body, html, ...note}) => note) };
      } else {
        const match = url.pathname.match(/^\/__learning\/notes\/([^/]+)\.json$/);
        if (match) result = state.view.notes.find((note) => note.id === decodeURIComponent(match[1]));
      }
      if (!result) { res.statusCode = 404; return res.end(); }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = error.code === 'ENOENT' ? 404 : 503;
      res.end('Learning snapshot unavailable');
    }
  };
}

export default function localLearning() {
  let timer;
  let closed = false;
  const dispose = () => { closed = true; clearInterval(timer); };
  return {
    name: 'local-learning-preview',
    apply: 'serve',
    closeBundle: dispose,
    async configureServer(server) {
      const outputDir = path.join(projectRoot, 'local-data/learning');
      server.middlewares.use(learningMiddleware(path.join(outputDir, 'state.json')));
      if (process.env.LEARNING_SYNC === '0') return;
      const [{syncLearning}, {renderLearningNote}] = await Promise.all([
        import('../lib/learning-sync.mjs'), import('../lib/learning-markdown.mjs'),
      ]);
      let running = false;
      const sync = async () => {
        if (running) return;
        running = true;
        try {
          const config = JSON.parse(await readFile(path.join(projectRoot, 'learning.config.json'), 'utf8'));
          const result = await syncLearning({
            config,
            learningRoot: process.env.LEARNING_ROOT ?? path.join(os.homedir(), 'Dev/Learning'),
            codexRoots: [path.join(os.homedir(), '.codex/sessions'), path.join(os.homedir(), '.codex/archived_sessions')],
            deepseekRoots: [path.join(os.homedir(), '.dsh/sessions')],
            outputDir,
            publicFile: path.join(projectRoot, 'src/data/learning.json'),
            renderNote: renderLearningNote,
          });
          if (result.errors.length) server.config.logger.warn(`[learning] ${result.errors.length} 项未能更新，保留可用快照。`);
        } catch {
          server.config.logger.warn('[learning] 本次同步未完成，保留上次快照。运行 npm run sync:learning 查看详情。');
        } finally { running = false; }
      };
      await sync();
      if (closed) return;
      timer = setInterval(sync, 30_000);
      timer.unref();
      server.httpServer?.once('close', dispose);
    },
  };
}
