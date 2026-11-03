/**
 * PM2.5 correction and the US AQI (YA-36). Pure arithmetic, every constant cited.
 *
 * The correction: the US EPA's extended correction for PurpleAir, as used on the AirNow Fire and Smoke Map (Barkjohn
 * et al.; "AirNow Fire and Smoke Map: Questions and Answers", equation 4, October 2021,
 * https://document.airnow.gov/airnow-fire-and-smoke-map-questions-and-answers.pdf, checked 2026-09-14). It extends the
 * 2021 US-wide correction (0.524 x PA - 0.0862 x RH + 5.75; Barkjohn et al., AMT 14, 4617-4637, 2021,
 * https://amt.copernicus.org/articles/14/4617/2021/) to smoke concentrations. The map applies it to the 10-minute
 * **cf_atm** average, "since 10-minute averages are not currently available for the cf_1 data", which is exactly what
 * PurpleAir's `pm2.5_10minute` is for an outdoor sensor (api.purpleair.com field notes: "CF=1 for indoor and ATM
 * variant for outdoor"). RH is the sensor's own reported humidity, as in the fit.
 *
 * The AQI: EPA's PM2.5 breakpoints as revised in 2024 (Good ends at 9.0 µg/m³), from the Technical Assistance Document
 * for the Reporting of Daily Air Quality, Table 6
 * (https://document.airnow.gov/technical-assistance-document-for-the-reporting-of-daily-air-quailty.pdf) and the AQS
 * breakpoint table (https://aqs.epa.gov/aqsweb/documents/codetables/aqi_breakpoints.html), both checked 2026-09-14.
 * Concentrations are truncated to one decimal place, then the index is rounded to the nearest integer. Above 325.4
 * µg/m³ the index goes on past 500 on the Hazardous line's own slope: Table 6, footnote 4, "AQI values greater than
 * 500 should be calculated using equation 1 and the concentration specified for the AQI value of 500", and the TAD's
 * FAQ, "AQI values above 500 based on the same linear slope as the AQI values between 301 and 500" (review C2).
 */
import type {AqiCategory} from '../core/types.ts';

/**
 * EPA-corrected PM2.5 in µg/m³ from PurpleAir's 10-minute cf_atm average `pa` (µg/m³) and relative humidity `rh`
 * (percent). Never negative.
 */
export function epaCorrectedPm25(pa: number, rh: number): number {
  let corrected: number;
  if (pa < 30) {
    corrected = 0.524 * pa - 0.0862 * rh + 5.75;
  } else if (pa < 50) {
    const blend = pa / 20 - 3 / 2;
    corrected = (0.786 * blend + 0.524 * (1 - blend)) * pa - 0.0862 * rh + 5.75;
  } else if (pa < 210) {
    corrected = 0.786 * pa - 0.0862 * rh + 5.75;
  } else if (pa < 260) {
    const blend = pa / 50 - 21 / 5;
    corrected =
      (0.69 * blend + 0.786 * (1 - blend)) * pa -
      0.0862 * rh * (1 - blend) +
      2.966 * blend +
      5.75 * (1 - blend) +
      8.84e-4 * pa ** 2 * blend;
  } else {
    corrected = 2.966 + 0.69 * pa + 8.84e-4 * pa ** 2;
  }
  return Math.max(0, corrected);
}

interface Breakpoint {
  concentrationLow: number;
  concentrationHigh: number;
  indexLow: number;
  indexHigh: number;
  category: AqiCategory;
}

/** EPA PM2.5 24-hour AQI breakpoints, 2024 revision (µg/m³, truncated to 0.1). */
export const PM25_BREAKPOINTS: readonly Breakpoint[] = [
  {concentrationLow: 0.0, concentrationHigh: 9.0, indexLow: 0, indexHigh: 50, category: 'good'},
  {concentrationLow: 9.1, concentrationHigh: 35.4, indexLow: 51, indexHigh: 100, category: 'moderate'},
  {
    concentrationLow: 35.5,
    concentrationHigh: 55.4,
    indexLow: 101,
    indexHigh: 150,
    category: 'unhealthyForSensitiveGroups',
  },
  {concentrationLow: 55.5, concentrationHigh: 125.4, indexLow: 151, indexHigh: 200, category: 'unhealthy'},
  {concentrationLow: 125.5, concentrationHigh: 225.4, indexLow: 201, indexHigh: 300, category: 'veryUnhealthy'},
  {concentrationLow: 225.5, concentrationHigh: 325.4, indexLow: 301, indexHigh: 500, category: 'hazardous'},
];

/** A concentration truncated (not rounded) to one decimal place, as the TAD requires. */
export function truncatePm25(concentration: number): number {
  return Math.floor(Math.max(0, concentration) * 10 + 1e-9) / 10;
}

export interface Aqi {
  aqi: number;
  category: AqiCategory;
}

/** The US AQI and category for a PM2.5 concentration in µg/m³. */
export function aqiFromPm25(concentration: number): Aqi {
  const truncated = truncatePm25(concentration);
  const last = PM25_BREAKPOINTS[PM25_BREAKPOINTS.length - 1];
  // The first band the concentration fits, or, beyond the table, the last band's line extended (footnote 4).
  const breakpoint = PM25_BREAKPOINTS.find((candidate) => truncated <= candidate.concentrationHigh) ?? last;
  const index =
    ((breakpoint.indexHigh - breakpoint.indexLow) / (breakpoint.concentrationHigh - breakpoint.concentrationLow)) *
      (truncated - breakpoint.concentrationLow) +
    breakpoint.indexLow;
  return {aqi: Math.round(index), category: breakpoint.category};
}
