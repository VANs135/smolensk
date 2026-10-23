/**
 * 地图输入的手势归属（B18a 立；B24 补了「拖动中」这一路）
 *
 * ## 为什么需要这一层
 * 地图的指针/滚轮监听挂在**视口容器**（`.mapcanvas__viewport`）上，而地图上的 DOM 浮层
 * （唯一会话框 `MapDock`、初设的「待你决定」队列 `DecisionQueue`、就地小窗外壳）是**该容器的子节点**
 * ⇒ 在浮层里点一下，事件会**冒泡到容器的监听器**，于是同一个点击既按了面板上的按钮，
 * 又被当成"点了地图上的某一格"。用户报告的现象（「点击增援窗口还是点到地图」）就是这条机制。
 *
 * 冒泡无法靠"给浮层加 `pointer-events`"解决：浮层确实要接收事件（它自己是可点的），
 * 缺的是**容器侧的归属判断**——只有**发源于画布本身**的事件才算地图手势。
 *
 * ## ★ B24：指针捕获会把 `target` 改成**捕获元素** ⇒ 必须有「拖动中」这一路
 *
 * MDN（`Element.setPointerCapture`）：「Subsequent events for the pointer will be **targeted at
 * the capture element** until capture is released」——即捕获期间连 `pointermove` / `pointerup` 的
 * `event.target` 都是**捕获元素**，而不是光标下的元素。
 *
 * 修前把捕获取在**视口容器**上，于是：按下（`target`＝画布 ✓）之后，移动与抬起全部变成
 * `target`＝容器 ⇒ 被判成"不是地图手势" ⇒ **拖动不平移、抬起不点格**。
 * 用户报告的两条（「无法拖动地图」「点初设高亮格无反应」）就是这一条机制。
 *
 * 两手都做，任何一浏览器行为差异都不至于再把它弄坏：
 *   ① 捕获取在**画布**上（`MapCanvas` 里 `captureTarget()`）⇒ `target` 始终是画布，判据天然成立；
 *   ② 本函数接受 `continued`：手势**已经在本画布上开始**（`drag.dragging`）时无条件认作地图手势。
 *
 * @param target    事件的 `target`
 * @param canvas    画布元素
 * @param continued 这次事件是否属于"已在画布上按下、尚未结束"的那一段手势（拖动中）
 */
export function isMapGestureTarget(
  target: EventTarget | null,
  canvas: EventTarget | null,
  continued = false,
): boolean {
  // ② 手势已开始 ⇒ 后续的移动/抬起都算（捕获重定向、拖出画布到浮层上都归它）
  if (continued) return true
  if (target === null || canvas === null) return false
  return target === canvas
}
