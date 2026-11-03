/** YA-36: the EPA correction and the 2024 PM2.5 AQI, against EPA's published example and every breakpoint edge. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aqiFromPm25, epaCorrectedPm25, PM25_BREAKPOINTS, truncatePm25} from '../../../src/voice/air/aqi.ts';

test("EPA's worked example: 35.9 µg/m³ is AQI 102, Unhealthy for Sensitive Groups", () => {
  // Technical Assistance Document for the Reporting of Daily Air Quality: (150-101)/(55.4-35.5) x (35.9-35.5) + 101.
  assert.deepEqual(aqiFromPm25(35.9), {aqi: 102, category: 'unhealthyForSensitiveGroups'});
});

test('every 2024 breakpoint edge lands on its own index and category', () => {
  const edges: Array<[number, number, string]> = [
    [0.0, 0, 'good'],
    [9.0, 50, 'good'],
    [9.1, 51, 'moderate'],
    [35.4, 100, 'moderate'],
    [35.5, 101, 'unhealthyForSensitiveGroups'],
    [55.4, 150, 'unhealthyForSensitiveGroups'],
    [55.5, 151, 'unhealthy'],
    [125.4, 200, 'unhealthy'],
    [125.5, 201, 'veryUnhealthy'],
    [225.4, 300, 'veryUnhealthy'],
    [225.5, 301, 'hazardous'],
    [325.4, 500, 'hazardous'],
  ];
  for (const [concentration, aqi, category] of edges) {
    assert.deepEqual(aqiFromPm25(concentration), {aqi, category}, `${concentration} µg/m³`);
  }
  // Good ends at 9.0 in the 2024 revision (it was 12.0 before).
  assert.equal(PM25_BREAKPOINTS[0].concentrationHigh, 9.0);
  assert.equal(aqiFromPm25(12.0).category, 'moderate');
});

test('concentrations are truncated to one decimal, not rounded, before the index', () => {
  assert.equal(truncatePm25(9.09), 9.0);
  assert.deepEqual(aqiFromPm25(9.09), {aqi: 50, category: 'good'});
  assert.equal(truncatePm25(35.49), 35.4);
  assert.equal(aqiFromPm25(35.49).aqi, 100);
  assert.equal(truncatePm25(-3), 0);
});

test('above 325.4 µg/m³ the index goes on past 500 on the Hazardous slope (TAD Table 6, footnote 4)', () => {
  const slope = (500 - 301) / (325.4 - 225.5);
  for (const concentration of [325.5, 420.4, 500.4, 600, 1000]) {
    const expected = Math.round(slope * (concentration - 225.5) + 301);
    assert.deepEqual(aqiFromPm25(concentration), {aqi: expected, category: 'hazardous'}, `${concentration} µg/m³`);
  }
  // The reviewer's figures: a corrected 420.4 is 689, 500.4 is 849; and 600 is 1047, 1000 is 1844.
  assert.equal(aqiFromPm25(420.4).aqi, 689);
  assert.equal(aqiFromPm25(500.4).aqi, 849);
  assert.equal(aqiFromPm25(600).aqi, 1047);
  assert.equal(aqiFromPm25(1000).aqi, 1844);
});

test('the 2021 US-wide correction below 30 µg/m³: 0.524 x PA - 0.0862 x RH + 5.75', () => {
  assert.ok(Math.abs(epaCorrectedPm25(20, 50) - (0.524 * 20 - 0.0862 * 50 + 5.75)) < 1e-9);
  assert.ok(Math.abs(epaCorrectedPm25(10, 30) - 8.404) < 1e-9);
  // Never negative: clean air on a humid day.
  assert.equal(epaCorrectedPm25(0, 100), 0);
});

test('the extended (smoke) correction: its published pieces, and no jump where they meet', () => {
  assert.ok(Math.abs(epaCorrectedPm25(100, 40) - (0.786 * 100 - 0.0862 * 40 + 5.75)) < 1e-9);
  assert.ok(Math.abs(epaCorrectedPm25(300, 20) - (2.966 + 0.69 * 300 + 8.84e-4 * 300 ** 2)) < 1e-9);
  // The blend from 30 to 50 is the 2021 line at 30 and the 0.786 line at 50.
  assert.ok(Math.abs(epaCorrectedPm25(40, 40) - ((0.786 * 0.5 + 0.524 * 0.5) * 40 - 0.0862 * 40 + 5.75)) < 1e-9);
  for (const edge of [30, 50, 210, 260]) {
    for (const rh of [10, 50, 90]) {
      const below = epaCorrectedPm25(edge - 1e-6, rh);
      const at = epaCorrectedPm25(edge, rh);
      assert.ok(Math.abs(at - below) < 0.01, `a jump of ${at - below} at ${edge} µg/m³, ${rh}% RH`);
    }
  }
});
