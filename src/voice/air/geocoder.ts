/**
 * Place names and postal codes to coordinates (YA-36), behind an interface, with Amazon Location Service's Places API
 * (v2) `Geocode` as the implementation.
 *
 * Why Amazon Location and not OpenStreetMap Nominatim (both checked 2026-09-14):
 * - Nominatim's public service allows "an absolute maximum of 1 request per second", needs an identifying User-Agent,
 *   requires results to be cached, and says services built around geocoding must run their own server; its data also
 *   needs ODbL attribution, which a voice answer cannot show (https://operations.osmfoundation.org/policies/nominatim/).
 *   A Lambda's shared outbound addresses would share that budget with strangers.
 * - Places v2 runs in the stack's own account and region, is authorised by IAM (`geo-places:Geocode` on the
 *   `provider/default` resource, no key and no resource to create), and costs $0.50 per 1,000 Core requests after a
 *   free trial of 20,000 a month for three months (https://aws.amazon.com/location/pricing/). The legacy place-index
 *   call, SearchPlaceIndexForText, "is no longer current and may be deprecated", and AWS points to Geocode
 *   (https://docs.aws.amazon.com/location/previous/APIReference/API_SearchPlaceIndexForText.html).
 *
 * Request (https://docs.aws.amazon.com/location/latest/APIReference/API_geoplaces_Geocode.html and
 * .../API_geoplaces_GeocodeFilter.html, checked 2026-09-14):
 * - `QueryText` (1 to 200 characters) and `MaxResults` (1 to 100; five here, to see rival places of the same name);
 * - `BiasPosition`, "[lng, lat]": "place results returned are ranked higher the closer they are to this position"
 *   (review C3), set to the device's or the home point;
 * - `Filter.IncludePlaceTypes`, whose valid values are `Locality | PostalCode | Intersection | Street | PointAddress |
 *   InterpolatedAddress | SecondaryAddress | PointOfInterest | Country | Region`: only `Locality` and `PostalCode`
 *   here, so a street, a building or a point of interest that happens to share a sensor's name is never "the place";
 * - `Filter.IncludeCountries`, "alpha-2 or alpha-3": the device's own alpha-2 code, for its postal code only;
 * - `IntendedUse` `Storage`: results are kept in memory for up to a day (the geocode cache), and the reference says
 *   "When storing Geocode responses, you must set this field to Storage". It is billed at the Stored rate.
 * Response: `ResultItems[]` with `Position` [lng, lat], `PlaceType`, `Address.Locality`, `Address.Region.Name`,
 * `Address.Country.Name` and `MatchScores.Overall` (0 to 1).
 */

import type {VoiceLogger} from '../core/types.ts';
import {isValidLatLon, type LatLon} from './geo.ts';
import {raceSignal} from './purpleair.ts';

export interface GeocodeQuery {
  text: string;
  /** ISO 3166-1 alpha-2, to keep a postal code in its own country. */
  countryCode?: string;
  /** Rank places near this point first. */
  bias?: LatLon;
}

/** One place the geocoder offered. `name` is a place name ("Springfield, Illinois"), never an address. */
export interface GeocodeCandidate {
  point: LatLon;
  placeType: 'Locality' | 'PostalCode';
  /** `MatchScores.Overall`, 0 to 1; 0 when the provider gave none. */
  score: number;
  /** The locality (or postal code) and its region or country, for speech. Letters, spaces and ,.'- only. */
  name: string;
  /** The locality or postal code alone, lower case, to tell rival places of one name apart. */
  key: string;
  /** The locality or postal code alone, as named, for speech when the region goes without saying. */
  own: string;
  /** The region (a state or province) or, failing that, the country, as named; undefined when the provider gave none. */
  region?: string;
}

export class GeocoderError extends Error {
  constructor(problem: string) {
    super(`geocoder: ${problem}`);
    this.name = 'GeocoderError';
  }
}

export interface Geocoder {
  /** Places that match, best first (at most five). Throws `GeocoderError` on failure. */
  search(query: GeocodeQuery, signal?: AbortSignal): Promise<GeocodeCandidate[]>;
}

/** The input of Places v2 `Geocode` this module sends. */
export interface GeoPlacesGeocodeInput {
  QueryText: string;
  MaxResults: number;
  IntendedUse: 'Storage';
  Language: string;
  BiasPosition?: [number, number];
  Filter: {IncludePlaceTypes: Array<'Locality' | 'PostalCode'>; IncludeCountries?: string[]};
}

export interface GeoPlacesResultItem {
  Position?: unknown;
  PlaceType?: unknown;
  Address?: {Locality?: unknown; PostalCode?: unknown; Region?: {Name?: unknown}; Country?: {Name?: unknown}};
  MatchScores?: {Overall?: unknown};
}

/** The part of the aggregated `GeoPlaces` client (`@aws-sdk/client-geo-places`, in the Lambda runtime) used here. */
export interface GeoPlacesClient {
  geocode(
    input: GeoPlacesGeocodeInput,
    options?: {abortSignal?: AbortSignal},
  ): Promise<{ResultItems?: GeoPlacesResultItem[]}>;
}

export const GEOCODER_TIMEOUT_MS = 1500;
export const GEOCODE_MAX_RESULTS = 5;
const MAX_QUERY_CHARS = 200;
const MAX_NAME_CHARS = 60;

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[^\p{L}\p{N} .,'-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned === '' ? undefined : cleaned.slice(0, MAX_NAME_CHARS);
}

/** A result item as a candidate, or undefined when it is not a usable locality or postal code. */
export function candidateOf(item: GeoPlacesResultItem): GeocodeCandidate | undefined {
  const placeType = item.PlaceType === 'Locality' || item.PlaceType === 'PostalCode' ? item.PlaceType : undefined;
  const position = Array.isArray(item.Position) ? item.Position : [];
  const point = {lat: Number(position[1]), lon: Number(position[0])};
  if (placeType === undefined || !isValidLatLon(point)) return undefined;
  const own = placeType === 'PostalCode' ? text(item.Address?.PostalCode) : text(item.Address?.Locality);
  if (own === undefined) return undefined;
  const region = text(item.Address?.Region?.Name) ?? text(item.Address?.Country?.Name);
  const score = typeof item.MatchScores?.Overall === 'number' ? Math.max(0, Math.min(1, item.MatchScores.Overall)) : 0;
  const candidate: GeocodeCandidate = {
    point,
    placeType,
    score,
    name: region === undefined ? own : `${own}, ${region}`,
    key: own.toLowerCase(),
    own,
  };
  if (region !== undefined) candidate.region = region;
  return candidate;
}

export interface AwsGeocoderOptions {
  client: (signal?: AbortSignal) => Promise<GeoPlacesClient>;
  log: VoiceLogger;
  now: () => number;
  timeoutMs?: number;
}

export function createAwsGeocoder(options: AwsGeocoderOptions): Geocoder {
  const timeoutMs = options.timeoutMs ?? GEOCODER_TIMEOUT_MS;
  return {
    async search(query, signal) {
      const queryText = query.text.trim().slice(0, MAX_QUERY_CHARS);
      if (queryText === '') return [];
      const started = options.now();
      const deadline = AbortSignal.timeout(timeoutMs);
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
      const country = query.countryCode?.trim().toUpperCase();
      const input: GeoPlacesGeocodeInput = {
        QueryText: queryText,
        MaxResults: GEOCODE_MAX_RESULTS,
        IntendedUse: 'Storage',
        Language: 'en',
        Filter: {IncludePlaceTypes: ['Locality', 'PostalCode']},
      };
      if (country !== undefined && /^[A-Z]{2}$/.test(country)) input.Filter.IncludeCountries = [country];
      if (query.bias !== undefined) input.BiasPosition = [query.bias.lon, query.bias.lat];
      let items: GeoPlacesResultItem[];
      try {
        const client = await raceSignal(options.client(combined), combined);
        const response = await raceSignal(client.geocode(input, {abortSignal: combined}), combined);
        items = Array.isArray(response.ResultItems) ? response.ResultItems : [];
      } catch (error) {
        options.log('warn', 'air.geocoder.failed', {
          ms: options.now() - started,
          errorName: error instanceof Error ? error.name : 'unknown',
          timedOut: deadline.aborted,
        });
        throw new GeocoderError(error instanceof Error ? error.name : 'unknown');
      }
      const candidates = items.flatMap((item) => candidateOf(item) ?? []);
      options.log('info', 'air.geocoder.call', {
        ms: options.now() - started,
        results: items.length,
        usable: candidates.length,
        placeTypes: candidates.map((candidate) => candidate.placeType),
        scores: candidates.map((candidate) => Math.round(candidate.score * 100) / 100),
        biased: query.bias !== undefined,
        countryFilter: input.Filter.IncludeCountries !== undefined,
      });
      return candidates;
    },
  };
}
