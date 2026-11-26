#!/usr/bin/env node
/**
 * AI 训练数据采集（BC）
 *
 * 只跑 `TrainingEnv.reset/step`，不跑 `runAiSelfPlay`，不等待 Vue nextTick。
 * 默认策略是脚本 AI（`decideAiAction`），输出「动作前观测 + 动作 + 结果」的 JSONL。
 *
 * 用法：
 *   node scripts/collect.mjs --scenario=Intro --episodes=1 --steps=20 --seed=20261126 \
 *     --out=E:/OCS/工作文件/ai-data/intro.jsonl
 *
 * 参数：
 *   --scenario  剧本 id（Intro / 1…7），默认 Intro
 *   --episodes  局数，默认 1
 *   --steps     每局最多步数，默认 100
 *   --seed      起始种子，逐局 +1，默认 20261126
 *   --out       输出 JSONL 路径；默认 ./ai-training-data.jsonl
 *   --include-refused  连被引擎拒绝的步也写入（默认写，便于诊断）
 *   --quiet     不打印每步进度
 */
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createServer } from 'vite'

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

function numberArg(args, name, fallback) {
  const raw = args[name]
  if (raw === undefined || raw === true) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} 需要非负整数，收到 ${raw}`)
  return value
}

async function main() {
  const args = parseArgs(process.argv)
  const scenarioId = typeof args.scenario === 'string' ? args.scenario : 'Intro'
  const episodes = numberArg(args, 'episodes', 1)
  const steps = numberArg(args, 'steps', 100)
  const seed = numberArg(args, 'seed', 20261126)
  const outPath = resolve(typeof args.out === 'string' ? args.out : 'ai-training-data.jsonl')
  const quiet = args.quiet === true
  const includeRefused = args['include-refused'] !== 'false'

  mkdirSync(dirname(outPath), { recursive: true })
  const stream = createWriteStream(outPath, { flags: 'w' })
  const server = await createServer({
    appType: 'custom',
    logLevel: 'error',
    server: { middlewareMode: true },
  })

  let total = 0
  try {
    const { createTrainingEnv } = await server.ssrLoadModule('/src/ai/training/env.ts')
    const { decideAiAction } = await server.ssrLoadModule('/src/ai/policy.ts')
    const { AI_TRAIN_VERSION } = await server.ssrLoadModule('/src/ai/training/contract.ts')

    for (let episode = 0; episode < episodes; episode += 1) {
      const episodeSeed = seed + episode
      const env = createTrainingEnv({ scenarioId, seed: episodeSeed, maxSteps: steps })
      const first = env.reset()
      if (!quiet)
        console.log(
          `[episode ${String(episode)}] reset ${scenarioId} seed=${String(episodeSeed)} entities=${String(first.entities.length)}`,
        )

      for (let step = 0; step < steps; step += 1) {
        const snapshot = env.snapshot()
        const action = decideAiAction(snapshot)
        if (action.kind === 'none') {
          if (!quiet)
            console.log(`[episode ${String(episode)}] step ${String(step)} none，提前结束`)
          break
        }
        const result = env.step(action)
        const record = {
          version: AI_TRAIN_VERSION,
          episode,
          step,
          scenarioId,
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
        if (includeRefused || result.info.ok) {
          stream.write(`${JSON.stringify(record)}\n`)
          total += 1
        }
        if (!quiet && step % 10 === 0) {
          console.log(
            `[episode ${String(episode)}] step ${String(step)} ${result.info.actionKey} ok=${String(result.info.ok)}`,
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
  console.log(`采集完成：${String(total)} 条 → ${outPath}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error)
  process.exitCode = 1
})
