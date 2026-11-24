// Variant B — dip-bounce mean reversion (see strategy.ts).
// Run by the grader as `node /bot/main.ts`; the SDK shim is vendored byte for byte
// in vendor/makefun-bot.ts. Every batch of orders is decided from that slot's
// state only: no clock, no randomness, no I/O, so the two graded executions
// produce byte-identical action logs.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const onBatch = createStrategy(DEFAULT_PARAMS);

await runBot({ onBatch });
