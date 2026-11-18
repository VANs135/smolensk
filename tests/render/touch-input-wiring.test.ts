import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * 触摸屏适配的**接线守卫**（安卓安装包：右键 → 长按、滚轮 → 双指捏合）
 *
 * 这一层没有组件挂载测试（仓里没有 `@vue/test-utils`），而"改了写法但忘了接线"这类
 * 退化在桌面浏览器上**看不出来**：鼠标右键照旧能用、滚轮照旧能缩放，只有真机上才发现
 * 长按没反应、两指捏不动。故把关键接线点按函数体切片钉住。
 */

const read = (path: string): string => readFileSync(path, 'utf8')

/** 按函数名切出函数体（到下一个 `function ` 声明为止，与其他守卫用例同口径） */
function bodyOf(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} 应存在`).toBeGreaterThan(-1)
  const next = source.indexOf('function ', start + 10)
  return source.slice(start, next > 0 ? next : source.length)
}

describe('地图画布：触摸手势接线', () => {
  const source = read('src/components/map/MapCanvas.vue')

  it('★ 长按判成后走的是**同一个** hexContext 出口（右键与长按不分叉）', () => {
    expect(source).toContain('function emitContextAt(')
    const longPress = bodyOf(source, 'startLongPress')
    expect(longPress, '长按必须调 emitContextAt').toContain('emitContextAt(start)')
    // 鼠标右键也走这一条（否则两条路各写一份换算，迟早错格）
    expect(bodyOf(source, 'onContextMenu')).toContain('emitContextAt(')
  })

  it('★ 长按成立后要吃掉随后的 click（否则松手会再点一次那一格）', () => {
    expect(bodyOf(source, 'startLongPress')).toContain('suppressNextClick()')
    expect(bodyOf(source, 'onPointerUp')).toContain('longPressFired')
  })

  it('★ 长按成立时**不**复位 drag（否则抬起走早退分支，longPressFired 留到下一次点击上）', () => {
    expect(bodyOf(source, 'startLongPress')).not.toContain('drag = IDLE_DRAG')
    // 抬手前剩下的移动也不再平移（菜单已经开着，底下的图乱动会让人点错）
    expect(bodyOf(source, 'onPointerMove')).toContain('if (longPressFired) return')
    // 新手势开始要清标记，否则长按过之后的第一次点击会被吞掉
    expect(bodyOf(source, 'onPointerDown')).toContain('longPressFired = false')
  })

  it('长按只在触摸/触控笔上起（鼠标右键行为不许变）', () => {
    expect(bodyOf(source, 'startLongPress')).toBeTruthy()
    expect(bodyOf(source, 'onPointerDown')).toContain('isTouchPointer(event.pointerType)')
    // 长按计时由按下这一击起，且被位移 / 抬手 / 取消三条路作废
    expect(bodyOf(source, 'onPointerDown')).toContain('startLongPress(event)')
    expect(bodyOf(source, 'onPointerMove')).toContain('cancelLongPress()')
    expect(bodyOf(source, 'onPointerUp')).toContain('cancelLongPress()')
    expect(bodyOf(source, 'onPointerCancel')).toContain('cancelLongPress()')
  })

  it('★ 双指捏合：第二根手指必须在 `drag.dragging` 早退**之前**被认出来', () => {
    const down = bodyOf(source, 'onPointerDown')
    const pinchAt = down.indexOf('touchPoints.size === 2')
    const dragEarlyReturn = down.indexOf('if (drag.dragging) return')
    expect(pinchAt).toBeGreaterThan(-1)
    expect(dragEarlyReturn).toBeGreaterThan(-1)
    expect(pinchAt).toBeLessThan(dragEarlyReturn)
  })

  it('★ 捏合优先于单指逻辑（移动与抬起都先分派给 pinch）', () => {
    expect(bodyOf(source, 'onPointerMove')).toContain('if (pinch !== null)')
    expect(bodyOf(source, 'onPointerUp')).toContain('if (pinch !== null)')
    // 缩放必须走纯几何模块，不许在组件里自己乘 offset
    expect(bodyOf(source, 'updatePinch')).toContain('pinchViewport(')
  })

  it('画布自己吃掉全部手势（否则浏览器先接管双击缩放/长按选择）', () => {
    expect(source).toContain('touch-action: none')
    expect(source).toContain('-webkit-touch-callout: none')
  })

  it('触摸时不出悬停浮签（手指没有"悬停"，浮签会僵在原地）', () => {
    expect(bodyOf(source, 'onPointerMove')).toContain('isTouchPointer(event.pointerType)')
  })
})

describe('其余右键入口：长按等价', () => {
  /** 每处 `@contextmenu` 旁边都必须有 `v-long-press`，否则手指端根本调不出这个菜单 */
  const panels = [
    'src/components/game/BoxCardFace.vue',
    'src/components/game/CounterPicker.vue',
    'src/components/game/MapActionPopover.vue',
    'src/components/containers/ContainersPanel.vue',
    'src/components/reinforcement/ReinforcementPanel.vue',
  ]

  it.each(panels)('%s 同时接了右键与长按', (path) => {
    const source = read(path)
    expect(source, '必须有 contextmenu（鼠标端）').toContain('@contextmenu')
    expect(source, '必须有 v-long-press（触摸端）').toContain('v-long-press')
    expect(source, '指令要从共享模块来').toContain("from '@/shared/long-press'")
  })

  it('长按指令是共享实现（五个面板不许各写一套计时器）', () => {
    const shared = read('src/shared/long-press.ts')
    expect(shared).toContain('export const vLongPress')
    expect(shared).toContain('export function attachLongPress')
    // 触控笔也算触摸，否则电磁笔用户按不出菜单
    expect(shared).toContain("pointerType === 'pen'")
  })
})

describe('触摸基线：视口与全局样式', () => {
  it('★ 禁掉页面级缩放（否则两指捏地图会缩放整个页面）', () => {
    const html = read('index.html')
    expect(html).toContain('user-scalable=no')
    expect(html).toContain('maximum-scale=1.0')
    // 铺到刘海底下再由安全区让开
    expect(html).toContain('viewport-fit=cover')
  })

  it('触摸端禁长按选择与回弹，但输入框仍可选中', () => {
    const css = read('src/styles/base.css')
    expect(css).toContain('@media (pointer: coarse)')
    expect(css).toContain('-webkit-touch-callout: none')
    expect(css).toContain('overscroll-behavior: none')
    // 例外条款必须在（改名 / 粘贴仍要能选字）
    expect(css).toContain("[contenteditable='true']")
  })

  it('触摸端把控件命中区放大到 ≥44px（桌面端不受影响）', () => {
    const css = read('src/styles/tokens.css')
    const coarse = css.slice(css.indexOf('@media (pointer: coarse)'))
    expect(coarse).toContain('--control-height: 46px')
    expect(coarse).toContain('--control-height-sm: 36px')
  })

  it('安全区在桌面恒为 0（不会给鼠标端多出内边距）', () => {
    expect(read('src/styles/tokens.css')).toContain('env(safe-area-inset-top, 0px)')
    expect(read('src/App.vue')).toContain('var(--safe-top)')
  })

  it('窄屏把竖栏转到底部横排、抽屉改成底部浮层（否则手机上地图只剩一条缝）', () => {
    const css = read('src/views/GameTableView.vue')
    const narrow = css.slice(css.indexOf('@media (max-width: 900px)'))
    expect(narrow).toContain('flex-direction: column')
    expect(narrow).toContain('.gt__rail')
    expect(narrow).toContain('flex-direction: row')
    expect(narrow).toContain('position: absolute')
  })
})
