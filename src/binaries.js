'use strict'

/**
 * dsh-fbq-bridge — 内置的 FBQ 发行版清单
 *
 * 由 scripts/update-binaries.js 生成，请勿手工编辑。
 * 来源：GitHub Release API（gtsteffaniak/filebrowser v2.1.6-beta）。
 */

const PINNED = {
  version: "v2.1.6-beta",
  repo: "gtsteffaniak/filebrowser",
  downloadBaseUrl: 'https://github.com/gtsteffaniak/filebrowser/releases/download',
  assets: {
    "linux-x64": {
      name: "linux-amd64-filebrowser",
      size: 29290060,
      sha256: "8310ac8188dd9843300cbfb09947e4ecf93f45cc1a0577b9443f427c737f7cd0",
    },
    "linux-arm64": {
      name: "linux-arm64-filebrowser",
      size: 27519504,
      sha256: "460d5e8575f701f1932047981d2804ed575225abc364d0ac4e705757795cb013",
    },
    "linux-armv6": {
      name: "linux-armv6-filebrowser",
      size: 21755976,
      sha256: "c099e547262b11d625dc0ca0ea18f08ad6975f8d2e6f5f2c81844f26c57e080c",
    },
    "linux-armv7": {
      name: "linux-armv7-filebrowser",
      size: 21734964,
      sha256: "14703719e711d1f242f22fc0dcc0254901fef6c39b8a268e24ccdd1c00dcd914",
    },
    "linux-riscv64": {
      name: "linux-riscv64-filebrowser",
      size: 44564640,
      sha256: "b8dc6eaae3bfb540a8f66db861e95746c7fd3011f67a5f8e029f3d602ae67601",
    },
    "darwin-x64": {
      name: "darwin-amd64-filebrowser",
      size: 48846064,
      sha256: "329abe537924b15af07008b8a8da815bc3d44dfcf8c6a4cc276e94dcd59d900c",
    },
    "darwin-arm64": {
      name: "darwin-arm64-filebrowser",
      size: 46940482,
      sha256: "2e95943cc2a8facb9fdcd1bcf8a6ae9b9b946ac37ef6808029c63f5e41e84c77",
    },
    "freebsd-x64": {
      name: "freebsd-amd64-filebrowser",
      size: 48029866,
      sha256: "483b36e8c789fe4cd0ec79e9169edff8fa40babaa8dbabfb1db4cb0195fd96c4",
    },
    "win32-x64": {
      name: "filebrowser.exe",
      size: 28762112,
      sha256: "deeb68746e33a00545616cb1fba97978350f98e4dab7b6b76d9481548ae3f4d1",
    },
  },
}

/** 本机平台键，例如 linux-x64。 */
function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`
}

/** 取本机对应的资产描述；不支持时返回 null。 */
function assetFor(platform = process.platform, arch = process.arch) {
  return PINNED.assets[platformKey(platform, arch)] || null
}

/** 资产下载 URL。 */
function assetUrl(asset, version = PINNED.version) {
  return `${PINNED.downloadBaseUrl}/${version}/${asset.name}`
}

module.exports = { PINNED, platformKey, assetFor, assetUrl }
