/**
 * 发布包装配脚本（W7 D4 打包与静态服务器 · 「双击即开的成品形态」）
 *
 * ★产出的 release/ 是一个**自包含**目录：把它整体拷给任何装了 Node 的人，
 *   双击里面的启动文件即可开玩，不需要 node_modules、不需要 npm、不需要联网。
 *
 * 目录形态：
 *   release/
 *   ├── index.html  assets/  map/  counters/  fonts/    ← npm run build 的产物（原样摊平）
 *   ├── serve.mjs                                      ← 单文件静态服务器（serve-dist.mjs 的副本）
 *   └── 启动兵棋.bat                                    ← 双击即开（内含 UTF-8 代码页切换与 Node 探测）
 *
 * ★两处刻意的工程选择：
 *   1. **启动文件的正文只用 ASCII**：cmd.exe 按「当时的代码页」逐字节读批处理文件，
 *      若正文含非 ASCII 字节，在切到 UTF-8 之前就可能被读错（乱码甚至语法错误）。
 *      故 .bat 第一行先 `chcp 65001`，正文一律 ASCII；控制台中文交给 serve.mjs 打印。
 *   2. **服务器副本与源码同源**：不复制粘贴实现，而是把 scripts/serve-dist.mjs 原样拷成
 *      serve.mjs，桌面端与仓库永远跑同一份代码。
 *
 * 运行：
 *   node scripts/pack-release.mjs                 # 读 dist/，产出 release/
 *   node scripts/pack-release.mjs --out 发布 --port 8080
 *
 * 通常经 `npm run pack` 调用（该脚本先跑 npm run build）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DEFAULT_PORT, INDEX_FILE } from './serve-dist.mjs'

/* ─────────────────────────────── 常量 ─────────────────────────────── */

/** 默认构建产物目录（vite build 的输出） */
export const DEFAULT_DIST_DIR = 'dist'

/** 默认发布包目录 */
export const DEFAULT_RELEASE_DIR = 'release'

/** 发布包内的服务器文件名（serve-dist.mjs 的副本） */
export const SERVER_FILE_NAME = 'serve.mjs'

/** 发布包内的双击启动文件（正文 ASCII，文件名面向玩家用中文） */
export const LAUNCHER_FILE_NAME = '启动兵棋.bat'

/** 发布包内必须存在的构建产物顶层条目（缺任一即视为没跑过 build） */
export const REQUIRED_ENTRIES = Object.freeze([INDEX_FILE])

/** 启动文件正文的换行（批处理用 CRLF，避免个别 cmd 解析异常） */
const CRLF = '\r\n'

/* ─────────────────────────────── 纯函数 ─────────────────────────────── */

/**
 * 渲染双击启动文件正文
 *
 * 结构：切 UTF-8 → 切到自身所在目录 → 探测 node → 起服务器（自动开浏览器）→ 异常时 pause 留住窗口。
 * `--root "."` 配 `cd /d "%~dp0"`：根目录即发布包自身，避免拼接 `%~dp0` 末位反斜杠带来的引号转义问题。
 *
 * @param {{ port?: number, serverFile?: string }} [options]
 * @returns {string} 批处理文本（**保证仅含 ASCII 字符**）
 */
export function renderLauncherBat(options = {}) {
  const port = Number(options.port ?? DEFAULT_PORT)
  const serverFile = String(options.serverFile ?? SERVER_FILE_NAME)
  const lines = [
    '@echo off',
    'rem OCS Smolensk - local static server launcher. Double-click to play.',
    'rem ASCII-only by design: cmd.exe reads this file with the active code page, so the',
    'rem code page is switched to UTF-8 first and every byte below stays in ASCII range.',
    'chcp 65001 >nul',
    'setlocal',
    'cd /d "%~dp0"',
    '',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo.',
    '  echo   [ERROR] Node.js was not found in PATH.',
    '  echo           Install Node.js 18 or newer from https://nodejs.org/ , then run this file again.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    '',
    'echo.',
    'echo   OCS Smolensk - starting local static server ...',
    'echo   Keep this window open while playing; press Ctrl+C to stop.',
    'echo.',
    '',
    `node "%~dp0${serverFile}" --root "." --port ${port} --open`,
    'set EXITCODE=%ERRORLEVEL%',
    '',
    'echo.',
    'echo   Server stopped (exit code %EXITCODE%).',
    'pause',
    'exit /b %EXITCODE%',
    '',
  ]
  return lines.join(CRLF)
}

/**
 * 递归列出目录下所有文件（相对 rootDir 的路径，统一用 `/` 分隔）
 *
 * @param {string} rootDir 目录绝对路径
 * @returns {string[]} 相对文件路径列表
 */
export function listFiles(rootDir) {
  /** @type {string[]} */
  const out = []
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) out.push(relative(rootDir, full).split('\\').join('/'))
    }
  }
  walk(rootDir)
  return out
}

/**
 * 递归拷贝目录内容到目标目录（目标不存在则逐级创建）
 *
 * @param {string} srcDir 源目录
 * @param {string} destDir 目标目录
 * @returns {number} 拷贝的文件数
 */
export function copyTree(srcDir, destDir) {
  let count = 0
  const walk = (current) => {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      const from = join(current, entry.name)
      const to = join(destDir, relative(srcDir, from))
      if (entry.isDirectory()) {
        mkdirSync(to, { recursive: true })
        walk(from)
      } else if (entry.isFile()) {
        mkdirSync(dirname(to), { recursive: true })
        copyFileSync(from, to)
        count += 1
      }
    }
  }
  walk(srcDir)
  return count
}

/**
 * 校验构建产物就绪（存在且含 index.html）
 *
 * @param {string} distDir 产物目录
 * @returns {string} 解析后的绝对路径
 */
export function assertDistReady(distDir) {
  const dist = resolve(distDir)
  let stat = null
  try {
    stat = statSync(dist)
  } catch {
    stat = null
  }
  if (stat === null || !stat.isDirectory()) {
    throw new Error(
      `构建产物目录不存在：${dist}\n请先执行 npm run build（或 npm run pack 会自动先构建）。`,
    )
  }
  for (const name of REQUIRED_ENTRIES) {
    if (!existsSync(join(dist, name))) {
      throw new Error(
        `构建产物缺少 ${name}：${dist}\n请先执行 npm run build（或 npm run pack 会自动先构建）。`,
      )
    }
  }
  return dist
}

/**
 * 归一化装配参数（纯函数，便于断言与复用）
 *
 * @param {{ distDir?: string, releaseDir?: string, serverSource: string, port?: number }} options
 * @returns {{
 *   distDir: string, releaseDir: string, serverSource: string,
 *   serverFile: string, launcherFile: string, port: number,
 * }}
 */
export function resolveReleasePlan(options) {
  const releaseDir = resolve(options.releaseDir ?? DEFAULT_RELEASE_DIR)
  return {
    distDir: resolve(options.distDir ?? DEFAULT_DIST_DIR),
    releaseDir,
    serverSource: resolve(options.serverSource),
    serverFile: join(releaseDir, SERVER_FILE_NAME),
    launcherFile: join(releaseDir, LAUNCHER_FILE_NAME),
    port: Number(options.port ?? DEFAULT_PORT),
  }
}

/** 人类可读的文件大小（装配摘要用） */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let index = 0
  let size = value
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024
    index += 1
  }
  const rounded = index === 0 ? String(size) : size.toFixed(1)
  return `${rounded} ${units[index]}`
}

/** 递归统计目录字节数 */
export function directorySize(dir) {
  let total = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += statSync(full).size
    }
  }
  walk(dir)
  return total
}

/* ─────────────────────────────── 装配 ─────────────────────────────── */

/**
 * 装配发布包：清空旧目录 → 摊平产物 → 放服务器副本 → 写双击启动文件
 *
 * @param {{
 *   distDir?: string, releaseDir?: string, port?: number,
 *   serverSource?: string, clean?: boolean,
 * }} [options]
 * @returns {{ releaseDir: string, launcherFile: string, serverFile: string, files: number, bytes: number, port: number }}
 */
export function assembleRelease(options = {}) {
  const serverSource =
    options.serverSource ?? fileURLToPath(new URL('./serve-dist.mjs', import.meta.url))
  const plan = resolveReleasePlan({
    distDir: options.distDir,
    releaseDir: options.releaseDir,
    port: options.port,
    serverSource,
  })

  const dist = assertDistReady(plan.distDir)

  // 先清后建：避免上一版残留文件混进新包（release/ 本身已被 .gitignore/.prettierignore 排除）
  if (options.clean !== false) rmSync(plan.releaseDir, { recursive: true, force: true })
  mkdirSync(plan.releaseDir, { recursive: true })

  const copied = copyTree(dist, plan.releaseDir)
  copyFileSync(plan.serverSource, plan.serverFile)
  writeFileSync(plan.launcherFile, renderLauncherBat({ port: plan.port }), 'utf8')

  return {
    releaseDir: plan.releaseDir,
    launcherFile: plan.launcherFile,
    serverFile: plan.serverFile,
    files: copied + 2,
    bytes: directorySize(plan.releaseDir),
    port: plan.port,
  }
}

/** 命令行帮助文本 */
export const HELP_TEXT = `OCS 斯摩棱斯克 · 发布包装配（W7 D4）

用法：
  node scripts/pack-release.mjs [选项]

选项：
  --dist <dir>    构建产物目录（默认 ${DEFAULT_DIST_DIR}）
  --out <dir>     发布包目录（默认 ${DEFAULT_RELEASE_DIR}）
  --port <n>      启动文件内置端口（默认 ${DEFAULT_PORT}）
  --help, -h      显示本帮助

说明：
  装配前请确保已执行 npm run build（npm run pack 会自动先构建）。
`

/**
 * 解析命令行参数
 *
 * @param {readonly string[]} argv 进程参数（不含 node 与脚本名）
 * @returns {{ distDir: string, releaseDir: string, port: number, help: boolean }}
 */
export function parseArgs(argv) {
  const options = {
    distDir: DEFAULT_DIST_DIR,
    releaseDir: DEFAULT_RELEASE_DIR,
    port: DEFAULT_PORT,
    help: false,
  }
  const list = Array.isArray(argv) ? argv : []
  for (let i = 0; i < list.length; i += 1) {
    const arg = list[i]
    if (arg === '--dist') {
      options.distDir = String(list[i + 1] ?? DEFAULT_DIST_DIR)
      i += 1
    } else if (arg === '--out') {
      options.releaseDir = String(list[i + 1] ?? DEFAULT_RELEASE_DIR)
      i += 1
    } else if (arg === '--port') {
      const value = Number(list[i + 1])
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new Error(`--port 需要 1–65535 的整数，收到：${String(list[i + 1])}`)
      }
      options.port = value
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (typeof arg === 'string' && arg.startsWith('--')) {
      process.stderr.write(`[pack-release] 忽略未知参数：${arg}\n`)
    }
  }
  return options
}

/**
 * 主流程：解析参数 → 装配 → 打印摘要
 *
 * @param {readonly string[]} argv 进程参数
 * @returns {{ releaseDir: string, launcherFile: string, serverFile: string, files: number, bytes: number, port: number } | null}
 *          帮助路径返回 null
 */
export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return null
  }

  const result = assembleRelease({
    distDir: options.distDir,
    releaseDir: options.releaseDir,
    port: options.port,
  })
  process.stdout.write(
    [
      '发布包已装配（双击即开）',
      `目录    ${result.releaseDir}`,
      `启动    ${LAUNCHER_FILE_NAME}（双击；内置端口 ${result.port}）`,
      `文件    ${result.files} 个 / ${formatBytes(result.bytes)}`,
      '',
    ].join('\n'),
  )
  return result
}

/* ─────────────────────────── 主流程守卫（被 import 时不执行） ─────────────────────────── */

const invokedDirectly =
  (typeof import.meta.main === 'boolean' ? import.meta.main : false) ||
  (process.argv[1] !== undefined &&
    pathToFileURL(process.argv[1]).href === pathToFileURL(fileURLToPath(import.meta.url)).href)

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    process.stderr.write(
      `[pack-release] 装配失败：${error instanceof Error ? error.message : error}\n`,
    )
    process.exitCode = 1
  }
}
