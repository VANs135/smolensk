import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置（安卓安装包）
 *
 * ## 为什么是 Capacitor 而不是继续用 Tauri
 * 本工程是**纯前端**：全仓不引 `@tauri-apps/api`，存档走 `localStorage / IndexedDB`
 * （`src/shared/storage.ts`），没有一处原生调用。Tauri 安卓要额外背一套 NDK + Rust
 * 交叉编译链，而 Capacitor 只是一层 WebView 壳——同样的界面，构建链短、产物小、
 * 且 `dist` 与桌面/网页三端共用同一份构建。
 *
 * ## 与桌面壳的关系
 * `src-tauri/` 原样保留（Windows 安装包照旧 `npm run tauri:build`）；
 * 两端互不影响，只是共享同一个 `dist`。
 */
const config: CapacitorConfig = {
  /** 与桌面壳 `identifier` 保持一致：同机装两个包也认得是同一个应用 */
  appId: 'local.ocs.smolensk',
  appName: '斯摩棱斯克',
  webDir: 'dist',
  /**
   * 存档写在 WebView 的 origin 下：换成自定义 scheme 会让老存档（同机旧版）
   * 落到另一个存储域里读不出来。固定 `https` + 稳定 host 即可。
   */
  server: {
    androidScheme: 'https',
  },
  android: {
    /**
     * 首帧底色：与命令台底色同值（`--color-command-bg`）。
     * 否则 WebView 起来前会闪一下白/黑，横屏下整块屏幕跳一下很刺眼。
     */
    backgroundColor: '#f2efe7',
    /** 不允许 https 页面混载 http 资源：本工程资源全在本包内，没有例外需求 */
    allowMixedContent: false,
    /** 输入法交互交给 WebView 自己处理（本项目只有极少数文本输入） */
    captureInput: true,
  },
}

export default config
