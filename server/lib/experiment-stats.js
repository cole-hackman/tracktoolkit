/**
 * The statistics an experiment readout needs, and nothing else: a normal CDF
 * and quantile, the two-proportion z-test, a two-arm sample-ratio check and
 * the sample-size formula. Pure functions, no dependency.
 *
 * The same arithmetic is written out in SQL in
 * docs/experiments/2026-11-activation-guided-first-run.md, and
 * tests/routes/experiment-readout.integration.test.js runs both against the
 * same rows, so the console and the document cannot drift apart.
 */

const SQRT_PI = Math.sqrt(Math.PI);

/**
 * Complementary error function, to about 1e-13.
 *
 * Below 2.5 the Maclaurin series of erf is summed directly; from 2.5 up the
 * continued fraction for erfc is used, because there 1 - erf(x) would cancel
 * away every digit that matters to a small p-value.
 */
export function erfc(x) {
  if (x < 0) return 2 - erfc(-x);
  if (x < 2.5) {
    let term = x;
    let sum = x;
    for (let n = 1; n < 200; n++) {
      term *= -(x * x) / n;
      const add = term / (2 * n + 1);
      sum += add;
      if (Math.abs(add) < 1e-17 * Math.abs(sum)) break;
    }
    return 1 - (2 / SQRT_PI) * sum;
  }
  let t = x;
  for (let k = 80; k >= 1; k--) t = x + k / 2 / t;
  return Math.exp(-x * x) / (SQRT_PI * t);
}

/** P(Z <= z) for a standard normal. */
export function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2);
}

/**
 * The z with P(Z <= z) = p. Acklam's rational approximation, then one Halley
 * step against `normalCdf`, which takes it from ~1e-9 to the precision of the
 * CDF itself.
 */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new RangeError('normalQuantile: p must be strictly between 0 and 1');
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  let x;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - low) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const error = normalCdf(x) - p;
  const u = error * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/**
 * Two-proportion z-test, treatment against control.
 *
 * The statistic uses the pooled proportion (the standard error under "no
 * difference"); the 95% interval for the difference uses each arm's own
 * proportion (Wald). `difference` is treatment minus control.
 *
 * @returns {null | { controlRate: number, treatmentRate: number, difference: number,
 *   z: number, pValue: number, ci95: [number, number] }}
 *   null when an arm is empty, or when nobody or everybody converted (no
 *   variance, so no test).
 */
export function twoProportionTest({ controlSuccesses, controlTotal, treatmentSuccesses, treatmentTotal }) {
  if (!(controlTotal > 0) || !(treatmentTotal > 0)) return null;
  const p1 = controlSuccesses / controlTotal;
  const p2 = treatmentSuccesses / treatmentTotal;
  const pooled = (controlSuccesses + treatmentSuccesses) / (controlTotal + treatmentTotal);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / controlTotal + 1 / treatmentTotal));
  if (!(se > 0)) return null;
  const z = (p2 - p1) / se;
  const seUnpooled = Math.sqrt((p1 * (1 - p1)) / controlTotal + (p2 * (1 - p2)) / treatmentTotal);
  const margin = normalQuantile(0.975) * seUnpooled;
  return {
    controlRate: p1,
    treatmentRate: p2,
    difference: p2 - p1,
    z,
    pValue: erfc(Math.abs(z) / Math.SQRT2),
    ci95: [p2 - p1 - margin, p2 - p1 + margin],
  };
}

/**
 * Sample-ratio mismatch for a two-arm split: a chi-square goodness-of-fit
 * test (1 degree of freedom) of the observed counts against the weights.
 *
 * A very small p-value (the pre-registration uses 0.001) means the arms are
 * not the sizes the assignment should produce, which is a bug in assignment
 * or in exposure logging, and no comparison between the arms can be trusted
 * until it is found.
 *
 * @param {number[]} observed  exactly two counts
 * @param {number[]} weights   their expected shares, any positive scale
 * @returns {null | { chi2: number, pValue: number, expected: number[] }}
 */
export function sampleRatioTest(observed, weights) {
  if (observed.length !== 2 || weights.length !== 2) return null;
  const total = observed[0] + observed[1];
  const weightSum = weights[0] + weights[1];
  if (!(total > 0) || !(weightSum > 0)) return null;
  const expected = weights.map((w) => (total * w) / weightSum);
  if (expected.some((e) => !(e > 0))) return null;
  const chi2 = observed.reduce((sum, o, i) => sum + ((o - expected[i]) ** 2) / expected[i], 0);
  return { chi2, pValue: erfc(Math.sqrt(chi2 / 2)), expected };
}

/**
 * Users needed in EACH arm to detect an absolute change of `mde` from
 * `baseline` with a two-sided two-proportion z-test.
 *
 *   n = ( z[1-alpha/2] * sqrt(2 * pbar * (1 - pbar))
 *       + z[power]     * sqrt(p1 * (1 - p1) + p2 * (1 - p2)) )^2 / (p2 - p1)^2
 *
 *   p1 = baseline, p2 = baseline + mde, pbar = (p1 + p2) / 2
 *
 * Rounded up. `mde` may be negative (detecting a drop); the result depends on
 * its size and on which side of 50% the two rates sit.
 */
export function sampleSizePerArm(baseline, mde, { alpha = 0.05, power = 0.8 } = {}) {
  const p1 = baseline;
  const p2 = baseline + mde;
  if (!(p1 > 0 && p1 < 1)) throw new RangeError('baseline must be strictly between 0 and 1');
  if (!(p2 > 0 && p2 < 1)) throw new RangeError('baseline + mde must be strictly between 0 and 1');
  if (mde === 0) throw new RangeError('mde must not be 0');
  if (!(alpha > 0 && alpha < 1) || !(power > 0 && power < 1)) {
    throw new RangeError('alpha and power must be strictly between 0 and 1');
  }
  const pbar = (p1 + p2) / 2;
  const zAlpha = normalQuantile(1 - alpha / 2);
  const zPower = normalQuantile(power);
  const numerator = zAlpha * Math.sqrt(2 * pbar * (1 - pbar)) + zPower * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((numerator * numerator) / (mde * mde));
}
