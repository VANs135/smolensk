/**
 * 安卓安装包构建（Capacitor + Gradle，本地自签 release）
 *
 * ## 用法
 *   `npm run android:apk`（= build → cap sync → 本脚本）
 *
 * 本脚本只做三件 npm 脚本做不了的事：
 *   ① 把 `JAVA_HOME / ANDROID_HOME` 找齐（这两个缺一，gradlew 只会甩一句
 *      "JAVA_HOME is not set"，看不出到底缺什么）；
 *   ② 调 `gradlew assembleRelease`；
 *   ③ 把产物按版本号搬到 `release/`，并用 `apksigner` 复验一次签名。
 *
 * ## 为什么产物要搬到 release/
 * `android/app/build/outputs/` 在 .gitignore 里（是构建中间目录，随时会被清）。
 * 交付用的安装包必须落在一个稳定、可传播的位置，并且**文件名带版本**——
 * 装过旧包的人一眼能分清手上那个是不是新的。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ANDROID_DIR = join(ROOT, 'android')
const IS_WINDOWS = process.platform === 'win32'

/** 本机（这台开发机）默认的工具链位置；环境变量优先 */
const FALLBACK_JAVA_HOME = 'F:\\ocs-android-build\\jdk21\\jdk-21.0.13+9'
const FALLBACK_ANDROID_HOME = 'F:\\ocs-android-build\\android-sdk'

/**
 * 最低 Java 版本
 *
 * `@capacitor/android` 的库以 `sourceCompatibility 21` 编译（7.6 起），JDK 17 会在
 * `:capacitor-android:compileReleaseJavaWithJavac` 报「无效源发行版: 21」——
 * 那句报错看不出是"版本不够"，故在这里先拦一次并说清楚。
 */
const MIN_JAVA_FEATURE = 21

/** 从 `java -version` 的输出里读出主版本号（`-version` 走 stderr）；解析不出返回 null */
function javaFeatureVersion(javaHome) {
  const exe = IS_WINDOWS ? join(javaHome, 'bin', 'java.exe') : join(javaHome, 'bin', 'java')
  const proc = spawnSync(exe, ['-version'], { encoding: 'utf8' })
  const text = `${proc.stdout ?? ''}${proc.stderr ?? ''}`
  const match = /version "(\d+)/.exec(text)
  return match === null ? null : Number(match[1])
}

function resolveEnv() {
  const javaHome = process.env.JAVA_HOME || FALLBACK_JAVA_HOME
  const androidHome = process.env.ANDROID_HOME || FALLBACK_ANDROID_HOME

  if (!existsSync(javaHome)) {
    throw new Error(
      `找不到 JDK：${javaHome}\n` +
        `请安装 JDK ${MIN_JAVA_FEATURE} 并设置 JAVA_HOME（Capacitor 7.6 的库以 Java 21 编译）。`,
    )
  }
  const feature = javaFeatureVersion(javaHome)
  if (feature !== null && feature < MIN_JAVA_FEATURE) {
    throw new Error(
      `JDK 版本过低：${javaHome} 是 Java ${feature}，需要 ${MIN_JAVA_FEATURE}（否则报「无效源发行版: ${MIN_JAVA_FEATURE}」）。`,
    )
  }
  if (!existsSync(androidHome)) {
    throw new Error(
      `找不到 Android SDK：${androidHome}\n` +
        '请安装 Android SDK（platforms;android-35 + build-tools;35.0.0）并设置 ANDROID_HOME。',
    )
  }
  return { javaHome, androidHome }
}

function version() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
}

function main() {
  const { javaHome, androidHome } = resolveEnv()
  const env = {
    ...process.env,
    JAVA_HOME: javaHome,
    ANDROID_HOME: androidHome,
    ANDROID_SDK_ROOT: androidHome,
  }

  if (!existsSync(join(ANDROID_DIR, 'app', 'build.gradle'))) {
    throw new Error('android/ 工程不存在：先跑 `npx cap add android`。')
  }

  const gradlew = join(ANDROID_DIR, IS_WINDOWS ? 'gradlew.bat' : 'gradlew')
  console.log('[android] gradle assembleRelease …')
  execFileSync(gradlew, ['assembleRelease', '--no-daemon'], {
    cwd: ANDROID_DIR,
    env,
    stdio: 'inherit',
  })

  const apk = join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk')
  if (!existsSync(apk)) throw new Error(`没有产出 APK：${apk}`)

  const outDir = join(ROOT, 'release')
  mkdirSync(outDir, { recursive: true })
  const target = join(outDir, `SmolenskOCS-v${version()}-android.apk`)
  copyFileSync(apk, target)

  const sizeMb = (statSync(target).size / 1024 / 1024).toFixed(1)
  console.log(`[android] 安装包：${target}（${sizeMb} MB）`)

  // 复验签名：调试包 / 未签名包在真机上只会给一句"应用未安装"，看不懂原因
  const apksigner = join(
    androidHome,
    'build-tools',
    '35.0.0',
    IS_WINDOWS ? 'apksigner.bat' : 'apksigner',
  )
  if (existsSync(apksigner)) {
    const out = execFileSync(apksigner, ['verify', '--print-certs', target], { env }).toString()
    console.log(out.trim().split('\n').slice(0, 3).join('\n'))
  } else {
    console.log('[android] 未找到 apksigner，跳过签名校验')
  }
}

main()
