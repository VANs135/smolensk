#!/usr/bin/env node
/**
 * AI 训练数据采集（BC）
 *
 * 只跑 `TrainingEnv.reset/step`，不跑 `runAiSelfPlay`，不等待 Vue nextTick。
 * 默认策略是脚本 AI（`decideAiAction`），输出「动作前观测 + 动作 + 结果」的 JSONL。
 *
 * 单进程：
 *   node scripts/collect.mjs --scenario=1 --episodes=10 --steps=400 --seed=20261126 \
 *     --out=/data/ocs/ai/sc1.jsonl
 *
 * 多进程（每进程一套 Pinia；回滚/采集不共享状态）：
 *   node scripts/collect.mjs --scenario=1 --episodes=40 --steps=400 --workers=4 \
 *     --out=E:/OCS/工作文件/ai-data/sc1.jsonl
 *
 * 参数：
 *   --scenario  剧本 id（Intro / 1…7），默认 Intro
 *   --episodes  局数，默认 1
 *   --steps     每局最多步数，默认 100
 *   --seed      起始种子，逐局 +1，默认 20261126
 *   --out       输出 JSONL 路径；默认 ./ai-training-data.jsonl
 *   --workers   并行 worker 进程数，默认 1；>1 时先写 .part-N，再合并
 *   --keep-shards  合并后保留 .part-N（默认删除）
 *   --include-refused  连被引擎拒绝的步也写入（默认写，便于诊断）
 *   --quiet     不打印每步进度
 */
import { execSync, fork } from 'node:child_process'
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { createServer } from 'vite'

const SCRIPT_PATH = fileURLToPath(import.meta.url)

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

function readOptions(args, outPath, workerIndex, workers) {
  return {
    scenarioId: typeof args.scenario === 'string' ? args.scenario : 'Intro',
    episodes: nonNegativeInt(args, 'episodes', 1),
    steps: positiveInt(args, 'steps', 100),
    seed: nonNegativeInt(args, 'seed', 20261126),
    includeRefused: args['include-refused'] !== 'false',
    quiet: args.quiet === true,
    outPath,
    workerIndex,
    workers,
  }
}

async function collectInto(options, metaType) {
  mkdirSync(dirname(options.outPath), { recursive: true })
  const stream = createWriteStream(options.outPath, { flags: 'w' })
  const server = await createServer({
    appType: 'custom',
    logLevel: 'error',
    // 每个 worker 独立 dep cache；多个 Vite 进程共用 node_modules/.vite 会争锁。
    cacheDir: resolve(`node_modules/.vite/collect-worker-${String(options.workerIndex)}`),
    server: {
      middlewareMode: true,
      hmr: false,
      // 多 worker 各自一个 WS 端口；Vite 在 middleware 模式仍会建 WS 服务。
      ws: { port: 24678 + options.workerIndex },
    },
  })
  /*
   * Vite 8 的 SSR module-runner 默认 60s 传输超时。本项目首次编译 `src/data`
   * 的空档实测会超过 60s（磁盘冷缓存时约 100s），会被误判成 transport timeout。
   * 只放宽 CLI 的 SSR 传输等待；不改源码模块和构建行为。
   */
  const ssrRunner = server.environments?.ssr?.runner
  if (ssrRunner?.transport !== undefined) ssrRunner.transport.timeout = 600_000

  let total = 0
  try {
    const { createTrainingEnv } = await server.ssrLoadModule('/src/ai/training/env.ts')
    const { decideAiAction } = await server.ssrLoadModule('/src/ai/policy.ts')
    const { AI_TRAIN_VERSION } = await server.ssrLoadModule('/src/ai/training/contract.ts')

    stream.write(
      `${JSON.stringify({
        type: metaType,
        version: AI_TRAIN_VERSION,
        commit: currentCommit(),
        scenarioId: options.scenarioId,
        seed: options.seed,
        episodes: options.episodes,
        maxSteps: options.steps,
        ...(metaType === 'shard-meta'
          ? { workerIndex: options.workerIndex, workers: options.workers }
          : {}),
      })}\n`,
    )

    for (
      let episode = options.workerIndex;
      episode < options.episodes;
      episode += options.workers
    ) {
      const episodeSeed = options.seed + episode
      const env = createTrainingEnv({
        scenarioId: options.scenarioId,
        seed: episodeSeed,
        maxSteps: options.steps,
      })
      const first = env.reset()
      if (!options.quiet)
        console.log(
          `[worker ${String(options.workerIndex)}] episode ${String(episode)} reset ` +
            `${options.scenarioId} seed=${String(episodeSeed)} entities=${String(first.entities.length)}`,
        )

      for (let step = 0; step < options.steps; step += 1) {
        const snapshot = env.snapshot()
        const action = decideAiAction(snapshot)
        if (action.kind === 'none') {
          if (!options.quiet)
            console.log(
              `[worker ${String(options.workerIndex)}] episode ${String(episode)} step ${String(step)} none，提前结束`,
            )
          break
        }
        const result = env.step(action)
        const record = {
          version: AI_TRAIN_VERSION,
          episode,
          step,
          scenarioId: options.scenarioId,
          seed: episodeSeed,
          observation: result.info.before,
          actionKey: result.info.actionKey,
          executedKey: result.info.executedKey,
          action,
          ok: result.info.ok,
          ...(result.info.rule === undefined ? {} : { rule: result.info.rule }),
          ...(result.info.reason === undefined ? {} : { reason: result.info.reason }),
          reward: result.reward,
          done: result.done,
        }
        if (options.includeRefused || result.info.ok) {
          stream.write(`${JSON.stringify(record)}\n`)
          total += 1
        }
        if (!options.quiet && step % 10 === 0) {
          console.log(
            `[worker ${String(options.workerIndex)}] episode ${String(episode)} step ${String(step)} ` +
              `${result.info.actionKey} ok=${String(result.info.ok)}`,
          )
        }
        if (result.done) break
      }
    }
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      stream.end((error) => (error ? rejectClose(error) : resolveClose()))
    })
    await server.close()
  }
  return total
}

function spawnShard(options, workerIndex) {
  return new Promise((resolvePromise, rejectPromise) => {
    const args = [
      `--scenario=${options.scenarioId}`,
      `--episodes=${String(options.episodes)}`,
      `--steps=${String(options.steps)}`,
      `--seed=${String(options.seed)}`,
      `--out=${options.outPath}`,
      `--workers=${String(options.workers)}`,
      `--worker-index=${String(workerIndex)}`,
    ]
    if (!options.includeRefused) args.push('--include-refused=false')
    if (options.quiet) args.push('--quiet')
    const child = fork(SCRIPT_PATH, args, {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    })
    child.on('error', rejectPromise)
    child.on('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else
        rejectPromise(
          new Error(
            `collect worker ${String(workerIndex)} 退出异常（code=${String(code)} signal=${String(signal)}）`,
          ),
        )
    })
  })
}

async function firstJsonLine(path) {
  const reader = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  try {
    for await (const line of reader) {
      if (line.trim() === '') continue
      return JSON.parse(line)
    }
    return null
  } finally {
    reader.close()
  }
}

async function mergeShards(shardPaths, outPath, keepShards) {
  const first = await firstJsonLine(shardPaths[0])
  if (first === null || first.type !== 'shard-meta') {
    throw new Error('合并失败：首个 shard 缺少 shard-meta')
  }
  const stream = createWriteStream(outPath, { flags: 'w' })
  let total = 0
  try {
    stream.write(
      `${JSON.stringify({
        type: 'meta',
        version: first.version,
        commit: first.commit,
        scenarioId: first.scenarioId,
        seed: first.seed,
        episodes: first.episodes,
        maxSteps: first.maxSteps,
        workers: first.workers,
      })}\n`,
    )
    for (const shard of shardPaths) {
      const reader = createInterface({ input: createReadStream(shard), crlfDelay: Infinity })
      try {
        for await (const line of reader) {
          if (line.trim() === '') continue
          const parsed = JSON.parse(line)
          if (parsed.type === 'shard-meta') continue
          stream.write(`${line}\n`)
          total += 1
        }
      } finally {
        reader.close()
      }
    }
  } finally {
    await new Promise((resolveClose, rejectClose) => {
      stream.end((error) => (error ? rejectClose(error) : resolveClose()))
    })
  }
  if (!keepShards) {
    for (const shard of shardPaths) {
      try {
        unlinkSync(shard)
      } catch {
        // 分片清理失败不掩盖合并结果；留在磁盘上供人工核对。
      }
    }
  }
  return total
}

async function main() {
  const args = parseArgs(process.argv)
  const outPath = resolve(typeof args.out === 'string' ? args.out : 'ai-training-data.jsonl')
  const workerIndex = nonNegativeInt(args, 'worker-index', 0)
  const workers = positiveInt(args, 'workers', 1)

  if (args['worker-index'] !== undefined) {
    const options = readOptions(args, outPath, workerIndex, workers)
    const total = await collectInto(options, 'shard-meta')
    console.log(`[worker ${String(workerIndex)}] 采集完成：${String(total)} 条 → ${outPath}`)
    return
  }

  if (workers === 1) {
    const options = readOptions(args, outPath, 0, 1)
    const total = await collectInto(options, 'meta')
    console.log(`采集完成：${String(total)} 条 → ${outPath}`)
    return
  }

  const options = readOptions(args, outPath, 0, workers)
  const shardPaths = Array.from(
    { length: workers },
    (_, index) => `${outPath}.part-${String(index)}`,
  )
  const shardOptions = shardPaths.map((shardPath, index) => ({
    ...options,
    outPath: shardPath,
    workerIndex: index,
  }))
  await Promise.all(shardOptions.map((shard, index) => spawnShard(shard, index)))
  const total = await mergeShards(shardPaths, outPath, args['keep-shards'] === true)
  console.log(`采集完成：${String(total)} 条 → ${outPath}（${String(workers)} worker）`)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
