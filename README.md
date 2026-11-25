[![make.fun](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Sakti69/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Sakti69/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pump.fun Bot Sprint — Momentum Bot

Paper-trading bot for the make.fun competition
`u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed`
(Pump.fun Bot Sprint: Make Bot And Win).

Competition: https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

## Strategy

Momentum / trend bot on pump.fun bonding curves, 10 SOL paper capital,
harness `pumpfun-replay/v2`:

- **Entry:** a curve that survived at least 300 slots and shows accelerating
  buy pressure over a 40-slot window — net SOL inflow >= 0.5 SOL, >= 5 buys
  from >= 4 distinct buyers, price up 8–120% and within 5% of its window
  high, inflow in both halves with the newer half at least as strong as
  the older one, and the tape's latest trade a buy. Real SOL reserve at
  entry 1–80 SOL.
- **Sizing:** first buy 0.10 SOL, pyramid adds of 0.10 SOL only while the
  trade is working (price at/above the last add, position value above
  cost, net flow still positive), up to 0.50 SOL per coin. Max 5 open
  positions, max 6 SOL at cost across all positions.
- **Exits (whole position):** stop-loss −25%, take-profit +60%, trailing
  stop 25% from the peak once up >= 20%, fade on net outflow < −1 SOL
  over 20 slots, exit on a single sell >= 5 SOL, or a 2000-slot time
  limit (waived while up >= 60%).
- **Guardrails:** 0.02 SOL probe round trips keep the run on pace for
  >= 20 coins with round trips of >= 0.01 SOL each.

Local smoke test (synthetic replay with fills, 461 batches): 6 buys,
2 sells, exits fired on the dump, final paper cash 10.31 SOL from 10.00
on a rising-then-dumping tape; two runs byte-identical.

Deterministic: no clock, no randomness, no I/O, no network.

## Layout

- `main.ts` — entrypoint, run by the grader as `node /bot/main.ts`
- `vendor/makefun-bot.ts` — kit SDK shim, byte-identical to the kit's
  `sdk/ts/makefun-bot.ts`

## License

MIT — see `LICENSE`.
