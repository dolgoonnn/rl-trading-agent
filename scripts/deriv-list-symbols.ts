#!/usr/bin/env tsx
/**
 * List Deriv active symbols (synthetic indices), to find exact API symbol codes.
 *   npx tsx scripts/deriv-list-symbols.ts [filter]
 * e.g. `npx tsx scripts/deriv-list-symbols.ts step` prints Step/Skew Step codes.
 */
import WebSocket from 'ws';

interface ActiveSymbol { symbol: string; display_name: string; market: string; submarket: string; exchange_is_open: number; }
interface Resp { active_symbols?: ActiveSymbol[]; error?: { message: string }; }

const filter = (process.argv[2] ?? '').toLowerCase();
const ws = new WebSocket('wss://ws.derivws.com/websockets/v3?app_id=1089');

ws.on('open', () => ws.send(JSON.stringify({ active_symbols: 'brief', product_type: 'basic' })));
ws.on('message', (d: WebSocket.RawData) => {
  const r = JSON.parse(d.toString()) as Resp;
  if (r.error) { console.error('error:', r.error.message); ws.close(); return; }
  const syms = (r.active_symbols ?? []).filter((s) =>
    s.market === 'synthetic_index' &&
    (!filter || s.display_name.toLowerCase().includes(filter) || s.symbol.toLowerCase().includes(filter)));
  console.log(`${syms.length} synthetic symbols${filter ? ` matching "${filter}"` : ''}:`);
  for (const s of syms.sort((a, b) => a.display_name.localeCompare(b.display_name))) {
    console.log(`  ${s.symbol.padEnd(14)} | ${s.display_name.padEnd(34)} | ${s.submarket}`);
  }
  ws.close();
});
ws.on('error', (e) => { console.error(e); process.exit(1); });
