# 雨流载荷循环计数与半循环来源核验后端

离线载荷序列的雨流循环计数服务，仅含 API 与 CLI，无前端。使用 TypeScript + Node.js + SQLite（`node:sqlite` 内置模块，无原生依赖），Windows 本地直接运行，不依赖 Docker / WSL / 外部在线服务。

本工具只统计载荷变化：不预测真实零件寿命、不计算材料损伤、不连接传感器，不支持多轴载荷与频域分析。演示数据均为虚构。

## 环境要求

- Node.js >= 22.5（使用内置 `node:sqlite`，建议 Node 24+；运行时出现 ExperimentalWarning 属正常提示）
- Windows 本地运行

## 快速开始

```powershell
npm install
npm run build     # 编译 TypeScript 到 dist/
npm test          # 构建并运行全部测试
npm run demo      # 运行内置演示序列（含栈变化过程）
npm start         # 启动 API 服务（默认从 8734 起自动选空闲端口）
```

数据保存在项目内 `data/rainflow.db`（可用环境变量 `RAINFLOW_DATA_DIR` 覆盖），重启后结果可核对。

## 算法说明

### 转折点提取（平台取点口径）

1. 先去掉连续相等值（平台段只保留第一个点）；
2. 保留两端点与严格方向反转点（峰/谷）；
3. 每个转折点保留其原始采样序号 `seq`，被剔除的中间点可通过原始采样与转折点记录对照追溯。

平台规则标识：`dedupe-consecutive+strict-reversal-endpoints`，随报告落库。

### 三点栈计数

每个新转折点入栈后，比较末三点形成的前一段范围 `X` 与后一段范围 `Y`：

- `X > Y`：暂不闭合；
- `X <= Y`（相等范围也结算）：
  - 栈恰三点：输出前段的**半循环**，移除最早点；
  - 栈多于三点：输出前段的**完整循环**，移除该段两个端点，保留最新点并继续检查。

全部点处理完后，栈中剩余相邻段各结算为一个**半循环**（残余段不丢弃）。

### 有限记录语义

输入是有限采样记录，首尾不闭合：末尾不会擅自接回开头形成周期信号。因此边界段以半循环结算，这是半循环的正常来源，而非数据缺失。

### 整数计数与聚合键

- 计数用半循环单位整数：`1` = 半次，`2` = 一次，汇总不做浮点累加；
- 均值可为半整数，保存 `mean2 = 2 * mean`（整数）作为精确聚合键；
- 循环谱按 `(range, mean2)` 聚合，保留均值差异，不只按范围合并。

每条循环记录：两个来源转折点（转折点下标 + 原始采样序号 + 载荷值）、范围、两倍均值、权重（半次/一次）、触发它的新转折点下标、类型（half / full / residual）。

## CLI 命令

```
node dist/src/cli.js serve [--port N]                 启动 API（端口被占用时自动顺延）
node dist/src/cli.js import --name N --values "[..]"  导入序列（--file 从文件读；--revision-of <id> 生成修订版）
node dist/src/cli.js list                             列出序列
node dist/src/cli.js turning-points <seriesId>        查看转折点
node dist/src/cli.js count <seriesId>                 执行计数并生成报告
node dist/src/cli.js report <reportId>                查看明细与循环谱
node dist/src/cli.js stack <reportId>                 查看栈变化过程
node dist/src/cli.js reports [seriesId]               列出报告
node dist/src/cli.js compare <idA> <idB>              比较两个序列版本
node dist/src/cli.js export <reportId> [--format csv|json] [--section cycles|spectrum]
node dist/src/cli.js demo                             内置演示
```

修订采样通过 `--revision-of` 产生新序列（revision 递增）并生成新报告，原始数据不被覆盖。

## HTTP API

默认 `http://127.0.0.1:8734`（占用时自动顺延，启动日志打印实际端口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/series` | 导入序列，body: `{name, values, revisionOf?}` |
| GET | `/series` | 列出序列 |
| GET | `/series/:id` | 序列详情与原始采样 |
| GET | `/series/:id/turning-points` | 转折点（含原始 seq） |
| POST | `/series/:id/count` | 执行计数，生成报告 |
| GET | `/series/:id/reports` | 该序列的报告列表 |
| GET | `/reports/:id` | 报告：转折点 + 循环明细 + 循环谱 |
| GET | `/reports/:id/stack?limit=&offset=` | 栈变化事件（每页上限 200 条） |
| GET | `/reports/:id/export?format=csv|json&section=cycles|spectrum` | 导出 |
| GET | `/compare?a=<id>&b=<id>` | 比较两个序列版本 |

错误响应统一为 `{"error": {"code", "message"}}`，错误码包括 `E_NOT_ARRAY`、`E_BAD_VALUE`、`E_OUT_OF_RANGE`、`E_TOO_LONG`、`E_BAD_ID`、`E_NOT_FOUND`、`E_NO_ROUTE`、`E_BODY_TOO_LARGE`、`E_INTERNAL`。

## 限制与假设

- 输入限制：最多 100000 个采样点；载荷须为安全整数且绝对值 <= 1e12；
- 栈事件展示每页上限 200 条（可用 `offset` 翻页）；
- 计数与落库在单个事务内完成：整次成功才发布完整循环谱，失败回滚，不留部分汇总；
- 不支持在线无限流与后台调度；每次 `count` 生成一份新报告，历史报告保留可核对；
- 算法版本标识 `rf-stack-1.0` 随报告保存，便于日后算法变更后区分结果。

## 演示序列

`npm run demo` 内置三组虚构序列：

- `[0,3,1,4,0]`：内部 3->1 形成 range=2 的一个完整循环；两端残余各形成 range=4 的半循环，合计一个 range=4 循环；两组均值均为 2；
- `[0,1,2,3,4]`：单调序列只有端点残余半循环；
- `[0,2,2,2,0,2,0]`：重复平台不增加循环。

## 测试

`npm test` 覆盖：演示序列手工栈核对、单调序列、重复平台、相等范围（X<=Y）、负载荷、全常量/空/单点、首尾不同、反复小峰谷、整体平移只改均值、乘正整数同比缩放范围与均值、排序破坏顺序语义、输入校验、API 全流程与版本比较。
