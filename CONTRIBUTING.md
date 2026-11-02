# 参与开发

日迹是一个 DSH 插件：给任务挂上截止日期，每天记一笔做过什么，随时翻回过去某一天看当时的样子。

这份文档写给想改代码的人。读完你应该能在自己机器上跑起来、改一处、看到效果，并且知道怎么发版。

## 代码地图

```
lib/index.js     宿主那一半：注册工具（priority_*），挂载路由和静态页
lib/api.js       HTTP 接口：/state /day /calendar /items ...
lib/store.js     一个 JSON 文件，原子写，进程内串行
lib/model.js     纯函数：分桶、统计、日视图。没有 IO，最好测
lib/client.js    浏览器那一半：侧边栏入口 + iframe 浮层
web/index.html   真正的界面，一个自包含的 HTML
locale/*.json    面板名（中/英）
cordis.patch.yml 装进 profile 时自动注册用
```

界面不在 `lib/` 里跑。`lib/client.js` 只负责把 `web/index.html` 装进一个同源 iframe，因为宿主切走面板会卸载 DOM，画布状态会丢。

**零依赖**。除了 `node:*`，什么都不 import。特别是不要 `import '@deepseek-ai/...'`——当前 DSH 里第三方插件解析不到这些包，导入阶段就会抛错，`apply()` 根本不会跑，表现是「装上了但没有工具」，很难查。

## 本地跑起来

两种方式，按你要不要改代码选。

### 只看效果：装发布版

```bash
pnpm add dsh-priority
```

然后在 profile 的 `cordis.patch.yml` 里加：

```yaml
- insert:
    - id: priority
      name: dsh-priority
      config:
        mountPrefix: /priority
        dataFile: ""
```

### 要改代码：链接源码

```bash
cd <你的 DSH profile 目录>/node_modules
ln -s /path/to/dsh-priority dsh-priority      # Windows 用 mklink /J
```

配置同上。这样改源码立刻生效，不用重装。

## 改完怎么生效

**宿主那一半（`lib/*.js` 除 client.js）**：热重载插件会在一两秒内重新挂载，不需要重启。

**浏览器那一半（`lib/client.js`、`web/index.html`）**：

- `web/index.html` 是每次请求读盘的，刷新页面就够
- `lib/client.js` 在宿主**启动时**读进内存，改完必须重启宿主

所以改界面优先改 `web/index.html`，改入口才动 `client.js`。

## 数据

一个文件：`~/.dsh/priority/tasks.json`（`dataFile` 可以改）。

```jsonc
{
  "schema": 2,
  "items": [{
    "id": "T1",
    "title": "季度复盘初稿",
    "due": "2026-11-02",        // 截止日，null 表示没有期限
    "status": "open",            // open | done | submitted | dropped
    "needsSubmit": true,         // 完成之后还要交出去吗
    "order": 1000,               // 只影响同一天内部的次序
    "doneAt": null,
    "submittedAt": null,
    "log": [{ "id": "lx8f2a", "at": "2026-10-26", "text": "读了两章" }]
  }]
}
```

几个约定：

- **`order` 只在同一个截止日内部有意义**。跨日期比大小没意义，日期已经排好了。
- **`log` 是一条条按日期排的过程记录**，不是任务的子步骤。
- **`done` 和 `submitted` 是两个状态**。写完但没交出去要能被提醒，所以不能合并成一个。
- 写入是「先写临时文件再 rename」，读之前会比对文件指纹，所以手工改 JSON 也能被读到。

## 提交

- 一个 PR 一件事，别混改动
- 提交信息写清楚「为什么」，不只是「改了什么」
- 改界面请附截图，改逻辑请说明怎么验的
- 新增状态字段或改数据格式，必须同时写迁移（`store.js` 里的 `migrate()`）

## 发版

版本号语义化：修 bug `patch`，加功能 `minor`，改数据格式或删接口 `major`。

```bash
npm version patch          # 或 minor / major
git push --follow-tags
```

推到 tag 之后 GitHub Actions 自动发布，用 OIDC 拿短期凭据，不碰任何 token。工作流在 `.github/workflows/publish.yml`。

发布权限不靠密码共享：npm 包上配了 Trusted Publisher，只认这个仓库、这个工作流名。换句话说，**往 main 合并 PR 就等于授权发布**，所以合并前请认真读代码。

## 许可

MIT。贡献进来就是 MIT。
