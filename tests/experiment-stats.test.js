import {
  erfc,
  normalCdf,
  normalQuantile,
  twoProportionTest,
  sampleRatioTest,
  sampleSizePerArm,
} from '../server/lib/experiment-stats.js';

// Reference values are from standard tables (and match PostgreSQL 16's
// erfc(), which the analysis SQL in the pre-registration document uses).

describe('erfc and the normal distribution', () => {
  test.each([
    [0, 1],
    [0.5, 0.4795001221869535],
    [1, 0.15729920705028513],
    [2, 0.004677734981047265],
    [3, 2.2090496998585438e-5],
    [5, 1.5374597944280351e-12],
  ])('erfc(%p)', (x, expected) => {
    expect(Math.abs(erfc(x) - expected) / expected).toBeLessThan(1e-10);
  });

  test('is continuous where the series hands over to the continued fraction', () => {
    expect(Math.abs(erfc(2.5 - 1e-9) - erfc(2.5))).toBeLessThan(1e-11);
  });

  test('erfc(-x) = 2 - erfc(x)', () => {
    expect(erfc(-1)).toBeCloseTo(2 - 0.15729920705028513, 12);
  });

  test('the usual critical values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 12);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 10);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 9);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 9);
    expect(normalQuantile(0.5)).toBeCloseTo(0, 12);
    expect(normalQuantile(0.025)).toBeCloseTo(-1.959963984540054, 9);
  });

  test('the quantile inverts the CDF across the range, tails included', () => {
    for (const p of [1e-8, 0.001, 0.02, 0.3, 0.5, 0.7, 0.98, 0.999, 1 - 1e-8]) {
      expect(Math.abs(normalCdf(normalQuantile(p)) - p)).toBeLessThan(1e-11);
    }
    expect(() => normalQuantile(0)).toThrow(RangeError);
    expect(() => normalQuantile(1)).toThrow(RangeError);
  });
});

describe('two-proportion z-test', () => {
  test('a worked example: 200/1000 against 250/1000', () => {
    const result = twoProportionTest({
      controlSuccesses: 200, controlTotal: 1000, treatmentSuccesses: 250, treatmentTotal: 1000,
    });
    // pooled 0.225; se = sqrt(0.225 * 0.775 * 0.002) = 0.0186748…
    expect(result.controlRate).toBe(0.2);
    expect(result.treatmentRate).toBe(0.25);
    expect(result.difference).toBeCloseTo(0.05, 12);
    expect(result.z).toBeCloseTo(2.6773978, 6);
    expect(result.pValue).toBeCloseTo(0.0074196, 6);
    expect(result.ci95[0]).toBeCloseTo(0.0134636, 6);
    expect(result.ci95[1]).toBeCloseTo(0.0865364, 6);
  });

  test('is signed: treatment below control gives a negative z and the same p', () => {
    const up = twoProportionTest({ controlSuccesses: 200, controlTotal: 1000, treatmentSuccesses: 250, treatmentTotal: 1000 });
    const down = twoProportionTest({ controlSuccesses: 250, controlTotal: 1000, treatmentSuccesses: 200, treatmentTotal: 1000 });
    expect(down.z).toBeCloseTo(-up.z, 12);
    expect(down.pValue).toBeCloseTo(up.pValue, 12);
    expect(down.difference).toBeCloseTo(-0.05, 12);
  });

  test('identical rates are z = 0, p = 1', () => {
    const result = twoProportionTest({ controlSuccesses: 30, controlTotal: 100, treatmentSuccesses: 60, treatmentTotal: 200 });
    expect(result.z).toBe(0);
    expect(result.pValue).toBe(1);
  });

  test('there is no test without both arms, or without any variance', () => {
    expect(twoProportionTest({ controlSuccesses: 0, controlTotal: 0, treatmentSuccesses: 5, treatmentTotal: 10 })).toBeNull();
    expect(twoProportionTest({ controlSuccesses: 5, controlTotal: 10, treatmentSuccesses: 0, treatmentTotal: 0 })).toBeNull();
    expect(twoProportionTest({ controlSuccesses: 0, controlTotal: 10, treatmentSuccesses: 0, treatmentTotal: 10 })).toBeNull();
    expect(twoProportionTest({ controlSuccesses: 10, controlTotal: 10, treatmentSuccesses: 10, treatmentTotal: 10 })).toBeNull();
  });
});

describe('sample-ratio check', () => {
  test('an even split passes; a lopsided one does not', () => {
    const even = sampleRatioTest([5000, 5040], [50, 50]);
    expect(even.pValue).toBeGreaterThan(0.5);
    const lopsided = sampleRatioTest([5000, 5400], [50, 50]);
    // chi2 = 2 * 200^2 / 5200 = 15.3846…
    expect(lopsided.chi2).toBeCloseTo(15.384615, 5);
    expect(lopsided.pValue).toBeLessThan(0.001);
    expect(lopsided.expected).toEqual([5200, 5200]);
  });

  test('uses the weights, whatever scale they are on', () => {
    const result = sampleRatioTest([900, 100], [90, 10]);
    expect(result.chi2).toBe(0);
    expect(result.pValue).toBe(1);
    expect(sampleRatioTest([900, 100], [9, 1]).expected).toEqual([900, 100]);
  });

  test('is only defined for two arms with someone in them', () => {
    expect(sampleRatioTest([0, 0], [50, 50])).toBeNull();
    expect(sampleRatioTest([1, 2, 3], [1, 1, 1])).toBeNull();
    expect(sampleRatioTest([10, 10], [100, 0])).toBeNull();
  });
});

describe('sample size per arm', () => {
  // Checked against the closed form by hand and against published tables for
  // a two-sided alpha of 0.05 and 80% power.
  test.each([
    [0.4, 0.05, 1534],
    [0.2, 0.05, 1094],
    [0.5, 0.1, 388],
    [0.1, 0.02, 3841],
  ])('baseline %p, MDE %p → %p', (baseline, mde, expected) => {
    expect(sampleSizePerArm(baseline, mde)).toBe(expected);
  });

  test('a smaller effect, more power or a stricter alpha all need more users', () => {
    const base = sampleSizePerArm(0.4, 0.05);
    expect(sampleSizePerArm(0.4, 0.025)).toBeGreaterThan(base * 3.5);
    expect(sampleSizePerArm(0.4, 0.05, { power: 0.9 })).toBeGreaterThan(base);
    expect(sampleSizePerArm(0.4, 0.05, { alpha: 0.01 })).toBeGreaterThan(base);
  });

  test('a drop of the same size is a valid input', () => {
    expect(sampleSizePerArm(0.45, -0.05)).toBe(sampleSizePerArm(0.4, 0.05));
  });

  test('refuses inputs that are not proportions', () => {
    expect(() => sampleSizePerArm(0, 0.05)).toThrow(RangeError);
    expect(() => sampleSizePerArm(0.4, 0)).toThrow(RangeError);
    expect(() => sampleSizePerArm(0.98, 0.05)).toThrow(RangeError);
    expect(() => sampleSizePerArm(40, 5)).toThrow(RangeError);
    expect(() => sampleSizePerArm(0.4, 0.05, { alpha: 5 })).toThrow(RangeError);
  });
});
