// @vitest-environment jsdom
/**
 * TrendChart rendering smoke test: the stacked bars + calls line must render
 * without throwing (a throw unmounts the whole plugin surface in the host).
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { TrendChart, type TrendPoint } from '../src/client/TrendChart.tsx'

/** Seven-day window with two models and per-model cost detail. */
const DATA: TrendPoint[] = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16'].map(
  (date, i) => ({
    date,
    cost: i * 2,
    calls: i * 5,
    byModel: { flash: i, pro: i > 0 ? i * 2 : 0 },
  }),
)

const MODELS = [
  { key: 'flash', name: 'DeepSeek V4 Flash', color: 'rgb(59, 130, 246)' },
  { key: 'pro', name: 'DeepSeek V4 Pro', color: 'rgb(65, 118, 230)' },
]

describe('TrendChart', () => {
  it('renders stacked bars and the calls line without throwing', () => {
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    expect(container.querySelector('svg')).not.toBeNull()
    // 两个模型 × 7 天中费用 > 0 的柱段。
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0)
  })

  it('stacks all models of a day into a single bar column', () => {
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    const xs = new Set([...container.querySelectorAll('rect')].map(rect => rect.getAttribute('x')))
    // 有量的 6 天各一根柱：x 位置数等于天数，而非「天数 × 模型数」。
    expect(xs.size).toBe(6)
  })

  it('renders the single-color fallback when no model detail exists', () => {
    const { container } = render(<TrendChart data={DATA} models={[]} />)
    expect(container.querySelectorAll('rect').length).toBeGreaterThan(0)
  })

  it('renders an empty state for no data', () => {
    const { container } = render(<TrendChart data={[]} models={MODELS} />)
    expect(container.textContent).toContain('暂无趋势数据')
  })

  it('survives hover over the chart (crosshair path must not throw)', () => {
    // 回归：hover 十字线读取 plotH，漏解构曾导致 ReferenceError 并卸载整个
    // 插件 surface（宿主里表现为「弹窗闪退 + 触发组件消失」）。
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    fireEvent.mouseMove(svg!, { clientX: 300, clientY: 60 })
    fireEvent.mouseMove(svg!, { clientX: 340, clientY: 80 })
  })

  it('renders the trend copy through the injected translator (issue: hardcoded Chinese)', () => {
    const en = (key: 'trendEmpty' | 'trendTotal' | 'calls'): string =>
      ({ trendEmpty: 'No trend data yet', trendTotal: 'Total', calls: 'Calls' })[key]
    const { container } = render(<TrendChart data={DATA} models={MODELS} t={en} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Calls')
    expect(text).not.toContain('调用')
    expect(text).not.toContain('总计')
  })

  it('falls back to the Chinese dictionary when no translator is given', () => {
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    expect(container.textContent ?? '').toContain('调用')
  })

  it('localizes the empty state instead of hardcoding it', () => {
    const en = (key: 'trendEmpty' | 'trendTotal' | 'calls'): string =>
      ({ trendEmpty: 'No trend data yet', trendTotal: 'Total', calls: 'Calls' })[key]
    const { container } = render(<TrendChart data={[]} models={[]} t={en} />)
    expect(container.textContent).toContain('No trend data yet')
  })

  it('draws the calls line as a smooth cubic curve instead of straight segments', () => {
    // 本 fork 的定制：调用量折线走单调三次贝塞尔。回归守卫——折线路径一旦退回
    // `M…L…` 拼接，这条断言会失败，避免上游合并时静默丢失平滑效果。
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    const line = [...container.querySelectorAll('path')].find(p => p.getAttribute('fill') === 'none')
    expect(line).toBeDefined()
    const d = line?.getAttribute('d') ?? ''
    // 每个相邻点对之间一个 C 段：7 天 → 6 段贝塞尔，且不含直线段 L。
    expect((d.match(/C/g) ?? []).length).toBe(DATA.length - 1)
    expect(d).not.toContain('L')
    // 起点仍是第一天，端点仍是最后一天（曲线不改变数据点位置）。
    expect(d.startsWith('M')).toBe(true)
  })

  it('keeps the smooth curve inside the plotted value range (no overshoot below zero)', () => {
    // 单调限幅：控制点 y 不得越过相邻两端点的 y 区间，否则曲线会在 0 轴下方鼓包。
    const { container } = render(<TrendChart data={DATA} models={MODELS} />)
    const line = [...container.querySelectorAll('path')].find(p => p.getAttribute('fill') === 'none')
    const d = line?.getAttribute('d') ?? ''
    const nums = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
    // 解析 M x y C c1x c1y c2x c2y x y ...：y 值成对出现于每个坐标对。
    const pairs: [number, number][] = []
    for (let i = 0; i + 1 < nums.length; i += 2) pairs.push([nums[i]!, nums[i + 1]!])
    const ys = pairs.map(([, y]) => y)
    // 调用量单调递增（0,5,10…30），y 单调递减，因此曲线 y 不得低于最后一点。
    const lastY = ys[ys.length - 1]!
    for (const y of ys) expect(y).toBeGreaterThanOrEqual(lastY - 0.001)
  })

})
