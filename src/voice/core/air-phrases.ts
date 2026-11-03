/** Curated sentence families, not a list of individual cities or failed requests (YA-37). */
export const AIR_LOCALES = ['en-US', 'en-GB', 'en-CA'] as const;
export type AirLocale = (typeof AIR_LOCALES)[number];
export type AirIntent = 'airQuality' | 'airQualityPlace' | 'airQualityIndoor';

const LOCATIONS: Record<AirIntent, readonly string[]> = {
  airQuality: ['here', 'at home', 'outside', 'outside my house', 'outside my home', 'around here', 'near me'],
  airQualityPlace: ['in {place}', 'near {place}', 'at {place}', 'for {place}'],
  airQualityIndoor: [
    'inside',
    'indoors',
    'inside my house',
    'inside my home',
    'in my house',
    'in my home',
    'in the house',
  ],
};

// Keep the location last: trailing words can otherwise become part of AMAZON.SearchQuery's place value.
const SENTENCES = [
  'air quality',
  "what's the air quality",
  'what is the air quality',
  'what the air quality is',
  'what the air quality is like',
  'what air quality is',
  "what's the air like",
  'what is the air like',
  'what the air is like',
  "how's the air",
  'how is the air',
  "how's the air quality",
  'how is the air quality',
  'how good is the air quality',
  'is the air okay',
  'is the air good',
  'check the air quality',
  'tell me the air quality',
  'tell me what the air quality is',
  'tell me what the air is like',
  'give me the air quality',
  'give me an air quality report',
  'can you check the air quality',
  'can you tell me what the air quality is',
  'please check the air quality',
  'current air quality',
  "what's the current air quality",
  'what the current air quality is',
  'what is the air quality right now',
  'what is the air quality today',
  'a. q. i.',
  "what's the a. q. i.",
  'what is the a. q. i.',
  'what the a. q. i. is',
  'tell me the a. q. i.',
  'check the a. q. i.',
  'current a. q. i.',
  'air quality index',
  'what is the air quality index',
  'what the air quality index is',
];

const SUBJECTS: Record<AirIntent, readonly string[]> = {
  airQuality: ['outdoor air quality', 'outside air quality', 'air quality from my outdoor sensor'],
  airQualityIndoor: ['indoor air quality', 'inside air quality', 'air quality from my indoor sensor'],
  airQualityPlace: [],
};

/** With no locale, the text client recognises the union of all three Alexa vocabularies. */
export function airQualitySamples(intent: AirIntent, locale?: AirLocale): readonly string[] {
  const locales = locale === undefined ? AIR_LOCALES : [locale];
  const locations = [...LOCATIONS[intent]];
  for (const language of locales) {
    if (intent === 'airQualityIndoor') {
      const dwelling = language === 'en-GB' ? 'flat' : 'apartment';
      locations.push(`inside my ${dwelling}`, `in my ${dwelling}`);
    } else if (intent === 'airQuality') {
      locations.push(language === 'en-US' ? 'in my neighborhood' : 'in my neighbourhood');
    } else {
      const postal = language === 'en-US' ? 'zip code' : language === 'en-GB' ? 'postcode' : 'postal code';
      locations.push(`for ${postal} {place}`);
    }
  }
  const samples = SENTENCES.flatMap((sentence) => [...new Set(locations)].map((place) => `${sentence} ${place}`));
  for (const subject of SUBJECTS[intent]) {
    for (const prefix of ['', "what's the ", 'what is the ', 'tell me the ', 'check the ', 'please check the ']) {
      samples.push(`${prefix}${subject}`);
    }
    samples.push(`what the ${subject} is`);
  }
  if (intent === 'airQualityPlace') {
    samples.push('air quality is {place}', 'air quality {place}');
    for (const prefix of [
      'air quality',
      "what's the air quality",
      'what the air quality is',
      'check the air quality',
    ]) {
      samples.push(`${prefix} from sensor {place}`, `${prefix} at sensor {place}`);
    }
  }
  return [...new Set(samples)];
}
