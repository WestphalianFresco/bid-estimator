# Gov Bid Estimator

面向小型总承包商的联邦/州政府建筑合同成本估算器。

## 定位(先读这段)

这是一个 **ROM / conceptual estimator** —— AACE International Class 4–5,
预期精度 **±20~30%**。用途是回答:

- 这个标值不值得投?
- 我的直觉报价在不在合理区间?
- 我漏了哪些成本项?

它**不是** detailed bid estimator。不要拿它的输出直接当投标价提交。

## 三层架构

```
客户输入(RFP 文本 / 自然语言需求)
        │
        ▼
┌────────────────────────────────────────────────┐
│ Layer 1 — Claude:结构化提取                    │
│ extract.ts                                     │
│ 自然语言 → ExtractedScope(schema 强制约束)     │
│ 同时输出「缺失信息」和「需要澄清的问题」         │
└────────────────────────────────────────────────┘
        │  ExtractedScope
        ▼
┌────────────────────────────────────────────────┐
│ Layer 2 — 确定性定价引擎(纯代码,无 AI)        │
│ price.ts                                       │
│                                                │
│  工作量 × 生产率 → 工时                         │
│  工时 × Davis-Bacon 装载工资率 → 直接人工       │
│  + 材料 + 设备 + 分包 = 直接成本                │
│  + 现场管理费 (Div 01)                          │
│  + 公司管理费 / G&A                             │
│  + 利润                                        │
│  + 保险                                        │
│  + 或然费 (contingency)                         │
│  ÷ (1 - 保证金率)  ← bond 按最终合同额计,需反算  │
│  = 投标价                                      │
│                                                │
│  ★ 所有金额都在这一层产生。全部用整数分计算。    │
└────────────────────────────────────────────────┘
        │  PricedEstimate
        ▼
┌────────────────────────────────────────────────┐
│ Layer 3 — Claude:解释、假设清单、风险提示       │
│ explain.ts                                     │
│ 只读数字,不改数字。生成客户看得懂的说明。       │
└────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────┐
│ 交叉校验(独立于 Layer 2)                       │
│ data/comparables.ts                            │
│ USAspending 同类合同中标价 p25/p50/p75          │
│ bottom-up 结果落在区间外 → 红旗                 │
└────────────────────────────────────────────────┘
```

**核心不变量:每一个金额都来自 Layer 2 的确定性代码。Claude 只碰文字。**
同一份输入 + 同一套假设 ⇒ 永远得到同一个数字,可复现、可审计。

## 数据来源

### 有的(公开、免费)

| 数据 | 来源 | 备注 |
|---|---|---|
| Davis-Bacon 工资裁定 | SAM.gov Wage Determinations | 按县 + 工种,含 base rate 与 fringe。联邦建筑合同 >$2,000 强制适用 |
| 材料价格指数 | BLS Producer Price Index | 只给**涨幅**,不给绝对单价。用于时间点调整 |
| 同类合同中标价 | USAspending API v2 | 有 NAICS / PSC / 履约地 / 金额;**没有建筑面积**,所以只能做总额区间校验,推不出 $/SF |
| 招标机会 | SAM.gov Opportunities API | 需申请 API key |

### 没有的(必须客户自备或购买)

| 数据 | 怎么办 |
|---|---|
| 劳动生产率(工时/单位) | 客户录入自己的历史数据。`assumptions.ts` 提供可编辑的起始默认值 |
| 材料绝对单价 | 客户录入本地供应商报价。BLS PPI 负责把旧报价调整到当前时点 |

> ⚠️ API 端点和字段名请对照当前官方文档核实 —— 政府 API 会改。
> 代码里标了 `VERIFY:` 的地方是需要你确认的。

## 目录

同一套代码提供两个版本,**逻辑完全一致**,只差注释:

- `zh/` —— 带中文注释,解释了每个设计决策的原因。用来读懂和维护。
- `clean/` —— 无注释纯代码,英文标识符和提示词。用来直接投产。

```
zh/ | clean/
  money.ts           整数分金额类型,避免浮点漂移
  schema.ts          层间契约(Zod)。改这里 = 改接口
  assumptions.ts     生产率 / 材料单价 / 加成率 —— 客户可调,是他们的资产
  prompts.ts         两个 system prompt(可缓存的稳定前缀)
  extract.ts         Layer 1 —— Claude 结构化提取
  price.ts           Layer 2 —— 纯函数,无网络无 AI,唯一产出金额的地方
  explain.ts         Layer 3 —— Claude 流式解释
  pipeline.ts        编排三层 + 生成审计快照(唯一允许 I/O 和读时钟的地方)
  demo.ts            命令行演示,跑一次完整估算
  price.test.ts      Layer 2 的单元测试
  data/
    wage-determinations.ts   Davis-Bacon 查询 + 工种名映射
    comparables.ts           USAspending 交叉校验
    escalation.ts            BLS PPI 时点调整

nextjs/
  app/page.tsx                    最小可用界面
  app/api/estimate/route.ts       流式接口(NDJSON)
```

## 起步

```bash
npm install
npm test          # Layer 2 单元测试 —— 不需要 API key,不需要网络
```

跑完整估算需要 API key:

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run demo
```

接到 Next.js:

```bash
npx create-next-app@latest bid-app --typescript --app --no-src-dir --import-alias "@/*"
# 把 clean/(或 zh/)复制进 bid-app/lib/,把 nextjs/app/ 复制进 bid-app/app/
# .env.local 里写 ANTHROPIC_API_KEY
npm run dev
```

API key 只在服务器端使用(Route Handler / Server Action),绝不能进浏览器。

## 上线前必须做的三件事

1. **免责声明** —— 「估算参考,非投标保证。使用者须自行核实。」放在输出页面上,不是埋在 ToS 里。
2. **人工复核提示** —— 超过一定金额或置信度低的估算,提示客户请注册估算师复核。
3. **完整快照** —— 每份估算保存:输入原文、当时的假设值、工资裁定版本、引擎版本号、时间戳。
   出争议时这份记录是你唯一的保护。见 `schema.ts` 的 `EstimateSnapshot`。

## 上线前必须改的三处配置

| 位置 | 现在 | 上线要改成 |
|---|---|---|
| `app/api/estimate/route.ts` | `useFixtureWages: true` | `false` + 配置 `SAM_GOV_API_KEY` |
| 同上 | `assumptions: STARTING_DEFAULTS` | 当前登录客户自己的假设库 |
| `data/escalation.ts` | `PPI_SERIES` 是空的 | 去 BLS 查证后填(**填错比留空更糟**) |

第一条最要紧。`makeFixtureWageTable()` 返回的工资率是编的,`determinationId` 写着
`FIXTURE-DO-NOT-USE-IN-PROD`。用它算出来的报价看起来完全正常 —— 这正是危险的地方。

## 测试

Layer 2 是纯函数,没有网络和 AI,**必须有单元测试**。这是唯一会产出金额的地方。

```bash
npm test
```
