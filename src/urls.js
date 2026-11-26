'use strict'

/**
 * dsh-quantum-files — FBQ 地址构造
 *
 * FBQ 的浏览器路由是 /files/<source>/<path>，**必须带来源名**；少了来源名会落到
 * "You don't have permissions to access this."（实测）。路径是相对来源根目录的。
 *
 * 给定会话 cwd，选前缀最长的那个来源；cwd 不在任何来源下时退回第一个来源 + 完整路径，
 * 让 FBQ 自己给出权限提示，而不是把用户送到一个必然 404 的地址。
 */

function normalizeRoot(p) {
  const s = String(p || '/')
  if (s.length > 1 && s.endsWith('/')) return s.slice(0, -1)
  return s || '/'
}

function encodePath(p) {
  return String(p || '')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
}

/**
 * @param {string} basePath 例如 /-/fbq
 * @param {Array<{name:string,path:string}>} sources 已解析的来源
 * @param {string} cwd 会话工作目录（绝对路径，可为空）
 * @returns {string} 可直接放进 iframe 的地址
 */
function filesUrlForCwd(basePath, sources, cwd) {
  const list = Array.isArray(sources) && sources.length ? sources : []
  if (!cwd || !list.length) {
    const first = list.length ? encodeURIComponent(list[0].name) : ''
    return `${basePath}/files/${first ? first + '/' : ''}`
  }

  let best = null
  for (const src of list) {
    const root = normalizeRoot(src.path)
    if (root === '/') {
      if (!best || best.root === null) best = { src, root: '/', rel: cwd }
      continue
    }
    if (cwd === root || cwd.startsWith(root + '/')) {
      const rel = cwd.slice(root.length) || ''
      if (!best || best.root === null || root.length > best.root.length) best = { src, root, rel }
    }
  }

  if (!best) {
    // cwd 不在任何来源下：用第一个来源 + 完整路径，让 FBQ 自己报权限
    const first = list[0]
    return `${basePath}/files/${encodeURIComponent(first.name)}${encodePath(cwd)}`
  }

  const rel = best.rel || ''
  return `${basePath}/files/${encodeURIComponent(best.src.name)}${encodePath(rel)}`
}

module.exports = { filesUrlForCwd, encodePath, normalizeRoot }
