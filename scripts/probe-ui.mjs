/**
 * UI 探针（渲染层改动的**实证**入口）
 *
 * ★定位：改贴图 / 落位 / 命中 / 面板样式这类「看出来的东西」时，用一条命令把
 *   生产包在真浏览器里开起来、走到对局台、按需操作、截图落盘，避免每次手写一遍
 *   Playwright 样板（此前这些脚本都散在个人临时目录里，别人接手时无从复现）。
 *
 * ★用途边界（对应 docs/开发文档.md §11.4）：
 *   - 它**不是**回归门禁：不参与 `npm run check`，不随提交自动跑；
 *   - 它**不是** AI 对打：不驱动引擎跑回合，只点界面、读 store、截图；
 *   - 结论仍靠人眼判图（本作面板/贴图类问题没有像素基线）。
 *
 * 运行：
 *   npx vite build --outDir dist          # 先出生产包（或复用已有 dist/）
 *   node scripts/probe-ui.mjs --out E:/OCS/工作文件/tmp/shot.png
 *   node scripts/probe-ui.mjs --scenario "Short Campaign" --preset --out shot.png
 *   node scripts/probe-ui.mjs --preset --zoom 6 --focus 820,520 --steps my-steps.mjs --out shot.png
 *
 * 步骤文件（`--steps`）是一个 ESM 默认导出的 async 函数，参数：
 *   { page, out } —— `page` 是 Playwright Page；`out` 是截图绝对路径。
 *   页面里已挂 `window.__probe.pinia`，因此可以在 `page.evaluate` 里直接取 store：
 *     const w = window.__probe.pinia._s.get('workbench')
 *   注意：store 是响应式代理，**不要**整体 return 出页面，只 return数组/数值等可序列化片段。
 */
// 下面两个全局只出现在 page.evaluate 的回调里（那些回调在浏览器侧执行）
/* global document, window */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStaticServer, listenWithFallback } from './serve-dist.mjs'

/** 探针默认端口（避开 Vite 5173 与 serve:dist 5174） */
export const PROBE_DEFAULT_PORT = 5175

/** 默认输出截图（相对当前工作目录） */
export const PROBE_DEFAULT_OUT = 'probe-ui.png'

/** 默认剧本卡片的匹配文本（首张卡；留空＝点第一张） */
export const PROBE_DEFAULT_SCENARIO = 'Short Campaign'

export const HELP_TEXT = `UI 探针：把生产包开到对局台并按需截图

用法：
  node scripts/probe-ui.mjs [选项]

选项：
  --dist <目录>        生产包目录（默认 dist）
  --out <文件>         截图路径（默认 ${PROBE_DEFAULT_OUT}）
  --scenario <文本>    剧本卡片文本片段（默认 Short Campaign）
  --mode <1|2|3>       模式项序号（默认 2＝教学模式）
  --preset             进入对局后执行「脚本落初设 + 开始游戏」
  --zoom <次数>        在 --focus 处滚轮放大次数（默认 0）
  --focus <x,y>        缩放焦点（CSS 像素，默认画布中心）
  --steps <文件.mjs>   步骤脚本（默认无）
  --port <端口>        静态服务端口（默认 ${PROBE_DEFAULT_PORT}，占用则自增）
  --keep-open          截图后不关浏览器（人工继续看，Ctrl+C 退出）
  --help               显示本帮助
`

/**
 * 解析命令行参数（纯函数，供用例断言）
 *
 * @param {readonly string[]} argv 不含 `node` 与脚本名的参数
 */
export function parseArgs(argv) {
  const options = {
    dist: 'dist',
    out: PROBE_DEFAULT_OUT,
    scenario: PROBE_DEFAULT_SCENARIO,
    mode: 2,
    preset: false,
    zoom: 0,
    focus: null,
    steps: null,
    port: PROBE_DEFAULT_PORT,
    keepOpen: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${arg} 需要一个值`)
      }
      i += 1
      return value
    }
    switch (arg) {
      case '--dist':
        options.dist = next()
        break
      case '--out':
        options.out = next()
        break
      case '--scenario':
        options.scenario = next()
        break
      case '--mode': {
        const mode = Number(next())
        if (!Number.isInteger(mode) || mode < 1 || mode > 4) {
          throw new Error('--mode 只接受 1–4')
        }
        options.mode = mode
        break
      }
      case '--preset':
        options.preset = true
        break
      case '--zoom': {
        const zoom = Number(next())
        if (!Number.isInteger(zoom) || zoom < 0) throw new Error('--zoom 需要非负整数')
        options.zoom = zoom
        break
      }
      case '--focus': {
        const raw = next()
        const parts = raw.split(',').map((part) => Number(part.trim()))
        if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
          throw new Error('--focus 需要 "x,y" 两个数字')
        }
        options.focus = { x: parts[0], y: parts[1] }
        break
      }
      case '--steps':
        options.steps = next()
        break
      case '--port': {
        const port = Number(next())
        if (!Number.isInteger(port) || port <= 0) throw new Error('--port 需要正整数')
        options.port = port
        break
      }
      case '--keep-open':
        options.keepOpen = true
        break
      case '--help':
        options.help = true
        break
      default:
        throw new Error(`未知参数：${arg}（--help 看用法）`)
    }
  }
  return options
}

/** 生产包必须已存在（探针不替人 build，避免与 `pack` 抢 dist/） */
export function assertDistReady(distDir) {
  const index = resolve(distDir, 'index.html')
  if (!existsSync(index)) {
    throw new Error(`生产包不存在：${index}（先跑 npx vite build --outDir ${distDir}）`)
  }
  return resolve(distDir)
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** 从「新建对局」走到「对局台」；找不到剧本卡片时抛错并列出候选文本 */
export async function enterMatch(page, options) {
  await page.getByRole('button', { name: /新建对局/ }).click()
  await sleep(400)
  const cards = page.locator('button.scenario__card')
  const count = await cards.count()
  if (count === 0) throw new Error('剧本列表为空：页面上没有 button.scenario__card')
  const wanted = options.scenario.trim()
  const card = wanted === '' ? cards.first() : cards.filter({ hasText: wanted }).first()
  if ((await card.count()) === 0) {
    const texts = await cards.allInnerTexts()
    throw new Error(`没有匹配“${wanted}”的剧本卡片；候选：${texts.join(' / ')}`)
  }
  await card.click({ force: true })
  await sleep(250)
  const modes = page.locator('label.modes__item')
  // 有的剧本卡片点开后没有模式栏（例如需要先选方的剧本）——8 秒内没出来就明确报错，
  // 不要让人对着 30 秒超时猜是不是探针坏了
  try {
    await modes.first().waitFor({ state: 'visible', timeout: 8000 })
  } catch {
    const texts = await cards.allInnerTexts()
    throw new Error(
      `剧本“${wanted || '第一张'}”点开后没有模式栏（label.modes__item）；换 --scenario，候选：${texts.join(' / ')}`,
    )
  }
  await modes.nth(options.mode - 1).click()
  await sleep(400)
  await page.getByRole('button', { name: /进入初设/ }).click()
  await sleep(900)
  if ((await page.getByRole('dialog').count()) > 0) {
    await page.getByRole('dialog').locator('button').last().click({ force: true })
    await sleep(900)
  }
}

/** 执行「脚本落初设 + 开始游戏」并在页面挂 `window.__probe`（只暴露 pinia，不外泄其它东西） */
export async function presetAndExpose(page) {
  await page.evaluate(() => {
    const app = document.querySelector('#app')
    const pinia = app?.__vue_app__?.config?.globalProperties?.$pinia
    if (pinia === undefined) throw new Error('#app 上取不到 $pinia')
    const setup = pinia._s.get('setup')
    setup.presetSelfSetupNow()
    setup.startGameNow()
    window.__probe = { pinia }
  })
  await sleep(600)
}

/** 主流程：起服务 → 开浏览器 → 进对局 → （可选）放大 / 步骤 → 截图 */
export async function runProbe(options) {
  const distDir = assertDistReady(options.dist)
  const outPath = resolve(options.out)
  const server = createStaticServer({ rootDir: distDir, quiet: true })
  const port = await listenWithFallback(server, {
    host: '127.0.0.1',
    port: options.port,
    tries: 20,
  })
  const url = `http://127.0.0.1:${port}/`

  const pw = await import('playwright-core')
  const chromium = pw.default?.chromium ?? pw.chromium
  const browser = await chromium.launch({ channel: 'msedge', headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } })
    await page.goto(url, { waitUntil: 'networkidle' })
    await enterMatch(page, options)
    if (options.preset) await presetAndExpose(page)

    if (options.zoom > 0) {
      const focus =
        options.focus ??
        (await page.evaluate(() => {
          const canvas = document.querySelector('canvas')
          const box = canvas?.getBoundingClientRect()
          return box
            ? { x: box.left + box.width / 2, y: box.top + box.height / 2 }
            : { x: 800, y: 500 }
        }))
      await page.mouse.move(focus.x, focus.y)
      for (let i = 0; i < options.zoom; i += 1) {
        await page.mouse.wheel(0, -240)
        await sleep(280)
      }
      await sleep(800)
    }

    if (options.steps !== null) {
      const stepsUrl = pathToFileURL(resolve(options.steps)).href
      const mod = await import(stepsUrl)
      const steps = mod.default ?? mod.run
      if (typeof steps !== 'function') throw new Error(`${options.steps} 要默认导出 async 函数`)
      await steps({ page, out: outPath, options })
    }

    await sleep(300)
    await page.screenshot({ path: outPath })
    return { url, out: outPath, keepOpen: options.keepOpen, browser }
  } catch (error) {
    await browser.close()
    throw error
  } finally {
    if (!options.keepOpen) server.close()
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
    return
  }
  if (options.help) {
    console.log(HELP_TEXT)
    return
  }
  const result = await runProbe(options)
  console.log(`探针截图：${result.out}`)
  console.log(`页面地址（截图时）：${result.url}`)
  if (result.keepOpen) {
    console.log('浏览器保持打开：Ctrl+C 退出（服务也会随之关闭）')
    await new Promise(() => {})
  } else {
    await result.browser.close()
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error))
    process.exitCode = 1
  })
}
