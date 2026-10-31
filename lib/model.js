// model.js — 纯逻辑，无 IO。日期分桶 + 桶内次序。
//
// 这一版砍掉了 Bradley-Terry / 重要性分数 / 紧急度公式。理由写在 README：
// 那些东西解决的是"全局排序"，而实际流程里日期已经把全局顺序排好了，
// 你只需要在同一天的任务之间表态。

export const STATUS = ['open', 'done', 'submitted', 'dropped'];

/** 今天的本地日期 YYYY-MM-DD。 */
export function todayISO(now = new Date()) {
  const off = now.getTimezoneOffset();
  return new Date(now.getTime() - off * 60000).toISOString().slice(0, 10);
}

/** to - from 的天数。两个都按 UTC 零点算，避开夏令时和时区坑。 */
export function daysBetween(fromISO, toISO) {
  const a = Date.parse(String(fromISO).slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(String(toISO).slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

export function addDays(iso, n) {
  const t = Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z');
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/** 桶的键：截止日期，没有截止日期归到 infinity。 */
export function bucketKeyOf(item) {
  return item.due ? String(item.due).slice(0, 10) : 'infinity';
}

/** 有效状态：完成但没提交的，仍然算"没做完"。 */
export function effective(item) {
  if (item.status === 'open' && item.log && item.log.length) return 'open';
  return item.status;
}

/** 一条任务相对今天的处境。 */
export function summarize(item, today) {
  const due = item.due ? String(item.due).slice(0, 10) : null;
  const daysLeft = due ? daysBetween(today, due) : null;
  const log = Array.isArray(item.log) ? item.log : [];
  const lastTouch = log.length ? log[log.length - 1].at : null;
  const open = item.status === 'open';
  return {
    daysLeft,
    overdue: open && due !== null && daysLeft < 0,
    dueToday: open && daysLeft === 0,
    dueSoon: open && daysLeft !== null && daysLeft >= 0 && daysLeft <= 2,
    // 引子到期：该动手了
    kickoff: open && Boolean(item.startBy) && daysBetween(today, String(item.startBy).slice(0, 10)) <= 0,
    // 完成了但还没交出去
    pendingSubmit: item.status === 'done',
    logCount: log.length,
    lastTouch,
    // 多久没碰过（只对进行中的有意义）
    quietDays: open && lastTouch ? daysBetween(String(lastTouch).slice(0, 10), today) : null,
  };
}

/**
 * 把 items 分组成按日期排序的桶。
 * 顺序：逾期的在前 → 今天 → 未来升序 → infinity 最后
 */
export function group(items, today) {
  const map = new Map();
  for (const it of items) {
    const key = bucketKeyOf(it);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }

  // 幽灵：今天或之后动过别的日期的任务 → 在那一天摆一个虚拟方框。
  // 过去的动过记录不进列表（去「日历」看），否则历史会把列表撑爆。
  const ghosts = new Map();
  for (const it of items) {
    const due = bucketKeyOf(it);
    for (const e of Array.isArray(it.log) ? it.log : []) {
      const day = String(e.at ?? '').slice(0, 10);
      if (!day || day === due) continue;
      if (day < today) continue;           // 只看今天及以后
      if (!ghosts.has(day)) ghosts.set(day, []);
      ghosts.get(day).push({
        taskId: it.id,
        title: it.title,
        due: it.due ? String(it.due).slice(0, 10) : null,
        text: e.text,
        at: day,
        status: it.status,
      });
    }
  }

  const buckets = [];
  for (const [key, list] of map) {
    list.sort((a, b) => {
      const oa = Number.isFinite(a.order) ? a.order : 1e9;
      const ob = Number.isFinite(b.order) ? b.order : 1e9;
      if (oa !== ob) return oa - ob;
      return String(a.created ?? '').localeCompare(String(b.created ?? ''));
    });
    buckets.push({
      key,
      date: key === 'infinity' ? null : key,
      items: list.map((it) => ({ ...it, ...summarize(it, today) })),
      ghosts: ghosts.get(key) ?? [],
    });
    ghosts.delete(key);
  }

  // 只有幽灵的日期（今天动了后面的任务，但当天没有到期任务）
  for (const [day, list] of ghosts) {
    buckets.push({ key: day, date: day, items: [], ghosts: list });
  }

  buckets.sort((a, b) => {
    if (a.key === 'infinity') return 1;
    if (b.key === 'infinity') return -1;
    return a.key.localeCompare(b.key);
  });

  return buckets;
}

/** 一份给模型/摘要用的统计。 */
export function stats(buckets) {
  let open = 0, overdue = 0, dueToday = 0, dueSoon = 0, pendingSubmit = 0, kickoff = 0, done = 0, dropped = 0;
  for (const b of buckets) {
    for (const it of b.items) {
      if (it.status === 'open') open += 1;
      else if (it.status === 'done') { done += 1; pendingSubmit += 1; }
      else if (it.status === 'submitted') done += 1;
      else if (it.status === 'dropped') dropped += 1;
      if (it.overdue) overdue += 1;
      if (it.dueToday) dueToday += 1;
      if (it.dueSoon) dueSoon += 1;
      if (it.kickoff) kickoff += 1;
    }
  }
  return { open, overdue, dueToday, dueSoon, pendingSubmit, kickoff, done, dropped };
}

/** 纯文本摘要，给助手读。 */
export function digest(items, today) {
  const buckets = group(items, today);
  const s = stats(buckets);
  if (!buckets.length) return '还没有任务。';
  const lines = [];
  for (const b of buckets) {
    const label = b.date === null ? '以后（无期限）' : b.date;
    const live = b.items.filter((it) => it.status !== 'dropped');
    if (!live.length) continue;
    lines.push('【' + label + '】');
    for (const it of live) {
      const bits = [it.title];
      if (it.status === 'done') bits.push('（已完成，待提交）');
      else if (it.status === 'submitted') bits.push('（已提交）');
      else if (it.status === 'dropped') bits.push('（已放弃）');
      if (it.overdue) bits.push('逾期 ' + Math.abs(it.daysLeft) + ' 天');
      else if (it.dueToday) bits.push('今天到期');
      else if (it.daysLeft !== null) bits.push('还有 ' + it.daysLeft + ' 天');
      if (it.kickoff) bits.push('该动手了');
      if (it.logCount) bits.push('碰过 ' + it.logCount + ' 次');
      lines.push('  ' + bits.join(' '));
    }
  }
  const head = [
    s.open + ' 件进行中',
    s.overdue ? s.overdue + ' 件逾期' : '',
    s.dueToday ? s.dueToday + ' 件今天到期' : '',
    s.pendingSubmit ? s.pendingSubmit + ' 件完成待提交' : '',
    s.kickoff ? s.kickoff + ' 件该动手了' : '',
  ].filter(Boolean).join('，');
  return head + '\n' + lines.join('\n');
}


// ---------- 日历：按天回看 ----------

const dayOf = (v) => (v ? String(v).slice(0, 10) : null);

/** 那一天的计数，用于月历格子。 */
export function dayStats(items, date) {
  let due = 0, touch = 0, done = 0, submitted = 0, created = 0;
  for (const it of items) {
    if (dayOf(it.due) === date) due += 1;
    if (dayOf(it.created) === date) created += 1;
    if (dayOf(it.doneAt) === date) done += 1;
    if (dayOf(it.submittedAt) === date) submitted += 1;
    for (const e of Array.isArray(it.log) ? it.log : []) {
      if (dayOf(e.at) === date) touch += 1;
    }
  }
  return { date, due, touch, done, submitted, created, total: due + touch + done + submitted + created };
}

/** 一段日期里每一天的计数（含没有事件的空日）。 */
export function calendarRange(items, from, to) {
  const days = [];
  let cursor = String(from).slice(0, 10);
  const end = String(to).slice(0, 10);
  let guard = 0;
  while (cursor <= end && guard++ < 400) {
    days.push(dayStats(items, cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

/**
 * 某一天的明细。
 * 任务的「当时状态」由 doneAt / submittedAt 与当天比较推出来：
 * 那天还没完成 → 进行中；那天之后才完成 → 那天仍在进行中。
 */
export function dayDetail(items, date) {
  const d = String(date).slice(0, 10);
  const due = [], touches = [], done = [], submitted = [], created = [];

  for (const it of items) {
    const title = it.title;
    const dueDay = dayOf(it.due);
    if (dueDay === d) {
      due.push({
        id: it.id,
        title,
        // 那一天它完成了没有：doneAt 存在且 <= 当天 → 当时已完成
        finishedThen: Boolean(it.doneAt) && dayOf(it.doneAt) <= d,
        status: it.status,
      });
    }
    if (dayOf(it.created) === d) created.push({ id: it.id, title });
    if (dayOf(it.doneAt) === d) done.push({ id: it.id, title });
    if (dayOf(it.submittedAt) === d) submitted.push({ id: it.id, title });

    for (const e of Array.isArray(it.log) ? it.log : []) {
      if (dayOf(e.at) === d) {
        touches.push({
          id: it.id,
          title,
          text: e.text,
          due: dueDay,
          // 那天它离截止还有几天
          daysLeftThen: dueDay ? daysBetween(d, dueDay) : null,
        });
      }
    }
  }

  const sortByTitle = (a, b) => a.title.localeCompare(b.title, 'zh');
  due.sort(sortByTitle);
  touches.sort(sortByTitle);
  return { date: d, due, touches, done, submitted, created, stats: dayStats(items, d) };
}
