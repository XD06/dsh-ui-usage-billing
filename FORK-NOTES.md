# 本地定制与上游同步说明

本仓库是 [`kenz1117/dsh-ui-usage-billing`](https://github.com/kenz1117/dsh-ui-usage-billing) 的 fork，
只保留**一处**定制：趋势图「每日费用与调用趋势」的调用量折线由折线改为平滑曲线。

- 上游：`upstream` → `https://github.com/kenz1117/dsh-ui-usage-billing.git`
- 本 fork：`origin` → `https://github.com/XD06/dsh-ui-usage-billing.git`
- 定制提交：`feat(trend): 调用量折线改为单调三次贝塞尔平滑曲线`

---

## 1. 定制内容（唯一的差异点）

| 文件 | 改动 |
|---|---|
| `src/client/TrendChart.tsx` | 新增 `smoothPath()` / `monotoneSlope()`；`linePath` 改为调用 `smoothPath` |
| `tests/trendchart.client.spec.tsx` | 新增 2 条回归断言（C 段数量、曲线不越界） |
| `lib/client.js` | 上述源码的构建产物（本仓 `lib/` 入库） |

设计要点：

- **单调三次贝塞尔（Fritsch–Carlson 限幅）**：切线按相邻两条割线夹逼，局部极值处
  归零，因此曲线不会在 0 轴下方鼓包，也不会越过当日调用量峰值。
- 首尾复制端点作虚拟邻居，两端切线不甩弧。
- 面积填充复用同一路径串（`${linePath} L … Z`），所以线与下方渐变面积一起变平滑。
- 柱状图、坐标轴、悬停十字线、tooltip 吸附位置、Token 视图**均未改动**。

---

## 2. 本地生效流程

```sh
# 1) 改源码
# 2) 构建（产物入库，必须一起提交）
pnpm install          # 首次
npx tsc -b tsconfig.json
npx tsdown

# 3) 重启 DSH 宿主，加载新产物
```

profile 已通过 `link:` 指向本目录，无需重新 `dsh plugin add`：

```
C:\Users\dsk\.dsh\profiles\desktop\package.json
  "@kenz1117/dsh-ui-usage-billing": "link:C:/Users/dsk/Documents/deepseek-harness/default-workspace/dsh-ui-usage-billing"
```

> ⚠️ 上游 `sync.sh` 假设的是作者本机的 `~/deepseek-harness` 布局，本机不适用，**不要运行**。

### 只验证不装

```sh
npx vitest run tests/trendchart.client.spec.tsx   # 曲线相关的 10 条
```

---

## 3. 上游更新后如何同步

```sh
cd dsh-ui-usage-billing

git fetch upstream
git checkout main
git merge upstream/main        # 或 git rebase upstream/main
```

### 冲突处理

冲突几乎只可能出现在两处：

1. **`src/client/TrendChart.tsx`**
   - 上游若只动了柱状图 / 坐标轴 / tooltip：保留上游代码，把 `linePath` 一行换成
     `smoothPath(...)` 调用，并确认 `smoothPath` / `monotoneSlope` 两个函数仍在文件里。
   - 上游若重写了 `linePath` 的生成方式（例如换算法、换数据结构）：以新的数据形状
     适配 `smoothPath` 的入参（它只要求 `{ x, y }[]` 按 x 递增）。

2. **`lib/client.js`**
   - **永远不要手工解决冲突**。取任意一侧，然后重新构建覆盖：
     ```sh
     npx tsc -b tsconfig.json && npx tsdown
     ```
   - 上游的 `lib/` 是他们构建的产物，本 fork 必须以本地构建结果为准。

3. **`pnpm-lock.yaml`**
   - 若本机 `pnpm install` 造成大量无关改动（`autoInstallPeers` 等），直接丢弃：
     ```sh
     git checkout -- pnpm-lock.yaml
     ```
   - 只有在上游确实新增/升级了依赖时才保留上游的 lockfile。

### 同步后的验收

```sh
npx vitest run tests/trendchart.client.spec.tsx
# 期望 10/10 通过，其中包含：
#   - draws the calls line as a smooth cubic curve instead of straight segments
#   - keeps the smooth curve inside the plotted value range (no overshoot below zero)
```

若这两条断言失败，说明平滑曲线在合并中丢失或算法被改坏。

### 推回自己的 fork

```sh
git push origin main
```

---

## 4. 上游同步记录

| 日期 | 上游提交 | 内容 | 冲突 | 结果 |
|---|---|---|---|---|
| 2026-10-21 | `d3b4d44` | fix(#103): 会话标题跟随重命名——回落先给最近一次完成的聚合，读不动的会话用宿主侧标题 | 仅 `lib/client.js`（构建产物） | 源码零冲突，定制的 `smoothPath`/`monotoneSlope` 未被触碰；取一侧后重新 `tsc -b && tsdown` 覆盖，产物同时含两侧内容 |

上游 `d3b4d44` 改动集中在「会话标题跟随重命名」链路
（`src/aggregate.ts` / `src/index.ts` / `src/routes/usage-stats.ts` /
`src/client/**` / `tests/aggregate.spec.ts` / `tests/stale-snapshot.client.spec.tsx`），
**未触碰** `src/client/TrendChart.tsx` 与 `tests/trendchart.client.spec.tsx`。

---

## 5. 已知的环境问题（与本定制无关）

`tests/ledger.spec.ts` 有 2 条锁竞争用例在**未改动的上游基线上同样失败**
（`keeps failing while the contending lock is fresh`）。这是 Windows 下
`dsh-atomic-write` 的 `kill(pid,0)` 锁回收行为差异，属上游既有问题，不影响本定制。

> 已于 2026-10-21 用 `git worktree` 在合并前的 `e3a7a44` 上复现确认：
> 同样是 2 failed / 9 passed，与合并无关。合并后全量为 715 passed / 2 failed。

---

## 6. 后续想撤销定制

```sh
git revert <定制提交的 SHA>
npx tsc -b tsconfig.json && npx tsdown
```

然后把 profile 切回 npm 版本：

```sh
# 在 DSH 里：插件管理 → 移除该插件 → 再从市场/包名安装 @kenz1117/dsh-ui-usage-billing
```
