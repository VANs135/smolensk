<script setup lang="ts">
import { ref } from 'vue'

import { BaseButton, BaseDialog, BasePanel, BaseTag } from '@/components/base'
import { formatInteger, formatPercent } from '@/shared'
import { useAppStore, useUiStore } from '@/stores'

const app = useAppStore()
const ui = useUiStore()

// ── 演示状态 ──
const dialogOpen = ref(false)
const tagDismissed = ref(false)

function showInfoToast(): void {
  ui.pushToast('info', '通知层就绪：ToastHost 已接入 ui store')
}

function showSuccessToast(): void {
  ui.pushToast('success', '基础底座搭建完成，可以开始接入引擎模块')
}

function showDangerToast(): void {
  ui.pushToast('danger', `示例告警（当前环境：${app.appEnv}）`)
}
</script>

<template>
  <div class="home">
    <!-- 环境信息 -->
    <BasePanel title="环境信息">
      <dl class="kv">
        <div class="kv__row">
          <dt>应用标题</dt>
          <dd>{{ app.appTitle }}</dd>
        </div>
        <div class="kv__row">
          <dt>运行环境</dt>
          <dd>{{ app.appEnv }}</dd>
        </div>
        <div class="kv__row">
          <dt>应用版本</dt>
          <dd class="num">{{ app.appVersion }}</dd>
        </div>
        <div class="kv__row">
          <dt>API 基地址</dt>
          <dd class="num">{{ app.apiBaseUrl || '未配置（本作无后端）' }}</dd>
        </div>
        <div class="kv__row">
          <dt>设计令牌</dt>
          <dd>tokens.css 中央配色与尺度，见下方色板</dd>
        </div>
      </dl>
    </BasePanel>

    <!-- 设计令牌色板 -->
    <BasePanel title="设计令牌色板">
      <ul class="swatches">
        <li
          v-for="swatch in [
            { var: '--color-bg', value: '#f6f4ee' },
            { var: '--color-bg-2', value: '#ece8de' },
            { var: '--color-panel', value: '#ffffff' },
            { var: '--color-ink', value: '#201e1a' },
            { var: '--color-muted', value: '#6a655c' },
            { var: '--color-rule', value: '#d9d4c8' },
            { var: '--color-accent', value: '#8c2f22' },
            { var: '--color-accent-2', value: '#46604c' },
            { var: '--color-gold', value: '#8a6420' },
          ]"
          :key="swatch.var"
          class="swatch"
        >
          <span class="swatch__chip" :style="{ background: swatch.value }" />
          <code class="swatch__name num">{{ swatch.var }}</code>
        </li>
      </ul>
    </BasePanel>

    <!-- 基础组件演示 -->
    <BasePanel title="基础组件演示">
      <div class="demo-row">
        <!-- B10：进入游戏的**新路径**（先选剧本与共识 → 再进游戏开始初设）；下面那条直通入口保留 -->
        <BaseButton variant="primary" @click="ui.navigate('scenario')"
          >选择剧本与共识 → 进入游戏</BaseButton
        >
        <BaseButton variant="primary" @click="ui.navigate('game')"
          >进入对局台（全流程可玩 · W7 C16）</BaseButton
        >
        <BaseButton variant="primary" @click="ui.navigate('map')"
          >打开地图（C2 渲染与视口）</BaseButton
        >
        <BaseButton variant="primary" @click="ui.navigate('workbench')"
          >打开骨架操作台（U0）</BaseButton
        >
        <BaseButton variant="primary" @click="showSuccessToast">主要按钮</BaseButton>
        <BaseButton variant="secondary" @click="showInfoToast">常规按钮</BaseButton>
        <BaseButton variant="ghost" @click="dialogOpen = true">打开对话框</BaseButton>
        <BaseButton variant="danger" @click="showDangerToast">危险按钮</BaseButton>
        <BaseButton variant="secondary" size="sm" :loading="false">小尺寸</BaseButton>
      </div>

      <div class="demo-row" style="margin-top: 12px">
        <BaseButton variant="secondary" size="sm" disabled>禁用</BaseButton>
        <BaseButton variant="primary" size="sm" loading>加载中</BaseButton>
        <BaseTag v-if="!tagDismissed" kind="success" closable @close="tagDismissed = true">
          可关闭标签
        </BaseTag>
        <BaseTag kind="info">信息标签</BaseTag>
        <BaseTag kind="warning">警告标签</BaseTag>
        <BaseTag kind="danger">危险标签</BaseTag>
        <BaseTag kind="neutral">中性标签</BaseTag>
      </div>

      <p class="muted">工具函数示例：{{ formatInteger(12345678) }} · {{ formatPercent(0.1234) }}</p>
    </BasePanel>

    <!-- 请求层说明 -->
    <BasePanel title="请求层（fetch 封装）">
      <p class="muted">
        本期为本地热坐对局、无后端服务。src/shared/request.ts 提供超时中止、错误归一化与可选 Zod
        校验的 GET/POST JSON 封装，用于数据管线加载与二期 FastAPI 接入时的统一出口；
        静态图片资源直接走 <code>&lt;img&gt;</code> 浏览器缓存，不经本层。
      </p>
    </BasePanel>

    <BaseDialog v-model:open="dialogOpen" title="基础对话框" width="420px">
      <p>对话框组件：遮罩 / Esc 键 / 右上角均可关闭，Teleport 至 body。</p>
      <template #footer>
        <BaseButton variant="secondary" @click="dialogOpen = false">取消</BaseButton>
        <BaseButton variant="primary" @click="dialogOpen = false">确定</BaseButton>
      </template>
    </BaseDialog>
  </div>
</template>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.kv {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
}

.kv__row {
  display: flex;
  gap: var(--space-4);
  padding-bottom: var(--space-2);
  border-bottom: 1px dashed var(--color-rule);
}

.kv__row:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.kv__row dt {
  flex: none;
  width: 120px;
  color: var(--color-muted);
  font-size: var(--text-sm);
}

.kv__row dd {
  margin: 0;
}

.swatches {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: var(--space-3);
  padding: 0;
  margin: 0;
  list-style: none;
}

.swatch {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  background: var(--color-bg);
  border: 1px solid var(--color-rule);
  border-radius: var(--radius-sm);
}

.swatch__chip {
  flex: none;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  border: 1px solid rgb(0 0 0 / 0.08);
}

.swatch__name {
  font-size: var(--text-xs);
}

.demo-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.muted {
  color: var(--color-muted);
  font-size: var(--text-sm);
}
</style>
