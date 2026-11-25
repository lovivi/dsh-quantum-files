'use strict'

/**
 * dsh-fbq-bridge — Client 平面
 *
 * 三个入口，都指向同一个 FBQ（同源 iframe /-/fbq/）：
 *   1) 右侧栏 tab 类型（kind = fbq-files）+ guide 卡片「文件 (FBQ)」
 *   2) 会话头部动作按钮「文件」—— 一键把右栏打开到 FBQ
 *   3) 对话区 view tab（全宽，适合当主文件管理器用）
 *
 * 零依赖：React 走 platform module（window.__ModuleLoader__ 的 require("react")）。
 */

const BASE_PATH = '/-/fbq'
const TAB_ID = 'dsh-fbq-bridge'
const SIDEBAR_ID = 'dsh-fbq-bridge.sidebar'
const SIDEBAR_KIND = 'fbq-files'
const LABEL = '文件'
const ORDER = 27

const btnStyle = {
  font: 'inherit',
  padding: '2px 8px',
  borderRadius: 6,
  border: '1px solid var(--dsw-border, rgba(127,127,127,.35))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
}

/** FBQ 的 iframe 面板。compact 用于窄容器（右侧栏）。 */
function FbqFrame(props) {
  const compact = Boolean(props && props.compact)
  const [nonce, setNonce] = React.useState(0)
  const [expanded, setExpanded] = React.useState(false)
  const [loaded, setLoaded] = React.useState(false)

  const reload = React.useCallback(() => {
    setLoaded(false)
    setNonce((n) => n + 1)
  }, [])
  const openExternal = React.useCallback(() => {
    window.open(`${BASE_PATH}/`, '_blank', 'noopener,noreferrer')
  }, [])
  const toggleExpand = React.useCallback(() => setExpanded((v) => !v), [])

  const toolbar = React.createElement(
    'div',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: compact ? 4 : 8,
        padding: compact ? '4px 6px' : '6px 10px',
        borderBottom: '1px solid var(--dsw-border, rgba(127,127,127,.25))',
        fontSize: 12,
        flex: '0 0 auto',
      },
    },
    React.createElement('span', { style: { opacity: 0.7 } }, compact ? 'FBQ' : 'FileBrowser Quantum'),
    React.createElement('span', { style: { flex: 1 } }),
    React.createElement('button', { type: 'button', onClick: reload, title: '重新加载', style: btnStyle }, '刷新'),
    React.createElement('button', { type: 'button', onClick: openExternal, title: '在新窗口打开', style: btnStyle }, '新窗口'),
    React.createElement(
      'button',
      { type: 'button', onClick: toggleExpand, title: '全屏 / 还原', style: btnStyle },
      expanded ? '还原' : '全屏',
    ),
  )

  const frame = React.createElement('iframe', {
    key: nonce,
    src: `${BASE_PATH}/`,
    title: 'FileBrowser Quantum',
    onLoad: () => setLoaded(true),
    allow: 'clipboard-read; clipboard-write; fullscreen',
    style: {
      flex: '1 1 auto',
      width: '100%',
      height: '100%',
      border: '0',
      display: 'block',
      background: 'var(--dsw-surface, #fff)',
      opacity: loaded ? 1 : 0.35,
      transition: 'opacity .15s ease',
    },
  })

  const shellStyle = expanded
    ? {
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--dsw-surface, #fff)',
      }
    : { display: 'flex', flexDirection: 'column', width: '100%', height: '100%' }

  return React.createElement('div', { style: shellStyle }, toolbar, frame)
}

/** 会话头部的一键按钮。 */
function makeOpenButton(onOpen) {
  return function OpenFilesButton() {
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: onOpen,
        title: '在右侧栏打开 FileBrowser Quantum',
        style: { ...btnStyle, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' },
      },
      '📁',
      React.createElement('span', { style: { fontSize: 12 } }, LABEL),
    )
  }
}

module.exports = {
  name: TAB_ID,
  inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
  apply(ctx) {
    const get = (n) => (ctx.get ? ctx.get(n) : ctx[n])
    const slots = get('slots')
    if (!slots || typeof slots.register !== 'function') {
      console.warn('[dsh-fbq-bridge] slots 不可用，界面未注册')
      return
    }

    const openSidebar = () => {
      const sr = get('sidebarRight')
      if (sr && typeof sr.openTab === 'function') {
        try {
          sr.openTab(SIDEBAR_KIND)
          return
        } catch (e) {
          console.warn('[dsh-fbq-bridge] 打开右侧栏失败:', e && e.message)
        }
      }
      console.warn('[dsh-fbq-bridge] sidebarRight 不可用，请用对话区「文件」tab')
    }

    // ── 1) 对话区 view tab（全宽）─────────────────────────────────────────
    const registerView = () =>
      slots.register(
        { name: 'conversation.view', id: TAB_ID, order: ORDER, label: () => LABEL },
        (props) => React.createElement(FbqFrame, props),
      )
    if (typeof slots.inject === 'function') slots.inject('conversation.view', registerView)
    else registerView()

    // ── 2) 右侧栏 tab 类型 + body ────────────────────────────────────────
    const registry = get('sidebarRightTabs')
    if (registry && typeof registry.register === 'function') {
      try {
        registry.register({
          id: SIDEBAR_ID,
          kind: SIDEBAR_KIND,
          title: () => LABEL,
          guide: [
            {
              id: SIDEBAR_ID,
              order: 20,
              title: () => `${LABEL} (FBQ)`,
              description: () => '用 FileBrowser Quantum 浏览/管理文件',
            },
          ],
        })
        console.log('[dsh-fbq-bridge] 右侧栏 tab 类型已注册 (kind=%s)', SIDEBAR_KIND)
      } catch (e) {
        console.warn('[dsh-fbq-bridge] 右侧栏 tab 类型注册失败:', e && e.message)
      }

      // body 是 keyed 槽：选项必须是 key（不是 id），key 取类型定义自己的 id
      try {
        slots.register({ name: 'sidebar.right.pane.tab', key: SIDEBAR_ID }, () =>
          React.createElement(FbqFrame, { compact: true }),
        )
        console.log('[dsh-fbq-bridge] 右侧栏 body 已注册 (key=%s)', SIDEBAR_ID)
      } catch (e) {
        console.warn('[dsh-fbq-bridge] 右侧栏 body 注册失败:', e && e.message)
      }
    } else {
      console.warn('[dsh-fbq-bridge] sidebarRightTabs 不可用，仅提供对话区 tab')
    }

    // ── 3) 会话头部一键按钮 ──────────────────────────────────────────────
    const registerHeader = () =>
      slots.register(
        { name: 'conversation.session.header.actions', id: `${TAB_ID}.header`, order: 12 },
        makeOpenButton(openSidebar),
      )
    if (typeof slots.inject === 'function') slots.inject('conversation.session.header.actions', registerHeader)
    else {
      try {
        registerHeader()
      } catch (e) {
        console.warn('[dsh-fbq-bridge] 头部按钮注册失败:', e && e.message)
      }
    }
  },
}
