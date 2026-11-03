/** YA-36: fresh rows only, outliers set aside, the median of the rest. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {aggregate, FRESH_MS, median, weightedMedian, withoutOutliers} from '../../../src/voice/air/aggregate.ts';
import {aqiFromPm25, epaCorrectedPm25} from '../../../src/voice/air/aqi.ts';
import type {SensorRow} from '../../../src/voice/air/purpleair.ts';

const NOW = Date.parse('2026-09-14T12:00:00Z');

function row(minutesAgo: number, pm?: number, humidity?: number): SensorRow {
  const sensor: SensorRow = {name: 'x', lat: 46.87, lon: -113.99, lastSeenMs: NOW - minutesAgo * 60_000};
  if (pm !== undefined) sensor.pm25TenMinute = pm;
  if (humidity !== undefined) sensor.humidity = humidity;
  return sensor;
}

test('median of odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test('one sensor far from the rest is an outlier; a spread of honest values is not', () => {
  assert.deepEqual(withoutOutliers([10, 11, 12, 11, 80]), [10, 11, 12, 11]);
  assert.deepEqual(withoutOutliers([10, 14, 18, 22]), [10, 14, 18, 22]);
  // With fewer than three values there is no majority to judge by, so both stay.
  assert.deepEqual(withoutOutliers([10, 80]), [10, 80]);
});

test('stale rows are set aside, and unusable ones (no humidity, impossible values) too', () => {
  const figure = aggregate(
    [row(2, 20, 40), row(3, 22, 40), row(4, 21, 40), row(40, 5, 40), row(2, 20), row(1, -4, 40), row(1, 20, 140)],
    NOW,
  );
  assert.equal(figure.used, 3);
  assert.equal(figure.stale, 1);
  assert.equal(figure.unusable, 3);
  assert.equal(figure.pm25, epaCorrectedPm25(21, 40));
  assert.equal(figure.newestMs, NOW - 2 * 60_000);
});

test('an outlier moves nothing: the median of the rest is the figure, and its age is the newest kept row', () => {
  const figure = aggregate([row(5, 20, 40), row(6, 21, 40), row(7, 22, 40), row(1, 400, 40)], NOW);
  assert.equal(figure.outliers, 1);
  assert.equal(figure.used, 3);
  assert.equal(figure.pm25, epaCorrectedPm25(21, 40));
  assert.equal(figure.newestMs, NOW - 5 * 60_000);
  assert.equal(figure.category, 'moderate');
});

test('only stale rows: no figure, and the age of the newest one', () => {
  const figure = aggregate([row(20, 10, 40), row(50, 10, 40)], NOW);
  assert.equal(figure.used, 0);
  assert.equal(figure.aqi, undefined);
  assert.equal(figure.newestMs, NOW - 20 * 60_000);
  // Exactly the freshness limit still counts as fresh.
  assert.equal(aggregate([row(FRESH_MS / 60_000, 10, 40)], NOW).used, 1);
});

test('no rows: nothing at all', () => {
  assert.deepEqual(aggregate([], NOW), {usable: 0, used: 0, nearUsed: 0, outliers: 0, stale: 0, unusable: 0});
});

const HOME = {lat: 46.87, lon: -113.99};

/** A fresh row `km` north of home. */
function northOf(km: number, pm: number): SensorRow {
  return {
    name: 'x',
    lat: HOME.lat + km / 111.195,
    lon: HOME.lon,
    lastSeenMs: NOW - 60_000,
    pm25TenMinute: pm,
    humidity: 40,
  };
}

test('weighted median: equal weights are the median; a heavy value wins; an exact half takes the mean', () => {
  assert.equal(weightedMedian([1, 2, 3].map((value) => ({value, weight: 1}))), 2);
  assert.equal(weightedMedian([1, 2, 3, 4].map((value) => ({value, weight: 1}))), 2.5);
  assert.equal(
    weightedMedian([
      {value: 50, weight: 1},
      {value: 5, weight: 0.1},
      {value: 5, weight: 0.1},
    ]),
    50,
  );
});

test("review C4: one sensor 110 m away reading USG and two 11 km away reading Good: the near sensor's air is the answer", () => {
  const figure = aggregate([northOf(0.11, 60), northOf(11, 5), northOf(11.5, 5)], NOW, {center: HOME, nearKm: 5});
  assert.equal(figure.outliers, 0, 'outliers are judged within a band, so the far pair cannot outvote the near one');
  assert.equal(figure.nearUsed, 1);
  assert.equal(figure.used, 3);
  assert.equal(figure.category, 'unhealthyForSensitiveGroups');
  assert.equal(figure.aqi, 135);
});

test('within a band the outlier rule still holds, and the nearest sensors lead', () => {
  const spider = aggregate([northOf(1, 20), northOf(2, 21), northOf(3, 22), northOf(1.5, 400)], NOW, {
    center: HOME,
    nearKm: 5,
  });
  assert.equal(spider.outliers, 1);
  assert.equal(spider.pm25, epaCorrectedPm25(20, 40), 'the 1 km sensor weighs most among the three kept');
  // Without a centre (a sensor chosen by name), every sensor weighs the same: the plain median.
  const plain = aggregate([northOf(1, 20), northOf(2, 21), northOf(3, 22)], NOW);
  assert.equal(plain.pm25, epaCorrectedPm25(21, 40));
});

test('recheck N1: a broken near sensor reading 999 is implausible after correction, so ten agreeing far ones decide', () => {
  const far = Array.from({length: 10}, (_unused, index) => northOf(11 + index * 0.2, 5));
  const figure = aggregate([northOf(0.5, 999), ...far], NOW, {center: HOME, nearKm: 5});
  assert.equal(figure.unusable, 1);
  assert.equal(figure.category, 'good');
  assert.equal(figure.disagreement, undefined);
  assert.ok((figure.aqi ?? 0) < 50);
});

test('recheck N1: a near sensor reading 0 against Moderate far ones is not silently Good: both are said, the higher leads', () => {
  const figure = aggregate([northOf(0.5, 0), northOf(11, 30), northOf(12, 31), northOf(13, 29)], NOW, {
    center: HOME,
    nearKm: 5,
  });
  assert.equal(figure.category, 'moderate');
  assert.deepEqual(figure.disagreement, {
    highAqi: figure.aqi,
    highSensors: 3,
    lowAqi: aqiFromPm25(epaCorrectedPm25(0, 40)).aqi,
    lowSensors: 1,
  });
});

test('recheck N1: a legitimately high near reading with far sensors agreeing is simply the reading', () => {
  const figure = aggregate([northOf(0.5, 150), northOf(11, 140), northOf(12, 145)], NOW, {center: HOME, nearKm: 5});
  assert.equal(figure.disagreement, undefined);
  assert.equal(figure.category, 'unhealthy');
  assert.equal(figure.pm25, epaCorrectedPm25(150, 40), 'the nearest leads the weighted median');
});

test('recheck N1: a single near sensor next to a clean far band is flagged, not picked silently', () => {
  const figure = aggregate([northOf(0.11, 60), northOf(11, 5), northOf(11.5, 5)], NOW, {center: HOME, nearKm: 5});
  assert.equal(figure.category, 'unhealthyForSensitiveGroups');
  assert.equal(figure.disagreement?.highSensors, 1);
  assert.equal(figure.disagreement?.lowSensors, 2);
  assert.equal(figure.disagreement?.lowAqi, aqiFromPm25(epaCorrectedPm25(5, 40)).aqi);
});

test('recheck N1: low channel confidence is unusable, and two lone sensors that disagree are both said', () => {
  const unsure = {...northOf(0.5, 400), confidence: 20};
  const figure = aggregate([unsure, northOf(1, 10), northOf(2, 11), northOf(3, 12)], NOW, {center: HOME, nearKm: 5});
  assert.equal(figure.unusable, 1);
  assert.equal(figure.category, 'good');
  const pair = aggregate([northOf(1, 5), northOf(2, 120)], NOW);
  assert.equal(pair.disagreement?.highSensors, 1);
  assert.equal(pair.disagreement?.lowSensors, 1);
  assert.equal(pair.category, aqiFromPm25(epaCorrectedPm25(120, 40)).category);
});
