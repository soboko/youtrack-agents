#!/usr/bin/env node
// Node >= 22.18 runs TypeScript directly. Application startup and error handling live in reusable run().
import {run} from './src/cli/run.ts';

// exitCode preserves buffered output on pipes; process.exit() can truncate large JSON listings.
process.exitCode = await run(process.argv.slice(2));
