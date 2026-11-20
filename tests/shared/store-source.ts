// 测试侧「聚合源码」读取器：把 facade 与它的全部领域切片拼成一份文本
//
// 为什么需要：`tests/**` 里有三十多处「源码守卫」测试，直接读 `src/stores/workbench.ts`
// 的文本、断言某段实现存在（例如"账本喂给引擎的两条事实"）。解构把这些实现搬进
// `workbench-<域>.ts` 之后，守卫会因为"文件里没有这段字"而假红 —— 那不代表行为变了。
//
// 所以统一从这里取：facade + 同目录下所有 `workbench-*.ts` 切片，按文件名排序拼接。
// 新增切片无需改任何测试，守卫自动覆盖到新文件。
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const STORE_DIR = 'src/stores'
const FACADE = 'workbench.ts'

let cached: string | null = null

/** facade + 全部 `workbench-*.ts` 切片的源码拼接（进程内缓存） */
export function readStoreSource(): string {
  if (cached !== null) return cached
  const slices = readdirSync(STORE_DIR)
    .filter((name) => name.startsWith('workbench-') && name.endsWith('.ts'))
    .sort()
  // ★ 顺序有讲究：切片在前、facade 在后。
  //   守卫普遍用 `source.indexOf('function X')` 去截函数体；搬走之后 facade 里只剩
  //   `function X(...) { return barrage.X(...) }` 这样的同名薄壳，若 facade 在前，
  //   indexOf 会截到那层壳、断言随之中假红。切片在前 ⇒ 命中的是真正的实现。
  cached = [...slices, FACADE].map((name) => readFileSync(join(STORE_DIR, name), 'utf8')).join('\n')
  return cached
}
