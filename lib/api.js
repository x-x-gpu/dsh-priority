// api.js — 纯 HTTP，不碰 cordis。
//
//   GET    /state                 按日期分组的全部任务 + 统计
//   GET    /digest                给模型读的纯文本
//   GET    /calendar?from&to      每天计数，给月历格子用
//   GET    /day?date=YYYY-MM-DD   某一天的明细（到期 / 动过 / 完成 / 提交）
//   POST   /items                 { title, due?, startBy?, needsSubmit? }
//   PATCH  /items/:id             { title?, due?, note?, status?, needsSubmit? }
//   POST   /items/:id/finish      完成（需要提交的进"待提交"）
//   POST   /items/:id/submit      提交（done -> submitted）
//   POST   /items/:id/log         { text, at? }  今天做了它的一部分
//   DELETE /items/:id/log?logId=|index=  删掉一条记错的记录
//   POST   /items/:id/sessions    { sessionId, title? }  关联一个 DSH 会话
//   POST   /reorder               { due, ids: [] }  桶内重排
//   DELETE /items/:id
//   POST   /import
//
import { todayISO } from './model.js';

const MAX_BODY = 256 * 1024;

function send(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求体太大'), { status: 413 });
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/** 只接受本机来源的写操作。 */
function guardWrite(req) {
  const origin = req.headers.origin;
  if (!origin) return null;
  const host = req.headers.host ?? '';
  try {
    const o = new URL(origin);
    if (o.host === host) return null;
    if (/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(o.host)) return null;
  } catch { /* 落到下面拒绝 */ }
  return Object.assign(new Error('跨源写入被拒绝'), { status: 403 });
}

export function createApi(store) {
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://placeholder');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    try {
      if (method !== 'GET' && method !== 'HEAD') {
        const err = guardWrite(req);
        if (err) return send(res, err.status, { error: err.message });
      }

      if (method === 'GET' && path === '/state') {
        await store.read();
        return send(res, 200, store.view(todayISO()));
      }

      if (method === 'GET' && path === '/digest') {
        const text = await store.digest(todayISO());
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(text);
      }

      if (method === 'GET' && path === '/calendar') {
        const from = url.searchParams.get('from') ?? '';
        const to = url.searchParams.get('to') ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return send(res, 400, { error: '需要 from 和 to，格式 YYYY-MM-DD' });
        }
        return send(res, 200, { days: await store.calendar(from, to) });
      }

      if (method === 'GET' && path === '/day') {
        const date = url.searchParams.get('date') ?? '';
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return send(res, 400, { error: '需要 date=YYYY-MM-DD' });
        return send(res, 200, await store.day(date));
      }

      if (method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, file: store.file, schema: 2 });
      }

      if (method === 'POST' && path === '/items') {
        const body = await readJson(req);
        if (!body.title || !String(body.title).trim()) return send(res, 400, { error: 'title 不能为空' });
        return send(res, 201, await store.add(body));
      }

      const m = path.match(/^\/items\/([^/]+)(?:\/(finish|log|submit|sessions))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const action = m[2];
        if (action === 'finish' && method === 'POST') {
          await store.finish(id);
          await store.read();
          return send(res, 200, store.view(todayISO()));
        }
        if (action === 'submit' && method === 'POST') {
          await store.submit(id);
          await store.read();
          return send(res, 200, store.view(todayISO()));
        }
        if (action === 'sessions' && method === 'DELETE') {
          return send(res, 200, await store.unlinkSession(id, url.searchParams.get('sessionId')));
        }
        if (action === 'sessions' && method === 'POST') {
          const body = await readJson(req);
          const item = await store.linkSession(id, { id: body.sessionId, title: body.title });
          return send(res, 200, item);
        }
        if (action === 'log' && method === 'DELETE') {
          const logId = url.searchParams.get('logId') ?? undefined;
          const rawIndex = url.searchParams.get('index');
          const outcome = await store.removeLog(id, {
            logId,
            index: rawIndex === null ? undefined : Number(rawIndex),
          });
          await store.read();
          return send(res, 200, { removed: outcome.removed, view: store.view(todayISO()) });
        }
        if (action === 'log' && method === 'POST') {
          const body = await readJson(req);
          const item = await store.logTouch(id, body.text, body.at ?? todayISO());
          await store.read();
          return send(res, 200, { item, view: store.view(todayISO()) });
        }
        if (!action && method === 'PATCH') {
          return send(res, 200, await store.update(id, await readJson(req)));
        }
        if (!action && method === 'DELETE') {
          await store.remove(id);
          return send(res, 200, { ok: true });
        }
      }

      if (method === 'POST' && path === '/reorder') {
        const body = await readJson(req);
        if (!Array.isArray(body.ids)) return send(res, 400, { error: '需要 ids 数组' });
        await store.reorder(body.due ?? null, body.ids);
        await store.read();
        return send(res, 200, store.view(todayISO()));
      }

      if (method === 'POST' && path === '/import') {
        const body = await readJson(req);
        if (!Array.isArray(body.items)) return send(res, 400, { error: '需要 items 数组' });
        return send(res, 200, await store.replace(body));
      }

      return send(res, 404, { error: '没有这个路由：' + method + ' ' + path });
    } catch (err) {
      return send(res, err.status ?? 400, { error: err.message ?? String(err) });
    }
  };
}
