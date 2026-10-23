import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DIST_DIR,
  DEFAULT_RELEASE_DIR,
  LAUNCHER_FILE_NAME,
  SERVER_FILE_NAME,
  assertDistReady,
  assembleRelease,
  copyTree,
  directorySize,
  formatBytes,
  listFiles,
  parseArgs,
  renderLauncherBat,
  resolveReleasePlan,
} from '../../scripts/pack-release.mjs'

/**
 * 发布包装配单测（W7 D4）
 *
 * 覆盖三件事：
 *   1. 双击启动文件的契约（UTF-8 代码页、内嵌端口、正文纯 ASCII）；
 *   2. 目录拷贝与产物就绪校验；
 *   3. 端到端装配——用临时 dist/ 跑完整流程，断言 release/ 里确实有「产物 + 服务器 + 启动文件」。
 */

const SERVER_SOURCE = fileURLToPath(new URL('../../scripts/serve-dist.mjs', import.meta.url))

/** 造一个最小 dist/：入口 + 哈希资源 + 嵌套图档目录 */
function makeDistDir(): string {
  const dist = mkdtempSync(join(tmpdir(), 'pack-dist-'))
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>OCS</title>', 'utf8')
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'export const ok = true\n', 'utf8')
  mkdirSync(join(dist, 'map'), { recursive: true })
  writeFileSync(join(dist, 'map', 'Smolensk-map.png'), 'fake-png', 'utf8')
  return dist
}

describe('pack-release 双击启动文件', () => {
  it('内含 UTF-8 代码页切换、Node 探测、自目录定位与自动开浏览器', () => {
    const bat = renderLauncherBat({ port: 5174 })
    expect(bat).toContain('chcp 65001')
    expect(bat).toContain('where node')
    expect(bat).toContain('cd /d "%~dp0"')
    expect(bat).toContain('--root "."')
    expect(bat).toContain('--port 5174')
    expect(bat).toContain('--open')
    expect(bat).toContain('pause')
  })

  it('正文保持纯 ASCII（cmd 逐字节读批处理，非 ASCII 会乱码）', () => {
    const bat = renderLauncherBat({ port: 8080 })
    const nonAscii = [...bat].filter((char) => char.charCodeAt(0) > 0x7f)
    expect(nonAscii).toEqual([])
  })

  it('换行统一 CRLF，避免个别 cmd 解析异常', () => {
    const bat = renderLauncherBat()
    expect(bat).toContain('\r\n')
    expect(bat.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('端口与服务器文件名可注入（默认 5174 / serve.mjs）', () => {
    const bat = renderLauncherBat({ port: 6000, serverFile: 'x.mjs' })
    expect(bat).toContain('--port 6000')
    expect(bat).toContain('serve')
    expect(bat).toContain('x.mjs')
  })
})

describe('pack-release 目录工具与校验', () => {
  it('listFiles：递归列出全部文件，路径统一用 / 分隔', () => {
    const dist = makeDistDir()
    try {
      const files = listFiles(dist).sort()
      expect(files).toEqual(['assets/index-abc123.js', 'index.html', 'map/Smolensk-map.png'])
    } finally {
      rmSync(dist, { recursive: true, force: true })
    }
  })

  it('copyTree：连同嵌套目录一起拷贝并返回文件数', () => {
    const dist = makeDistDir()
    const out = mkdtempSync(join(tmpdir(), 'pack-out-'))
    try {
      expect(copyTree(dist, out)).toBe(3)
      expect(listFiles(out).sort()).toEqual([
        'assets/index-abc123.js',
        'index.html',
        'map/Smolensk-map.png',
      ])
      expect(directorySize(out)).toBeGreaterThan(0)
    } finally {
      rmSync(dist, { recursive: true, force: true })
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('assertDistReady：目录缺失或没有 index.html 时提示先构建', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pack-empty-'))
    try {
      expect(() => assertDistReady(join(empty, 'nope'))).toThrow(/npm run build/)
      expect(() => assertDistReady(empty)).toThrow(/index\.html/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('formatBytes：按单位归一到一位小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('resolveReleasePlan：发布包内的两个文件名固定，端口可注入', () => {
    const plan = resolveReleasePlan({
      releaseDir: 'release',
      serverSource: SERVER_SOURCE,
      port: 6000,
    })
    expect(plan.serverFile.endsWith(SERVER_FILE_NAME)).toBe(true)
    expect(plan.launcherFile.endsWith(LAUNCHER_FILE_NAME)).toBe(true)
    expect(plan.port).toBe(6000)
    expect(plan.releaseDir).not.toBe('release') // 已归一化为绝对路径
  })

  it('parseArgs：默认值与显式覆盖，端口非法即抛错', () => {
    const defaults = parseArgs([])
    expect(defaults.distDir).toBe(DEFAULT_DIST_DIR)
    expect(defaults.releaseDir).toBe(DEFAULT_RELEASE_DIR)

    const explicit = parseArgs(['--dist', 'out', '--out', '发布', '--port', '8080'])
    expect(explicit.distDir).toBe('out')
    expect(explicit.releaseDir).toBe('发布')
    expect(explicit.port).toBe(8080)

    expect(() => parseArgs(['--port', '0'])).toThrow(/1–65535/)
    expect(parseArgs(['--help']).help).toBe(true)
  })
})

describe('pack-release 端到端装配', () => {
  it('release/ = 产物摊平 + 服务器副本（字节一致） + 双击启动文件', () => {
    const dist = makeDistDir()
    const release = join(mkdtempSync(join(tmpdir(), 'pack-e2e-')), 'release')
    try {
      const result = assembleRelease({ distDir: dist, releaseDir: release, port: 5199 })

      // 1. 产物按原样摊平（不再多套一层 dist/）
      const files = listFiles(release).sort()
      expect(files).toContain('index.html')
      expect(files).toContain('assets/index-abc123.js')
      expect(files).toContain('map/Smolensk-map.png')

      // 2. 服务器副本与原文件逐字节一致 —— 桌面端与仓库跑同一份代码
      expect(readFileSync(result.serverFile).equals(readFileSync(SERVER_SOURCE))).toBe(true)

      // 3. 启动文件就位、端口写入正确、正文纯 ASCII
      const bat = readFileSync(result.launcherFile, 'utf8')
      expect(bat).toContain('--port 5199')
      expect([...bat].filter((char) => char.charCodeAt(0) > 0x7f)).toEqual([])

      // 4. 摘要计数 = 产物 3 + 服务器 1 + 启动文件 1
      expect(result.files).toBe(5)
      expect(result.bytes).toBeGreaterThan(0)
    } finally {
      rmSync(dist, { recursive: true, force: true })
      rmSync(release, { recursive: true, force: true })
    }
  })

  it('重复装配会清掉上一版残留，不混入旧文件', () => {
    const dist = makeDistDir()
    const release = join(mkdtempSync(join(tmpdir(), 'pack-again-')), 'release')
    try {
      assembleRelease({ distDir: dist, releaseDir: release, port: 5174 })
      writeFileSync(join(release, 'stale.txt'), 'old', 'utf8')
      assembleRelease({ distDir: dist, releaseDir: release, port: 5174 })
      expect(listFiles(release)).not.toContain('stale.txt')
    } finally {
      rmSync(dist, { recursive: true, force: true })
      rmSync(release, { recursive: true, force: true })
    }
  })
})
