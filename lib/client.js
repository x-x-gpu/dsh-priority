// dsh-priority 客户端一半 —— 照 dsh-thoughtdag 的做法：
// 侧边栏加一个入口，点开在主栏打开画布。
//
// 画布本体是同源 iframe（/priority/），不写进 React 树：宿主 main 槽位每次切换
// 都会卸载组件，画布状态跟着丢。ThoughtDAG 的 lib/client.js 里记过这个坑。
//
// 宿主如果还没有 sidebar.panellist 槽位（老版本），就退回一个浮在聊天上方的
// 小胶囊按钮 + 全窗口覆盖层。

window.__ModuleLoader__.load({
  id: 'dsh-priority',
  factory: (require) => {
    const module = { exports: {} }

    let React = null
    try { React = require('react') } catch { React = null }

    module.exports.inject = ['slots', 'locale', 'layout', 'sessions']
    module.exports.apply = (ctx) => {
      const NS = 'dsh-priority'
      const PANEL_ID = 'priority'
      const MOUNT = '/priority/'

      // ── 样式表：宿主会按 data-plugin-css 认领，插件重载时自动清掉 ──
      const CSS_ID = 'dsh-priority/client.css'
      let style = document.head.querySelector('style[data-plugin-css="' + CSS_ID + '"]')
      if (!style) {
        style = document.createElement('style')
        style.setAttribute('data-plugin', NS)
        style.setAttribute('data-plugin-css', CSS_ID)
        document.head.append(style)
      }
      style.textContent = [
        '.dsh-pri-page{display:block;width:100%;height:100%;min-height:100%;box-sizing:border-box}',
        '.dsh-pri-overlay{position:fixed;z-index:100;background:#f7f6f3}',
        '.dsh-pri-overlay[hidden]{display:none}',
        '.dsh-pri-overlay iframe{display:block;width:100%;height:100%;border:0}',
        '.dsh-pri-overlay.dsh-pri-full{inset:var(--dsh-frame-top-clearance,0px) 0 0 0}',
        '.dsh-pri-pill{position:fixed;z-index:120;top:calc(var(--dsh-frame-top-clearance,0px) + 10px);right:18px;',
        'display:flex;align-items:center;gap:6px;border:1px solid #d1d5db;border-radius:999px;',
        'background:rgba(255,255,255,.96);padding:4px 12px;cursor:pointer;font:600 12px Inter,system-ui,sans-serif;',
        'color:#374151;backdrop-filter:blur(10px);-webkit-app-region:no-drag}',
        '.dsh-pri-pill:hover{background:#fff;border-color:#9ca3af}',
        '.dsh-pri-pill i{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3d63d6}',
        '.dsh-pri-pill[hidden]{display:none}',
      ].join('')

      // ── 覆盖层 + iframe ──
      let host = document.body.querySelector(':scope > [data-dsh-priority]')
      if (!host) {
        host = document.createElement('div')
        host.setAttribute('data-dsh-priority', '')
        document.body.append(host)
      }
      host.innerHTML =
        '<section class="dsh-pri-overlay" hidden><iframe title="日迹" data-src="' + MOUNT + '"></iframe></section>' +
        '<button type="button" class="dsh-pri-pill" hidden><i></i><span>日迹</span></button>'

      const overlay = host.querySelector('.dsh-pri-overlay')
      const frame = host.querySelector('iframe')
      const pill = host.querySelector('.dsh-pri-pill')

      // iframe 在第一次打开时才赋 src：藏在 display:none 里量出来的尺寸是 0×0，
      // 画布首屏会按 0 宽自适应，露出来时是空的。（同 ThoughtDAG 的 ensureSrc）
      const ensureSrc = () => { if (!frame.src) frame.src = frame.dataset.src }

      let pageEl = null

      // 占位 div 是空的，如果宿主的父容器是 fit-content（宽度由内容撑开），
      // 它量出来会很窄 —— 早期版本只按高度判断要不要往上爬，于是拿到一个
      // 600 来像素的宽度，画布只占左半屏。宽和高都要判，并且一路爬到
      // 明显更大的祖先为止。
      const MEASURED = new WeakSet()
      const place = () => {
        if (!pageEl) return
        let box = pageEl
        let r = box.getBoundingClientRect()
        for (let i = 0; i < 6; i++) {
          const wide = r.width >= 480
          const tall = r.height >= 240
          if (wide && tall) break
          const parent = box.parentElement
          if (!parent) break
          const pr = parent.getBoundingClientRect()
          // 祖先只有明显更大才采用，避免爬到整页（那样会把侧边栏也盖住）
          if (pr.width > r.width + 8 || pr.height > r.height + 8) {
            box = parent
            r = pr
          } else break
        }
        const pad = box === pageEl ? parseFloat(getComputedStyle(pageEl).paddingTop) || 0 : 0
        overlay.style.left = r.left + 'px'
        overlay.style.top = (r.top + pad) + 'px'
        overlay.style.width = r.width + 'px'
        overlay.style.height = Math.max(0, r.height - pad) + 'px'
        if (!MEASURED.has(box) && typeof ResizeObserver === 'function') {
          MEASURED.add(box)
          const ro = new ResizeObserver(() => place())
          ro.observe(box)
        }
      }

      const openPanel = (el) => {
        pageEl = el
        overlay.classList.add('dsh-pri-full')
        overlay.style.left = overlay.style.top = overlay.style.width = overlay.style.height = ''
        overlay.hidden = false
        ensureSrc()
        // 面板刚挂上时布局还没稳定（侧边栏可能还在动），量一次不够。
        // 头一秒内多量几次，之后就靠 ResizeObserver。
        place()
        for (const ms of [16, 60, 160, 400, 900]) window.setTimeout(() => { if (pageEl === el) place() }, ms)
      }
      const closePanel = () => { pageEl = null; overlay.hidden = true }

      // ── 面板模式：侧边栏入口 + 主栏页面 ──
      let panelMode = false
      let registered = false
      try {
        if (!React) throw new Error('宿主没有借出 React')
        const h = React.createElement

        // 侧边栏图标：一个坐标轴十字
        const PanelIcon = ({ size }) =>
          h('svg', { width: size ?? 16, height: size ?? 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
            h('rect', { x: 1.2, y: 1.2, width: 13.6, height: 13.6, rx: 3, fill: 'none', stroke: '#3d63d6', strokeWidth: 1.3 }),
            h('line', { x1: 8, y1: 3, x2: 8, y2: 13, stroke: '#3d63d6', strokeWidth: 1.1 }),
            h('line', { x1: 3, y1: 8, x2: 13, y2: 8, stroke: '#3d63d6', strokeWidth: 1.1 }),
            h('circle', { cx: 10.4, cy: 5.2, r: 1.5, fill: '#d34b45' }))

        // 主栏页面：只是占位，iframe 盖在它上面
        const PanelPage = () => {
          const ref = React.useRef(null)
          React.useEffect(() => {
            if (ref.current) openPanel(ref.current)
            return () => closePanel()
          }, [])
          return h('div', { ref, className: 'dsh-pri-page', 'data-pri-page': '' })
        }

        ctx.effect(
          () => ctx.locale.register(NS, { zh: { panel: '日迹' }, en: { panel: 'Traces' } }),
          'dsh-priority: dictionaries',
        )
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) }, PanelPage))
        ctx.slots.inject('sidebar.panellist', () => {
          const dispose = ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 40, locale: NS, label: () => t('panel') },
            PanelIcon,
          )
          registered = true
          return dispose
        })
        panelMode = true
      } catch (error) {
        console.warn('[dsh-priority] 面板入口不可用，改用浮层：', error)
        panelMode = false
      }

      // ── 退路：小胶囊 + 全窗口覆盖层 ──
      pill.addEventListener('click', () => {
        const showing = !overlay.hidden
        if (showing) { overlay.hidden = true; return }
        overlay.classList.add('dsh-pri-full')
        overlay.hidden = false
        ensureSrc()
        pill.textContent = '关闭'
      })
      window.addEventListener('message', (event) => {
        if (event.origin !== location.origin) return
        if (event.data?.source !== 'dsh-priority') return
        if (event.data.type === 'pri:close') {
          overlay.hidden = true
          if (panelMode) { try { ctx.layout.selectPanel(null) } catch { /* 宿主没有这个能力就算了 */ } }
          return
        }
        // 画布里的会话 chip：跳回那个会话继续干活
        if (event.data.type === 'pri:open-session' && typeof event.data.sessionId === 'string') {
          const open = ctx.sessions.open ?? ctx.sessions.select
          try {
            open.call(ctx.sessions, event.data.sessionId)
          } catch (error) {
            console.warn('[dsh-priority] 打不开会话：', error)
          }
        }
      })

      if (panelMode) {
        // 槽位要等宿主声明后才接受注册；2.5 秒还没注册上就当这个宿主没有面板列表
        window.setTimeout(() => {
          if (!registered) { pill.hidden = false; panelMode = false }
        }, 2500)
      } else {
        pill.hidden = false
      }

      window.addEventListener('resize', () => { if (!overlay.hidden && pageEl) place() })
    }

    return module.exports
  },
})
