# Pump.fun Replay Sprint — Dip-Bounce Paper Bot (Variant B)

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/indrairawan4503-cmd/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/indrairawan4503-cmd/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A TypeScript trading bot that trades 10 SOL of paper money on a replay of 24h of
pump.fun bonding-curve events. Variant B is a mean-reversion bot: it buys sharp
dips only after the bounce has confirmed itself (price up off the post-peak
trough, fresh buys printing), in small fixed stakes, and exits fast on a take
profit, stop loss, trailing stop, or a hard holding limit — never catching a
falling knife.

## Run it

Requires Node 22. The grader runs `node main.ts`; locally, grade on the kit's
dev window with:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver docker --bundle <transcripts.tar.gz>
```

## Strategy

- Track each curve's price (virtual SOL / virtual token reserves) per trade.
- Enter when price fell 15–30% from a fresh peak (within 1200 slots), bounced
  ≥15% off the trough within the last 600 slots, and buyers are still stepping
  in (≥4 of last 5 trades are buys, latest trade a buy) on a curve holding
  ≥10 SOL of real reserves.
- One fixed 0.15 SOL stake per coin, capped by the per-reply size cap.
- Exit at +20% take profit, −7% stop loss, or after 1200 slots held (no
  trailing stop: sweeps showed it cuts winners short).
- Deterministic: no clock, no randomness, no I/O — the two graded executions
  produce byte-identical action logs.

<sub>Entered on [make.fun](https://make.fun/?ref=8dxq9bq0&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
