/**
 * dsh-priority — 按截止日期分组的事项视图，挂在 DSH 现有的 web server 上。
 *
 * 形态照 dsh-thoughtdag：不另起进程、不另开端口，复用宿主已有的 webServer，
 * 静态页面在 /priority/，接口在 /priority/api/。
 *
 * @module dsh-priority
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './store.js'
import { createApi } from './api.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = path.join(HERE, '..', 'web')

export const name = 'priority'
export const inject = ['webServer', 'tools']

const DEFAULTS = Object.freeze({
  mountPrefix: '/priority',
  dataFile: '',
})

/**
 * 配置解析。不要把这个函数导出成 Config —— 宿主会把名为 Config 的导出
 * 当成 schemastery schema 用（要 .validate），普通函数会在加载阶段炸掉。
 */
function resolveConfig(config) {
  const c = { ...DEFAULTS, ...(config ?? {}) }
  if (typeof c.mountPrefix !== 'string' || !c.mountPrefix.startsWith('/') || c.mountPrefix.length < 2)
    throw new Error('mountPrefix 必须以 / 开头且不是单个 /')
  if (c.mountPrefix.endsWith('/')) throw new Error('mountPrefix 不要以 / 结尾')
  if (c.dataFile !== '' && typeof c.dataFile !== 'string')
    throw new Error('dataFile 必须是绝对路径字符串，或留空使用默认位置')
  return c
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

/** 把 /priority/xxx 映射到 web/xxx，拒绝越界路径。 */
function staticHandler(prefix) {
  return async (req, res) => {
    const url = new URL(req.url, 'http://placeholder')
    let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || '/'
    if (rel.endsWith('/')) rel += 'index.html'
    const target = path.join(WEB_ROOT, rel)
    const root = path.resolve(WEB_ROOT) + path.sep
    if (!path.resolve(target).startsWith(root)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('越界路径')
    }
    try {
      const buf = await fs.readFile(target)
      res.writeHead(200, {
        'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        'content-length': buf.length,
      })
      res.end(buf)
    } catch (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        return res.end('没有这个文件：' + rel)
      }
      throw err
    }
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const prefix = config.mountPrefix
  const store = new Store(config.dataFile || undefined)
  const inner = createApi(store)
  const apiPrefix = prefix + '/api'
  const api = (req, res) => {
    if (!req.url.startsWith(apiPrefix)) {
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ error: '没有这个路由' }))
    }
    req.url = req.url.slice(apiPrefix.length) || '/'
    return inner(req, res)
  }
  const served = staticHandler(prefix)

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: prefix, handler: (_req, res) => {
      res.writeHead(302, { location: prefix + '/' })
      res.end()
    } }),
    'priority: redirect',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: apiPrefix, handler: api }),
    'priority: api',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: prefix, handler: served }),
    'priority: static',
  )

  // ── 给模型的工具（手写 JSON Schema，不 import @deepseek-ai/*）──
  const register = (def) => {
    try {
      ctx.effect(() => ctx.tools.register(def), 'priority: tool ' + def.name)
      return true
    } catch (error) {
      ctx.logger?.warn?.('[dsh-priority] 工具没注册上 ' + def.name + ': ' + (error?.message ?? error))
      return false
    }
  }
  const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }

  register({
    name: 'priority_add',
    description: '给用户的事项表加一条：标题 + 截止日期。用户说"记一下我要做 X，几号前"时用这个。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '事项标题' },
        due: { type: 'string', description: '截止日期 YYYY-MM-DD；不传表示没有期限' },
        startBy: { type: 'string', description: '引子：从这天起该开始留意，可选' },
        needsSubmit: { type: 'boolean', description: '需要提交/交出去的，完成后再提醒一次，可选' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const it = await store.add({
        title: args.title,
        due: args.due ?? null,
        startBy: args.startBy ?? null,
        needsSubmit: Boolean(args.needsSubmit),
      })
      return '已加入 ' + it.id + '：' + it.title + (it.due ? '（截止 ' + it.due + '）' : '（无期限）')
    },
  })

  register({
    name: 'priority_list',
    description: '列出用户的事项：按截止日期分组，带逾期/今天/待提交/该动手了的标记。想知道"现在该做什么"时用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOut,
    async execute() {
      return await store.digest()
    },
  })

  register({
    name: 'priority_finish',
    description: '把一件事标成完成。需要提交的事项会进入"待提交"，不会直接消失。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '条目 id，例如 T3' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const it = await store.finish(args.id)
      return it.status === 'done'
        ? it.title + ' 已完成，还需要提交（提交截止 ' + (it.submitDue ?? it.due ?? '未设') + '）'
        : it.title + ' 已完成。'
    },
  })

  register({
    name: 'priority_submit',
    description: '把已完成但还没交出去的事项标成已提交。用户说"那个已经交了"时用。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '条目 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const it = await store.submit(args.id)
      return it.title + ' 已标记为已提交。'
    },
  })

  register({
    name: 'priority_link_session',
    description: '把当前会话挂到某个事项上：以后在工作台里点一下就能回到这个会话继续。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id' },
        session_id: { type: 'string', description: '会话 id，默认当前会话' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args, exec) {
      const sid = args.session_id ?? exec?.agent?.session?.id
      if (!sid) return '拿不到会话 id：请在会话里调用，或显式传 session_id。'
      await store.linkSession(args.id, { id: sid })
      return '已把会话 ' + String(sid).slice(0, 12) + '… 挂到 ' + args.id + '。'
    },
  })

  register({
    name: 'priority_log',
    description: '给某项记一条过程：今天做了它的一部分。用户说"我今天写了引言"这类时用，会出现在到期那天的回放里。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id' },
        text: { type: 'string', description: '一句话，做了什么' },
        at: { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const it = await store.logTouch(args.id, args.text, args.at)
      return '已记在 ' + it.title + ' 名下（共 ' + it.log.length + ' 条）。'
    },
  })

  register({
    name: 'priority_remove',
    description: '删掉一条记错的事项。只用于"本来就不该存在"的，做不完了请用 priority_update status=dropped。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '条目 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      await store.remove(args.id)
      return '已删除 ' + args.id + '。'
    },
  })

  register({
    name: 'priority_unlog',
    description: '删掉某条记错的过程记录（"记一笔"写错了）。index 从 0 开始，指 priority_list 里那条的顺序。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '条目 id' },
        index: { type: 'number', description: '要删的记录序号，从 0 开始' },
        text: { type: 'string', description: '按内容匹配（index 没给时用）' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const item = (await store.read(), store.view().buckets.flatMap((b) => b.items).find((i) => i.id === args.id))
      if (!item) return '没有这条：' + args.id
      const log = Array.isArray(item.log) ? item.log : []
      if (!log.length) return '「' + item.title + '」没有过程记录。'
      let idx = args.index
      if (!Number.isInteger(idx)) {
        if (!args.text) return '给个 index，或者给 text 让我按内容找。'
        idx = log.findIndex((e) => String(e.text).includes(args.text))
        if (idx < 0) return '没找到包含「' + args.text + '」的记录。'
      }
      try {
        const outcome = await store.removeLog(args.id, { index: idx })
        return '已删掉「' + item.title + '」下的记录：' + outcome.removed.at + ' ' + outcome.removed.text
      } catch (error) {
        return error?.message ?? String(error)
      }
    },
  })

  register({
    name: 'priority_update',
    description: '改一条的标题、截止日期、引子日期或状态。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        due: { type: 'string', description: 'YYYY-MM-DD，传空字符串表示改成无期限' },
        startBy: { type: 'string' },
        status: { type: 'string', enum: ['open', 'done', 'submitted', 'dropped'] },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: textOut,
    async execute(args) {
      const patch = {}
      for (const k of ['title', 'due', 'startBy', 'status']) {
        if (args[k] !== undefined) patch[k] = args[k]
      }
      const it = await store.update(args.id, patch)
      return '已更新 ' + it.id + '：' + it.title
    },
  })

  ctx.logger?.info?.('[dsh-priority] 挂在 ' + prefix + '/，数据文件 ' + store.file)
}
