/**
 * 训练 CLI 的运行时加载器：预编译 bundle 优先，Vite SSR 仅作兜底
 *
 * 为什么要这层：Vite 8 每次 `createServer` + `ssrLoadModule` 都会重建模块图，
 * 冷盘 `src/data` 曾在单 worker 上报 318 秒启动；bundle 生成后这里只做一次
 * Node `import()`。bundle 不存在时仍保留旧路径，避免脚本在未构建时不可用。
 */
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DEFAULT_TRAINING_BUNDLE = resolve(ROOT, '.training-bundle/training-runner.mjs')

function assertRuntime(mod, source) {
  for (const name of ['createTrainingEnv', 'decideAiAction', 'AI_TRAIN_VERSION']) {
    if (mod[name] === undefined) throw new Error(`${source} 缺少导出 ${name}`)
  }
  return {
    source,
    createTrainingEnv: mod.createTrainingEnv,
    decideAiAction: mod.decideAiAction,
    AI_TRAIN_VERSION: mod.AI_TRAIN_VERSION,
    close: async () => {},
  }
}

async function relaxSsrTransport(server) {
  const apply = (runner) => {
    if (runner?.transport !== undefined) runner.transport.timeout = 600_000
  }
  apply(server.environments?.ssr?.runner)
  /*
   * `ssrLoadModule` 实际用的是 `_ssrCompatModuleRunner`，它自己 new 了一个
   * transport，和 environment.runner 不是同一个对象；先加载轻量模块实例化 runner。
   */
  if (server._ssrCompatModuleRunner === undefined)
    await server.ssrLoadModule('/src/ai/training/contract.ts')
  apply(server._ssrCompatModuleRunner)
}

async function loadViteRuntime({ workerIndex, cacheDir }) {
  const { createServer } = await import('vite')
  const server = await createServer({
    appType: 'custom',
    logLevel: 'error',
    cacheDir,
    server: {
      middlewareMode: true,
      hmr: false,
      // 多 worker 各自一个 WS 端口；Vite 在 middleware 模式仍会建 WS 服务。
      ws: { port: 24678 + workerIndex },
    },
  })
  await relaxSsrTransport(server)
  const { createTrainingEnv } = await server.ssrLoadModule('/src/ai/training/env.ts')
  const { decideAiAction } = await server.ssrLoadModule('/src/ai/policy.ts')
  const { AI_TRAIN_VERSION } = await server.ssrLoadModule('/src/ai/training/contract.ts')
  return {
    source: 'vite-ssr',
    createTrainingEnv,
    decideAiAction,
    AI_TRAIN_VERSION,
    close: () => server.close(),
  }
}

/**
 * @param {{ bundlePath?: string | null, workerIndex?: number, cacheDir?: string }} [options]
 */
export async function loadTrainingRuntime(options = {}) {
  const workerIndex = options.workerIndex ?? 0
  const cacheDir =
    options.cacheDir ?? resolve(ROOT, `node_modules/.vite/training-worker-${String(workerIndex)}`)
  const bundlePath = options.bundlePath === undefined ? DEFAULT_TRAINING_BUNDLE : options.bundlePath
  if (bundlePath !== null && existsSync(bundlePath)) {
    try {
      const mod = await import(pathToFileURL(bundlePath).href)
      return assertRuntime(mod, `bundle(${bundlePath})`)
    } catch (error) {
      console.warn(
        `[training-runtime] bundle 加载失败，回退 Vite SSR：${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return loadViteRuntime({ workerIndex, cacheDir })
}

/** bundle 不存在时按需构建一次；父进程在 fork worker 前调用，避免多 worker 并发构建。 */
export async function ensureTrainingBundle(bundlePath = DEFAULT_TRAINING_BUNDLE) {
  if (bundlePath === null || existsSync(bundlePath)) return bundlePath
  const { buildTrainingBundle } = await import('../build-training-bundle.mjs')
  return buildTrainingBundle(dirname(bundlePath))
}
