/**
 * YA-36: the Places v2 geocoder sends a biased, type-filtered query and reads localities and postal codes only, with
 * their place names and scores.
 */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  candidateOf,
  createAwsGeocoder,
  GEOCODE_MAX_RESULTS,
  GeocoderError,
  type GeoPlacesClient,
  type GeoPlacesGeocodeInput,
  type GeoPlacesResultItem,
} from '../../../src/voice/air/geocoder.ts';
import {recordingLog} from './helpers.ts';

function geocoder(
  respond: (input: GeoPlacesGeocodeInput) => Promise<{ResultItems?: GeoPlacesResultItem[]}>,
  timeoutMs?: number,
) {
  const inputs: GeoPlacesGeocodeInput[] = [];
  const log = recordingLog();
  const client: GeoPlacesClient = {
    geocode: async (input) => {
      inputs.push(input);
      return respond(input);
    },
  };
  return {
    geocoder: createAwsGeocoder({
      client: async () => client,
      log: log.log,
      now: () => 0,
      ...(timeoutMs === undefined ? {} : {timeoutMs}),
    }),
    inputs,
    log,
  };
}

const SPRINGFIELD_IL: GeoPlacesResultItem = {
  PlaceType: 'Locality',
  Position: [-89.65, 39.8],
  Address: {Locality: 'Springfield', Region: {Name: 'Illinois'}, Country: {Name: 'United States'}},
  MatchScores: {Overall: 1},
};

test('the request: bias as [lng, lat], localities and postal codes only, the country only when given, Storage use', async () => {
  const g = geocoder(async () => ({ResultItems: [SPRINGFIELD_IL]}));
  const found = await g.geocoder.search({text: 'springfield', bias: {lat: 46.87, lon: -113.99}});
  assert.deepEqual(g.inputs[0], {
    QueryText: 'springfield',
    MaxResults: GEOCODE_MAX_RESULTS,
    IntendedUse: 'Storage',
    Language: 'en',
    Filter: {IncludePlaceTypes: ['Locality', 'PostalCode']},
    BiasPosition: [-113.99, 46.87],
  });
  assert.deepEqual(found, [
    {
      point: {lat: 39.8, lon: -89.65},
      placeType: 'Locality',
      score: 1,
      name: 'Springfield, Illinois',
      key: 'springfield',
      own: 'Springfield',
      region: 'Illinois',
    },
  ]);
  await g.geocoder.search({text: '59802', countryCode: 'us'});
  assert.deepEqual(g.inputs[1].Filter, {IncludePlaceTypes: ['Locality', 'PostalCode'], IncludeCountries: ['US']});
  assert.equal(g.inputs[1].BiasPosition, undefined);
});

test('streets, addresses and points of interest never become places; a bad position or name is dropped', () => {
  assert.equal(candidateOf({...SPRINGFIELD_IL, PlaceType: 'Street'}), undefined);
  assert.equal(candidateOf({...SPRINGFIELD_IL, PlaceType: 'PointOfInterest'}), undefined);
  assert.equal(candidateOf({...SPRINGFIELD_IL, Position: ['x', 'y']}), undefined);
  assert.equal(candidateOf({...SPRINGFIELD_IL, Address: {Region: {Name: 'Illinois'}}}), undefined);
  assert.deepEqual(
    candidateOf({
      PlaceType: 'PostalCode',
      Position: [-113.97, 46.905],
      Address: {PostalCode: '59802', Region: {Name: 'Montana'}},
    }),
    {
      point: {lat: 46.905, lon: -113.97},
      placeType: 'PostalCode',
      score: 0,
      name: '59802, Montana',
      key: '59802',
      own: '59802',
      region: 'Montana',
    },
  );
  assert.equal(
    candidateOf({...SPRINGFIELD_IL, Address: {Locality: 'Spring<b>field</b>', Region: {Name: 'Illinois'}}})?.name,
    'Spring b field b, Illinois',
  );
});

test('an SDK error or a timeout is a GeocoderError, logged by name only; words and names are never logged', async () => {
  const failing = geocoder(async () => {
    throw Object.assign(new Error('User is not authorized for 46.87,-113.99'), {name: 'AccessDeniedException'});
  });
  await assert.rejects(failing.geocoder.search({text: 'missoula'}), GeocoderError);
  assert.equal(failing.log.text().includes('46.87'), false);
  const slow = geocoder(() => new Promise(() => {}), 5);
  await assert.rejects(slow.geocoder.search({text: 'missoula'}), GeocoderError);
  const ok = geocoder(async () => ({ResultItems: [SPRINGFIELD_IL]}));
  await ok.geocoder.search({text: 'springfield'});
  assert.equal(/springfield|illinois/i.test(ok.log.text()), false);
});
