# Mayorga Estimate Studio

*We estimate better · by WestphalianFresco*

A cost estimator for small general contractors bidding on federal, state and local construction contracts. The product name is what the UI and the printed proposal carry; the repository, the package and the engine keep their original names.

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
| Retail material prices | Home Depot via SerpApi | `npm run refresh-prices`. Retail, not contractor pricing — see below |
| Awarded prices of comparable contracts | USAspending API v2 | Has NAICS / PSC / place of performance / amount; **no building area**, so it can only validate the total range, not derive $/SF |
| Solicitation opportunities | SAM.gov Opportunities API | Requires an API key |

### Not available (client must supply or purchase)

| Data | What to do |
|---|---|
| Labor productivity (hours/unit) | Client enters their own historical data. `assumptions.ts` provides editable starting defaults |
| Absolute material unit prices | Client enters local supplier quotes. BLS PPI adjusts old quotes to the current point in time. `npm run refresh-prices` pulls Home Depot retail as a starting point, which is **not** the same thing — see below |

> ⚠️ Verify API endpoints and field names against the current official docs — government APIs change.
> Places marked `VERIFY:` in the code are things you need to confirm.

## Directory layout

```
src/
  money.ts           Integer-cents money type, avoids float drift
  schema.ts          Cross-layer contract (Zod). Change this = change the interface
  assumptions.ts     Productivity / material unit prices / markups — client-tunable, their asset
  prompts.ts         The two system prompts (stable, cacheable prefixes)
  extract.ts         Layer 1 — Claude structured extraction
  price.ts           Layer 2 — pure function, no network no AI, the only place dollars are produced
  bands.ts           The same estimate at three commercial postures — the bid band
  rollups.ts         Report subtotals: cost by type, cost by division, per-SF, price build-up
  explain.ts         Layer 3 — Claude streaming explanation
  pipeline.ts        Orchestrates the three layers + produces an audit snapshot (only place allowed I/O and clock reads)
  demo.ts            Command-line demo, runs one full estimate
  price.test.ts      Layer 2 unit tests
  bands.test.ts      Bid band and report roll-up tests
  data/
    wage-determinations.ts   Davis-Bacon lookup + trade-name mapping
    comparables.ts           USAspending cross-check
    escalation.ts            BLS PPI point-in-time adjustment

nextjs/
  app/page.tsx                    Workspace: owns state and the two fetches, no money math
  app/layout.tsx                  Theme bootstrap (Cockpit dark / Paper light, no flash)
  app/globals.css                 Design tokens, motion primitives, the print sheet
  app/preview/page.tsx            Offline preview — the real report on a fixture scope, no API key
  app/_components/
    Intake.tsx                    Drop zone, scope text, place of performance, letterhead
    Report.tsx                    The deliverable: an eleven-section bid proposal
    charts.tsx                    Hand-drawn animated SVG — market position, band, composition
    AdjustPanel.tsx               Every quantity, rate and markup on the job, editable
    ui.tsx                        Reveal-on-scroll, count-up figures, formatting, figure chrome
    export.ts                     The same report as Markdown
    types.ts                      Wire types shared by the client components
  app/api/estimate/route.ts       Streaming endpoint (NDJSON), accepts JSON or multipart
  app/api/reprice/route.ts        Layer 2 only — re-prices with manual overrides, no key needed
```

The UI carries two themes. **Cockpit** (dark) is the working surface; **Paper**
(light) is the same document as it will print. Printing always forces Paper, so
what leaves the building is a quotation rather than a screenshot of a dashboard.
Chart colours are validated palette slots, run against both surfaces for
colour-vision separation and contrast, and every chart ships a table view so no
value is reachable only by hovering.

## Location

Location selects the wage determination, the sales tax, the prevailing wage
statute and the licence classification, so it is asked for before anything else
and is the one field the extractor is not allowed to guess at.

`state` is a two-letter code or `null` — never a placeholder word. A county name
alone does not identify a state (Jefferson County exists in twenty-five of them),
so when the document names a county and nothing else, extraction returns `null`,
the report says the location is unresolved, and the wage and comparable-award
lookups are skipped rather than being sent a bad code. The UI carries a state
selector that overrides whatever the document said.

## Input and output

Two ways in:

- **A description** — type or paste anything from a formal Scope of Work down to a
  few sentences about the job. Layer 1 extracts what is stated and records what a
  bidder would still have to ask.
- **A file** — `.pdf`, `.docx`, `.txt`, `.md`, up to 20 MB. PDFs are passed to the
  model as document blocks rather than being flattened by a text extractor, so
  quantities stated in tables keep their row/column association. `.docx` is read
  with `mammoth`.

One way out: a **bid proposal** — quoted price and the band around it, market
position against comparable local awards, the markup build-up, the schedule of
work with labor hours per line, cost by division and by type, basis of estimate,
qualifications and exclusions, missing information, questions for the contracting
officer, the estimator narrative, and an acceptance block. Print it to PDF from the
browser or download it as Markdown. Every dollar figure in the report comes from
Layer 2; the narrative describes those numbers and never changes them.

## The bid band

No estimator walks into a bid room with a single number. `bands.ts` prices the
same scope three times — **aggressive**, **recommended**, **conservative** — and
the report leads with the range.

Only two things move across the three columns: **fee** and **contingency**. Direct
cost, field overhead, home office, G&A, insurance and the bond schedule are
identical in all of them, because the takeoff and the wage determination do not
change because someone feels differently about the job. A "low bid" produced by
quietly shaving quantities is not a low bid, it is a wrong estimate, and it is how
contractors lose money on work they win.

The multipliers are factors on the estimate's own schedule, not hardcoded rates, so
a contractor working at a 4% fee gets a band centred on 4% — including after they
override the fee by hand in the adjustment panel. The recommended column is priced
from the identical `PriceInput` as the headline figure and is asserted equal to it
to the cent, so the chart can never disagree with the number above it.

## Getting started

```bash
npm install
npm test          # 105 unit tests — no API key, no network needed
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
cd bid-app
npm install @anthropic-ai/sdk zod mammoth   # mammoth reads .docx uploads
# Copy src/ into bid-app/lib/ (drop demo.ts, refresh-prices.ts and *.test.ts),
# and nextjs/app/ into bid-app/app/
# Put ANTHROPIC_API_KEY in .env.local
npm run dev
```

The API key is used server-side only (Route Handler / Server Action) and must never reach the browser.

## Adjusting an estimate

The report carries an adjustment panel. Open **Adjust prices** and every quantity,
material unit cost, wage rate and markup percentage on the job becomes editable;
the bid price recalculates as you type.

The browser still produces no dollar amounts. Each edit posts the *inputs* to
`POST /api/reprice`, which runs the same Layer 2 function that produced the
original figure and returns the *amounts*. That endpoint calls no model and
touches no network, so it answers in about 15 ms and costs nothing. The report
records which fields were overridden, so an adjusted estimate stays as auditable
as an unadjusted one.

Clear a field to fall back to the engine value; **reset** drops every override at
once. `/api/reprice` returns the re-derived bid band and roll-ups alongside the
totals, so an adjusted report never shows a stale chart beside a fresh price.

## Material prices

`src/assumptions.ts` ships unit costs that are plausible, not sourced. Two ways
to improve on them:

**Home Depot retail, via SerpApi.**

```bash
$env:SERPAPI_API_KEY = "..."          # https://serpapi.com/manage-api-key
npm run refresh-prices                 # ZIP 21201 (Baltimore MD) by default
npm run refresh-prices -- 20850 0.72   # different ZIP, 28% account discount
```

This writes `material-prices.local.json`, which the route handler loads and folds
into the assumption set. The quotes used are captured in the estimate snapshot,
so pricing stays reproducible — nothing calls a live pricing API during an
estimate.

Three things it is honest about:

- **Retail is the wrong basis.** A commercial contractor buys roofing from ABC
  Supply, plumbing from Ferguson and gear from Graybar on accounts that run
  20–40% under shelf price. Pass a `retailFactor` to model your own discount;
  it defaults to 1.0 because inventing a discount would be worse than showing
  the retail number and saying what it is.
- **Only part of the catalog is a retail SKU.** Ready-mix by the yard, fabricated
  ES-1 edge metal, commercial rooftop units, elevator controllers and site
  utility pipe are not sold at Home Depot in a form an estimator can use. Those
  keys keep their catalog default and are reported as unsourced.
- **Retail sells packages, estimating needs units.** Polyiso by the 4x8 sheet,
  TPO by the 1,000 SF roll, shingles by the bundle. Each mapping carries the
  coverage of one package and a waste factor; the unit cost is derived.

**Supplier quotes.** More accurate than any of the above, because they are your
prices. Enter them in `src/assumptions.ts` and list the key in `calibratedKeys`.

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
