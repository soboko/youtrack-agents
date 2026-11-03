/**
 * Small geometry for the air-quality service (YA-36): a bounding box around a point, great-circle distance, and the
 * rounding that keys the cache. Pure functions, no I/O.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/** A PurpleAir-shaped box: north-west and south-east corners. */
export interface BoundingBox {
  nwLat: number;
  nwLon: number;
  seLat: number;
  seLon: number;
}

const EARTH_RADIUS_KM = 6371.0088;
/** On the same sphere as `distanceKm`, so a box always holds its circle (review P3-14: 111.32 cut 15 km to 14.98). */
const KM_PER_DEGREE = (Math.PI * EARTH_RADIUS_KM) / 180;
/** A box is padded by this fraction, so a sensor exactly on the circle is inside it. */
const BOX_PADDING = 1.01;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Whether a latitude and longitude are finite and in range. */
export function isValidLatLon(point: LatLon): boolean {
  return (
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lon) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lon >= -180 &&
    point.lon <= 180
  );
}

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(a: LatLon, b: LatLon): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The box that holds a circle of `radiusKm` around `center`, clamped to valid coordinates. Near the poles the
 * longitude span is capped at the whole circle. A box crossing the antimeridian is clamped at it rather than wrapped:
 * nobody in this household lives there, and a clamped box only finds fewer sensors, never wrong ones.
 */
export function boxAround(center: LatLon, radiusKm: number): BoundingBox {
  const padded = radiusKm * BOX_PADDING;
  const dLat = padded / KM_PER_DEGREE;
  const cosLat = Math.cos(toRadians(center.lat));
  const dLon = cosLat < 1e-6 ? 180 : Math.min(180, padded / (KM_PER_DEGREE * cosLat));
  const clampLat = (value: number) => Math.max(-90, Math.min(90, value));
  const clampLon = (value: number) => Math.max(-180, Math.min(180, value));
  return {
    nwLat: clampLat(center.lat + dLat),
    nwLon: clampLon(center.lon - dLon),
    seLat: clampLat(center.lat - dLat),
    seLon: clampLon(center.lon + dLon),
  };
}

/**
 * A point rounded to two decimal places (about 1.1 km of latitude), as a cache key. Two requests a few hundred metres
 * apart share a reading, which is well inside what a 5 km average can tell apart.
 */
export function roundedKey(point: LatLon): string {
  const round = (value: number) => (Math.round(value * 100) / 100).toFixed(2);
  return `${round(point.lat)},${round(point.lon)}`;
}
