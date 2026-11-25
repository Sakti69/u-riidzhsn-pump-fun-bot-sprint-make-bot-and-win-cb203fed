// Pump.fun Bot Sprint — momentum / trend bot for agent-fun/replay/v2.
//
// Paper trading only: 10 SOL of paper capital, at most 5 open positions, no
// shorts, no leverage. The bot reads each replay batch as it arrives on its
// slot and answers with the orders for that slot (the harness fills them
// latency_slots later). It never reads the clock, the environment or
// Math.random, so the two grading runs agree byte for byte.
//
// Idea, in one paragraph: most pump.fun curves die fast, so only buy a curve
// that has already survived a while and is actively being bought — several
// distinct buyers, net SOL flowing in, price rising but still near its recent
// high, and the inflow accelerating into the newer half of the window. Start
// small (0.10 SOL), add only while the trade is working (pyramid into
// strength, up to 0.50 SOL per coin), and get out whole on a stop loss, a
// take-profit, a trailing stop, a fade in flow, a single big sell, or a time
// limit. A small probe round trip keeps the run above the guardrail pace
// (at least 20 coins with a round trip of at least 0.01 SOL) when momentum
// entries are scarce.
//
// hello: the harness sends it once before the first batch; onBatch answers
// every batch with orders; the reply carries the batch seq.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
// Curve fee (protocol 95 bps + creator 30 bps fallback) used when valuing a
// position from its reserves.
const CURVE_FEE = 0.0125;

const P = {
  window: 40, // entry lookback, in slots
  minNetSol: 0.5, // net buy SOL (buys minus sells) over the window
  minBuys: 5, // buy trades in the window
  minBuyers: 4, // distinct buying wallets in the window
  minPriceUp: 0.08, // price now vs window start, minus 1
  maxPriceUp: 1.2, // skip curves that already ran too far in one window
  accel: 1.0, // newer-half net inflow must be >= this x older-half net
  nearHigh: 0.95, // price now at least this share of the window high
  minRqSol: 1, // real SOL reserve bounds at entry
  maxRqSol: 80,
  minAge: 300, // slots since CreateEvent before an entry is allowed
  stakeSol: 0.5, // most SOL into one position in total
  initialSol: 0.1, // first buy of a position
  addSol: 0.1, // each pyramid add
  minBuySol: 0.01, // smallest buy worth sending (the guardrail round trip)
  buySlipBps: 1500, // buys tolerate 15% slippage across the latency
  stopLoss: 0.25, // exit when value < cost * (1 - stopLoss)
  takeProfit: 0.6, // exit whole when value >= cost * (1 + takeProfit)
  trail: 0.25, // trailing stop from the peak value
  trailArm: 0.2, // trail arms once value >= cost * (1 + trailArm)
  fadeWindow: 20, // exit when net SOL over this window < -fadeNetSol
  fadeNetSol: 1,
  bigSellSol: 5, // exit on any single recorded sell of at least this
  maxHold: 2000, // exit after this many slots held (unless well up)
  holdIfUp: 0.6, // the time limit does not apply while up this much
  cooldown: 150, // slots to wait after an exit before re-entering a curve
  maxEntries: 2, // most entries per curve over the run
  maxExposureSol: 6, // most SOL at cost across all positions at once
  // Guardrail pacing: keep the run on pace for 24 coins / 120 fills over a
  // 6-hour window; probes are 0.02 SOL round trips on liquid curves.
  targetCoins: 24,
  targetFills: 120,
  paceSecs: 21_600,
  probeSol: 0.02,
  maxProbes: 1,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
/** Positions the bot opened itself, by mint. */
const held = new Map<Pubkey, Held>();
/** Probe round trips in flight, by mint: false while buying, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;
const keep = P.window + 5;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

/** Net recorded SOL (buys minus sells) over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Entry signal on a curve's tape at slot `now`. */
function entrySignal(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < P.minRqSol || rqSol > P.maxRqSol) return false;
  if (t.created === null || now - t.created < P.minAge) return false;
  const from = now - P.window;
  const mid = now - P.window / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  let lastBuy = false;
  const byUser = new Map<string, number>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
    lastBuy = tr.buy;
  }
  if (buys < P.minBuys || byUser.size < P.minBuyers) return false;
  if (buySol - sellSol < P.minNetSol) return false;
  if (startPrice <= 0) return false;
  const up = last / startPrice - 1;
  if (up < P.minPriceUp || up > P.maxPriceUp) return false;
  if (last < high * P.nearHigh) return false;
  // Acceleration must be real: inflow in BOTH halves, and the newer half at
  // least as strong as the older one. (v1 let a negative older half pass.)
  if (netOld <= 0 || netNew <= 0 || netNew < P.accel * netOld) return false;
  // Do not buy right after the tape's latest trade is a sell: the momentum
  // just broke, and the latency would fill us into the dump.
  if (!lastBuy) return false;
  return true;
}

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const bigSell = new Set<Pubkey>();
    const traded = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= P.bigSellSol) bigSell.add(e.mint);
      }
    }
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }
    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) {
      pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = Number(state.txFeeLamports()) / LAMPORTS;

    // Exits first: stop loss, take profit, trailing stop, fade, big sell,
    // time limit. A position is always sold whole.
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          const t = tapeOf(mint);
          if (h.filled) t.lastExit = now;
          else t.entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const mk = marks.get(mint);
      const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const tokens = Number(pos.token_amount);
      const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValue) h.peakValue = value;
      h.lastValue = value;
      let exit = h.exiting;
      const t = tapeOf(mint);
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && value >= cost * (1 + P.takeProfit)) exit = true;
      if (!exit && h.peakValue >= cost * (1 + P.trailArm) && value < h.peakValue * (1 - P.trail)) exit = true;
      if (!exit && flow(t, now, P.fadeWindow) < -P.fadeNetSol) exit = true;
      if (!exit && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > P.maxHold && value < cost * (1 + P.holdIfUp)) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      }
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // Probe round trips: sell the whole probe as soon as its buy has landed.
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // Entries and pyramid adds, in the order the batch's trades arrived.
    let free = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let exposure = 0;
    for (const [mint, h] of held) {
      exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
      let want: number;
      if (h === undefined) {
        if (slotsLeft <= 0) continue;
        if (t.entries >= P.maxEntries || now - t.lastExit < P.cooldown) continue;
        if (!entrySignal(t, now, rqSol)) continue;
        want = Math.min(P.initialSol, P.stakeSol);
      } else {
        // Pyramid into strength only: the position is up, the price is at or
        // above the last add, and net SOL still flows in.
        if (h.exiting || !h.filled || h.invested >= P.stakeSol - P.minBuySol) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        if (price < h.lastAddPrice) continue;
        if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS) continue;
        if (flow(t, now, P.window) < P.minNetSol) continue;
        if (rqSol > P.maxRqSol) continue;
        want = Math.min(P.addSol, P.stakeSol - h.invested);
      }
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
      let amount = Math.min(capSol, want, P.maxExposureSol - exposure);
      if (amount > free - tx) amount = free - tx;
      if (amount < P.minBuySol) continue;
      const lamports = BigInt(Math.floor(amount * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
      free -= amount + tx;
      exposure += amount;
      if (h === undefined) {
        held.set(mint, {
          opened: now,
          peakValue: 0,
          invested: amount,
          exiting: false,
          filled: false,
          lastAddPrice: price,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.lastAddPrice = price;
      }
    }

    // Guardrail pacing: open a probe when fills or coins lag the pace.
    if (probes.size < P.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, (lastTime - firstTime) / P.paceSecs);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        const minRq = (P.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= P.maxProbes) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
          if (free < P.probeSol + 2 * tx) break;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)),
            max_slippage_bps: P.buySlipBps,
          });
          probes.set(mint, false);
          free -= P.probeSol + tx;
        }
      }
    }
    return orders;
  },
});
