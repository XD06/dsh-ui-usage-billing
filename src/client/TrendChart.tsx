/**
 * TrendChart: dependency-free SVG chart of daily cost + calls.
 *
 * The columns are STACKED per day — one bar per day, with each model's cost
 * as a colored segment inside the bar, so the daily total reads at a glance
 * and the model mix stays visible. The blue line is the total call volume
 * across all models, plotted on its own right-hand axis.
 * A hover crosshair shows the day's model breakdown. No chart library — the
 * surface stays self-contained and offline.
 */

import { useMemo, useState } from 'react'
import css from './UsageBilling.module.css'
import { zh } from './locales.ts'
import { convertFromCny, formatMoney, type CostCurrency } from './pricing.ts'
import { shortNumber } from './TokenPanel.tsx'

/** 本地日期戳：YYYY-MM-DD（与 stats.byDay 的键一致）。 */
function localDayStamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One model's legend identity: key, display name, and brand color. */
export interface TrendSeriesModel {
  /** Stats key (`byModel` key), also the `byModel` map key. */
  key: string
  /** Human-readable model name. */
  name: string
  /** Resolved brand color for the bar and legend swatch (empty = single-color fallback). */
  color: string
}

/** One day row fed to the chart. */
export interface TrendPoint {
  /** ISO date `YYYY-MM-DD`. */
  date: string
  /** Total cost that day. */
  cost: number
  /** API calls that day (total across models). */
  calls: number
  /** Total tokens that day (input+output — stats.input already includes cache hit/miss); used by the `tokens` metric. */
  tokens?: number
  /** Per-model cost that day (stats key → CNY); absent entries plot zero. */
  byModel?: Readonly<Record<string, number>>
}

/** Fixed viewBox; the SVG scales to its container. */
const W = 680
const H = 220
const PAD = { top: 18, right: 40, bottom: 26, left: 46 }

/** Split a date into `M/D` for axis labels. */
function shortDate(iso: string): string {
  const [, month, day] = iso.split('-')
  return `${Number(month)}/${Number(day)}`
}

/**
 * 单调三次插值的切线：Fritsch–Carlson 限幅，保证曲线不冲出相邻数据点的取值区间
 * （不会在 0 轴下方鼓包，也不会越过当日调用量峰值）。
 *
 * 三点退化（`dx` 为 0）时返回 0 而不是继续做除法：0/0 会得到 `NaN`，而 `NaN`
 * 参与任何比较都是 `false`，会绕过下面的全部分支判断并污染整条路径。
 * @param x0..x2 - 相邻三点的 x（严格递增，退化调用方需自行规避）。
 * @param y0..y2 - 对应点的 y（已翻转成屏幕坐标）。
 * @returns 中间点处受两侧割线夹逼的斜率。
 */
function monotoneSlope(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx1 = x1 - x0
  const dx2 = x2 - x1
  if (dx1 === 0 || dx2 === 0) return 0
  const d1 = (y1 - y0) / dx1
  const d2 = (y2 - y1) / dx2
  // 两侧走向相反（局部极值）时切线归零，极值点被压成水平，杜绝过冲。
  // 用 `<= 0` 一并覆盖 d1 或 d2 为 0 的平段。
  if (d1 * d2 <= 0) return 0
  // 同号时调和平均：|m| ≤ 2·min(|d1|,|d2|) < 3·min，满足 Fritsch–Carlson 不越界条件。
  return (2 * d1 * d2) / (d1 + d2)
}

/**
 * 把逐点坐标串成平滑的 SVG 路径（单调三次贝塞尔，Catmull-Rom 的控制点形态）。
 *
 * 切线按点逐个求：内部点用 {@link monotoneSlope} 双侧夹逼，**首尾点用单侧割线**
 * ——端点没有第二个邻居，若照搬「复制端点作虚拟邻居」会让 `dx` 退化为 0，
 * 因此这里直接给端点一条单侧斜率，从根上避免重复坐标。
 * 控制点取「三分之一弦长」：`cp1 = p1 + m1·dx/3`、`cp2 = p2 - m2·dx/3`。
 * @param points - 按 x 递增排列的屏幕坐标点。
 * @returns `M … C …` 形式的路径串；点数不足 2 时退化为 `M`（不产生曲线）。
 */
function smoothPath(points: readonly { x: number; y: number }[]): string {
  if (points.length === 0) return ''
  const first = points[0]
  if (first === undefined) return ''
  if (points.length === 1) return `M${first.x} ${first.y}`
  const last = points.length - 1
  const p = (i: number): { x: number; y: number } => points[i] as { x: number; y: number }

  // 每个点的切线斜率：内部双侧限幅，端点单侧割线。
  const tangent = points.map((_, i) => {
    if (i === 0) {
      const a = p(0)
      const b = p(1)
      return b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x)
    }
    if (i === last) {
      const a = p(last - 1)
      const b = p(last)
      return b.x === a.x ? 0 : (b.y - a.y) / (b.x - a.x)
    }
    const a = p(i - 1)
    const b = p(i)
    const c = p(i + 1)
    return monotoneSlope(a.x, a.y, b.x, b.y, c.x, c.y)
  })

  let path = `M${first.x} ${first.y}`
  for (let i = 0; i < last; i++) {
    const p1 = p(i)
    const p2 = p(i + 1)
    const dx = p2.x - p1.x
    const m1 = tangent[i] ?? 0
    const m2 = tangent[i + 1] ?? 0
    const cp1x = p1.x + dx / 3
    const cp1y = p1.y + (m1 * dx) / 3
    const cp2x = p2.x - dx / 3
    const cp2y = p2.y - (m2 * dx) / 3
    path += ` C${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`
  }
  return path
}

/* shortNumber 复用 TokenPanel 的实现（同一 bundle，避免两份重复定义）。 */

/** Ticks every `step` items for sparse axis labels. */
function tickIndexes(length: number, step: number): number[] {
  const out: number[] = []
  for (let i = 0; i < length; i += step) out.push(i)
  if (length > 0 && out[out.length - 1] !== length - 1) out.push(length - 1)
  return out
}

/** Single-color fallback identity used when the stats carry no per-model detail. */
const TOTAL_MODEL: TrendSeriesModel = { key: '__total__', name: '', color: '' }

/** One stacked segment: one model's cost inside one day's bar. */
interface Bar {
  date: string
  model: TrendSeriesModel
  /** Bar left edge x. */
  x: number
  /** Cumulative cost of the segments below this one (stack base). */
  base: number
  /** Cost value this model contributed that day. */
  value: number
  /** Whether this segment is the day's top one (gets the rounded cap). */
  topRounded: boolean
}

/** Metric rendered by the chart columns: daily cost (stacked by model) or total tokens. */
export type TrendMetric = 'cost' | 'tokens'

/**
 * Render the daily bars plus the total-calls line.
 * @param props.data - sorted daily rows (ascending date).
 * @param props.models - the model legend, in bar order (used by the `cost` metric).
 * @param props.currency - display currency for the cost labels.
 * @param props.metric - `cost` (stacked per-model CNY, default) or `tokens` (single-color total tokens).
 */
export function TrendChart({ data, models = [], currency = 'cny', metric = 'cost', t }: { data: readonly TrendPoint[]; models?: readonly TrendSeriesModel[]; currency?: CostCurrency; metric?: TrendMetric; t?: (key: 'trendEmpty' | 'trendTotal' | 'calls') => string }): React.ReactNode {
  // 省略 t 时回落到中文词典，保持既有调用方（含测试）行为不变。
  const tr = t ?? ((key: 'trendEmpty' | 'trendTotal' | 'calls'): string => zh[key])
  const [hover, setHover] = useState<number | null>(null)
  const money = (cny: number): string => formatMoney(convertFromCny(cny, currency), currency)
  const axisOf = (value: number): string => metric === 'tokens' ? shortNumber(value) : money(value)
  // Column value source by metric: cost (stacked) vs total tokens (single color).
  const valueOf = (d: TrendPoint): number => metric === 'tokens' ? (d.tokens ?? 0) : d.cost

  const layout = useMemo(() => {
    const n = data.length
    if (n === 0) return null
    const plotW = W - PAD.left - PAD.right
    const plotH = H - PAD.top - PAD.bottom
    const inner = (i: number): number => {
      if (n === 1) return PAD.left + plotW / 2
      return PAD.left + (plotW * i) / (n - 1)
    }
    // 刻度按「单日总费用」：堆叠柱顶端即当日总费用，直方更饱满。
    // 刻度按当前指标的最大值：费用用堆叠顶端，Token 用当日总量。
    const maxCost = metric === 'tokens'
      ? Math.max(...data.map(d => d.tokens ?? 0), 0.0001)
      : Math.max(
          ...data.map(d => Math.max(d.cost, Object.values(d.byModel ?? {}).reduce((sum, v) => sum + v, 0))),
          0.0001,
        )
    const yCost = (value: number): number => PAD.top + plotH - (value / maxCost) * plotH
    // 调用量比例尺：独立右轴，柱（费用）与线（调用）各用各的刻度。
    const maxCalls = Math.max(...data.map(d => d.calls), 1)
    const yCalls = (value: number): number => PAD.top + plotH - (value / maxCalls) * plotH

    const groupW = plotW / n
    const barW = Math.min(18, groupW * 0.6)

    // 堆叠柱：每天一根柱，各模型费用自下而上拼成色段；顶部段圆角收尾。
    const bars: Bar[] = data.flatMap((d, i) => {
      const x = inner(i) - barW / 2
      if (models.length === 0 || metric === 'tokens') {
        // 无模型明细或 Token 指标：单色总费用/总量柱兜底。
        //（柱体只读 model.color/key；name 从不渲染，不再按 locale 生成。）
        return [{ date: d.date, model: TOTAL_MODEL, x, base: 0, value: valueOf(d), topRounded: true }]
      }
      // 顶部圆角给当天最后一个有量的模型段。
      let topKey: string | null = null
      for (const model of models) {
        if ((d.byModel?.[model.key] ?? 0) > 0) topKey = model.key
      }
      let acc = 0
      return models.map((model) => {
        const value = d.byModel?.[model.key] ?? 0
        const bar: Bar = { date: d.date, model, x, base: acc, value, topRounded: model.key === topKey }
        acc += value
        return bar
      })
    })

    const costTicks = [0, 0.25, 0.5, 0.75, 1].map(f => maxCost * f).reverse()
    const callsTicks = [0, 0.25, 0.5, 0.75, 1].map(f => maxCalls * f).reverse()
    // 调用量折线路径：柱 = 每日分模型费用，线 = 每日总调用次数。
    // 平滑曲线（单调三次贝塞尔）：面积填充复用同一条路径串，故线与下方渐变面积一起变平滑；
    // 悬停十字线仍按每日真实 x 吸附，数据点位置不变。
    const linePath = smoothPath(data.map((d, i) => ({ x: inner(i), y: yCalls(d.calls) })))
    return { n, plotW, plotH, inner, yCost, yCalls, barW, bars, costTicks, callsTicks, linePath }
  }, [data, models, metric])

  if (layout === null) {
    return <div className={css.chartEmpty}>{tr('trendEmpty')}</div>
  }

  const { n, plotW, plotH, inner, yCost, yCalls, barW, bars, costTicks, callsTicks, linePath } = layout
  const activePoint = hover === null ? undefined : data[hover]
  const indices = tickIndexes(n, Math.max(1, Math.ceil(n / 8)))

  return (
    <div className={css.chartWrap}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={css.chartSvg}
        role="img"
        aria-label="Daily cost by model and total calls"
        onMouseLeave={() => { setHover(null) }}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const x = ((e.clientX - rect.left) / rect.width) * W
          const ratio = (x - PAD.left) / plotW
          const index = Math.round(ratio * (n - 1))
          setHover(Math.min(Math.max(index, 0), n - 1))
        }}
      >
        {/* Horizontal grid lines with cost labels (left axis). */}
        {costTicks.map((value, idx) => {
          const y = yCost(value)
          return (
            <g key={`cost-${idx}`}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className={css.chartGrid} />
              <text x={PAD.left - 8} y={y + 3} textAnchor="end" className={css.chartAxisLabel}>
                {axisOf(value)}
              </text>
            </g>
          )
        })}

        {/* Stacked per-day cost bars: one bar per day, per-model segments. */}
      {bars.map(bar => {
        // 费用=0 但调用>0 的当天，画一个 1px 高的占位空柱，避免「没柱=没调用」的误解。
        if (bar.value > 0) {
          return (
            <rect
              key={`${bar.date}-${bar.model.key}`}
              x={bar.x}
              y={yCost(bar.base + bar.value)}
              width={barW}
              height={yCost(bar.base) - yCost(bar.base + bar.value)}
              rx={bar.topRounded ? 2 : 0}
              className={bar.model.color === '' ? css.chartBar : css.chartStack}
              style={bar.model.color === '' ? undefined : { fill: bar.model.color }}
            />
          )
        }
        // 占位空柱：当天有调用但费用为 0 时，画一个 1px 高的灰柱提示「有调用但免费」。
        // key 含 model.key 保证唯一（同一天多模型段共享同一 date，占位柱 key 不能只用 date）。
        const day = data.find(d => d.date === bar.date)
        if (day !== undefined && day.calls > 0 && bar.base === 0) {
          return (
            <rect
              key={`${bar.date}-${bar.model.key}-placeholder`}
              x={bar.x}
              y={yCost(0) - 1}
              width={barW}
              height={1}
              rx={0}
              className={css.chartBarPlaceholder}
            />
          )
        }
        return null
      })}

        {/* Calls line (right axis): the daily call volume trend. */}
        <path d={linePath} fill="none" className={css.chartLine} />
        {/* v1.5：今日竖虚线 + 渐变填充（面积图下垫）。 */}
        {(() => {
          const todayKey = localDayStamp()
          const todayIdx = data.findIndex(d => d.date === todayKey)
          return todayIdx >= 0 ? (
            <>
              <defs>
                <linearGradient id="chartAreaGrad" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset="0%" stopColor="var(--ds-blue)" stopOpacity="0.35" />
                  <stop offset="100%" stopColor="var(--ds-blue)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* 面积填充：折线下方到 0 的渐变 */}
              <path
                d={`${linePath} L ${inner(data.length - 1)} ${yCalls(0)} L ${inner(0)} ${yCalls(0)} Z`}
                fill="url(#chartAreaGrad)"
              />
              {/* 今日竖虚线 + 顶部标记 */}
              <line
                x1={inner(todayIdx)} x2={inner(todayIdx)}
                y1={PAD.top} y2={PAD.top + plotH}
                stroke="var(--ds-amber)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.6"
              />
              <text
                x={inner(todayIdx) + 4}
                y={PAD.top - 6}
                fill="var(--ds-amber)"
                fontSize="10"
                fontFamily="var(--font-num)"
              >
                {shortDate(todayKey)}
              </text>
            </>
          ) : null
        })()}
        {/* Right-axis call labels. */}
        {callsTicks.map((value, idx) => {
          const y = yCalls(value)
          return (
            <text key={`calls-${idx}`} x={W - PAD.right + 8} y={y + 3} textAnchor="start" className={css.chartAxisLabel}>
              {shortNumber(value)}
            </text>
          )
        })}

        {/* X-axis date labels. */}
        {indices.map((i) => {
          const point = data[i]
          if (point === undefined) return null
          return (
            <text key={point.date} x={inner(i)} y={H - 6} textAnchor="middle" className={css.chartAxisLabel}>
              {shortDate(point.date)}
            </text>
          )
        })}

        {/* Hover crosshair. */}
        {hover !== null && (
          <line x1={inner(hover)} x2={inner(hover)} y1={PAD.top} y2={PAD.top + plotH} className={css.chartCrosshair} />
        )}
      </svg>

      {/* Hover tooltip: the day's model breakdown. */}
      {activePoint !== undefined && hover !== null && (
        <div
          className={css.chartTooltip}
          style={{ left: `${(inner(hover) / W) * 100}%`, top: `${(yCost(activePoint.cost) / H) * 100}%` }}
        >
          <div className={css.chartTooltipDate}>{activePoint.date}</div>
          {metric !== 'tokens' && models.filter(model => (activePoint.byModel?.[model.key] ?? 0) > 0).map(model => (
            <div key={model.key} className={css.chartTooltipRow}>
              <span className={css.chartTooltipSwatch} style={{ background: model.color }} />
              {model.name} <strong>{money(activePoint.byModel?.[model.key] ?? 0)}</strong>
            </div>
          ))}
          <div className={css.chartTooltipRow}>
            <span className={css.chartLegendBar} />
            {tr('trendTotal')} <strong>{metric === 'tokens' ? shortNumber(activePoint.tokens ?? 0) : money(activePoint.cost)}</strong>
          </div>
          <div className={css.chartTooltipRow}>
            <span className={css.chartLegendLine} />
            {tr('calls')} <strong>{activePoint.calls.toLocaleString()}</strong>
          </div>
        </div>
      )}

      {/* Model legend: colored squares are per-model cost, the line is calls. */}
      {models.length > 0 && metric !== 'tokens' && (
        <div className={css.chartLegend}>
          {models.map(model => (
            <span key={model.key}>
              <span className={css.chartTooltipSwatch} style={{ background: model.color }} />
              {model.name}
            </span>
          ))}
          <span>
            <span className={css.chartLegendLine} />
            {tr('calls')}
          </span>
        </div>
      )}
    </div>
  )
}
