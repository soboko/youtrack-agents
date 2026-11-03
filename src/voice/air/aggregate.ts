/**
 * From sensor rows to one figure (YA-36): keep fresh rows with a reading and a humidity, correct each with the EPA
 * formula, set aside outliers within distance bands, and take the distance-weighted median. Pure: the time is passed in.
 *
 * Bands (review C4). Rows within the first radius are the near band, rows beyond it (after a widening) the far band.
 * Outliers are judged within a band only, so two sensors 11 km away can never outvote the one sensor 110 m away: in a
 * smoke plume or a valley that one is the truth. Within a band, with three or more sensors, a corrected value further
 * from the band's median than both 5 µg/m³ and three scaled median absolute deviations is set aside (a sensor with a
 * spider in it, or one sitting over a barbecue).
 *
 * Weights. With a centre, each kept sensor weighs 1 / max(distance, 1 km), and the figure is the weighted median: the
 * nearest sensors lead, but one sensor alone among several near ones cannot move it far. Without a centre (a sensor
 * chosen by name) every sensor weighs the same.
 *
 * Plausibility (correctness recheck N1). A row is unusable when PurpleAir's `confidence` (channel A and B agreement,
 * 0 to 100) is below `MIN_CONFIDENCE`, or when its corrected PM2.5 is outside 0 to `MAX_CORRECTED_PM25` µg/m³.
 *
 * Disagreement (N1). Weighting must never let one or two sensors decide silently. When the near band has fewer than
 * `MIN_SENSORS` and there are sensors further out, or when only two sensors are kept at all, the two groups are
 * compared; if they disagree wildly (two or more AQI categories apart, or three times apart and 10 µg/m³ or more), the
 * figure is the higher group's, and the aggregate says both, so the listener hears that readings disagree.
 */
import type {AqiCategory} from '../core/types.ts';
import {aqiFromPm25, epaCorrectedPm25} from './aqi.ts';
import {distanceKm, type LatLon} from './geo.ts';
import type {SensorRow} from './purpleair.ts';

/** A row is fresh when it reported within this long. PurpleAir sensors report about every two minutes. */
export const FRESH_MS = 15 * 60 * 1000;
/** Fewer near sensors than this, and the radius is widened, and the figure is called rough. */
export const MIN_SENSORS = 3;
/** Plausible raw PurpleAir values; outside them a row is a fault, not air. */
const MAX_RAW_PM25 = 1000;
/** Plausible corrected PM2.5, µg/m³ (N1): a raw 999 corrects to about 1574, which no sensor nearby is breathing. */
export const MAX_CORRECTED_PM25 = 1000;
/** Rows whose channels agree less than this (PurpleAir's `confidence`, percent) are set aside. */
export const MIN_CONFIDENCE = 50;
/** Groups this many AQI categories apart disagree wildly. */
const WILD_CATEGORY_STEPS = 2;
const WILD_RATIO = 3;
const WILD_DIFFERENCE_UGM3 = 10;
const CATEGORY_ORDER: readonly AqiCategory[] = [
  'good',
  'moderate',
  'unhealthyForSensitiveGroups',
  'unhealthy',
  'veryUnhealthy',
  'hazardous',
];

const OUTLIER_FLOOR_UGM3 = 5;
const OUTLIER_MADS = 3;
/** Scales a median absolute deviation to a standard deviation for normally distributed values. */
const MAD_SCALE = 1.4826;
/** Distances under this weigh as this: a sensor on the doorstep is not infinitely more right than one down the road. */
const WEIGHT_FLOOR_KM = 1;

export interface AggregateOptions {
  /** The point the figure is for. Without it, no bands and equal weights. */
  center?: LatLon;
  /** The near band's radius. Rows beyond it are the far band. */
  nearKm?: number;
  /** EPA's outdoor correction is not used for indoor measurements. */
  correction?: 'epa' | 'raw';
  /** Explicitly selected sensors may be read with a spoken confidence caveat. */
  allowLowConfidence?: boolean;
}

export interface Aggregate {
  lowConfidence?: boolean;
  /** Fresh sensors with a usable reading, before outliers were set aside. */
  usable: number;
  /** Sensors in the figure. */
  used: number;
  /** Sensors in the figure from the near band. */
  nearUsed: number;
  outliers: number;
  /** Rows set aside as stale. */
  stale: number;
  /** Rows set aside for a missing or implausible reading or humidity. */
  unusable: number;
  /** Weighted median corrected PM2.5, µg/m³; undefined when nothing was used. */
  pm25?: number;
  aqi?: number;
  category?: AqiCategory;
  /** Epoch ms of the newest row used, or, with none used, of the newest stale row. */
  newestMs?: number;
  /** Two groups of sensors disagreed wildly: the figure above is the higher group's. */
  disagreement?: {highAqi: number; highSensors: number; lowAqi: number; lowSensors: number};
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The weighted median: the value at which half the total weight lies on each side. Equal weights give the ordinary
 * median; where the halfway point falls exactly between two values, their mean.
 */
export function weightedMedian(entries: ReadonlyArray<{value: number; weight: number}>): number {
  const sorted = [...entries].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, entry) => sum + entry.weight, 0);
  let cumulative = 0;
  for (let index = 0; index < sorted.length; index++) {
    cumulative += sorted[index].weight;
    const half = total / 2;
    if (Math.abs(cumulative - half) < 1e-9 * total && index + 1 < sorted.length) {
      return (sorted[index].value + sorted[index + 1].value) / 2;
    }
    if (cumulative > half) return sorted[index].value;
  }
  return sorted[sorted.length - 1].value;
}

/** The values that are not outliers, by the rule in the header. Fewer than three values are all kept. */
export function withoutOutliers(values: readonly number[]): number[] {
  if (values.length < MIN_SENSORS) return [...values];
  const centre = median(values);
  const mad = median(values.map((value) => Math.abs(value - centre)));
  const limit = Math.max(OUTLIER_FLOOR_UGM3, OUTLIER_MADS * MAD_SCALE * mad);
  return values.filter((value) => Math.abs(value - centre) <= limit);
}

interface Usable {
  lowConfidence: boolean;
  value: number;
  lastSeenMs: number;
  km: number;
  near: boolean;
}

/** The entries of one band that are not outliers, judged within the band. */
function keptInBand(band: readonly Usable[]): Usable[] {
  const kept = withoutOutliers(band.map((entry) => entry.value));
  const remaining = new Map<number, number>();
  for (const value of kept) remaining.set(value, (remaining.get(value) ?? 0) + 1);
  return band.filter((entry) => {
    const count = remaining.get(entry.value) ?? 0;
    if (count === 0) return false;
    remaining.set(entry.value, count - 1);
    return true;
  });
}

export function aggregate(rows: readonly SensorRow[], nowMs: number, options: AggregateOptions = {}): Aggregate {
  let stale = 0;
  let unusable = 0;
  let newestStale: number | undefined;
  const usable: Usable[] = [];
  for (const row of rows) {
    if (nowMs - row.lastSeenMs > FRESH_MS) {
      stale++;
      newestStale = Math.max(newestStale ?? row.lastSeenMs, row.lastSeenMs);
      continue;
    }
    const pa = row.pm25TenMinute;
    const rh = row.humidity;
    const lowConfidence = row.confidence !== undefined && row.confidence < MIN_CONFIDENCE;
    if (
      pa === undefined ||
      rh === undefined ||
      pa < 0 ||
      pa > MAX_RAW_PM25 ||
      rh < 0 ||
      rh > 100 ||
      (lowConfidence && !options.allowLowConfidence)
    ) {
      unusable++;
      continue;
    }
    const value = options.correction === 'raw' ? pa : epaCorrectedPm25(pa, rh);
    if (!(value >= 0 && value <= MAX_CORRECTED_PM25)) {
      unusable++;
      continue;
    }
    const km = options.center === undefined ? 0 : distanceKm(options.center, row);
    const near = options.nearKm === undefined || km <= options.nearKm;
    usable.push({value, lastSeenMs: row.lastSeenMs, km, near, lowConfidence});
  }
  const kept = [
    ...keptInBand(usable.filter((entry) => entry.near)),
    ...keptInBand(usable.filter((entry) => !entry.near)),
  ];
  const nearUsed = kept.filter((entry) => entry.near).length;
  const result: Aggregate = {
    ...(kept.some((entry) => entry.lowConfidence) ? {lowConfidence: true} : {}),
    usable: usable.length,
    used: kept.length,
    nearUsed,
    outliers: usable.length - kept.length,
    stale,
    unusable,
  };
  if (kept.length === 0) {
    if (newestStale !== undefined) result.newestMs = newestStale;
    return result;
  }
  const newestMs = Math.max(...kept.map((entry) => entry.lastSeenMs));
  const split = disagreeingGroups(kept);
  if (split !== null) {
    const [high, low] = split;
    const {aqi, category} = aqiFromPm25(high.pm25);
    return {
      ...result,
      pm25: high.pm25,
      aqi,
      category,
      newestMs,
      disagreement: {
        highAqi: aqi,
        highSensors: high.sensors,
        lowAqi: aqiFromPm25(low.pm25).aqi,
        lowSensors: low.sensors,
      },
    };
  }
  const weighted = kept.map((entry) => ({
    value: entry.value,
    weight: options.center === undefined ? 1 : 1 / Math.max(entry.km, WEIGHT_FLOOR_KM),
  }));
  const pm25 = weightedMedian(weighted);
  const {aqi, category} = aqiFromPm25(pm25);
  return {...result, pm25, aqi, category, newestMs};
}

interface Group {
  pm25: number;
  sensors: number;
}

/** Whether two concentrations are far enough apart that neither can stand for both. */
export function disagreeWildly(a: number, b: number): boolean {
  const steps = Math.abs(
    CATEGORY_ORDER.indexOf(aqiFromPm25(a).category) - CATEGORY_ORDER.indexOf(aqiFromPm25(b).category),
  );
  const ratio = Math.max(a, b) / Math.max(Math.min(a, b), 1);
  return steps >= WILD_CATEGORY_STEPS || (ratio >= WILD_RATIO && Math.abs(a - b) >= WILD_DIFFERENCE_UGM3);
}

/**
 * The two groups to compare when one or two sensors could otherwise decide (see the header), higher first, or null
 * when there is nothing to compare or they agree well enough.
 */
function disagreeingGroups(kept: readonly Usable[]): [Group, Group] | null {
  const near = kept.filter((entry) => entry.near);
  const far = kept.filter((entry) => !entry.near);
  let groups: [Usable[], Usable[]] | null = null;
  if (near.length > 0 && near.length < MIN_SENSORS && far.length > 0) {
    groups = [near, far];
  } else if (kept.length === 2) {
    groups = [[kept[0]], [kept[1]]];
  }
  if (groups === null) return null;
  const [first, second] = groups.map((group) => ({
    pm25: median(group.map((entry) => entry.value)),
    sensors: group.length,
  }));
  if (!disagreeWildly(first.pm25, second.pm25)) return null;
  return first.pm25 >= second.pm25 ? [first, second] : [second, first];
}

/** Whole minutes from `thenMs` to `nowMs`, never negative. */
export function minutesSince(nowMs: number, thenMs: number): number {
  return Math.max(0, Math.floor((nowMs - thenMs) / 60_000));
}
