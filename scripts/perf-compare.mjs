/**
 * D 阶段验收：**同一探针、同组指标**，对照「桌面版 vs Web 生产包」
 *
 * ## 为什么单独成脚本
 *   A/B/C 的历史数字（1327→95ms 等）都是用临时探针（`node_modules/.tmp/perf-probe2.mjs`）
 *   跑出来的；那个文件不入库、不随仓库演进。桌面壳上线后要再比一次，若探针换了一套，
 *   新旧数字就不可比——所以把探针落到 `scripts/`，并把「机器负载」同时记下来。
 *
 * ## 测量纪律（用户口径）
 *   绝对值会随机器负载漂移（实测同一构建 264→450ms，`msedge` 12–14 个进程）。
 *   因此每次采样都记：`msedge` 进程数、`msedgewebview2` 进程数、CPU 平均占用。
 *   报表里必须带这三列，否则单看 settle 无法判断是「壳变快」还是「机器变闲」。
 *
 * ## 两个目标怎么接
 *   · **Web 生产包**：起 `npm run serve:dist -- --port 4199`，再用无头 Edge 开 CDP：
 *       msedge.exe --headless=new --remote-debugging-port=9222 \
 *                  --user-data-dir=%TEMP%\ocs-probe-web about:blank
 *     探针会**新开标签并导航**，保证从首页起跑。
 *   · **桌面版**：先设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`
 *     再启动应用；探针**附加到已运行窗口**（`/json/list` 取 page 目标），
 *     先 `Page.reload` 回到首页再跑；不覆盖视口，按真实窗口尺寸量。
 *
 * ## 用法
 *   node scripts/perf-compare.mjs --desktop-cdp http://127.0.0.1:9333
 *   node scripts/perf-compare.mjs --skip-web --desktop-cdp http://127.0.0.1:9333
 *   node scripts/perf-compare.mjs --out docs/perf-compare-<日期>.md
 *
 * ## 三组关键指标（与 A/B/C 验收线同一口径）
 *   · 进入对局台 `click:进入初设` ≤250ms（C 的线）
 *   · 突围段（`snap.segment` 含「突围」的那一步）≤250ms（B 的线）
 *   · 移动会话 `click:开始移动` ≤300ms（A 的线）
 *
 * 本脚本只读页面状态与打点，**不改任何规则或数据**；失败只影响报表，不影响构建。
 */

import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const DEFAULT_WEB_URL = 'http://127.0.0.1:4199/'
const DEFAULT_WEB_CDP = 'http://127.0.0.1:9222'
const DEFAULT_DESKTOP_CDP = 'http://127.0.0.1:9333'

/** 与桌面窗口默认尺寸一致（`src-tauri/tauri.conf.json` 的 1600×1000） */
const VIEWPORT = { width: 1600, height: 1000 }

/** 三组关键指标：标签 / 验收线（ms） */
const KEY_METRICS = [
  { key: 'enterGame', label: '进入对局台', budget: 250 },
  { key: 'breakout', label: '突围段', budget: 250 },
  { key: 'moveSession', label: '移动会话', budget: 300 },
]

const INSTRUMENT = `(() => {
  const P = window.__P = { longtasks: [], paints: [], lcp: [], events: [], frames: null, mark: 0 };
  const obs = (type, cb, opts) => { try { new PerformanceObserver(cb).observe(Object.assign({ type, buffered: true }, opts || {})) } catch (e) {} };
  obs('longtask', l => { for (const e of l.getEntries()) P.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]) });
  obs('event', l => { for (const e of l.getEntries()) P.events.push([e.name, Math.round(e.startTime), Math.round(e.duration)]) }, { durationThreshold: 16 });
  P.startFrames = () => { P.frames = []; const loop = (t) => { P.frames.push(t); P.raf = requestAnimationFrame(loop) }; P.raf = requestAnimationFrame(loop) };
  P.stopFrames = () => { cancelAnimationFrame(P.raf); P.raf = null; return P.frames };
  P.settle = () => new Promise(r => { setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - P.mark))), 0) });
  P.setMark = () => { P.mark = performance.now(); return P.mark };
})()`

const HELPERS = `
window.__store = (name) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get(name);
window.__rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, disabled: !!el.disabled } };
window.__btn = (text, root) => { const sc = root ? document.querySelector(root) : document; if (!sc) return null; return [...sc.querySelectorAll('button')].find(b => b.textContent.replace(/\\s+/g,' ').trim().includes(text)) || null };
window.__snap = () => {
  const wb = window.__store('workbench') || {}, su = window.__store('setup') || {}, mv = window.__store('mapView') || {}
  return {
    setupFinished: su.finished, turn: wb.turn, phase: wb.phase, side: wb.activeSide,
    segment: wb.segmentStep ? wb.segmentStep.label : null,
    units: Array.isArray(wb.units) ? wb.units.length : null,
    expanded: mv.expandedStack ? { col: mv.expandedStack.col, row: mv.expandedStack.row } : null,
    sel: Array.isArray(mv.stackSelection) ? mv.stackSelection.length : 0,
    session: mv.session ? mv.session.kind : null,
    popup: mv.popup ? mv.popup.variant : null,
    movePick: Array.isArray(wb.movePickChoices) ? wb.movePickChoices.length : 0,
    hover: wb.hoverHex && typeof wb.hoverHex.col === 'number' ? { col: wb.hoverHex.col, row: wb.hoverHex.row } : null,
    lastAction: su.lastAction ? { ok: su.lastAction.ok, rule: su.lastAction.rule, detail: su.lastAction.detail } : null,
  }
}
`

/* ───────────────────────────── CDP 客户端 ───────────────────────────── */

class Cdp {
  constructor(url) {
    this.id = 0
    this.pending = new Map()
    this.ws = new WebSocket(url)
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', (event) => reject(event), { once: true })
    })
    this.ws.addEventListener('message', (message) => {
      const data = JSON.parse(message.data)
      if (data.id !== undefined && this.pending.has(data.id)) {
        const { resolve, reject } = this.pending.get(data.id)
        this.pending.delete(data.id)
        if (data.error) reject(new Error(JSON.stringify(data.error)))
        else resolve(data.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error('eval: ' + JSON.stringify(result.exceptionDetails).slice(0, 600))
    }
    return result.result.value
  }
  close() {
    try {
      this.ws.close()
    } catch {
      /* 已关闭 */
    }
  }
}

async function newTarget(cdpBase) {
  const response = await fetch(`${cdpBase}/json/new?about:blank`, { method: 'PUT' })
  return response.json()
}

/** 附加模式：从已运行窗口里挑一个 page 目标（桌面版 WebView2 用） */
async function firstPageTarget(cdpBase) {
  const response = await fetch(`${cdpBase}/json/list`)
  const targets = await response.json()
  const page = targets.find((item) => item.type === 'page' && String(item.url) !== 'about:blank')
  if (page === undefined) throw new Error(`CDP ${cdpBase} 下没有可附加的 page 目标`)
  return page
}

async function waitUntil(cdp, expression, timeout = 15000, interval = 100) {
  const started = Date.now()
  for (;;) {
    if (await cdp.eval(expression, false)) return Date.now() - started
    if (Date.now() - started > timeout) throw new Error('timeout: ' + expression)
    await sleep(interval)
  }
}

async function clickPoint(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  })
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  })
}

/** 一次「动作 + 排空到帧」的测量：settle 取 mark 到两帧后的间隔，长任务取区间增量 */
async function measured(cdp, action, label) {
  const longTaskBase = await cdp.eval('window.__P.longtasks.length', false)
  const eventBase = await cdp.eval('window.__P.events.length', false)
  await cdp.eval('window.__P.setMark()', false)
  await action()
  const settle = await cdp.eval('window.__P.settle()')
  const longTasks = await cdp.eval(`window.__P.longtasks.slice(${longTaskBase})`, false)
  const events = await cdp.eval(`window.__P.events.slice(${eventBase})`, false)
  const snap = await cdp.eval('window.__snap()', false)
  return {
    label,
    settle: Math.round(settle),
    longTasks,
    longTaskMax: longTasks.length > 0 ? Math.max(...longTasks.map((item) => item[1])) : 0,
    events: events
      .filter((item) => item[0] === 'click' || item[0] === 'pointerup' || item[0] === 'pointerdown')
      .map((item) => item[0] + ':' + item[2]),
    snap,
  }
}

async function clickByText(cdp, text, root) {
  const rect = await cdp.eval(
    `(() => { const el = window.__btn(${JSON.stringify(text)}, ${
      root ? JSON.stringify(root) : 'undefined'
    }); return el ? window.__rect(el) : null })()`,
    false,
  )
  if (rect === null) return null
  if (rect.disabled) {
    return {
      label: 'click:' + text,
      skipped: 'disabled',
      snap: await cdp.eval('window.__snap()', false),
    }
  }
  return measured(cdp, () => clickPoint(cdp, rect.x, rect.y), 'click:' + text)
}

async function hoverHex(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  })
  await sleep(40)
  return cdp.eval(
    `(() => { const w = window.__store('workbench').hoverHex; return w && typeof w.col === 'number' ? { col: w.col, row: w.row } : null })()`,
    false,
  )
}

/** 3x3 仿射最小二乘：由「悬停点的格号→屏幕坐标」样本反解目标格位置 */
function solve3(rows) {
  const S = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const T = [0, 0, 0]
  for (const sample of rows) {
    const vector = [sample.c, sample.r, 1]
    for (let i = 0; i < 3; i += 1) {
      for (let j = 0; j < 3; j += 1) S[i][j] += vector[i] * vector[j]
      T[i] += vector[i] * sample.out
    }
  }
  const M = S.map((row, i) => [...row, T[i]])
  for (let i = 0; i < 3; i += 1) {
    let pivot = i
    for (let k = i + 1; k < 3; k += 1) if (Math.abs(M[k][i]) > Math.abs(M[pivot][i])) pivot = k
    if (Math.abs(M[pivot][i]) < 1e-9) return null
    ;[M[i], M[pivot]] = [M[pivot], M[i]]
    const divisor = M[i][i]
    for (let j = i; j < 4; j += 1) M[i][j] /= divisor
    for (let k = 0; k < 3; k += 1) {
      if (k === i) continue
      const factor = M[k][i]
      for (let j = i; j < 4; j += 1) M[k][j] -= factor * M[i][j]
    }
  }
  return [M[0][3], M[1][3], M[2][3]]
}

/* ───────────────────────────── 单目标探针 ───────────────────────────── */

/**
 * 跑一个目标（Web 生产包或桌面版）
 *
 * @param {{ label: string, cdpBase: string, url?: string, attach?: boolean }} options
 * @returns {Promise<object>} 步骤耗时、备注与视口尺寸
 */
async function runProbe(options) {
  const { label, cdpBase, url, attach } = options
  const target = attach ? await firstPageTarget(cdpBase) : await newTarget(cdpBase)
  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.open()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')

  if (attach) {
    // 桌面版：回到首页再跑，避免上一轮残留的对局状态影响步骤；不覆盖视口，按真实窗口量
    await cdp.send('Page.reload', { ignoreCache: false })
    await waitUntil(cdp, 'document.readyState === "complete"', 20000)
    await sleep(800)
    await cdp.eval(INSTRUMENT, false)
  } else {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })
    await cdp.send('Network.clearBrowserCache')
    await cdp.send('Page.navigate', { url })
    await waitUntil(cdp, 'document.readyState === "complete"', 20000)
    await sleep(800)
  }

  await cdp.eval(HELPERS, false)
  await cdp.eval('window.__P.longtasks.length = 0; window.__P.events.length = 0', false)

  const viewport = await cdp.eval(
    '({ width: window.innerWidth, height: window.innerHeight })',
    false,
  )
  const out = { label, viewport, steps: [], notes: [] }

  const start = await clickByText(cdp, '新建对局')
  if (start) out.steps.push(start)
  await waitUntil(cdp, '!!document.querySelector(".scenario__card")', 8000)
  const cardRect = await cdp.eval(
    `(() => { const el = document.querySelector('.scenario__card'); return el ? window.__rect(el) : null })()`,
    false,
  )
  out.steps.push(
    await measured(cdp, () => clickPoint(cdp, cardRect.x, cardRect.y), 'click:scenario-card'),
  )
  await cdp.eval("window.__store('hotseat').setMode('solo')", false)
  const enter = await clickByText(cdp, '进入初设')
  if (enter) out.steps.push(enter)
  await waitUntil(
    cdp,
    '(() => { const c = document.querySelector(".mapcanvas__canvas"); if (!c) return false; const d = c.getContext("2d").getImageData(Math.floor(c.width/2), Math.floor(c.height/2), 1, 1).data; return d[3] > 0 })()',
    20000,
  )
  await sleep(500)

  // 初设：分方确认 + 自动布设 + 开局（走既有 store 动作，不改代码）
  out.steps.push(
    await measured(
      cdp,
      async () => {
        await cdp.eval(
          `(() => {
      const s = window.__store('setup')
      const r = s.presetSelfSetupNow()
      window.__preset = { placed: r.placed, air: r.airPlaced, remaining: r.remaining, failures: r.failures.map(f => f.label + ':' + f.reason) }
      const ok = s.startGameNow()
      window.__started = ok
    })()`,
          false,
        )
      },
      'click:初设收束(store)',
    ),
  )
  out.notes.push({
    preset: await cdp.eval('window.__preset', false),
    started: await cdp.eval('window.__started', false),
  })
  await sleep(900)
  out.notes.push({ afterStart: await cdp.eval('window.__snap()', false) })

  // 切到移动/战斗环节（最多推进 10 次）
  for (let i = 0; i < 10; i += 1) {
    const segment = await cdp.eval('window.__snap().segment', false)
    if (String(segment).includes('移动') || String(segment).includes('战斗')) break
    const rect = await cdp.eval(
      `(() => { const el = document.querySelector('.bar__advance'); return el ? window.__rect(el) : null })()`,
      false,
    )
    if (rect === null || rect.disabled) {
      out.notes.push({ at: 'advance-stop', i, rect, segment })
      break
    }
    out.steps.push(await measured(cdp, () => clickPoint(cdp, rect.x, rect.y), 'advance#' + (i + 1)))
    await sleep(120)
  }
  out.notes.push({ at: 'before-map', snap: await cdp.eval('window.__snap()', false) })

  // 悬停校准：找一格本方堆叠最多的格
  const stacksRaw = await cdp.eval(
    `(() => {
    const wb = window.__store('workbench'); const m = new Map()
    for (const u of wb.units) {
      if (u.side !== wb.activeSide) continue
      if (u.noncombatKind !== null && u.noncombatKind !== undefined) continue
      const k = u.hex.col + '.' + u.hex.row
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => ({ hex: k, n }))
  })()`,
    false,
  )
  const mapRect = await cdp.eval(
    `(() => { const r = document.querySelector('.mapcanvas__canvas').getBoundingClientRect(); return { left: r.left, top: r.top, w: r.width, h: r.height } })()`,
    false,
  )
  const samples = []
  for (const fy of [0.2, 0.45, 0.7, 0.9]) {
    for (const fx of [0.15, 0.4, 0.65, 0.88]) {
      const x = mapRect.left + mapRect.w * fx
      const y = mapRect.top + mapRect.h * fy
      const hovered = await hoverHex(cdp, Math.round(x), Math.round(y))
      if (hovered !== null) samples.push({ x, y, c: hovered.col, r: hovered.row })
    }
  }
  out.notes.push({ stacksRaw, samples: samples.length })

  let pos = null
  if (samples.length >= 3 && stacksRaw.length > 0) {
    const [c, r] = stacksRaw[0].hex.split('.').map(Number)
    const ax = solve3(samples.map((sample) => ({ c: sample.c, r: sample.r, out: sample.x })))
    const ay = solve3(samples.map((sample) => ({ c: sample.c, r: sample.r, out: sample.y })))
    if (ax && ay) {
      const px = ax[0] * c + ax[1] * r + ax[2]
      const py = ay[0] * c + ay[1] * r + ay[2]
      const okAt = async (x, y) => {
        const hovered = await hoverHex(cdp, Math.round(x), Math.round(y))
        return hovered && hovered.col === c && hovered.row === r
      }
      if (await okAt(px, py)) pos = { x: px, y: py }
      else {
        for (const step of [8, 14, 20, 28]) {
          for (let i = -4; i <= 4 && pos === null; i += 1) {
            for (let j = -4; j <= 4 && pos === null; j += 1) {
              const x = px + i * step
              const y = py + j * step
              if (
                x < mapRect.left + 4 ||
                x > mapRect.left + mapRect.w - 4 ||
                y < mapRect.top + 4 ||
                y > mapRect.top + mapRect.h - 4
              )
                continue
              if (await okAt(x, y)) pos = { x, y }
            }
          }
          if (pos !== null) break
        }
      }
    }
  }
  out.notes.push({ target: stacksRaw[0] || null, pos })

  if (pos !== null) {
    out.steps.push(
      await measured(
        cdp,
        () => clickPoint(cdp, Math.round(pos.x), Math.round(pos.y)),
        'click:stack-expand',
      ),
    )
    // 再点一次选一枚（扇面在格内展开）
    for (const [dx, dy] of [
      [0, 0],
      [10, -12],
      [-10, -12],
      [0, 12],
    ]) {
      const step = await measured(
        cdp,
        () => clickPoint(cdp, Math.round(pos.x + dx), Math.round(pos.y + dy)),
        'click:token',
      )
      out.steps.push(step)
      if (step.snap.movePick > 0 || step.snap.popup !== null || step.snap.session !== null) break
    }
    out.notes.push({ at: 'after-token', snap: await cdp.eval('window.__snap()', false) })
    const startMove = await clickByText(cdp, '开始移动')
    if (startMove) out.steps.push(startMove)
    out.notes.push({ at: 'after-session', snap: await cdp.eval('window.__snap()', false) })
  }

  out.dom = await cdp.eval(`(() => ({ nodes: document.querySelectorAll('*').length }))()`, false)
  cdp.close()
  if (!attach) {
    try {
      await fetch(`${cdpBase}/json/close/${target.id}`)
    } catch {
      /* 关标签失败不影响测量结果 */
    }
  }
  return out
}

/* ───────────────────────────── 机器负载 ───────────────────────────── */

/**
 * 采样当时的机器负载（Windows）：Edge 进程数、WebView2 进程数、CPU 平均占用
 *
 * @returns {{ msedge: number | null, webview2: number | null, cpu: number | null }}
 */
function readLoad() {
  if (process.platform !== 'win32') return { msedge: null, webview2: null, cpu: null }
  const command =
    '$e = @(Get-Process msedge -ErrorAction SilentlyContinue).Count; ' +
    '$w = @(Get-Process msedgewebview2 -ErrorAction SilentlyContinue).Count; ' +
    '$c = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; ' +
    'Write-Output ("$e|$w|$c")'
  try {
    const raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 15000,
    }).trim()
    const [msedge, webview2, cpu] = raw.split('|').map((part) => Number(part))
    return {
      msedge: Number.isFinite(msedge) ? msedge : null,
      webview2: Number.isFinite(webview2) ? webview2 : null,
      cpu: Number.isFinite(cpu) ? cpu : null,
    }
  } catch {
    return { msedge: null, webview2: null, cpu: null }
  }
}

/* ───────────────────────────── 报表 ───────────────────────────── */

/** 取一条步骤的 settle（毫秒）；没有就返回 null */
function settleOf(result, label) {
  const step = result?.steps?.find((item) => item && item.label === label)
  return step && typeof step.settle === 'number' ? step.settle : null
}

/** 突围段：动作后 `snap.segment` 含「突围」的那一步（probe 的 snap 是动作后取的） */
function breakoutOf(result) {
  const step = result?.steps?.find((item) => String(item?.snap?.segment ?? '').includes('突围'))
  return step && typeof step.settle === 'number' ? step : null
}

function keyValueOf(result, key) {
  if (key === 'enterGame') return { settle: settleOf(result, 'click:进入初设'), step: null }
  if (key === 'moveSession') return { settle: settleOf(result, 'click:开始移动'), step: null }
  const step = breakoutOf(result)
  return { settle: step ? step.settle : null, step }
}

function formatMs(value) {
  return typeof value === 'number' ? `${value}` : '—'
}

function verdictOf(value, budget) {
  if (typeof value !== 'number') return '未测到'
  return value <= budget ? `达标（≤${budget}）` : `未达标（>${budget}）`
}

/**
 * 渲染 Markdown 对照表
 *
 * @param {{ web: object | null, desktop: object | null, loads: object, options: object }} report
 * @returns {string}
 */
function renderMarkdown(report) {
  const { web, desktop, loads, options } = report
  const lines = []
  lines.push('## 桌面版 vs Web 生产包 · 同一探针对照')
  lines.push('')
  lines.push(`- 生成时间：${new Date().toISOString()}`)
  lines.push(
    `- Web 生产包：${options.skipWeb ? '（跳过）' : options.webUrl}（CDP ${options.webCdp}）`,
  )
  lines.push(
    `- 桌面版：${options.skipDesktop ? '（跳过）' : options.desktopCdp}（附加已运行窗口，按真实窗口尺寸）`,
  )
  lines.push('')
  lines.push('### 机器负载（每次采样当时）')
  lines.push('')
  lines.push('| 目标 | msedge 进程数 | msedgewebview2 进程数 | CPU 平均占用 |')
  lines.push('| --- | --- | --- | --- |')
  for (const side of [
    ['web', 'Web 生产包'],
    ['desktop', '桌面版'],
  ]) {
    const load = loads[side[0]]
    if (!load) continue
    lines.push(
      `| ${side[1]} | ${load.msedge ?? '—'} | ${load.webview2 ?? '—'} | ${load.cpu === null ? '—' : load.cpu + '%'} |`,
    )
  }
  lines.push('')
  lines.push('### 三组关键指标（与 A/B/C 验收线同口径）')
  lines.push('')
  lines.push('| 指标 | Web 生产包 settle (ms) | 桌面版 settle (ms) | 桌面版判定 |')
  lines.push('| --- | --- | --- | --- |')
  for (const metric of KEY_METRICS) {
    const webValue = web ? keyValueOf(web, metric.key).settle : null
    const deskStep = desktop ? keyValueOf(desktop, metric.key) : null
    const deskValue = deskStep ? deskStep.settle : null
    lines.push(
      `| ${metric.label} | ${formatMs(webValue)} | ${formatMs(deskValue)} | ${verdictOf(deskValue, metric.budget)} |`,
    )
  }
  lines.push('')
  lines.push('### 逐步耗时（settle = 动作 → 两帧排空；longTask = 区间内最长长任务）')
  lines.push('')
  lines.push('| 步骤 | Web settle | Web longTask | 桌面 settle | 桌面 longTask |')
  lines.push('| --- | --- | --- | --- | --- |')
  const labels = []
  for (const result of [web, desktop]) {
    for (const step of result?.steps ?? []) {
      if (!step || typeof step.label !== 'string') continue
      if (!labels.includes(step.label)) labels.push(step.label)
    }
  }
  const stepOf = (result, label) =>
    result?.steps?.find((item) => item && item.label === label) ?? null
  for (const label of labels) {
    const left = stepOf(web, label)
    const right = stepOf(desktop, label)
    lines.push(
      `| ${label} | ${formatMs(left?.settle)} | ${formatMs(left?.longTaskMax)} | ${formatMs(right?.settle)} | ${formatMs(right?.longTaskMax)} |`,
    )
  }
  lines.push('')
  lines.push('### 视口与 DOM')
  lines.push('')
  lines.push('| 目标 | 视口 | DOM 节点数 |')
  lines.push('| --- | --- | --- |')
  for (const [result, name] of [
    [web, 'Web 生产包'],
    [desktop, '桌面版'],
  ]) {
    if (!result) continue
    const viewport = result.viewport ? `${result.viewport.width}×${result.viewport.height}` : '—'
    lines.push(`| ${name} | ${viewport} | ${result.dom?.nodes ?? '—'} |`)
  }
  lines.push('')
  const failures = [web, desktop].filter((result) => result?.error)
  if (failures.length > 0) {
    lines.push('### 失败环节')
    lines.push('')
    for (const result of failures) lines.push(`- ${result.label}：${result.error}`)
    lines.push('')
  }
  return lines.join('\n')
}

/* ───────────────────────────── 参数与主流程 ───────────────────────────── */

function parseArgs(argv) {
  const options = {
    webUrl: DEFAULT_WEB_URL,
    webCdp: DEFAULT_WEB_CDP,
    desktopCdp: DEFAULT_DESKTOP_CDP,
    skipWeb: false,
    skipDesktop: false,
    out: null,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    switch (arg) {
      case '--web':
        options.webUrl = String(argv[i + 1] ?? options.webUrl)
        i += 1
        break
      case '--web-cdp':
        options.webCdp = String(argv[i + 1] ?? options.webCdp)
        i += 1
        break
      case '--desktop-cdp':
        options.desktopCdp = String(argv[i + 1] ?? options.desktopCdp)
        i += 1
        break
      case '--skip-web':
        options.skipWeb = true
        break
      case '--skip-desktop':
        options.skipDesktop = true
        break
      case '--out':
        options.out = String(argv[i + 1] ?? '')
        i += 1
        break
      case '--help':
      case '-h':
        options.help = true
        break
      default:
        if (typeof arg === 'string' && arg.startsWith('--')) {
          process.stderr.write(`[perf-compare] 忽略未知参数：${arg}\n`)
        }
        break
    }
  }
  return options
}

const HELP_TEXT = `桌面版 vs Web 生产包 · 同一探针对照

用法：node scripts/perf-compare.mjs [选项]

选项：
  --web <url>          Web 生产包地址（默认 ${DEFAULT_WEB_URL}）
  --web-cdp <url>      Web 侧 CDP 端点（默认 ${DEFAULT_WEB_CDP}）
  --desktop-cdp <url>  桌面侧 CDP 端点（默认 ${DEFAULT_DESKTOP_CDP}）
  --skip-web           不跑 Web 侧
  --skip-desktop       不跑桌面侧
  --out <file>         把 Markdown 报表另存为文件
  --help, -h           显示本帮助

前置（详见 docs 里的 D 阶段验收清单）：
  1) npm run build; npm run serve:dist -- --port 4199
  2) Edge 无头 + CDP：msedge --headless=new --remote-debugging-port=9222 ...
  3) 桌面版：设 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 后启动应用
`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(HELP_TEXT)
    return
  }

  const loads = {}
  const report = { web: null, desktop: null, loads, options }

  if (!options.skipWeb) {
    loads.web = readLoad()
    try {
      report.web = await runProbe({ label: 'web', cdpBase: options.webCdp, url: options.webUrl })
    } catch (error) {
      report.web = { label: 'web', error: String(error?.message ?? error) }
    }
  }

  if (!options.skipDesktop) {
    loads.desktop = readLoad()
    try {
      report.desktop = await runProbe({
        label: 'desktop',
        cdpBase: options.desktopCdp,
        attach: true,
      })
    } catch (error) {
      report.desktop = { label: 'desktop', error: String(error?.message ?? error) }
    }
  }

  const markdown = renderMarkdown(report)
  process.stdout.write(markdown + '\n')

  if (options.out) {
    writeFileSync(options.out, markdown + '\n', 'utf8')
    process.stdout.write(`\n已写入 ${options.out}\n`)
  }

  const failed = [report.web, report.desktop].some((result) => result?.error)
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`[perf-compare] 失败：${error?.message ?? error}\n`)
  process.exitCode = 1
})
