/**
 * 训练 CLI 的预编译入口
 *
 * `collect.mjs` / `bench-training.mjs` 每次启动都走 Vite SSR 会把
 * `src/data` + store 整套模块重新编译，单 worker 实测约 318 秒。
 * 这个入口只导出脚本真正用到的三个符号，交给 Vite 打成 Node ESM bundle；
 * 源码 import 路径不变，训练环境仍然只读同一份 store/规则。
 */
export { AI_TRAIN_VERSION } from './contract'
export { createTrainingEnv } from './env'
export { decideAiAction } from '../policy'
