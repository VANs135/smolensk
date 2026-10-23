import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:http'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_ROOT,
  HELP_TEXT,
  IMMUTABLE_CACHE_CONTROL,
  REVALIDATE_CACHE_CONTROL,
  assertRootReady,
  cacheControlFor,
  contentTypeFor,
  createStaticServer,
  etagFor,
  hasFileExtension,
  isNotModified,
  listenWithFallback,
  openBrowser,
  parseArgs,
  renderBanner,
  safeResolve,
} from '../../scripts/serve-dist.mjs'

/**
 * 单文件静态服务器单测（W7 D4）
 *
 * 分两层：
 *   1. 纯函数层——MIME、缓存策略、目录穿越防护、条件请求、参数解析；
 *   2. 端到端层——真起 http 服务器（端口 0 取临时端口）对临时产物目录发真实请求，
 *      证明「构建产物能被这台服务器打开」这件事本身成立。
 */

/** 造一个等价于 dist/ 的最小产物目录：入口 + 哈希资源 + 图档 + 子目录 */
function makeFixtureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'serve-dist-'))
  writeFileSync(
    join(root, 'index.html'),
    '<!doctype html><title>OCS</title><div id="app"></div>',
    'utf8',
  )
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'export const ok = true\n', 'utf8')
  mkdirSync(join(root, 'map'), { recursive: true })
  writeFileSync(join(root, 'map', 'Smolensk-map.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return root
}

describe('serve-dist 纯函数', () => {
  it('contentTypeFor：已知扩展名按表返回，大小写不敏感，未知回退 octet-stream', () => {
    expect(contentTypeFor('/assets/index-abc.js')).toContain('text/javascript')
    expect(contentTypeFor('a/b/C.PNG')).toBe('image/png')
    expect(contentTypeFor('/fonts/Outfit-Regular.ttf')).toBe('font/ttf')
    expect(contentTypeFor('index.html')).toContain('text/html')
    expect(contentTypeFor('noext')).toBe('application/octet-stream')
    expect(contentTypeFor('weird.zzz')).toBe('application/octet-stream')
  })

  it('hasFileExtension：带扩展名的资源不参与 SPA 回退', () => {
    expect(hasFileExtension('/assets/index-abc.js')).toBe(true)
    expect(hasFileExtension('/map/Smolensk-map.png')).toBe(true)
    expect(hasFileExtension('/game')).toBe(false)
    expect(hasFileExtension('/')).toBe(false)
  })

  it('cacheControlFor：assets/ 哈希产物长缓存，其余强制校验', () => {
    expect(cacheControlFor('/assets/index-abc.js')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(cacheControlFor('assets/index-abc.js')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(cacheControlFor('/index.html')).toBe(REVALIDATE_CACHE_CONTROL)
    expect(cacheControlFor('/map/Smolensk-map.png')).toBe(REVALIDATE_CACHE_CONTROL)
  })

  it('safeResolve：正常路径落在根目录内', () => {
    const root = join(tmpdir(), 'serve-root')
    const result = safeResolve(root, '/assets/index-abc.js')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.filePath).toBe(join(root, 'assets', 'index-abc.js'))
  })

  it('safeResolve：根路径解析为根目录本身', () => {
    const root = join(tmpdir(), 'serve-root')
    const result = safeResolve(root, '/')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.filePath).toBe(root)
  })

  it('safeResolve：目录穿越一律拒绝（含 /../ 与编码形态）', () => {
    const root = join(tmpdir(), 'serve-root')
    for (const bad of [
      '/../package.json',
      '/../../etc/passwd',
      '/a/../../b',
      '/..%2f..%2fpackage.json',
    ]) {
      const result = safeResolve(root, bad)
      expect(result.ok, `应拒绝：${bad}`).toBe(false)
      if (!result.ok) expect(result.reason).toBe('traversal')
    }
  })

  it('safeResolve：NUL 字节与残缺编码分别归类为 nul / invalid', () => {
    const root = join(tmpdir(), 'serve-root')
    const nul = safeResolve(root, '/a\0b')
    expect(nul.ok).toBe(false)
    if (!nul.ok) expect(nul.reason).toBe('nul')

    const invalid = safeResolve(root, '/%ZZ')
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.reason).toBe('invalid')
  })

  it('etagFor：由大小与 mtime 生成弱 ETag，mtime 取整保证同秒稳定', () => {
    expect(etagFor({ size: 120, mtimeMs: 1700000000123.9 })).toBe('W/"120-1700000000123"')
  })

  it('isNotModified：命中当前 ETag 或 * 即 304，缺失/不匹配则否', () => {
    const etag = 'W/"1-2"'
    expect(isNotModified({ 'if-none-match': etag }, etag)).toBe(true)
    expect(isNotModified({ 'if-none-match': `"x", ${etag}` }, etag)).toBe(true)
    expect(isNotModified({ 'if-none-match': '*' }, etag)).toBe(true)
    expect(isNotModified({ 'if-none-match': 'W/"9-9"' }, etag)).toBe(false)
    expect(isNotModified({}, etag)).toBe(false)
  })

  it('parseArgs：默认值即「dist + 回环 + 5174 + 不自动开浏览器」', () => {
    const options = parseArgs([])
    expect(options.root).toBe(DEFAULT_ROOT)
    expect(options.host).toBe(DEFAULT_HOST)
    expect(options.port).toBe(DEFAULT_PORT)
    expect(options.open).toBe(false)
    expect(options.help).toBe(false)
  })

  it('parseArgs：显式覆盖各项，且 --open/--no-open 后者生效', () => {
    const options = parseArgs([
      '--root',
      '.',
      '--host',
      '127.0.0.1',
      '--port',
      '8080',
      '--open',
      '--no-open',
    ])
    expect(options.root).toBe('.')
    expect(options.port).toBe(8080)
    expect(options.open).toBe(false)
  })

  it('parseArgs：端口非法直接抛错，不静默落到意外端口', () => {
    expect(() => parseArgs(['--port', '0'])).toThrow(/1–65535/)
    expect(() => parseArgs(['--port', '70000'])).toThrow(/1–65535/)
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/1–65535/)
  })

  it('parseArgs：--help/-h 置位', () => {
    expect(parseArgs(['--help']).help).toBe(true)
    expect(parseArgs(['-h']).help).toBe(true)
    expect(HELP_TEXT).toContain('--root')
  })

  it('renderBanner：同时给出根目录与实际监听地址', () => {
    const banner = renderBanner({ root: 'D:/OCS/smolensk/dist', host: '127.0.0.1', port: 5174 })
    expect(banner).toContain('D:/OCS/smolensk/dist')
    expect(banner).toContain('http://127.0.0.1:5174/')
  })

  it('assertRootReady：目录不存在或缺 index.html 时给出可操作指引', () => {
    const empty = mkdtempSync(join(tmpdir(), 'serve-empty-'))
    try {
      expect(() => assertRootReady(join(empty, 'nope'))).toThrow(/npm run build/)
      expect(() => assertRootReady(empty)).toThrow(/index\.html/)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('openBrowser：不支持的平台也不抛错（返回值即契约）', () => {
    // 只断言「不抛异常且返回布尔」——真去开浏览器不是单测该做的事
    const quiet = { quiet: true }
    expect(typeof openBrowser('http://127.0.0.1:1/', quiet)).toBe('boolean')
  })
})

describe('serve-dist 端到端（真起服务器打真请求）', () => {
  let root = ''
  let server: Server
  let base = ''

  beforeAll(async () => {
    root = makeFixtureDir()
    server = createStaticServer({ rootDir: root, quiet: true })
    const port = await listenWithFallback(server, { host: DEFAULT_HOST, port: 0 })
    base = `http://${DEFAULT_HOST}:${port}`
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  })

  it('GET / 返回入口文件（目录 → index.html）', async () => {
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('id="app"')
  })

  it('GET 哈希资源：正确 MIME + 长缓存 + nosniff', async () => {
    const response = await fetch(`${base}/assets/index-abc123.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/javascript')
    expect(response.headers.get('cache-control')).toBe(IMMUTABLE_CACHE_CONTROL)
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  it('GET 图档：字节级一致（png 头不被改写）', async () => {
    const response = await fetch(`${base}/map/Smolensk-map.png`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    const buffer = Buffer.from(await response.arrayBuffer())
    expect([...buffer]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('GET 不存在的「带扩展名」路径 → 404（不误回入口文件）', async () => {
    const response = await fetch(`${base}/assets/missing-xyz.js`)
    expect(response.status).toBe(404)
  })

  it('GET 不存在的「无扩展名」路径 → SPA 回退到入口文件', async () => {
    const response = await fetch(`${base}/game/table`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="app"')
  })

  it('GET 编码后的目录穿越 → 403', async () => {
    const response = await fetch(`${base}/..%2f..%2fpackage.json`)
    expect(response.status).toBe(403)
  })

  it('HEAD 只回头不回体，且带 content-length', async () => {
    const response = await fetch(`${base}/`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(0)
    expect(await response.text()).toBe('')
  })

  it('条件请求：带上 If-None-Match 再取一次 → 304', async () => {
    const first = await fetch(`${base}/index.html`)
    const etag = first.headers.get('etag')
    expect(etag).not.toBeNull()
    const second = await fetch(`${base}/index.html`, { headers: { 'if-none-match': String(etag) } })
    expect(second.status).toBe(304)
  })

  it('写方法不被放行 → 405 且告知 Allow', async () => {
    const response = await fetch(`${base}/`, { method: 'POST' })
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('GET, HEAD')
  })
})
