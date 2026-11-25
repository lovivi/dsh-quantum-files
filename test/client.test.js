'use strict'

/**
 * Client 平面单测：在假 DOM 里执行 client/bundle.js，
 * 验证它真的向 slots / sidebarRightTabs 做了注册，并且没抛异常。
 *
 * 这里不验证渲染效果（那要真浏览器），只验证"注册动作发生了、参数对"。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

/** 一个够用的假 React：createElement / hooks 桩。 */
function fakeReact() {
  const state = []
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    Fragment: 'Fragment',
  }
}

/**
 * 真实 slots 契约（抄自 dsh-web-frontend 的注册校验）：
 *   keyed → 必须有 options.key；list → 必须有 options.id；single → 都不需要。
 * 假 slots 也按这个校验，否则测试就测不出真实的注册错误。
 */
const SLOT_KINDS = {
  'conversation.view': 'custom', // 该槽自定义（用 id）
  'sidebar.right.pane.tab': 'keyed',
  'sidebar.right.pane.tab.title': 'keyed',
  'conversation.session.header.actions': 'list',
}

function validateSlotOptions(spec) {
  const kind = SLOT_KINDS[spec && spec.name] || 'custom'
  if (kind === 'keyed' && spec.key === undefined) {
    throw new Error(`keyed slot "${spec.name}" requires options.key`)
  }
  if (kind === 'list' && spec.id === undefined) {
    throw new Error(`list slot "${spec.name}" requires options.id`)
  }
}

function loadBundle() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'client', 'bundle.js'), 'utf8')
  const registrations = { loaded: null, slots: [], sidebar: null, injected: [] }
  const window = {
    __ModuleLoader__: {
      load: (entry) => {
        registrations.loaded = entry
      },
    },
    open: () => {},
    setTimeout,
  }

  // 执行 bundle：它只调用 window.__ModuleLoader__.load
  new Function('window', source)(window)
  assert.ok(registrations.loaded, 'bundle 应注册到 __ModuleLoader__')

  // 取 factory 并执行，拿到 plugin 模块
  const factory = registrations.loaded.factory
  const plugin = factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`意外的 platform module 请求: ${name}`)
  })

  // 假 ctx：记录注册调用
  const injected = registrations.injected
  const slots = {
    register: (spec, component) => {
      validateSlotOptions(spec)
      registrations.slots.push({ spec, component })
      return () => {}
    },
    inject: (name, cb) => {
      injected.push(name)
      cb()
      return () => {}
    },
  }
  const sidebarRightTabs = {
    register: (def) => {
      registrations.sidebar = def
      return () => {}
    },
  }
  const ctx = {
    get: (n) => ({ slots, sidebarRightTabs })[n],
    slots,
    sidebarRightTabs,
  }
  return { plugin, ctx, registrations }
}

test('bundle 结构：__ModuleLoader__ + id + factory', () => {
  const { registrations } = loadBundle()
  assert.equal(registrations.loaded.id, 'dsh-quantum-files')
  assert.equal(typeof registrations.loaded.factory, 'function')
})

test('plugin 声明 name / inject / apply', () => {
  const { plugin } = loadBundle()
  assert.equal(plugin.name, 'dsh-quantum-files')
  assert.deepEqual(plugin.inject, ['slots', 'sidebarRightTabs', 'sidebarRight'])
  assert.equal(typeof plugin.apply, 'function')
})

test('apply 注册 conversation.view tab', () => {
  const { plugin, ctx, registrations } = loadBundle()
  plugin.apply(ctx)
  const view = registrations.slots.find((s) => s.spec.name === 'conversation.view')
  assert.ok(view, '应注册 conversation.view')
  assert.equal(view.spec.id, 'dsh-quantum-files')
  assert.equal(view.spec.order, 27)
  assert.equal(view.spec.label(), '文件')
  assert.equal(typeof view.component, 'function')
})

test('apply 注册右侧栏 tab 类型与 body（含 guide 入口）', () => {
  const { plugin, ctx, registrations } = loadBundle()
  plugin.apply(ctx)

  const def = registrations.sidebar
  assert.ok(def, '应调用 sidebarRightTabs.register')
  assert.equal(def.kind, 'fbq-files')
  assert.equal(def.title(), '文件')
  assert.ok(Array.isArray(def.guide) && def.guide.length === 1, 'guide 里要有一个入口，否则用户点不到')
  assert.equal(def.guide[0].id, def.id, 'guide 入口 id 必须与类型 id 一致')

  const body = registrations.slots.find((s) => s.spec.name === 'sidebar.right.pane.tab')
  assert.ok(body, '应注册 sidebar.right.pane.tab body')
  assert.equal(body.spec.key, def.id, 'keyed 槽必须用 options.key 且等于类型 id')
  assert.equal(body.spec.id, undefined, 'keyed 槽不应传 id（真实框架会忽略/误导）')
})

test('apply 注册会话头部一键按钮，点击调用 sidebarRight.openTab', () => {
  const { plugin, ctx, registrations } = loadBundle()
  let openedKind = null
  const sidebarRight = {
    openTab: (kind) => {
      openedKind = kind
    },
  }
  const slots = {
    register: (spec, component) => {
      validateSlotOptions(spec)
      registrations.slots.push({ spec, component })
      return () => {}
    },
    inject: (n, cb) => {
      cb()
      return () => {}
    },
  }
  const fullCtx = { get: (n) => ({ slots, sidebarRight, sidebarRightTabs: ctx.sidebarRightTabs })[n], slots }
  plugin.apply(fullCtx)

  const header = registrations.slots.find((s) => s.spec.name === 'conversation.session.header.actions')
  assert.ok(header, '应注册会话头部动作')
  const Button = header.component
  const el = Button({})
  assert.equal(el.type, 'button')
  el.props.onClick()
  assert.equal(openedKind, 'fbq-files', '点击应打开 fbq-files 类型的右栏 tab')
})

test('缺少 sidebarRightTabs 时不影响对话区 tab', () => {
  const { plugin } = loadBundle()
  const registered = []
  const slots = {
    register: (spec) => {
      validateSlotOptions(spec)
      registered.push(spec.name)
      return () => {}
    },
    inject: (n, cb) => {
      cb()
      return () => {}
    },
  }
  const ctx = { get: (n) => (n === 'slots' ? slots : undefined), slots }
  assert.doesNotThrow(() => plugin.apply(ctx))
  assert.ok(registered.includes('conversation.view'), '对话区 tab 仍要注册')
})
