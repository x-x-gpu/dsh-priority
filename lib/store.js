// store.js — 一个 JSON 文件，原子写，进程内串行。
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { todayISO, group, stats, digest, calendarRange, dayDetail } from './model.js';

export const SCHEMA = 2;

const empty = () => ({
  schema: SCHEMA,
  updated: new Date().toISOString(),
  items: [],
  log: [],
});

export class Store {
  #file;
  #data = null;
  #stamp = null;          // 文件指纹（mtime:size），外部改过就重读
  #queue = Promise.resolve();

  constructor(file) {
    this.#file = file ?? path.join(os.homedir(), '.dsh', 'priority', 'tasks.json');
  }

  get file() { return this.#file; }

  read() { return this.#serial(() => this.#load()); }

  #serial(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async #load() {
    // 有人（备份恢复、手工编辑、别的进程）改过文件 → 丢掉缓存重读
    if (this.#data && (await this.#fingerprint()) !== this.#stamp) this.#data = null;
    if (this.#data) return this.#data;
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      const parsed = JSON.parse(raw);
      this.#data = migrate(parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        const aside = this.#file + '.corrupt-' + Date.now();
        await fs.rename(this.#file, aside).catch(() => {});
        console.error('[priority] tasks.json 解析失败，已移到 ' + aside);
      }
      this.#data = empty();
    }
    this.#stamp = await this.#fingerprint();
    return this.#data;
  }

  async #fingerprint() {
    try {
      const st = await fs.stat(this.#file);
      return st.mtimeMs + ':' + st.size;
    } catch {
      return 'missing';
    }
  }

  async #commit() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    this.#data.updated = new Date().toISOString();
    const tmp = this.#file + '.tmp-' + process.pid;
    await fs.writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
    await fs.rename(tmp, this.#file);
    this.#stamp = await this.#fingerprint();
  }

  // ---------- 读 ----------

  view(today = todayISO()) {
    const d = this.#data ?? empty();
    const items = d.items ?? [];
    const buckets = group(items, today);
    return { today, updated: d.updated, buckets, stats: stats(buckets), count: items.length };
  }

  async digest(today = todayISO()) {
    await this.#serial(() => this.#load());
    return digest(this.#data.items ?? [], today);
  }

  /** 某个月/某段日期的每天计数。 */
  async calendar(from, to, today = todayISO()) {
    await this.#serial(() => this.#load());
    return calendarRange(this.#data.items ?? [], from, to);
  }

  /** 某一天的明细：那天到期的、那天动过的、那天完成的。 */
  async day(date, today = todayISO()) {
    await this.#serial(() => this.#load());
    return dayDetail(this.#data.items ?? [], date);
  }

  // ---------- 写 ----------

  add(input) {
    return this.#serial(async () => {
      await this.#load();
      const items = this.#data.items;
      const due = normDate(input.due);
      const order = Number.isFinite(input.order) ? input.order : nextOrder(items, due);
      const item = {
        id: input.id ?? nextId(items),
        title: String(input.title ?? '').trim() || '未命名',
        due,
        startBy: normDate(input.startBy),
        needsSubmit: Boolean(input.needsSubmit),
        submitDue: normDate(input.submitDue),
        status: 'open',
        order,
        created: new Date().toISOString(),
        doneAt: null,
        submittedAt: null,
        droppedAt: null,
        note: input.note ?? '',
        log: [],
        sessions: [],
      };
      items.push(item);
      this.#audit('add', { id: item.id, title: item.title, due: item.due });
      await this.#commit();
      return item;
    });
  }

  update(id, patch) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      const before = it.status;
      for (const k of ['title', 'note']) {
        if (typeof patch[k] === 'string') it[k] = patch[k];
      }
      for (const k of ['due', 'startBy', 'submitDue']) {
        if (patch[k] !== undefined) it[k] = normDate(patch[k]);
      }
      if (patch.needsSubmit !== undefined) it.needsSubmit = Boolean(patch.needsSubmit);
      if (Number.isFinite(patch.order)) it.order = patch.order;
      if (patch.status !== undefined) {
        it.status = patch.status;
        // 三种终止时间各自留痕，回看时才分得清"做完"和"放弃"
        if (patch.status === 'done' && !it.doneAt) it.doneAt = new Date().toISOString();
        if (patch.status === 'submitted' && !it.submittedAt) it.submittedAt = new Date().toISOString();
        if (patch.status === 'dropped' && !it.droppedAt) it.droppedAt = new Date().toISOString();
        if (patch.status === 'open') { it.doneAt = null; it.submittedAt = null; it.droppedAt = null; }
      }
      this.#audit('update', { id, from: before, to: it.status });
      await this.#commit();
      return it;
    });
  }

  /** 完成：需要提交的进入待提交，否则直接 submitted。 */
  finish(id) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      it.status = it.needsSubmit ? 'done' : 'submitted';
      it.doneAt = it.doneAt ?? new Date().toISOString();
      if (it.status === 'submitted') it.submittedAt = new Date().toISOString();
      this.#audit('finish', { id, status: it.status });
      await this.#commit();
      return it;
    });
  }

  /** 提交：完成之后真正交出去。done -> submitted。 */
  submit(id) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      it.status = 'submitted';
      it.submittedAt = it.submittedAt ?? new Date().toISOString();
      it.doneAt = it.doneAt ?? it.submittedAt;
      this.#audit('submit', { id });
      await this.#commit();
      return it;
    });
  }

  /** 关联一个 DSH 会话：任务详情里能直接跳过去。 */
  linkSession(id, session) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      const sid = String(session?.id ?? '').trim();
      if (!sid) throw httpError(400, '需要会话 id');
      if (!Array.isArray(it.sessions)) it.sessions = [];
      if (it.sessions.some((x) => x.id === sid)) return it;
      it.sessions.push({
        id: sid,
        title: String(session?.title ?? '').slice(0, 80),
        at: new Date().toISOString(),
      });
      this.#audit('link-session', { id, session: sid });
      await this.#commit();
      return it;
    });
  }

  /** 解除挂载只移除事项里的关联，保留原对话。 */
  unlinkSession(id, sessionId) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw httpError(400, '需要会话 id');
      it.sessions = (it.sessions ?? []).filter((session) => session.id !== sessionId);
      this.#audit('unlink-session', { id, session: sessionId });
      await this.#commit();
      return it;
    });
  }

  /** 加一条日志：今天做了它的一部分。 */
  logTouch(id, text, at = todayISO()) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      const body = String(text ?? '').trim();
      if (!body) throw httpError(400, '记录不能是空的');
      if (!Array.isArray(it.log)) it.log = [];
      it.log.push({
        id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        at: String(at).slice(0, 10),
        text: body,
        addedAt: new Date().toISOString(),
      });
      it.log.sort((a, b) => a.at.localeCompare(b.at) || a.addedAt.localeCompare(b.addedAt));
      this.#audit('log', { id, at, text: body });
      await this.#commit();
      return it;
    });
  }

  /** 删掉一条记错的记录。按 logId 删；老数据没有 id 时按当前顺序的序号删。 */
  removeLog(id, { logId, index } = {}) {
    return this.#serial(async () => {
      await this.#load();
      const it = this.#data.items.find((i) => i.id === id);
      if (!it) throw httpError(404, '没有这个 id：' + id);
      if (!Array.isArray(it.log) || !it.log.length) throw httpError(400, '这条没有记录');
      let k = -1;
      if (logId) k = it.log.findIndex((e) => e.id === logId);
      else if (Number.isInteger(index)) k = index;
      if (k < 0 || k >= it.log.length) throw httpError(404, '找不到这条记录');
      const [gone] = it.log.splice(k, 1);
      this.#audit('unlog', { id, at: gone.at, text: gone.text });
      await this.#commit();
      return { removed: gone, item: it };
    });
  }

  /** 桶内重排：把 ids 按给定顺序写回 order。 */
  reorder(due, ids) {
    return this.#serial(async () => {
      await this.#load();
      const key = due ?? 'infinity';
      const bucket = this.#data.items.filter((i) => (i.due ?? 'infinity') === key);
      const byId = new Map(bucket.map((i) => [i.id, i]));
      const seen = new Set();
      let cursor = 0;
      for (const id of ids) {
        const it = byId.get(id);
        if (!it || seen.has(id)) continue;
        it.order = cursor++;
        seen.add(id);
      }
      // 没在 ids 里出现的，接在后面
      for (const it of bucket) {
        if (!seen.has(it.id)) it.order = cursor++;
      }
      this.#audit('reorder', { due: key, ids });
      await this.#commit();
      return bucket.length;
    });
  }

  remove(id) {
    return this.#serial(async () => {
      await this.#load();
      const before = this.#data.items.length;
      this.#data.items = this.#data.items.filter((i) => i.id !== id);
      if (this.#data.items.length === before) throw httpError(404, '没有这个 id：' + id);
      this.#audit('remove', { id });
      await this.#commit();
    });
  }

  replace(payload) {
    return this.#serial(async () => {
      await this.#load();
      const items = (payload.items ?? []).map((i, k) => ({
        id: String(i.id ?? 'T' + (k + 1)),
        title: String(i.title ?? '未命名').trim() || '未命名',
        due: normDate(i.due),
        startBy: normDate(i.startBy),
        needsSubmit: Boolean(i.needsSubmit),
        submitDue: normDate(i.submitDue),
        status: ['open', 'done', 'submitted', 'dropped'].includes(i.status) ? i.status : 'open',
        order: Number.isFinite(i.order) ? i.order : k,
        created: i.created ?? new Date().toISOString(),
        doneAt: i.doneAt ?? null,
        submittedAt: i.submittedAt ?? null,
        droppedAt: i.droppedAt ?? null,
        note: i.note ?? '',
        log: Array.isArray(i.log) ? i.log : [],
        sessions: Array.isArray(i.sessions) ? i.sessions : [],
      }));
      this.#data.items = items;
      this.#audit('import', { items: items.length });
      await this.#commit();
      return { items: items.length };
    });
  }

  /** 导出成 Obsidian 能直接打开的 md 目录内容。 */
  async exportMarkdown(today = todayISO()) {
    await this.#serial(() => this.#load());
    const files = [];
    const safe = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
    for (const it of this.#data.items) {
      const lines = ['---'];
      lines.push('id: ' + it.id);
      if (it.due) lines.push('due: ' + it.due);
      if (it.startBy) lines.push('startBy: ' + it.startBy);
      lines.push('status: ' + it.status);
      if (it.created) lines.push('created: ' + it.created.slice(0, 10));
      if (it.doneAt) lines.push('doneAt: ' + it.doneAt.slice(0, 10));
      if (it.submittedAt) lines.push('submittedAt: ' + it.submittedAt.slice(0, 10));
      lines.push('---', '', '# ' + it.title, '');
      if (it.note) lines.push(it.note, '');
      if (it.log && it.log.length) {
        lines.push('## 过程', '');
        for (const e of it.log) lines.push('- ' + e.at + '  ' + e.text);
        lines.push('');
      }
      files.push({ name: safe(it.title) + '.md', body: lines.join('\n') });
    }
    // 一份每日流水
    const byDay = new Map();
    for (const it of this.#data.items) {
      for (const e of it.log ?? []) {
        if (!byDay.has(e.at)) byDay.set(e.at, []);
        byDay.get(e.at).push(it.title + '：' + e.text);
      }
    }
    const days = [...byDay.keys()].sort();
    const daily = ['# 工作流水', '', '导出日：' + today, ''];
    for (const d of days) {
      daily.push('## ' + d, '');
      for (const line of byDay.get(d)) daily.push('- ' + line);
      daily.push('');
    }
    files.push({ name: '_流水.md', body: daily.join('\n') });
    return files;
  }

  #audit(action, payload) {
    if (!Array.isArray(this.#data.log)) this.#data.log = [];
    this.#data.log.push({ at: new Date().toISOString(), action, ...payload });
    if (this.#data.log.length > 2000) this.#data.log = this.#data.log.slice(-2000);
  }
}

/** 老 schema（deadline/prior/comparisons 那版）搬过来，尽量不丢数据。 */
function migrate(raw) {
  if (!raw || typeof raw !== 'object') return empty();
  if (raw.schema === SCHEMA) return { ...empty(), ...raw, log: raw.log ?? [] };
  const items = (raw.items ?? []).map((i, k) => ({
    id: i.id ?? 'T' + (k + 1),
    title: i.title ?? '未命名',
    due: normDate(i.deadline ?? i.due),
    startBy: null,
    needsSubmit: false,
    submitDue: null,
    status: i.done ? 'submitted' : (i.status === 'dropped' ? 'dropped' : 'open'),
    order: k,
    created: i.created ?? new Date().toISOString(),
    doneAt: i.done ? (i.created ?? null) : null,
    submittedAt: i.done ? (i.created ?? null) : null,
    droppedAt: null,
    note: i.note ?? '',
    log: Array.isArray(i.log) ? i.log : [],
    sessions: [],
  }));
  return { schema: SCHEMA, updated: new Date().toISOString(), items, log: [] };
}

function normDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function nextOrder(items, due) {
  const key = due ?? 'infinity';
  const same = items.filter((i) => (i.due ?? 'infinity') === key);
  return same.reduce((m, i) => Math.max(m, Number.isFinite(i.order) ? i.order : -1), -1) + 1;
}

function nextId(items) {
  let n = 1;
  const used = new Set(items.map((i) => i.id));
  while (used.has('T' + n)) n += 1;
  return 'T' + n;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
