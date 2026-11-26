#!/usr/bin/env node
/**
 * TrainingEnv 吞吐基线（多进程，不跑 ai-selfplay）
 *
 * 每个 worker 是一个独立 Node 进程 + 独立 Pinia；同一 worker 在同一个起点
 * checkpoint 上反复跑「推进 → 回滚」，避免把 reset/初设成本混进步伐统计。
 *
 * 用法：
 *   node scripts/bench-training.mjs --scenario=1 --steps=200 --episodes=2 --workers=auto
 *   node scripts/bench-training.mjs --workers=1,2,4 --steps=100 --out=E:/OCS/工作文件/ai-data/bench.json
 *
 * 输出：JSON 基线（吞吐、p50/p95、内存峰值、CPU、10^6 步估算）。
 * 注意：这是开发/采集基线，不是训练；不启动 ai-selfplay，也不读取模型。
 */
import { fork, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createServer } from 'vite'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

function parseArgs(argv) {
  const args = {}
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) throw new Error(`未知参数：${raw}`)
    const body = raw.slice(2)
    const eq = body.indexOf('=')
    if (eq < 0) args[body] = true
    else args[body.slice(0, eq)] = body.slice(eq + 1)
  }
  return args
}

function valueArg(args, name, fallback) {
  const raw = args[name]
  if (raw === undefined || raw === true) return fallback
  return String(raw)
}

function positiveInt(args, name, fallback) {
  const raw = args[name]
  if (raw === undefined || raw === true) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} 需要正整数，收到 ${raw}`)
  return value
}

function nonNegativeInt(args, name, fallback) {
  const raw = args[name]
  if (raw === undefined || raw === true) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} 需要非负整数，收到 ${raw}`)
  return value
}

function currentCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

function percentile(values, p) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[index]
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits))
}

function cpuInfo() {
  const list = cpus()
  return {
    model: list[0]?.model ?? 'unknown',
    logicalCores: list.length,
    totalMemGb: round(totalmem() / 1024 ** 3, 1),
    freeMemGb: round(freemem() / 1024 ** 3, 1),
  }
}

function workerList(args) {
  const raw = args.workers
  if (raw === undefined || raw === true || raw === 'auto') {
    return [Math.max(1, cpus().length)]
  }
  const list = String(raw)
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
  if (list.length === 0) throw new Error(`--workers 需要 auto 或正整数列表，收到 ${String(raw)}`)
  return [...new Set(list)].sort((a, b) => a - b)
}

function makeWorkerArgs(options, workerIndex, workerTotal) {
  return [
    `--scenario=${options.scenarioId}`,
    `--steps=${String(options.steps)}`,
    `--episodes=${String(options.episodes)}`,
    `--warmup=${String(options.warmup)}`,
    `--seed=${String(options.seed)}`,
    `--worker-index=${String(workerIndex)}`,
    `--worker-total=${String(workerTotal)}`,
    `--quiet`,
  ]
}

function prepareWorker(options, workerIndex, workerTotal, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    const child = fork(SCRIPT_PATH, makeWorkerArgs(options, workerIndex, workerTotal), {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    let ready = false
    let result
    let doneResolve
    let doneReject
    const done = new Promise((resolvePromise, rejectPromise) => {
      doneResolve = resolvePromise
      doneReject = rejectPromise
    })
    const timer = setTimeout(() => {
      if (ready) return
      ready = true
      child.kill('SIGTERM')
      rejectReady(new Error(`worker ${String(workerIndex)} 启动超时（${String(timeoutMs)} ms）`))
    }, timeoutMs)

    const fail = (error) => {
      if (!ready) rejectReady(error)
      else doneReject(error)
    }

    child.on('message', (payload) => {
      if (payload === null || typeof payload !== 'object') return
      if (payload.type === 'bench-ready' && !ready) {
        ready = true
        clearTimeout(timer)
        resolveReady({ child, done })
      }
      if (payload.type === 'bench-result') {
        result = payload
        if (typeof payload.error === 'string') {
          doneReject(new Error(`worker ${String(workerIndex)}：${payload.error}`))
        } else {
          doneResolve(payload)
        }
      }
    })
    child.on('error', fail)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (!ready) {
        rejectReady(
          new Error(
            `worker ${String(workerIndex)} 启动失败（code=${String(code)} signal=${String(signal)}）`,
          ),
        )
        return
      }
      if (code === 0 && result !== undefined) doneResolve(result)
      else {
        const detail =
          result !== undefined && typeof result.error === 'string' ? `：${result.error}` : ''
        doneReject(
          new Error(
            `worker ${String(workerIndex)} 退出异常（code=${String(code)} signal=${String(signal)}）${detail}`,
          ),
        )
      }
    })
  })
}

function readWorkerResult(message, workerIndex) {
  if (message === undefined) throw new Error(`worker ${String(workerIndex)} 没有返回结果`)
  if (message.error !== undefined)
    throw new Error(`worker ${String(workerIndex)}：${message.error}`)
  return message
}

async function runLevel(options, workers) {
  const levelStartedAt = performance.now()
  const prepared = []
  try {
    // 启动串行化：避免多个 Vite SSR 同时编译、互相抢 CPU 导致 transport 超时。
    for (let index = 0; index < workers; index += 1) {
      prepared.push(await prepareWorker(options, index, workers, options.timeoutMs))
    }
  } catch (error) {
    for (const item of prepared) item.child.kill('SIGTERM')
    throw error
  }
  const startupWallMs = performance.now() - levelStartedAt

  const startedAt = performance.now()
  for (const item of prepared) item.child.send({ type: 'bench-go' })
  const results = await Promise.all(prepared.map((item) => item.done))
  const wallMs = performance.now() - startedAt
  const workerResults = results.map((message, index) => readWorkerResult(message, index))
  const totalSteps = workerResults.reduce((sum, item) => sum + item.steps, 0)
  const totalStepMs = workerResults.reduce((sum, item) => sum + item.totalStepMs, 0)
  // 多 worker 的步是并行的：总吞吐取「最慢 worker 的步+回滚循环」作临界路径，
  // 不是把各 worker 的 stepMs 相加（那会把并行时间重复计一次）。reset 是起步成本，单列。
  const criticalPathMs = Math.max(
    0,
    ...workerResults.map((item) => item.totalStepMs + item.rollbackMs),
  )
  const throughput = totalSteps / (criticalPathMs / 1000)
  const wallThroughput = totalSteps / (wallMs / 1000)
  const perWorkerThroughput = totalSteps / (totalStepMs / 1000)
  const peakRssMb = workerResults.reduce((sum, item) => sum + item.rssPeakMb, 0)
  const stepDurations = workerResults.flatMap((item) => item.stepDurations)

  return {
    workers,
    startupWallMs: round(startupWallMs),
    wallMs: round(wallMs),
    totalSteps,
    criticalPathMs: round(criticalPathMs),
    throughputStepsPerSecond: round(throughput, 2),
    wallThroughputStepsPerSecond: round(wallThroughput, 2),
    perWorkerStepsPerSecond: round(perWorkerThroughput, 2),
    parallelEfficiency: round(throughput / Math.max(1e-9, perWorkerThroughput * workers), 2),
    stepMs: {
      mean: round(totalStepMs / Math.max(1, totalSteps), 3),
      p50: round(percentile(stepDurations, 0.5), 3),
      p95: round(percentile(stepDurations, 0.95), 3),
      max: round(Math.max(0, ...stepDurations), 3),
    },
    rollbackMs: {
      mean: round(
        workerResults.reduce((sum, item) => sum + item.rollbackMs, 0) /
          Math.max(
            1,
            workerResults.reduce((sum, item) => sum + item.rollbackCount, 0),
          ),
        3,
      ),
      total: round(
        workerResults.reduce((sum, item) => sum + item.rollbackMs, 0),
        3,
      ),
    },
    episodeSteps: workerResults.map((item) => item.episodeSteps),
    resetMs: {
      mean: round(
        workerResults.reduce((sum, item) => sum + item.resetMs, 0) / Math.max(1, workers),
        3,
      ),
    },
    moduleLoadMs: round(
      workerResults.reduce((sum, item) => sum + item.moduleLoadMs, 0) / Math.max(1, workers),
      3,
    ),
    rssPeakMbPerWorker: round(peakRssMb / Math.max(1, workers), 1),
    rssPeakMbTotal: round(peakRssMb, 1),
    cpuMs: {
      user: round(
        workerResults.reduce((sum, item) => sum + item.cpuUserMs, 0),
        1,
      ),
      system: round(
        workerResults.reduce((sum, item) => sum + item.cpuSystemMs, 0),
        1,
      ),
    },
    workerResults,
    estimates: estimateForMillion(throughput, workers, perWorkerThroughput),
  }
}

function estimateForMillion(throughput, workers, perWorkerThroughput) {
  const hoursAtThisConcurrency = 1_000_000 / Math.max(1e-9, throughput) / 3600
  const coreHours = hoursAtThisConcurrency * workers
  const coresForOneHour = Math.ceil(1_000_000 / Math.max(1e-9, perWorkerThroughput) / 3600)
  return {
    steps: 1_000_000,
    hoursAtThisConcurrency: round(hoursAtThisConcurrency, 2),
    coreHours: round(coreHours, 2),
    coresForOneHour: coresForOneHour,
    note: '按稳态步耗时外推；未含 Vite SSR/进程启动、数据写盘、模型推理与网络开销。',
  }
}

async function runParent(args) {
  const options = {
    scenarioId: valueArg(args, 'scenario', '1'),
    steps: positiveInt(args, 'steps', 200),
    episodes: positiveInt(args, 'episodes', 2),
    warmup: positiveInt(args, 'warmup', 10),
    seed: positiveInt(args, 'seed', 20261126),
    timeoutMs: positiveInt(args, 'timeout-ms', 900_000),
    outPath: resolve(valueArg(args, 'out', 'E:/OCS/工作文件/ai-data/bench-training.json')),
    quiet: args.quiet === true,
  }
  const levels = workerList(args)
  mkdirSync(dirname(options.outPath), { recursive: true })

  const report = {
    type: 'bench',
    generatedAt: new Date().toISOString(),
    commit: currentCommit(),
    scenarioId: options.scenarioId,
    seed: options.seed,
    stepsPerEpisode: options.steps,
    episodes: options.episodes,
    warmupSteps: options.warmup,
    cpu: cpuInfo(),
    runs: [],
  }

  for (const workers of levels) {
    if (!options.quiet) console.log(`[bench] workers=${String(workers)} ...`)
    const level = await runLevel(options, workers)
    report.runs.push(level)
    if (!options.quiet) {
      console.log(
        `[bench] workers=${String(workers)} steps=${String(level.totalSteps)} ` +
          `tps=${String(level.throughputStepsPerSecond)} p50=${String(level.stepMs.p50)}ms ` +
          `rss=${String(level.rssPeakMbPerWorker)}MB/worker`,
      )
    }
  }

  writeFileSync(options.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`基线已写入：${options.outPath}`)
  for (const level of report.runs) {
    console.log(
      `  ${String(level.workers)} worker：${String(level.throughputStepsPerSecond)} 步/秒，` +
        `100 万步 ${String(level.estimates.hoursAtThisConcurrency)} 小时 / ${String(level.estimates.coreHours)} core-hour，` +
        `1 小时需 ${String(level.estimates.coresForOneHour)} 核`,
    )
  }
}

async function runWorker(args) {
  const workerIndex = nonNegativeInt(args, 'worker-index', 0)
  const workerTotal = positiveInt(args, 'worker-total', 1)
  const scenarioId = valueArg(args, 'scenario', '1')
  const steps = positiveInt(args, 'steps', 200)
  const episodes = positiveInt(args, 'episodes', 2)
  const warmup = positiveInt(args, 'warmup', 10)
  const seed = positiveInt(args, 'seed', 20261126) + workerIndex
  const quiet = args.quiet === true

  let server
  let moduleLoadMs = 0
  let resetMs = 0
  let checkpointMs = 0
  let rollbackMs = 0
  let rollbackCount = 0
  let stepDurations = []
  let episodeSteps = []
  let totalStepMs = 0
  let stepsDone = 0
  let rssPeak = process.memoryUsage().rss
  let heapPeak = process.memoryUsage().heapUsed
  const startedAt = performance.now()

  const sampleMemory = () => {
    const usage = process.memoryUsage()
    rssPeak = Math.max(rssPeak, usage.rss)
    heapPeak = Math.max(heapPeak, usage.heapUsed)
  }

  try {
    const loadStarted = performance.now()
    server = await createServer({
      appType: 'custom',
      logLevel: 'error',
      cacheDir: resolve(`node_modules/.vite/bench-worker-${String(workerIndex)}`),
      server: {
        middlewareMode: true,
        hmr: false,
        // Vite 在 middleware 模式仍会建 WS 服务；多 worker 必须各用各的端口。
        ws: { port: 24678 + workerIndex },
      },
    })
    /*
     * 首次编译 `src/data` 在冷缓存下可能超过 Vite 默认的 60s SSR transport 超时；
     * 这里放宽到 10 分钟，避免把慢启动误报成模块错误。
     */
    const ssrRunner = server.environments?.ssr?.runner
    if (ssrRunner?.transport !== undefined) ssrRunner.transport.timeout = 600_000
    const { createTrainingEnv } = await server.ssrLoadModule('/src/ai/training/env.ts')
    const { decideAiAction } = await server.ssrLoadModule('/src/ai/policy.ts')
    const { AI_TRAIN_VERSION } = await server.ssrLoadModule('/src/ai/training/contract.ts')
    moduleLoadMs = performance.now() - loadStarted
    sampleMemory()

    const env = createTrainingEnv({ scenarioId, seed, maxSteps: 0 })
    const resetStarted = performance.now()
    const first = env.reset()
    resetMs = performance.now() - resetStarted
    sampleMemory()
    if (!quiet)
      console.log(
        `[worker ${String(workerIndex)}] reset ${scenarioId} seed=${String(seed)} entities=${String(first.entities.length)}`,
      )

    const checkpointStarted = performance.now()
    env.checkpoint()
    checkpointMs = performance.now() - checkpointStarted
    sampleMemory()

    // 启动串行化：编译/初设都完成后才向父进程报到；父进程统一发 go，再并行跑步。
    process.send?.({ type: 'bench-ready', workerIndex })
    await new Promise((resolveGo, rejectGo) => {
      const onMessage = (payload) => {
        if (payload !== null && typeof payload === 'object' && payload.type === 'bench-go') {
          process.off('message', onMessage)
          resolveGo()
        }
      }
      process.on('message', onMessage)
      process.once('disconnect', () => rejectGo(new Error('父进程断开，bench 未收到 go')))
    })

    const runCycle = (limit, record) => {
      let localSteps = 0
      while (localSteps < limit && !env.done) {
        const stepStarted = performance.now()
        const snapshot = env.snapshot()
        const action = decideAiAction(snapshot)
        if (action.kind === 'none') break
        const result = env.step(action)
        const duration = performance.now() - stepStarted
        localSteps += 1
        if (record) {
          stepDurations.push(duration)
          totalStepMs += duration
          stepsDone += 1
        }
        if (localSteps % 10 === 0) sampleMemory()
        if (result.done) break
      }
      return localSteps
    }

    if (warmup > 0) {
      runCycle(Math.min(warmup, steps), false)
      const rollbackStarted = performance.now()
      env.restoreCheckpoint()
      rollbackMs += performance.now() - rollbackStarted
      rollbackCount += 1
    }

    for (let episode = 0; episode < episodes; episode += 1) {
      const measured = runCycle(steps, true)
      episodeSteps.push(measured)
      sampleMemory()
      const rollbackStarted = performance.now()
      env.restoreCheckpoint()
      rollbackMs += performance.now() - rollbackStarted
      rollbackCount += 1
      sampleMemory()
    }

    const usage = process.resourceUsage()
    const result = {
      type: 'bench-result',
      trainVersion: AI_TRAIN_VERSION,
      workerIndex,
      workerTotal,
      seed,
      steps: stepsDone,
      episodeSteps,
      stepDurations: stepDurations.map((value) => round(value, 3)),
      totalStepMs: round(totalStepMs, 3),
      resetMs: round(resetMs, 3),
      checkpointMs: round(checkpointMs, 3),
      rollbackMs: round(rollbackMs, 3),
      rollbackCount,
      moduleLoadMs: round(moduleLoadMs, 3),
      rssPeakMb: round(rssPeak / 1024 / 1024, 1),
      heapPeakMb: round(heapPeak / 1024 / 1024, 1),
      cpuUserMs: round(usage.userCPUTime / 1000, 1),
      cpuSystemMs: round(usage.systemCPUTime / 1000, 1),
      elapsedMs: round(performance.now() - startedAt, 3),
    }
    /*
     * 结果送到父进程后强制退出：Vite 的 middleware WS 有时会在 `server.close()`
     * 后仍留一个句柄，导致 worker 已跑完但进程不退、父进程一直等 exit。
     * 这是 CLI worker，没有需要优雅收尾的外部资源；把 IPC 回调作为退出门。
     */
    if (process.send !== undefined) process.send(result, () => process.exit(0))
    else process.exitCode = 0
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    if (process.send !== undefined)
      process.send({ type: 'bench-result', workerIndex, error: message }, () => process.exit(1))
    else process.exitCode = 1
  }
}

async function main() {
  const args = parseArgs(process.argv)
  if (args['worker-index'] !== undefined) await runWorker(args)
  else await runParent(args)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
