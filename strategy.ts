// Variant B — dip-bounce mean reversion on pump.fun bonding curves.
//
// Idea: a curve that pumped, dumped hard, and has just started to bounce tends to
// retrace part of the fall before the crowd moves on. We only buy AFTER the bounce
// has shown itself (price up off the post-peak trough, fresh buys printing), so we
// never buy a knife that is still falling. One fixed stake per coin, no adds, and a
// fast exit: take profit, stop loss, trailing stop once in profit, or a hard time
// limit. Small stakes across many coins keep the 20-coin guardrail in reach.
//
// Everything here is a pure function of the batches the harness sends: no clock,
// no randomness, no I/O, so the two graded executions produce byte-identical
// action logs. Each batch of orders is decided from the state of that slot only.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots of price history kept per coin (a slot is ~0.4s). */
  windowSlots: number;
  /** Trades a coin needs before it can be entered. */
  minTrades: number;
  /** Enter when price fell at least this far from the window peak (fraction). */
  dipMin: number;
  /** ...and no further than this (a collapse, not a dip). */
  dipMax: number;
  /** Bounce off the post-peak trough needed to confirm the dip is turning. */
  bounceMin: number;
  /** The bounce must have started within this many slots. */
  bounceFreshSlots: number;
  /** Of the last `flowTrades` trades, at least this many must be buys. */
  flowTrades: number;
  minBuys: number;
  /** The latest trade must be a buy (buyers stepping in right now). */
  lastMustBeBuy: boolean;
  /** Minimum real SOL in the curve at entry (lamports). */
  minRealSol: bigint;
  /** Minimum real SOL at the window peak (the pump was real, not dust). */
  minPeakRealSol: bigint;
  /** Lamports per entry (capped by the per-reply size cap). */
  stake: bigint;
  /** Smallest buy worth sending (tx fee is 105k lamports per order). */
  minBuy: bigint;
  /** Take profit when liquidation value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Stop when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Trailing stop: once value is above cost * (1 + trailArm), sell if it falls
   *  this far below the best value seen since entry. */
  trailArm: number;
  trailDrop: number;
  /** Exit after holding this many slots regardless. */
  maxHoldSlots: number;
  /** After an exit, ignore the coin for this many slots. */
  cooldownSlots: number;
  /** The window peak must be this fresh (slots) — a pullback in a live coin,
   *  not a bounce on a coin that peaked long ago and has been bleeding. */
  peakFreshSlots: number;
  /** The peak-to-trough fall must complete within this many slots — a sharp
   *  dump exhausts sellers; a slow bleed usually keeps bleeding. */
  maxDipSlots: number;
  /** Slippage tolerance on buys and on sells (bps). */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Most new entries per reply (batch). */
  maxEntriesPerBatch: number;
}

export const DEFAULT_PARAMS: Params = {
  windowSlots: 3600,
  minTrades: 12,
  dipMin: 0.15,
  dipMax: 0.3,
  bounceMin: 0.15,
  bounceFreshSlots: 600,
  flowTrades: 5,
  minBuys: 4,
  lastMustBeBuy: true,
  minRealSol: 10_000_000_000n,
  minPeakRealSol: 2_000_000_000n,
  stake: 150_000_000n,
  minBuy: 20_000_000n,
  takeProfit: 0.2,
  stopLoss: 0.07,
  // Trailing stop disabled: sweeps on the dev window showed it cuts winners
  // short (the bounce usually tops out near the take-profit level and then
  // fades, so a trailing exit just banks less than the fixed target).
  trailArm: 999,
  trailDrop: 0.06,
  maxHoldSlots: 1200,
  cooldownSlots: 900,
  peakFreshSlots: 1200,
  maxDipSlots: 900,
  buySlippageBps: 800,
  sellSlippageBps: 2000,
  maxEntriesPerBatch: 3,
};

interface Trade {
  slot: number;
  /** SOL per token: virtual SOL reserves / virtual token reserves. */
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface Book {
  trades: Trade[];
  entryPrice: number;
  entrySlot: number;
  /** Best liquidation-value / cost ratio seen since entry (1 = breakeven). */
  bestRatio: number;
  /** Slot until which the coin is ignored after an exit. */
  coolUntil: number;
  /** A sell is in flight: do not send another. */
  exiting: boolean;
}

const FEE_BPS = 125n;
const BPS = 10_000n;

/** Per-reply buy cap, with a margin for our own flow shifting the reserves. */
function buyCap(state: BotState, mint: Pubkey): bigint {
  return (state.maxBuyLamports(mint) * 97n) / 100n;
}

/**
 * What selling `tokens` would pay against the curve's latest recorded reserves,
 * curve fees deducted. Uses the SDK's curve table, which the harness keeps current
 * for every mint seen.
 */
function liquidationValue(state: BotState, mint: Pubkey, tokens: bigint): bigint {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0n;
  const vq = curve.virtual_quote_reserves;
  const vt = curve.virtual_token_reserves;
  const rq = curve.real_quote_reserves;
  if (vt + tokens === 0n) return 0n;
  let q = (tokens * vq) / (vt + tokens);
  if (q > rq) q = rq;
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const books = new Map<Pubkey, Book>();
  const book = (mint: Pubkey): Book => {
    let b = books.get(mint);
    if (b === undefined) {
      b = { trades: [], entryPrice: 0, entrySlot: -1, bestRatio: 1, coolUntil: -1, exiting: false };
      books.set(mint, b);
    }
    return b;
  };

  return function onBatch(state: BotState, batch: Batch): OrderInput[] {
    const slot = batch.slot;
    const touched: Pubkey[] = [];
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const b = book(e.mint);
      const vt = BigInt(e.virtual_token_reserves);
      const price = vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt);
      b.trades.push({ slot, price, realSol: BigInt(e.real_quote_reserves), isBuy: e.is_buy, sol: BigInt(e.sol_amount) });
      if (b.trades.length > 400) b.trades.splice(0, b.trades.length - 400);
      if (touched[touched.length - 1] !== e.mint && !touched.includes(e.mint)) touched.push(e.mint);
    }
    // A sell that resolved (or failed) frees the book for the next exit attempt;
    // a position fully closed starts the cooldown. A buy that never filled forgets
    // the entry so the coin can be reconsidered from scratch.
    for (const f of batch.fills) {
      const b = books.get(f.mint);
      if (b === undefined) continue;
      if (f.side === 'sell') {
        b.exiting = false;
        if (!state.positions.has(f.mint)) {
          b.entrySlot = -1;
          b.bestRatio = 1;
          b.coolUntil = slot + p.cooldownSlots;
        }
      } else if (f.status !== 'filled' && !state.positions.has(f.mint)) {
        let stillPending = false;
        for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
        if (!stillPending) {
          b.entrySlot = -1;
          b.bestRatio = 1;
        }
      }
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();
    const pendingMints = new Set<Pubkey>();
    for (const o of state.pending.values()) pendingMints.add(o.order.mint);

    // 1. Exits on held positions, in mint order so the reply is deterministic.
    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= cap) break;
      const h = state.positions.get(mint)!;
      const b = book(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (b.exiting || pendingMints.has(mint)) continue;
      const value = liquidationValue(state, mint, h.token_amount);
      const cost = h.cost_lamports;
      if (cost <= 0n) continue;
      const ratio = Number(value) / Number(cost);
      if (ratio > b.bestRatio) b.bestRatio = ratio;
      const entrySlot = b.entrySlot < 0 ? slot : b.entrySlot;
      const tp = ratio >= 1 + p.takeProfit;
      const sl = ratio <= 1 - p.stopLoss;
      const trail = b.bestRatio >= 1 + p.trailArm && ratio <= b.bestRatio * (1 - p.trailDrop);
      const stale = slot - entrySlot >= p.maxHoldSlots;
      if (tp || sl || trail || stale) {
        orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: p.sellSlippageBps });
        b.exiting = true;
      }
    }

    // 2. New entries on coins that traded in this batch, in event order.
    let entries = 0;
    let open = state.committedPositionCount();
    for (const mint of touched) {
      if (orders.length >= cap || entries >= p.maxEntriesPerBatch) break;
      if (open >= state.hello.caps.max_open_positions) break;
      if (state.positions.has(mint) || pendingMints.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const b = book(mint);
      if (slot < b.coolUntil) continue;
      const trades = b.trades;
      if (trades.length < p.minTrades) continue;
      const last = trades[trades.length - 1]!;
      if (last.realSol < p.minRealSol) continue;
      if (p.lastMustBeBuy && !last.isBuy) continue;

      // Peak inside the window, and the trough since that peak.
      let peak = 0;
      let peakReal = 0n;
      let peakIdx = -1;
      let peakSlot = -1;
      for (let i = trades.length - 1; i >= 0; i--) {
        const t = trades[i]!;
        if (slot - t.slot > p.windowSlots) break;
        if (t.price > peak) {
          peak = t.price;
          peakReal = t.realSol;
          peakIdx = i;
          peakSlot = t.slot;
        }
      }
      if (peak <= 0 || peakIdx < 0 || peakReal < p.minPeakRealSol) continue;
      // The peak must be fresh and the fall sharp: a pullback in a live coin.
      if (slot - peakSlot > p.peakFreshSlots) continue;
      const dip = 1 - last.price / peak;
      if (dip < p.dipMin || dip > p.dipMax) continue;

      // Trough since the peak, and the bounce off it.
      let trough = Infinity;
      let troughSlot = -1;
      for (let i = peakIdx; i < trades.length; i++) {
        const t = trades[i]!;
        if (t.price < trough) {
          trough = t.price;
          troughSlot = t.slot;
        }
      }
      if (trough === Infinity || trough <= 0 || troughSlot < 0) continue;
      // The fall from peak to trough must be sharp, not a slow bleed.
      if (troughSlot - peakSlot > p.maxDipSlots) continue;
      const bounce = last.price / trough - 1;
      if (bounce < p.bounceMin) continue;
      // The bounce must be fresh: the trough itself within the fresh window,
      // so we buy a turn that just happened, not a flat line hours old.
      if (slot - troughSlot > p.bounceFreshSlots) continue;

      // Buyers still stepping in over the recent flow.
      let buys = 0;
      for (let i = trades.length - p.flowTrades; i < trades.length; i++) {
        if (trades[i]!.isBuy) buys++;
      }
      if (buys < p.minBuys) continue;

      let amount = p.stake;
      const sizeCap = buyCap(state, mint);
      if (amount > sizeCap) amount = sizeCap;
      if (amount < p.minBuy) continue;
      if (state.freeCashLamports() - amount - tx < 0n) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
      b.entryPrice = last.price;
      b.entrySlot = slot;
      b.bestRatio = 1;
      b.exiting = false;
      pendingMints.add(mint);
      entries++;
      open++;
    }
    return orders;
  };
}
