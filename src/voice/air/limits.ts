/**
 * Spending limits for air quality (YA-36 review S-P2), in memory, per Lambda execution environment.
 *
 * - Lookups: at most `lookupsPerSpeaker` per speaker and `lookupsPerContainer` in all, per `LOOKUP_WINDOW_MS`. Past
 *   either, the answer is "busy" ("Try again in a few minutes") and nothing is called.
 * - Calls that cost money: at most `purpleAirPerHour` and `purpleAirPerDay` PurpleAir calls, and `geocodesPerDay`
 *   geocodes. Past a budget, the lookup is "busy" too, and `air.budget.exhausted` is logged at warn once per window.
 *
 * Windows slide: a call counts until its own window has passed since it was made. The counters are per execution
 * environment, so N concurrent environments allow N times these; a household skill runs in one or two.
 */

export const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Speakers remembered at once; the oldest are forgotten first. */
const MAX_SPEAKERS = 500;

export interface AirLimitSettings {
  lookupsPerSpeaker: number;
  lookupsPerContainer: number;
  purpleAirPerHour: number;
  purpleAirPerDay: number;
  geocodesPerDay: number;
}

export const DEFAULT_AIR_LIMITS: AirLimitSettings = {
  lookupsPerSpeaker: 20,
  lookupsPerContainer: 40,
  purpleAirPerHour: 30,
  purpleAirPerDay: 150,
  geocodesPerDay: 150,
};

/** A sliding-window counter over the times of recent takes. */
export class WindowCounter {
  private readonly times: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    while (this.times.length > 0 && (this.times[0] <= cutoff || this.times[0] > this.now())) this.times.shift();
  }

  /** Counts one if under the limit, and says whether it did. */
  tryTake(): boolean {
    this.prune();
    if (this.times.length >= this.limit) return false;
    this.times.push(this.now());
    return true;
  }

  get count(): number {
    this.prune();
    return this.times.length;
  }

  get empty(): boolean {
    return this.count === 0;
  }
}

export type LookupRefusal = 'speaker' | 'container';
export type SpendKind = 'purpleair-hour' | 'purpleair-day' | 'geocode-day';

export class AirLimits {
  readonly settings: AirLimitSettings;
  private readonly now: () => number;
  private readonly speakers = new Map<string, WindowCounter>();
  private readonly container: WindowCounter;
  private readonly purpleAirHour: WindowCounter;
  private readonly purpleAirDay: WindowCounter;
  private readonly geocodeDay: WindowCounter;

  constructor(now: () => number, settings: AirLimitSettings = DEFAULT_AIR_LIMITS) {
    this.now = now;
    this.settings = settings;
    this.container = new WindowCounter(settings.lookupsPerContainer, LOOKUP_WINDOW_MS, now);
    this.purpleAirHour = new WindowCounter(settings.purpleAirPerHour, HOUR_MS, now);
    this.purpleAirDay = new WindowCounter(settings.purpleAirPerDay, DAY_MS, now);
    this.geocodeDay = new WindowCounter(settings.geocodesPerDay, DAY_MS, now);
  }

  /** Takes one lookup for `speaker` (when known) and for the container, or says which limit refused it. */
  takeLookup(speaker: string | undefined): LookupRefusal | null {
    let counter: WindowCounter | undefined;
    if (speaker !== undefined) {
      counter = this.speakers.get(speaker);
      if (counter === undefined) {
        for (const [key, existing] of this.speakers) {
          if (this.speakers.size < MAX_SPEAKERS) break;
          if (existing.empty || this.speakers.size >= MAX_SPEAKERS) this.speakers.delete(key);
        }
        counter = new WindowCounter(this.settings.lookupsPerSpeaker, LOOKUP_WINDOW_MS, this.now);
        this.speakers.set(speaker, counter);
      }
      if (counter.count >= this.settings.lookupsPerSpeaker) return 'speaker';
    }
    if (!this.container.tryTake()) return 'container';
    counter?.tryTake();
    return null;
  }

  /** Takes one PurpleAir call from both budgets, or says which is used up. */
  takePurpleAir(): SpendKind | null {
    if (this.purpleAirHour.count >= this.settings.purpleAirPerHour) return 'purpleair-hour';
    if (!this.purpleAirDay.tryTake()) return 'purpleair-day';
    this.purpleAirHour.tryTake();
    return null;
  }

  takeGeocode(): SpendKind | null {
    return this.geocodeDay.tryTake() ? null : 'geocode-day';
  }

  /** Counts for the usage log line: calls in the last hour and day. */
  usage(): {purpleAirLastHour: number; purpleAirLastDay: number; geocodesLastDay: number; lookupsLast10Min: number} {
    return {
      purpleAirLastHour: this.purpleAirHour.count,
      purpleAirLastDay: this.purpleAirDay.count,
      geocodesLastDay: this.geocodeDay.count,
      lookupsLast10Min: this.container.count,
    };
  }
}
