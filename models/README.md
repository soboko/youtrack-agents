# Alexa English models — YA-37

These are complete interaction models for **issue desk**, not fragments. Upload each file to the matching language
in the Alexa developer console, then Save and Build Model for that language:

- `en-US/model.json`: English (US), including ZIP code and neighbourhood vocabulary spelt `neighborhood`.
- `en-GB/model.json`: English (UK), including postcode and flat.
- `en-CA/model.json`: English (Canada), including postal code and apartment.

Generate all three from the same source:

```sh
node src/voice/alexa/generate-model.ts src/voice/core/intents.ts --invocation-name "issue desk" --all-locales --output-dir models
```

Append `--check` to verify the files without rewriting them. To generate just one to stdout, use `--locale en-GB`
(or `en-US` / `en-CA`) instead of `--all-locales --output-dir models`. With no locale flag, the default is **en-US**.
The root `model.json` is not used or overwritten by the all-locales command.

Edit the shared sentence families in `src/voice/core/air-phrases.ts`, not these generated files. Other intents remain
in the core catalogue. Module catalogues may export `catalogueForLocale(locale)`; static JSON catalogues are emitted
unchanged for each locale. Regenerate `docs/voice/commands.md` with `node src/voice/docs/generate-commands.ts` too.

## Coverage and boundaries

Direct questions, indirect one-shot questions, contractions, requests, polite forms, current readings, AQI, and
air quality index are combined with explicit home/outdoor, indoor, or named-place locations. Regional terms vary
by locale; city and sensor names stay in `AMAZON.SearchQuery`, not a hard-coded city list. Location slots come last
so words such as “today” do not become a trailing part of the captured place. “At home” means outside near home;
“in my house”, “inside”, and “indoors” mean the configured indoor sensor. These are current readings, not forecasts
or daily averages. No model can enumerate all natural language or guarantee how Alexa will classify it.

Amazon recommends varied sentence structures, including indirect questions for one-shot invocation and regional
vocabulary: [Design custom intents](https://developer.amazon.com/en-US/docs/alexa/interaction-model-design/design-the-custom-intents-for-your-skill.html).
The generator does not put the wake word or invocation name into samples. Local tests check structure and the text
parser, **not Amazon's NLU**. A Lambda deployment does not publish these interaction models.

## Things to check after each console build

In the developer console simulator, select the locale being checked. Confirm these intent/slot expectations;
then try the same requests aloud with “Alexa, ask issue desk …”. Repeat in each supported locale's simulator:

| Request after the invocation | Expected intent | Expected place |
| --- | --- | --- |
| what the air quality is in Salt Lake | AirQualityPlaceIntent | Salt Lake |
| what is the air quality near Salt Lake City | AirQualityPlaceIntent | Salt Lake City |
| what the air quality is in Toronto | AirQualityPlaceIntent | Toronto |
| what the air quality is in London | AirQualityPlaceIntent | London |
| what is the air quality in my house | AirQualityIndoorIntent | none |
| tell me the air quality from my indoor sensor | AirQualityIndoorIntent | none |
| what the air quality is outside my house | AirQualityHereIntent | none |

Also try a real ZIP code, postcode or postal code with the matching locale's “air quality for …” wording.
Check the simulator's request JSON, not just the spoken answer: named places must not arrive as a home intent
without a slot. Save these results when accepting the build; repeat the matrix after later model changes.
