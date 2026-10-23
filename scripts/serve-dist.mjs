/**
 * 单文件零依赖静态服务器（W7 D4 打包与静态服务器）
 *
 * ★定位：把 `npm run build` 产出的纯静态文件（dist/）在本地开起来看/玩。
 *   本作无后端、无网络请求（数据经打包期 JSON import 内联），唯一需要 HTTP 的理由是
 *   浏览器禁止 `file://` 下加载 ES module 与读取静态图档（public/map、public/fonts）。
 *
 * ★硬约束（对应 CODE_SPEC §1「生产构建产物为纯静态文件，用单文件静态服务器本地打开」）：
 *   - **单文件**：全部逻辑在本文件内，只依赖 Node 内置模块（node:http / node:fs / …），
 *     不引第三方包，不需要 node_modules —— 拷贝到任何有 Node 的机器即可运行；
 *   - **零配置**：默认根目录 `dist`、回环地址、端口 5174（避开 Vite 开发服务器的 5173）；
 *   - **可被测试**：纯函数全部具名导出；主流程由 `invokedDirectly` 守卫，
 *     被 `import` 时不监听端口、不打印 banner、不打开浏览器。
 *
 * 运行：
 *   node scripts/serve-dist.mjs                 # 服务 ./dist，地址 http://127.0.0.1:5174
 *   node scripts/serve-dist.mjs --open          # 起服务并自动打开默认浏览器
 *   node scripts/serve-dist.mjs --root . --port 8080
 *
 * 安全边界：仅绑定回环地址（不放行局域网），并对请求路径做目录穿越（`../`）防护。
 */
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { platform } from 'node:os'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

/* ─────────────────────────────── 默认值 ─────────────────────────────── */

/** 默认服务根目录（相对当前工作目录；`npm run serve:dist` 即项目根的 dist/） */
export const DEFAULT_ROOT = 'dist'

/** 默认绑定地址：回环，同机热坐对局，不放行局域网（与 vite.config.ts 的 server.host 同口径） */
export const DEFAULT_HOST = '127.0.0.1'

/** 默认端口：避开 Vite 开发服务器的 5173，两者可同时运行 */
export const DEFAULT_PORT = 5174

/** 端口被占用时的自增重试次数 */
export const DEFAULT_PORT_TRIES = 20

/**
 * 扩展名 → MIME 类型（本作实际会用到的一小撮，未命中回退 octet-stream）
 *
 * 只列打包产物与 public/ 下真实存在的类型，不抄一张巨型表：
 *   - .js/.mjs/.css/.html：Vite 产物
 *   - .json：日后若接入运行时取数
 *   - .png/.jpg/.svg/.webp：地图扫描图与算子图档
 *   - .ttf/.woff2：public/fonts 下的字体（tokens.css 经 /fonts/ 引用）
 */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
})

/** 未知扩展名的回退类型 */
export const FALLBACK_MIME = 'application/octet-stream'

/** 构建产物中的入口文件；SPA 回退与「根目录是否就绪」都以它为判据 */
export const INDEX_FILE = 'index.html'

/** 带内容哈希的产物目录：文件名随内容变化，可长缓存（Vite 默认输出 assets/） */
export const HASHED_ASSET_PREFIX = 'assets/'

/** 命中哈希产物时的缓存策略：一年不可变 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** 其余一律「必须先找服务端校验」；配合 ETag/Last-Modified，命中即 304，永远拿到最新 UI */
export const REVALIDATE_CACHE_CONTROL = 'no-cache'

/* ─────────────────────────────── 纯函数 ─────────────────────────────── */

/**
 * 由扩展名取 MIME 类型（大小写不敏感；无扩展名/未知类型回退 octet-stream）
 *
 * @param {string} filePath 文件路径或 URL 路径
 * @returns {string} MIME 类型
 */
export function contentTypeFor(filePath) {
  const ext = extname(String(filePath ?? '')).toLowerCase()
  return MIME_TYPES[ext] ?? FALLBACK_MIME
}

/**
 * 判断 URL 路径是否「看起来是静态文件」（末段含扩展名）
 *
 * 用途：SPA 回退的边界——`/game`（路由，无扩展名）找不到文件时回退 index.html；
 * `/assets/x.js`、`/map/a.png`（有扩展名）找不到就老实 404，避免把 JS 当 HTML 返回
 * 触发浏览器的 MIME 类型报错。
 *
 * @param {string} urlPath URL 路径（只取 pathname，不含查询串）
 * @returns {boolean} 末段是否带扩展名
 */
export function hasFileExtension(urlPath) {
  const last = String(urlPath ?? '')
    .split('/')
    .pop()
  if (!last) return false
  return extname(last).length > 1
}

/**
 * 缓存策略：`assets/` 下的哈希产物长缓存，其余强制校验
 *
 * @param {string} urlPath URL 路径
 * @returns {string} Cache-Control 头值
 */
export function cacheControlFor(urlPath) {
  const normalized = String(urlPath ?? '').replace(/^\/+/, '')
  return normalized.startsWith(HASHED_ASSET_PREFIX)
    ? IMMUTABLE_CACHE_CONTROL
    : REVALIDATE_CACHE_CONTROL
}

/**
 * 把 URL 路径安全地解析为根目录下的绝对文件路径
 *
 * 目录穿越防护：解析后必须仍在根目录内（`/../etc/passwd`、`%2e%2e%2f`、绝对路径注入一律拒绝）。
 *
 * @param {string} rootDir 服务根目录（绝对路径）
 * @param {string} urlPath URL 路径（已 decode 的 pathname）
 * @returns {{ ok: true, filePath: string } | { ok: false, reason: 'invalid' | 'nul' | 'traversal' }}
 */
export function safeResolve(rootDir, urlPath) {
  const raw = String(urlPath ?? '')

  if (raw.includes('\0')) return { ok: false, reason: 'nul' }

  let decoded
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // 百分号编码残缺（如 `%ZZ`）→ 无法还原成合法路径
    return { ok: false, reason: 'invalid' }
  }
  if (decoded.includes('\0')) return { ok: false, reason: 'nul' }

  const root = resolve(rootDir)
  // 去掉开头斜杠并按 `/` 分段，逐段拒绝 `..`：比字符串 normalize 更直白，也挡住编码绕过
  const segments = decoded.split(/[/\\]+/).filter((part) => part !== '' && part !== '.')
  if (segments.some((part) => part === '..')) return { ok: false, reason: 'traversal' }

  const filePath = resolve(root, ...segments)
  // 双保险：解析结果必须落在根目录内（Windows 盘符/大小写差异用 relative 判定）
  const rel = relative(root, filePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: 'traversal' }

  return { ok: true, filePath }
}

/**
 * 由文件路径的 mtime 与大小生成弱 ETag（本地服务器无需强哈希，够用且零开销）
 *
 * @param {{ size: number, mtimeMs: number }} stat fs.statSync 结果
 * @returns {string} 形如 `W/"<size>-<mtimeMs>"`
 */
export function etagFor(stat) {
  const size = Number(stat?.size ?? 0)
  const mtimeMs = Math.floor(Number(stat?.mtimeMs ?? 0))
  return `W/"${size}-${mtimeMs}"`
}

/**
 * 条件请求判定：客户端带来的 If-None-Match 与当前 ETag 一致即 304
 *
 * @param {import('node:http').IncomingHttpHeaders} headers 请求头
 * @param {string} etag 当前资源 ETag
 * @returns {boolean} 是否可直接返回 304
 */
export function isNotModified(headers, etag) {
  const raw = headers?.['if-none-match']
  if (typeof raw !== 'string' || raw === '') return false
  return raw
    .split(',')
    .map((item) => item.trim())
    .some((item) => item === etag || item === '*')
}

/**
 * 解析命令行参数
 *
 * 支持：`--root <dir>` / `--port <n>` / `--host <addr>` / `--open` / `--no-open` / `--help`。
 * 端口非法（非整数或越界）直接抛出，避免静默监听一个意外端口。
 *
 * @param {readonly string[]} argv 进程参数（不含 node 与脚本名）
 * @returns {{
 *   root: string, host: string, port: number, open: boolean,
 *   portTries: number, help: boolean,
 * }}
 */
export function parseArgs(argv) {
  /** @type {{ root: string, host: string, port: number, open: boolean, portTries: number, help: boolean }} */
  const options = {
    root: DEFAULT_ROOT,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    open: false,
    portTries: DEFAULT_PORT_TRIES,
    help: false,
  }

  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    switch (arg) {
      case '--root':
        options.root = String(list[i + 1] ?? '')
        i += 1
        break
      case '--port': {
        const value = Number(list[i + 1])
        if (!Number.isInteger(value) || value < 1 || value > 65535) {
          throw new Error(`--port 需要 1–65535 的整数，收到：${String(list[i + 1])}`)
        }
        options.port = value
        i += 1
        break
      }
      case '--host':
        options.host = String(list[i + 1] ?? DEFAULT_HOST)
        i += 1
        break
      case '--open':
        options.open = true
        break
      case '--no-open':
        options.open = false
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        // 未知参数不静默吞掉：提示后继续（脚本常被 .bat 包一层，宽容更稳）
        if (typeof arg === 'string' && arg.startsWith('--')) {
          process.stderr.write(`[serve-dist] 忽略未知参数：${arg}\n`)
        }
        break
    }
  }
  return options
}

/** 命令行帮助文本（纯静态，测试可见） */
export const HELP_TEXT = `OCS 斯摩棱斯克 · 单文件静态服务器（无后端）

用法：
  node scripts/serve-dist.mjs [选项]

选项：
  --root <dir>    服务根目录（默认 ${DEFAULT_ROOT}）
  --host <addr>   绑定地址（默认 ${DEFAULT_HOST}，仅本机可访问）
  --port <n>      监听端口（默认 ${DEFAULT_PORT}；被占用时自动向后试 ${DEFAULT_PORT_TRIES} 个）
  --open          就绪后自动打开默认浏览器
  --no-open       不打开浏览器（默认）
  --help, -h      显示本帮助

示例：
  node scripts/serve-dist.mjs --open
  node scripts/serve-dist.mjs --root . --port 8080
`

/**
 * 拼启动横幅（多行文本；测试可直接断言）
 *
 * @param {{ root: string, host: string, port: number }} info 实际生效的根目录与监听地址
 * @returns {string} 供控制台打印的横幅
 */
export function renderBanner(info) {
  const url = `http://${info.host}:${info.port}/`
  return [
    'OCS 斯摩棱斯克 · 静态服务器（单文件 / 零依赖）',
    `根目录  ${info.root}`,
    `地址    ${url}`,
    '停止    Ctrl+C',
    '',
  ].join('\n')
}

/* ─────────────────────────────── 服务器 ─────────────────────────────── */

/**
 * 创建静态服务器实例（**不监听**，便于测试注入临时目录与端口 0）
 *
 * @param {{ rootDir: string, quiet?: boolean }} options
 * @returns {import('node:http').Server} http 服务器
 */
export function createStaticServer(options) {
  const rootDir = resolve(options?.rootDir ?? DEFAULT_ROOT)
  const quiet = options?.quiet === true

  /** 统一的响应收尾：写状态码与公共头 */
  const respond = (res, status, headers) => {
    res.writeHead(status, headers)
    res.end()
  }

  return createServer((req, res) => {
    const method = req.method ?? 'GET'

    // 只放行读操作（HEAD 供浏览器/下载器探测）
    if (method !== 'GET' && method !== 'HEAD') {
      respond(res, 405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      return
    }

    // 解析 pathname：用 URL 去掉查询串与 hash（非法 URL 直接 400）
    let urlPath
    try {
      urlPath = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      respond(res, 400, { 'content-type': 'text/plain; charset=utf-8' })
      return
    }

    const resolved = safeResolve(rootDir, urlPath)
    if (!resolved.ok) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('403 路径越界\n')
      return
    }

    // 目录 → 目录下的 index.html（本作只有根目录一层站点，够用且直白）
    let filePath = resolved.filePath
    let stat = statOf(filePath)
    if (stat?.isDirectory() === true) {
      filePath = join(filePath, INDEX_FILE)
      stat = statOf(filePath)
    }

    // SPA 回退：无扩展名的路径找不到 → 交给入口文件（前端路由自会解析）
    if ((stat === null || !stat.isFile()) && !hasFileExtension(urlPath) && urlPath !== '/') {
      filePath = join(rootDir, INDEX_FILE)
      stat = statOf(filePath)
    }

    if (stat === null || !stat.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`404 未找到 ${urlPath}\n`)
      return
    }

    const etag = etagFor(stat)
    const headers = {
      'content-type': contentTypeFor(filePath),
      'cache-control': cacheControlFor(urlPath.replace(/^\/+/, '')),
      etag,
      'last-modified': new Date(stat.mtimeMs).toUTCString(),
      'x-content-type-options': 'nosniff',
    }

    if (isNotModified(req.headers, etag)) {
      respond(res, 304, headers)
      return
    }

    headers['content-length'] = String(stat.size)
    res.writeHead(200, headers)
    if (method === 'HEAD') {
      res.end()
      return
    }

    const stream = createReadStream(filePath)
    stream.on('error', (error) => {
      if (!quiet) process.stderr.write(`[serve-dist] 读取失败 ${filePath}：${error.message}\n`)
      // 响应头已发出，只能中断连接让浏览器看到失败，而不是回一份残缺文件
      res.destroy()
    })
    stream.pipe(res)
  })
}

/** stat 的安全封装：不存在/无权限一律返回 null（调用方按 404 处理，不抛进请求链） */
function statOf(filePath) {
  try {
    return statSync(filePath)
  } catch {
    return null
  }
}

/**
 * 依次尝试端口直到监听成功（被占用则 +1，最多 tries 次）
 *
 * @param {import('node:http').Server} server 待监听的服务器
 * @param {{ host: string, port: number, tries?: number }} options
 * @returns {Promise<number>} 实际生效的端口
 */
export function listenWithFallback(server, options) {
  const maxTries = Math.max(1, Number(options.tries ?? DEFAULT_PORT_TRIES))
  const host = options.host
  const startPort = Number(options.port)

  return new Promise((resolvePromise, rejectPromise) => {
    // remaining / port 声明在 attempt 之外：重试计数必须跨次累减，否则会无限自增
    let remaining = maxTries
    let port = startPort

    const attempt = () => {
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, host)
    }

    const onError = (error) => {
      server.removeAllListeners('listening')
      const code = /** @type {NodeJS.ErrnoException} */ (error).code
      if (code === 'EADDRINUSE' && remaining > 1 && port < 65535) {
        remaining -= 1
        port += 1
        attempt()
        return
      }
      rejectPromise(error)
    }

    const onListening = () => {
      server.removeListener('error', onError)
      const address = server.address()
      resolvePromise(typeof address === 'object' && address !== null ? address.port : port)
    }

    attempt()
  })
}

/**
 * 用系统默认程序打开 URL
 *
 * Windows 走 `cmd /c start ""`（start 的第一个引号参数会被当作窗口标题，故必须留空串占位）；
 * macOS 走 `open`；其余按 freedesktop 走 `xdg-open`。失败只记一行日志，不影响服务器自身。
 *
 * @param {string} url 待打开地址
 * @param {{ quiet?: boolean }} [options]
 * @returns {boolean} 是否已把打开动作交给系统
 */
export function openBrowser(url, options) {
  const quiet = options?.quiet === true
  const current = platform()
  /** @type {{ command: string, args: string[] }} */
  let spec
  if (current === 'win32') {
    spec = { command: 'cmd', args: ['/c', 'start', '', url] }
  } else if (current === 'darwin') {
    spec = { command: 'open', args: [url] }
  } else {
    spec = { command: 'xdg-open', args: [url] }
  }

  try {
    const child = spawn(spec.command, spec.args, { stdio: 'ignore', detached: true })
    child.on('error', (error) => {
      if (!quiet) process.stderr.write(`[serve-dist] 打开浏览器失败：${error.message}\n`)
    })
    child.unref()
    return true
  } catch (error) {
    if (!quiet) process.stderr.write(`[serve-dist] 打开浏览器失败：${String(error)}\n`)
    return false
  }
}

/**
 * 校验根目录就绪（存在且含 index.html），否则抛出带指引的错误
 *
 * @param {string} rootDir 服务根目录
 * @returns {string} 解析后的绝对路径
 */
export function assertRootReady(rootDir) {
  const root = resolve(rootDir)
  const stat = statOf(root)
  if (stat === null || !stat.isDirectory()) {
    throw new Error(
      `根目录不存在：${root}\n请先执行 npm run build 生成构建产物，或用 --root 指定目录。`,
    )
  }
  if (statOf(join(root, INDEX_FILE)) === null) {
    throw new Error(`根目录缺少 ${INDEX_FILE}：${root}\n请先执行 npm run build 生成构建产物。`)
  }
  return root
}

/**
 * 主流程：校验根目录 → 建服务器 → 试端口 → 打印横幅 → 可选开浏览器 → 等待信号退出
 *
 * @param {readonly string[]} argv 进程参数
 * @returns {Promise<import('node:http').Server>} 已就绪的服务器（测试可 close）
 */
export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)

  if (options.help) {
    process.stdout.write(HELP_TEXT)
    // 帮助路径不建服务器：返回一个未监听的实例，保持返回类型稳定
    return createStaticServer({ rootDir: DEFAULT_ROOT, quiet: true })
  }

  const root = assertRootReady(options.root)
  const server = createStaticServer({ rootDir: root })
  const port = await listenWithFallback(server, {
    host: options.host,
    port: options.port,
    tries: options.portTries,
  })

  process.stdout.write(renderBanner({ root, host: options.host, port }))
  if (options.open) openBrowser(`http://${options.host}:${port}/`)

  const shutdown = () => {
    server.close(() => process.exit(0))
    // 兜底：连接未及时释放也要退出，避免 .bat 窗口关不掉
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  return server
}

/* ─────────────────────────── 主流程守卫（被 import 时不执行） ─────────────────────────── */

/**
 * 是否为「直接运行」：Node 22 起有 import.meta.main，旧版本回退比较 argv[1] 与模块 URL。
 * Windows 下路径大小写/分隔符不一致，故统一转成 file URL 再比。
 */
const invokedDirectly =
  (typeof import.meta.main === 'boolean' ? import.meta.main : false) ||
  (process.argv[1] !== undefined &&
    pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href)

if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(
      `[serve-dist] 启动失败：${error instanceof Error ? error.message : error}\n`,
    )
    process.exitCode = 1
  })
}
