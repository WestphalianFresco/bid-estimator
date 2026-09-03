import { priceBands } from "@/lib/bands";
import { assertTotalsConsistent } from "@/lib/price";
import { RepriceRequestSchema, isUnchanged, repriceEstimate } from "@/lib/reprice";
import { summarizeComposition } from "@/lib/rollups";

/**
 * Re-prices an estimate with the estimator's manual adjustments.
 *
 * No model call, no network, no API key — this is Layer 2 and nothing else, so
 * it answers in milliseconds and costs nothing to call on every keystroke.
 *
 * It exists so the adjustment panel in the report does not have to do
 * arithmetic in the browser. The client sends inputs (a quantity, a unit cost,
 * a base wage, a markup percentage); this returns amounts. That is the same
 * division of labour as the main estimate endpoint, and it is what keeps
 * "every dollar comes from the pricing engine" true even while the estimator
 * is dragging numbers around.
 */

export const runtime = "nodejs";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Request body is not valid JSON" }, { status: 400 });
  }

  const parsed = RepriceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      {
        error: "Adjustment request failed validation",
        detail: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
      { status: 400 },
    );
  }

  try {
    const { estimate, input, changed } = repriceEstimate(parsed.data);
    assertTotalsConsistent(estimate.totals);
    // The band and the roll-ups are re-derived from the same merged input, so
    // an adjusted report never shows a stale chart beside a fresh total.
    return Response.json({
      estimate,
      changed,
      unchanged: isUnchanged(changed),
      bands: priceBands(input),
      composition: summarizeComposition(estimate, input.scope),
    });
  } catch (e) {
    console.error("Reprice failed:", e);
    const message =
      process.env.NODE_ENV === "production"
        ? "Re-pricing failed."
        : e instanceof Error
          ? e.message
          : String(e);
    return Response.json({ error: message }, { status: 500 });
  }
}
