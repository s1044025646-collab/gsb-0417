# 雨流载荷循环计数与半循环来源核验后端

离线载荷序列的雨流循环计数服务。仅做 API 与 CLI，TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无原生依赖），Windows 本地运行，不依赖 Docker / WSL / 外部在线服务。

## 范围说明

- 只统计载荷变化，**不**预测真实零件寿命、**不**计算材料损伤、**不**连接传感器，**不**扩展到多轴载荷或频域分析。
- 样例均为虚构数据。
- 原采样顺序决定结果，不会对载荷值排序后再分析。

## 核心算法

### 预处理（平台取点口径 `dedupe-consecutive-v1`）

1. 先去掉连续相等值（重复平台不产生额外循环）。
2. 保留两端点与严格方向反转点（峰谷）作为转折点，并保留对应的原始采样编号，未输出的中间点可通过预处理记录追溯。

### 转折点三点栈（`rainflow-3pt-stack-v1`）

每个新转折点入栈后，比较末三点形成的前一段范围 X 与后一段范围 Y：

- `X > Y`：暂不闭合，继续入栈。
- `X <= Y`（相等也结算）：
  - 栈恰有 3 点：前一段输出为**半循环**，移去最早点。
  - 栈多于 3 点：前一段输出为**完整循环**，移去它的两个端点，保留最新点后继续检查。

全部点处理完后，栈中剩余相邻段各作为**半循环**结算，不丢弃残余段，也不把末尾接回开头形成周期信号（有限记录语义）。

### 计数与聚合

- 计数使用半循环单位的整数权重：1 = 半次，2 = 一次，汇总不使用浮点累加。
- 载荷为安全整数，范围为整数；均值可为半整数，聚合键使用**两倍均值**（`mean2`，整数）保证精确。
- 报告同时保留逐循环明细与按（范围, 均值）聚合的循环谱，不只按范围合并。
- 每条循环记录：两个来源转折点（含原始采样编号）、范围、均值、权重（半/全）、触发它的新点、是否残余段。

## 持久化与一致性

- SQLite 保存原始采样、平台规则、算法版本、栈变化与完整结果，重启后可核对。
- 修订采样通过 `revisions` 产生新序列与新报告，不覆盖原始数据。
- 整次计算在单个事务中完成：成功后才把报告置为 `completed` 并发布循环谱；失败或非法载荷不会留下貌似完成的部分汇总。
- 限制：采样点上限 100000；明细展示默认/上限 500 条（可用 `limit`/`offset` 分页）。

## 安装与运行

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 内置演示（0,3,1,4,0 / 单调 / 重复平台）
npm start         # 启动 API（默认端口 0 = 自动选空闲端口）
```

数据目录为项目内 `data/`（可用 `--db 路径` 覆盖）。

## CLI 命令

```
node dist/src/cli.js serve [--port N]             # 启动 API，默认自动选空闲端口
node dist/src/cli.js import <name> <v1,v2,...>    # 导入载荷序列
node dist/src/cli.js revise <seqId> <name> <v..>  # 创建修订版序列
node dist/src/cli.js list                         # 列出序列
node dist/src/cli.js show <seqId>                 # 查看采样
node dist/src/cli.js turning-points <seqId>       # 查看转折点
node dist/src/cli.js count <seqId>                # 执行雨流计数
node dist/src/cli.js report <reportId>            # 报告与循环谱
node dist/src/cli.js cycles <reportId>            # 逐循环明细
node dist/src/cli.js stack <reportId>             # 栈变化过程
node dist/src/cli.js compare <idA> <idB>          # 比较序列版本
node dist/src/cli.js export <reportId> --format csv --out out.csv
node dist/src/cli.js demo                         # 演示
```

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| POST | `/api/sequences` | 导入 `{name, values:[int...]}` |
| GET | `/api/sequences` | 序列列表 |
| GET | `/api/sequences/:id` | 采样（`limit`/`offset`） |
| GET | `/api/sequences/:id/turning-points` | 转折点与平台规则 |
| POST | `/api/sequences/:id/count` | 执行计数，生成报告 |
| POST | `/api/sequences/:id/revisions` | 修订产生新序列 |
| GET | `/api/sequences/:id/compare?other=:id2` | 比较两个版本 |
| GET | `/api/reports/:id` | 报告与循环谱 |
| GET | `/api/reports/:id/cycles` | 逐循环明细 |
| GET | `/api/reports/:id/stack` | 栈变化 |
| GET | `/api/reports/:id/export?format=csv\|json` | 导出 |

错误统一返回 `{"error":{"code","message"}}`，错误码：`INVALID_INPUT`、`NOT_FOUND`、`LIMIT_EXCEEDED`、`CONFLICT`、`INTERNAL`。

## 演示序列的手工栈核对

`[0, 3, 1, 4, 0]`：

```
push 0        栈 [0]
push 3        栈 [0,3]
push 1        栈 [0,3,1]   X=|0-3|=3 > Y=|3-1|=2，不闭合
push 4        栈 [0,3,1,4] X=|3-1|=2 <= Y=|1-4|=3，栈>3点
              → 全循环 3->1，范围2，均值2（触发点：采样#3）
              栈 [0,4]
push 0        栈 [0,4,0]   X=|0-4|=4 <= Y=|4-0|=4，栈=3点
              → 半循环 0->4，范围4，均值2（触发点：采样#4）
              栈 [4,0]
结束          残余段 4->0 → 半循环，范围4，均值2
```

循环谱：范围2/均值2 计 1 次；范围4/均值2 计 1 次（两个半循环合成）。

## 测试

`npm test` 覆盖：演示序列手工栈核对、单调序列、重复平台、相等范围、负载荷、全常量/空/单点、首尾不同、反复小峰谷、平移只改均值、乘正整数同比缩放范围与均值而次数不变、预处理编号追溯、持久化与修订不覆盖、非法输入、HTTP 端到端。

## 限制

- 仅离线有限记录，不支持在线无限流与后台调度。
- 半整数均值在 API JSON 中以 `mean2`（两倍均值整数）呈现，避免浮点误差。
- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，属正常现象。
