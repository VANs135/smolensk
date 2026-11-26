#!/usr/bin/env node
/**
 * 预编译训练 CLI 的 Node bundle
 *
 * 只走 Vite 的 SSR build（无浏览器入口、无 UI），把 `src/ai/training/entry.ts`
 * 打成一个 Node ESM 文件。之后 `collect.mjs` / `bench-training.mjs` 直接 import，
 * 不再为每个 worker 重新跑 Vite SSR 模块图。
 *
 * 用法：
 *   npm run build:train
 *   node scripts/build-training-bundle.mjs --out-dir=E:/OCS/工作文件/training-bundle
 */
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'vite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_TRAINING_BUNDLE_DIR = resolve(ROOT, '.training-bundle')
export const TRAINING_BUNDLE_FILE = 'training-runner.mjs'

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

/**
 * @param {string} [outDir]
 * @returns {Promise<string>} bundle 文件的绝对路径
 */
export async function buildTrainingBundle(outDir = DEFAULT_TRAINING_BUNDLE_DIR) {
  const absoluteOutDir = resolve(outDir)
  mkdirSync(absoluteOutDir, { recursive: true })
  await build({
    root: ROOT,
    configFile: resolve(ROOT, 'vite.config.ts'),
    logLevel: 'warn',
    build: {
      // 只打训练入口；SSR build 不生成 index.html，也不复制 public。
      ssr: resolve(ROOT, 'src/ai/training/entry.ts'),
      outDir: absoluteOutDir,
      emptyOutDir: true,
      copyPublicDir: false,
      target: 'node20',
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: TRAINING_BUNDLE_FILE,
          format: 'es',
        },
      },
    },
  })
  const bundlePath = resolve(absoluteOutDir, TRAINING_BUNDLE_FILE)
  if (!existsSync(bundlePath)) {
    throw new Error(`训练 bundle 未生成：${bundlePath}`)
  }
  return bundlePath
}

async function main() {
  const args = parseArgs(process.argv)
  const outDir =
    typeof args['out-dir'] === 'string' ? resolve(args['out-dir']) : DEFAULT_TRAINING_BUNDLE_DIR
  const started = performance.now()
  const bundlePath = await buildTrainingBundle(outDir)
  console.log(`训练 bundle 已生成：${bundlePath}（${(performance.now() - started).toFixed(0)} ms）`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error)
    process.exitCode = 1
  })
}
