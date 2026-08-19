export type Cents = number & { readonly __brand: "Cents" };

export const cents = (n: number): Cents => {
  if (!Number.isFinite(n)) throw new Error(`Not a finite amount: ${n}`);
  return Math.round(n) as Cents;
};

export const fromDollars = (d: number): Cents => cents(d * 100);
export const toDollars = (c: Cents): number => c / 100;

export const add = (...xs: Cents[]): Cents =>
  cents(xs.reduce<number>((a, b) => a + b, 0));

export const sub = (a: Cents, b: Cents): Cents => cents(a - b);

export const scale = (c: Cents, factor: number): Cents => {
  if (!Number.isFinite(factor)) throw new Error(`Not a finite factor: ${factor}`);
  return cents(c * factor);
};

export const markup = (base: Cents, pct: number): Cents => scale(base, pct);

export const grossUp = (
  base: Cents,
  rate: number,
): { total: Cents; premium: Cents } => {
  if (rate < 0 || rate >= 1) throw new Error(`Bond rate must be in [0, 1): ${rate}`);
  const total = cents(base / (1 - rate));
  return { total, premium: sub(total, base) };
};

export const percentile = (sorted: Cents[], p: number): Cents | null => {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return cents(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
};

export const formatUSD = (c: Cents): string =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(toDollars(c));
