# Gov Bid Estimator

A cost estimator for small general contractors bidding on federal/state government construction contracts.

## Positioning (read this first)

This is a **ROM / conceptual estimator** — AACE International Class 4–5,
expected accuracy **±20–30%**. It's meant to answer:

- Is this solicitation worth pursuing?
- Is my gut-feel price in a reasonable range?
- Which cost items am I forgetting?

It is **not** a detailed bid estimator. Do not submit its output directly as a bid price.

## Three-layer architecture

```
Client input (RFP text / natural-language requirements)
        │
        ▼
┌────────────────────────────────────────────────┐
│ Layer 1 — Claude: structured extraction         │
│ extract.ts                                      │
│ Natural language → ExtractedScope (schema-bound)│
│ Also outputs "missing info" and "questions to   │
│ clarify"                                         │
└────────────────────────────────────────────────┘
        │  ExtractedScope
        ▼
┌────────────────────────────────────────────────┐
│ Layer 2 — Deterministic pricing engine (pure    │
│ code, no AI)                                    │
│ price.ts                                        │
│                                                 │
│  Quantity × productivity → labor hours          │
│  Hours × Davis-Bacon loaded wage rate → direct  │
│    labor                                        │
│  + materials + equipment + subs = direct cost   │
│  + field overhead (Div 01)                      │
│  + company overhead / G&A                        │
│  + profit                                       │
│  + insurance                                    │
│  + contingency                                  │
│  ÷ (1 − bond rate)  ← bond is on final contract  │
│    amount, so back it out                       │
│  = bid price                                    │
│                                                 │
│  ★ Every dollar amount is produced in this      │
│    layer. All math in integer cents.            │
└────────────────────────────────────────────────┘
        │  PricedEstimate
        ▼
┌────────────────────────────────────────────────┐
│ Layer 3 — Claude: explanation, assumption list, │
│ risk callouts                                   │
│ explain.ts                                      │
│ Reads the numbers only, never changes them.     │
│ Produces a client-readable writeup.             │
└────────────────────────────────────────────────┘
        │
        ▼
┌────────────────────────────────────────────────┐
│ Cross-check (independent of Layer 2)            │
│ data/comparables.ts                             │
│ Awarded prices of comparable USAspending        │
│ contracts, p25/p50/p75                          │
│ Bottom-up result outside the range → red flag   │
└────────────────────────────────────────────────┘
```

**Core invariant: every dollar amount comes from Layer 2's deterministic code. Claude only touches text.**
The same input + the same assumptions ⇒ always the same number — reproducible and auditable.

## Data sources

### Available (public, free)

| Data | Source | Notes |
|---|---|---|
| Davis-Bacon wage determinations | SAM.gov Wage Determinations | By county + trade, includes base rate and fringe. Mandatory on federal construction contracts >$2,000 |
| Material price indices | BLS Producer Price Index | Gives the **rate of change** only, not absolute unit prices. Used for point-in-time adjustment |
| Awarded prices of comparable contracts | USAspending API v2 | Has NAICS / PSC / place of performance / amount; **no building area**, so it can only validate the total range, not derive $/SF |
| Solicitation opportunities | SAM.gov Opportunities API | Requires an API key |

### Not available (client must supply or purchase)

| Data | What to do |
|---|---|
| Labor productivity (hours/unit) | Client enters their own historical data. `assumptions.ts` provides editable starting defaults |
| Absolute material unit prices | Client enters local supplier quotes. BLS PPI adjusts old quotes to the current point in time |

> ⚠️ Verify API endpoints and field names against the current official docs — government APIs change.
> Places marked `VERIFY:` in the code are things you need to confirm.

## Directory layout

The same codebase ships in two versions, **logically identical**, differing only in comments:

- `zh/` — with Chinese comments explaining the reason behind each design decision. For reading and maintaining.
- `clean/` — no comments, English identifiers and prompts. For direct production use.

```
zh/ | clean/
  money.ts           Integer-cents money type, avoids float drift
  schema.ts          Cross-layer contract (Zod). Change this = change the interface
  assumptions.ts     Productivity / material unit prices / markups — client-tunable, their asset
  prompts.ts         The two system prompts (stable, cacheable prefixes)
  extract.ts         Layer 1 — Claude structured extraction
  price.ts           Layer 2 — pure function, no network no AI, the only place dollars are produced
  explain.ts         Layer 3 — Claude streaming explanation
  pipeline.ts        Orchestrates the three layers + produces an audit snapshot (only place allowed I/O and clock reads)
  demo.ts            Command-line demo, runs one full estimate
  price.test.ts      Layer 2 unit tests
  data/
    wage-determinations.ts   Davis-Bacon lookup + trade-name mapping
    comparables.ts           USAspending cross-check
    escalation.ts            BLS PPI point-in-time adjustment

nextjs/
  app/page.tsx                    Minimal usable UI
  app/api/estimate/route.ts       Streaming endpoint (NDJSON)
```

## Getting started

```bash
npm install
npm test          # Layer 2 unit tests — no API key, no network needed
```

Running a full estimate needs an API key:

```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm run demo
```

Wiring into Next.js:

```bash
npx create-next-app@latest bid-app --typescript --app --no-src-dir --import-alias "@/*"
# Copy clean/ (or zh/) into bid-app/lib/, and nextjs/app/ into bid-app/app/
# Put ANTHROPIC_API_KEY in .env.local
npm run dev
```

The API key is used server-side only (Route Handler / Server Action) and must never reach the browser.

## Three things you must do before going live

1. **Disclaimer** — "Estimate for reference, not a bid guarantee. User must verify independently." Put it on the output page, not buried in the ToS.
2. **Manual-review prompt** — for estimates above a certain amount or with low confidence, prompt the client to have a registered estimator review them.
3. **Full snapshot** — for each estimate, save: the original input text, the assumption values at the time, the wage-determination version, the engine version number, and a timestamp.
   When a dispute arises, this record is your only protection. See `EstimateSnapshot` in `schema.ts`.

## Three config settings you must change before going live

| Location | Currently | Change to for production |
|---|---|---|
| `app/api/estimate/route.ts` | `useFixtureWages: true` | `false` + configure `SAM_GOV_API_KEY` |
| same | `assumptions: STARTING_DEFAULTS` | the currently logged-in client's own assumption library |
| `data/escalation.ts` | `PPI_SERIES` is empty | fill it in after verifying against BLS (**filling it wrong is worse than leaving it empty**) |

The first one matters most. The wage rates returned by `makeFixtureWageTable()` are made up, and the
`determinationId` reads `FIXTURE-DO-NOT-USE-IN-PROD`. A bid computed from them looks completely normal —
which is exactly what makes it dangerous.

## Testing

Layer 2 is a pure function with no network and no AI, so it **must have unit tests**. It's the only place that produces dollar amounts.

```bash
npm test
```
