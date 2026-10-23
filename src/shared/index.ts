/**
 * src/shared 统一出口
 *
 * 只放与业务无关的纯工具；涉及规则的计算一律走 engine。
 * 组件中按需具名引入，避免整包引入造成摇树失败。
 */

export * from './is'
export * from './id'
export * from './assert'
export * from './math'
export * from './format'
export * from './request'
export * from './storage'
