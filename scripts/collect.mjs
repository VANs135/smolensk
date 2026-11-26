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
 *   --include-refused  连被拒绝/空转的步也写入（默认只写 ok 且盘面有变化的步）
 *   --include-candidates  记录里附完整候选动作（默认只附 candidateKeys）
 *   --bundle  训练 bundle 文件；默认 .training-bundle/training-runner.mjs
 *   --no-bundle  不预编译，回退 Vite SSR（仅诊断用）
 *   --quiet     不打印每步进度
 */
import { execSync, fork } from 'node:child_process'
import { createReadStream, createWriteStream, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'

import {
  DEFAULT_TRAINING_BUNDLE,
  ensureTrainingBundle,
  loadTrainingRuntime,
} from './lib/training-runtime.mjs'

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
    includeRefused: args['include-refused'] === true,
    includeCandidates: args['include-candidates'] === true,
    bundlePath:
      args['no-bundle'] === true
        ? null
        : typeof args.bundle === 'string'
          ? resolve(args.bundle)
          : DEFAULT_TRAINING_BUNDLE,
    quiet: args.quiet === true,
    outPath,
    workerIndex,
    workers,
  }
}

async function collectInto(options, metaType) {
  mkdirSync(dirname(options.outPath), { recursive: true })
  const stream = createWriteStream(options.outPath, { flags: 'w' })
  let runtime = null
  let total = 0
  try {
    runtime = await loadTrainingRuntime({
      bundlePath: options.bundlePath,
      workerIndex: options.workerIndex,
      cacheDir: resolve(`node_modules/.vite/collect-worker-${String(options.workerIndex)}`),
    })
    const { createTrainingEnv, decideAiAction, AI_TRAIN_VERSION } = runtime

    stream.write(
      `${JSON.stringify({
        type: metaType,
        version: AI_TRAIN_VERSION,
        commit: currentCommit(),
        scenarioId: options.scenarioId,
        seed: options.seed,
        episodes: options.episodes,
        maxSteps: options.steps,
        includeRefused: options.includeRefused,
        includeCandidates: options.includeCandidates,
        runtime: runtime.source,
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
        const candidates = env.candidates()
        const result = env.step(action)
        const candidateKeys = candidates.map((candidate) => candidate.key)
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
          stateChanged: result.info.stateChanged,
          noop: result.info.noop,
          noopSteps: result.info.noopSteps,
          stalled: result.info.stalled,
          truncated: result.info.truncated,
          candidateCount: candidateKeys.length,
          candidateKeys,
          ...(options.includeCandidates
            ? {
                candidates: candidates.map((candidate) => ({
                  key: candidate.key,
                  family: candidate.family,
                  source: candidate.source,
                  action: candidate.action,
                })),
              }
            : {}),
          ...(result.info.rule === undefined ? {} : { rule: result.info.rule }),
          ...(result.info.reason === undefined ? {} : { reason: result.info.reason }),
          reward: result.reward,
          done: result.done,
        }
        /*
         * 默认只落「引擎接受 + 盘面真的变了」的正样本。
         * 被拒/空转的步不是行为克隆数据；需要诊断时显式 --include-refused。
         */
        if (options.includeRefused || (result.info.ok && result.info.stateChanged)) {
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
    if (runtime !== null) await runtime.close()
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
    if (options.includeRefused) args.push('--include-refused')
    if (options.includeCandidates) args.push('--include-candidates')
    if (options.bundlePath === null) args.push('--no-bundle')
    else args.push(`--bundle=${options.bundlePath}`)
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
        includeRefused: first.includeRefused,
        includeCandidates: first.includeCandidates,
        runtime: first.runtime,
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
    if (options.bundlePath !== null) await ensureTrainingBundle(options.bundlePath)
    const total = await collectInto(options, 'shard-meta')
    console.log(`[worker ${String(workerIndex)}] 采集完成：${String(total)} 条 → ${outPath}`)
    return
  }

  if (workers === 1) {
    const options = readOptions(args, outPath, 0, 1)
    if (options.bundlePath !== null) await ensureTrainingBundle(options.bundlePath)
    const total = await collectInto(options, 'meta')
    console.log(`采集完成：${String(total)} 条 → ${outPath}`)
    return
  }

  const options = readOptions(args, outPath, 0, workers)
  if (options.bundlePath !== null) await ensureTrainingBundle(options.bundlePath)
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
