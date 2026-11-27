#!/usr/bin/env node
/**
 * 训练 stdio 协议服务端
 *
 * 外部训练进程（通常是 Python）spawn 本进程，通过 stdin/stdout 逐行 JSON 驱动
 * `TrainingEnv`：
 *
 *   Python → node scripts/train-stdio.mjs --scenario=1 --seed=20261126
 *   node   → {"type":"hello","protocol":"ocs-train-stdio/1","trainVersion":3,...}
 *   Python → {"id":1,"type":"reset",...}
 *   node   → {"id":1,"type":"reset","ok":true,"observation":{...},"candidates":[...]}
 *
 * 设计边界：
 * - 每行一个 JSON，stdout 只走协议；诊断日志写 stderr，避免训练侧解析被污染。
 * - 一个 Node 进程可连续 reset 多局；reset 会重建 Pinia，不沿用上一局状态。
 * - `step` 优先认 `key`（来自上一条响应的 candidates），也允许直接传 `action`。
 * - `policy:"scripted"` 由引擎脚本策略代选，用于无模型联调。
 * - 不做单独的超时；外部训练进程按自己的节奏发下一条命令。
 *
 * 参数：
 *   --scenario=1          默认剧本（可被 reset 覆盖）
 *   --seed=20261126       默认种子（可被 reset 覆盖）
 *   --control=both        both / axis / soviet
 *   --profile=full        AI 档位覆盖（full / baseline）；桥接客户端传 full，避免 baseline 把战斗投影关掉
 *   --max-steps=0          0 = 只由终止/空转截断
 *   --max-noop-steps=50    连续空转截断；0 = 关闭
 *   --max-setup-steps=500  初设补步上限
 *   --bundle=路径          训练 bundle；默认 .training-bundle/training-runner.mjs
 *   --no-bundle            回退 Vite SSR（诊断用，冷启动很慢）
 */
import { execSync } from 'node:child_process'
import { createInterface } from 'node:readline'

import { loadTrainingRuntime } from './lib/training-runtime.mjs'

const PROTOCOL = 'ocs-train-stdio/1'

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

function integerArg(name, raw, fallback, { min = 0 } = {}) {
  if (raw === undefined || raw === true) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`--${name} 需要 >=${String(min)} 的整数，收到 ${String(raw)}`)
  }
  return value
}

function stringArg(name, raw, fallback) {
  if (raw === undefined || raw === true) return fallback
  const value = String(raw).trim()
  if (value === '') throw new Error(`--${name} 不能为空`)
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

function buildDefaults(args) {
  const defaults = {}
  if (args.scenario !== undefined) defaults.scenarioId = stringArg('scenario', args.scenario)
  if (args.seed !== undefined) defaults.seed = integerArg('seed', args.seed)
  if (args.control !== undefined) defaults.control = stringArg('control', args.control)
  /*
   * --profile=full：人类客户端桥接用（Godot 客户端只借候选面驱动，不跑 AI 决策）。
   * 引擎按剧本取档位（只有 Intro 是 full），baseline 会把「战斗段可选防御格」等纯投影一并关掉，
   * 客户端因此在战役剧本里根本选不到战斗。见 env.ts TrainingEnvOptions.aiProfile。
   */
  if (args.profile !== undefined) {
    const profile = stringArg('profile', args.profile)
    if (profile !== 'full' && profile !== 'baseline') {
      throw new Error(`--profile 只认 full / baseline，收到 ${profile}`)
    }
    defaults.aiProfile = profile
  }
  if (args['max-steps'] !== undefined) {
    defaults.maxSteps = integerArg('max-steps', args['max-steps'])
  }
  if (args['max-noop-steps'] !== undefined) {
    defaults.maxNoopSteps = integerArg('max-noop-steps', args['max-noop-steps'])
  }
  if (args['max-setup-steps'] !== undefined) {
    defaults.maxSetupSteps = integerArg('max-setup-steps', args['max-setup-steps'], undefined, {
      min: 1,
    })
  }
  return defaults
}

function optionsFromCommand(command) {
  const options = {}
  for (const key of [
    'scenarioId',
    'seed',
    'control',
    'aiProfile',
    'maxSteps',
    'maxNoopSteps',
    'maxSetupSteps',
  ]) {
    if (command[key] !== undefined) options[key] = command[key]
  }
  return options
}

function protocolError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function compactInfo(info) {
  return {
    executedKey: info.executedKey,
    actionKey: info.actionKey,
    ok: info.ok,
    rule: info.rule ?? null,
    reason: info.reason ?? null,
    intent: info.intent,
    waiting: info.waiting ?? null,
    fellBack: info.fellBack === true,
    stateChanged: info.stateChanged,
    noop: info.noop,
    noopSteps: info.noopSteps,
    stalled: info.stalled,
    truncated: info.truncated,
  }
}

function main() {
  const args = parseArgs(process.argv)
  const defaults = buildDefaults(args)
  const bundlePath =
    args['no-bundle'] === true ? null : args.bundle === undefined ? undefined : String(args.bundle)

  let runtime
  let env = null
  let lastCandidates = []

  const emit = (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  }

  const fail = (id, error) => {
    emit({
      id: id ?? null,
      type: 'error',
      ok: false,
      error: {
        code: error.code ?? 'server_error',
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }

  const terminalInfo = () => {
    const session = env.ctx.session
    const game = session.session
    const finalized = game?.status.form === 'terminated'
    const verdict = session.pushedVerdicts.final ?? session.pushedVerdicts.decisive
    return {
      terminated: session.terminated,
      form: game?.status.form ?? null,
      reason: game !== null && finalized ? game.status.reason : null,
      winner: finalized ? (verdict?.winner ?? null) : null,
      outcome: finalized ? (verdict?.outcome ?? null) : null,
    }
  }

  const stateEnvelope = (observation, extra = {}) => {
    lastCandidates = env.candidates()
    return {
      observation,
      candidates: lastCandidates,
      done: env.done,
      steps: env.steps,
      terminal: terminalInfo(),
      ...extra,
    }
  }

  const requireEnv = () => {
    if (env === null) throw protocolError('not_initialized', '先发 reset 初始化训练环境')
    return env
  }

  const reset = (command) => {
    const overrides = optionsFromCommand(command)
    if (env === null) {
      const options = { ...defaults, ...overrides }
      if (options.scenarioId === undefined || options.seed === undefined) {
        throw protocolError(
          'missing_reset_options',
          '首次 reset 需要 scenarioId 与 seed（或启动时传 --scenario / --seed）',
        )
      }
      env = runtime.createTrainingEnv(options)
      const observation = env.reset()
      return stateEnvelope(observation)
    }
    const observation = env.reset(overrides)
    return stateEnvelope(observation)
  }

  const chooseAction = (command) => {
    if (command.policy !== undefined) {
      if (command.policy !== 'scripted') {
        throw protocolError('bad_policy', `不支持的 policy：${String(command.policy)}`)
      }
      return runtime.decideAiAction(env.snapshot())
    }
    if (typeof command.key === 'string' && command.key !== '') {
      const hit = lastCandidates.find((candidate) => candidate.key === command.key)
      if (hit === undefined) {
        const available = lastCandidates.map((candidate) => candidate.key)
        throw protocolError(
          'unknown_key',
          `候选里没有 key=${command.key}；当前候选：${available.slice(0, 8).join(', ') || '（空）'}`,
        )
      }
      return hit.action
    }
    if (command.action !== undefined && command.action !== null) {
      if (typeof command.action !== 'object' || Array.isArray(command.action)) {
        throw protocolError('bad_action', 'action 必须是 JSON 对象')
      }
      return command.action
    }
    throw protocolError('missing_action', 'step 需要 key、action 或 policy:"scripted"')
  }

  const step = (command) => {
    requireEnv()
    const action = chooseAction(command)
    const result = env.step(action)
    return stateEnvelope(result.observation, {
      actionKey: result.actionKey,
      reward: result.reward,
      info: compactInfo(result.info),
    })
  }

  const handle = (command) => {
    const type = command.type
    switch (type) {
      case 'ping':
        return {
          type: 'pong',
          protocol: PROTOCOL,
          trainVersion: runtime.AI_TRAIN_VERSION,
          initialized: env !== null,
        }
      case 'reset':
        return { type: 'reset', ok: true, ...reset(command) }
      case 'observe':
        requireEnv()
        return { type: 'observe', ok: true, ...stateEnvelope(env.observe()) }
      case 'candidates':
        requireEnv()
        lastCandidates = env.candidates()
        return {
          type: 'candidates',
          ok: true,
          candidates: lastCandidates,
          done: env.done,
          steps: env.steps,
          terminal: terminalInfo(),
        }
      case 'step': {
        requireEnv()
        const result = step(command)
        return { type: 'step', ok: true, ...result }
      }
      case 'actionKey': {
        requireEnv()
        if (command.action === undefined) {
          throw protocolError('missing_action', 'actionKey 需要 action')
        }
        return { type: 'actionKey', ok: true, actionKey: env.actionKey(command.action) }
      }
      case 'snapshot':
        requireEnv()
        return { type: 'snapshot', ok: true, snapshot: env.snapshot() }
      case 'checkpoint':
        requireEnv()
        env.checkpoint()
        return { type: 'checkpoint', ok: true }
      case 'restore':
      case 'restoreCheckpoint':
        requireEnv()
        env.restoreCheckpoint()
        return { type: 'restore', ok: true, ...stateEnvelope(env.observe()) }
      case 'close':
        return { type: 'close', ok: true }
      default:
        throw protocolError('unknown_command', `未知命令：${String(type)}`)
    }
  }

  const run = async () => {
    runtime = await loadTrainingRuntime({ bundlePath })
    emit({
      type: 'hello',
      protocol: PROTOCOL,
      trainVersion: runtime.AI_TRAIN_VERSION,
      commit: currentCommit(),
      pid: process.pid,
      defaults,
    })

    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
    for await (const line of rl) {
      const text = line.trim()
      if (text === '') continue
      let command
      try {
        command = JSON.parse(text)
      } catch {
        fail(null, protocolError('bad_json', '这一行不是合法 JSON'))
        continue
      }
      if (command === null || typeof command !== 'object' || Array.isArray(command)) {
        fail(null, protocolError('bad_command', '命令必须是 JSON 对象'))
        continue
      }
      const id = command.id
      try {
        const response = handle(command)
        emit({ id: id ?? null, ...response })
        if (command.type === 'close') break
      } catch (error) {
        fail(id, error)
      }
    }
    await runtime.close()
  }

  run().catch((error) => {
    emit({
      type: 'fatal',
      ok: false,
      error: {
        code: error.code ?? 'startup_error',
        message: error instanceof Error ? error.message : String(error),
      },
    })
    process.exitCode = 1
  })
}

main()
