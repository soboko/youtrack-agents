/**
 * In-memory fakes for the air-quality service (YA-36): a PurpleAir client over a list of sensors, and a geocoder over
 * a table of places. Used by the transcript tests and the air service tests, with the real aggregation, correction,
 * AQI, cache and limits in between, so a transcript checks the arithmetic end to end.
 */
import {distanceKm, type BoundingBox, type LatLon} from './geo.ts';
import {GeocoderError, type GeocodeCandidate, type GeocodeQuery, type Geocoder} from './geocoder.ts';
import {
  MAX_AGE_SECONDS,
  PurpleAirError,
  type PurpleAirClient,
  type PurpleAirFailureKind,
  type SensorRow,
} from './purpleair.ts';

export interface SensorFixture {
  name: string;
  lat: number;
  lon: number;
  /** Minutes before the fixture's reference time that the sensor last reported. */
  ageMinutes: number;
  /** Raw 10-minute cf_atm PM2.5, µg/m³. Absent: no reading. */
  pm?: number;
  /** Percent. Absent: no humidity. */
  humidity?: number;
  /** PurpleAir's channel-agreement confidence, 0 to 100. Absent: none reported. */
  confidence?: number;
  /** Indoor (`location_type=1`) rather than the default outdoor (`location_type=0`). */
  indoor?: boolean;
}

/** One place a query matches. `score` defaults to 1, `type` to Locality, `name` to the query capitalised. */
export interface PlaceFixture {
  lat: number;
  lon: number;
  name?: string;
  type?: 'Locality' | 'PostalCode';
  score?: number;
}

export interface AirFixture {
  /** Lower-case query -> [latitude, longitude] (one Locality), a list of places, or null (nothing usable). */
  places: Record<string, [number, number] | PlaceFixture[] | null>;
  sensors: SensorFixture[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlace(value: unknown): value is PlaceFixture {
  return isRecord(value) && typeof value.lat === 'number' && typeof value.lon === 'number';
}

/** Validates parsed JSON as an air fixture. */
export function parseAirFixture(json: unknown): AirFixture {
  if (!isRecord(json) || !isRecord(json.places) || !Array.isArray(json.sensors)) {
    throw new Error('Air fixture: expected {"places": {...}, "sensors": [...]}');
  }
  const places: AirFixture['places'] = {};
  for (const [name, value] of Object.entries(json.places)) {
    if (value === null) {
      places[name] = null;
    } else if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'number')) {
      places[name] = [value[0] as number, value[1] as number];
    } else if (Array.isArray(value) && value.every(isPlace)) {
      places[name] = value;
    } else {
      throw new Error(`Air fixture: place "${name}" must be [lat, lon], a list of places, or null`);
    }
  }
  const sensors = json.sensors.map((raw: unknown, index): SensorFixture => {
    if (!isRecord(raw) || typeof raw.name !== 'string' || typeof raw.lat !== 'number' || typeof raw.lon !== 'number') {
      throw new Error(`Air fixture: sensors[${index}] needs name, lat and lon`);
    }
    if (typeof raw.ageMinutes !== 'number') throw new Error(`Air fixture: sensors[${index}] needs ageMinutes`);
    const sensor: SensorFixture = {name: raw.name, lat: raw.lat, lon: raw.lon, ageMinutes: raw.ageMinutes};
    if (typeof raw.pm === 'number') sensor.pm = raw.pm;
    if (typeof raw.humidity === 'number') sensor.humidity = raw.humidity;
    if (typeof raw.confidence === 'number') sensor.confidence = raw.confidence;
    return sensor;
  });
  return {places, sensors};
}

function inBox(point: LatLon, box: BoundingBox): boolean {
  return point.lat <= box.nwLat && point.lat >= box.seLat && point.lon >= box.nwLon && point.lon <= box.seLon;
}

export interface FakePurpleAirCall {
  box?: BoundingBox;
  fields?: readonly string[];
  indexes?: readonly number[];
  /** Rows returned. */
  rows: number;
}

/**
 * A PurpleAir client over fixture sensors: the box, `show_only` and `max_age` filter as the API does, and a name-only
 * fetch returns names and indexes only. A sensor's index is its position in the fixture, from 1. Records every call.
 */
export class FakePurpleAir implements PurpleAirClient {
  readonly calls: FakePurpleAirCall[] = [];
  private failures: PurpleAirFailureKind[] = [];
  private readonly sensors: readonly SensorFixture[];
  private readonly referenceMs: number;
  private readonly now: () => number;

  /** `referenceMs` is the time each sensor's `ageMinutes` counts back from. */
  constructor(sensors: readonly SensorFixture[], referenceMs: number, now: () => number) {
    this.sensors = sensors;
    this.referenceMs = referenceMs;
    this.now = now;
  }

  failNext(kind: PurpleAirFailureKind, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push(kind);
  }

  private rows(include: (sensor: SensorFixture, index: number) => boolean, namesOnly: boolean): SensorRow[] {
    const rows: SensorRow[] = [];
    this.sensors.forEach((sensor, position) => {
      const index = position + 1;
      const lastSeenMs = this.referenceMs - sensor.ageMinutes * 60_000;
      if (this.now() - lastSeenMs > MAX_AGE_SECONDS * 1000 || !include(sensor, index)) return;
      if (namesOnly) {
        rows.push({index, name: sensor.name, lat: 0, lon: 0, lastSeenMs: 0});
        return;
      }
      const row: SensorRow = {index, name: '', lat: sensor.lat, lon: sensor.lon, lastSeenMs};
      if (sensor.pm !== undefined) row.pm25TenMinute = sensor.pm;
      if (sensor.humidity !== undefined) row.humidity = sensor.humidity;
      if (sensor.confidence !== undefined) row.confidence = sensor.confidence;
      rows.push(row);
    });
    return rows;
  }

  private failure(): void {
    const failure = this.failures.shift();
    if (failure !== undefined) throw new PurpleAirError(failure);
  }

  async sensorsInBox(
    box: BoundingBox,
    fields: readonly string[],
    _signal?: AbortSignal,
    locationType = 0,
  ): Promise<SensorRow[]> {
    const call: FakePurpleAirCall = {box, fields, rows: 0};
    this.calls.push(call);
    this.failure();
    const rows = this.rows(
      (sensor) => inBox(sensor, box) && Number(sensor.indoor === true) === locationType,
      !fields.includes('latitude'),
    );
    call.rows = rows.length;
    return rows;
  }

  async sensorsByIndex(indexes: readonly number[], _signal?: AbortSignal, locationType = 0): Promise<SensorRow[]> {
    const call: FakePurpleAirCall = {indexes, rows: 0};
    this.calls.push(call);
    this.failure();
    const rows = this.rows(
      (sensor, index) => indexes.includes(index) && Number(sensor.indoor === true) === locationType,
      false,
    );
    call.rows = rows.length;
    return rows;
  }
}

function capitalised(text: string): string {
  return text.replace(/(^|\s)(\p{L})/gu, (_whole, space: string, letter: string) => `${space}${letter.toUpperCase()}`);
}

/**
 * A geocoder over a table of places, matched on the lower-cased, trimmed text. With a bias, equally scored places are
 * ranked nearest first, as the provider ranks them. Records every query.
 */
export class FakeGeocoder implements Geocoder {
  readonly calls: GeocodeQuery[] = [];
  private failures = 0;
  private readonly places: AirFixture['places'];

  constructor(places: AirFixture['places']) {
    this.places = places;
  }

  failNext(times = 1): void {
    this.failures += times;
  }

  async search(query: GeocodeQuery): Promise<GeocodeCandidate[]> {
    this.calls.push(query);
    if (this.failures > 0) {
      this.failures--;
      throw new GeocoderError('fake failure');
    }
    const text = query.text.trim().toLowerCase();
    const found = this.places[text];
    if (found === undefined || found === null) return [];
    const places: PlaceFixture[] =
      Array.isArray(found) && typeof found[0] === 'number'
        ? [{lat: found[0] as number, lon: found[1] as number}]
        : (found as PlaceFixture[]);
    const candidates = places.map((place): GeocodeCandidate => {
      const type = place.type ?? (/^[\d\s-]+$/.test(text) ? 'PostalCode' : 'Locality');
      const name = place.name ?? capitalised(text);
      const [own, ...rest] = name.split(',').map((part) => part.trim());
      const candidate: GeocodeCandidate = {
        point: {lat: place.lat, lon: place.lon},
        placeType: type,
        score: place.score ?? 1,
        name,
        key: own.toLowerCase(),
        own,
      };
      if (rest.length > 0) candidate.region = rest.join(', ');
      return candidate;
    });
    const bias = query.bias;
    if (bias === undefined) return candidates;
    return candidates
      .map((candidate, order) => ({candidate, order, km: distanceKm(bias, candidate.point)}))
      .sort((a, b) => Math.round((b.candidate.score - a.candidate.score) * 10) || a.km - b.km || a.order - b.order)
      .map((entry) => entry.candidate);
  }
}
