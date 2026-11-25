// Transactions and pump.fun instructions: building, parsing, signing,
// account layouts and price math.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { b58decode, b58encode } from '../js/b58.js';
import { concat, compactU16, toBase64, u32le, u64le, u16le } from '../js/bytes.js';
import { Keypair } from '../js/keys.js';
import { pda, associatedTokenAddress, toBytes } from '../js/pda.js';
import {
  buildLegacyTransaction, parseTransaction, signTransaction, transactionId,
  setComputeUnitLimit, setComputeUnitPrice, systemTransfer, SYSTEM_PROGRAM, COMPUTE_BUDGET_PROGRAM,
} from '../js/tx.js';
import * as pump from '../js/pump.js';

const BLOCKHASH = b58encode(new Uint8Array(32).fill(7));

function verifySig(message, sig, pubkey) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(pubkey)]);
  return nodeCrypto.verify(null, message, nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }), sig);
}

function metaOf(tx, i) {
  const h = tx.header;
  const n = tx.staticKeys.length;
  const isSigner = i < h.numRequiredSignatures;
  const isWritable = isSigner ? i < h.numRequiredSignatures - h.numReadonlySigned : i < n - h.numReadonlyUnsigned;
  return { pubkey: tx.staticKeys[i], isSigner, isWritable };
}

test('known pump.fun PDAs', async () => {
  assert.equal(await pda(['__event_authority'], pump.PUMP), 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(await pump.mintAuthorityAddress(), 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM');
  assert.equal(await pda(['__event_authority'], pump.PUMP_AMM), 'GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR');
});

test('buy transaction: 17 accounts in IDL order with the right flags, signs and verifies', async () => {
  const kp = await Keypair.generate();
  const mint = 'Coyj3LtKn1BNSgWc9HsGK5SKoGfEoDaymig4wrN6pump';
  const { keys, bondingCurve, associatedBaseUser } = await pump.curveTradeAccounts(kp.address, mint, pump.TOKEN_2022);
  assert.equal(keys.length, 17);
  assert.equal(bondingCurve, await pda(['bonding-curve', toBytes(mint)], pump.PUMP));
  assert.equal(associatedBaseUser, await associatedTokenAddress(kp.address, mint, pump.TOKEN_2022));
  const ix = pump.buyExactQuoteInV3Ix(keys, 50_000_000n, 1_000_000n);
  const tx = buildLegacyTransaction({
    payer: kp.address, recentBlockhash: BLOCKHASH,
    instructions: [
      setComputeUnitLimit(150_000), setComputeUnitPrice(250_000),
      pump.createAtaIdempotent(kp.address, associatedBaseUser, kp.address, mint, pump.TOKEN_2022),
      ix,
    ],
  });
  const parsed = parseTransaction(tx);
  assert.equal(parsed.version, 'legacy');
  assert.equal(parsed.header.numRequiredSignatures, 1);
  assert.equal(parsed.staticKeys[0], kp.address);
  assert.equal(parsed.recentBlockhash, BLOCKHASH);
  assert.equal(parsed.instructions.length, 4);
  // compute budget
  assert.equal(parsed.staticKeys[parsed.instructions[0].programIdIndex], COMPUTE_BUDGET_PROGRAM);
  assert.deepEqual(parsed.instructions[0].data, concat(Uint8Array.of(2), u32le(150_000)));
  assert.deepEqual(parsed.instructions[1].data, concat(Uint8Array.of(3), u64le(250_000)));
  // buy: every account matches the expected meta exactly
  const buy = parsed.instructions[3];
  assert.equal(parsed.staticKeys[buy.programIdIndex], pump.PUMP);
  assert.deepEqual(buy.data, concat(Uint8Array.from([225, 247, 80, 30, 213, 179, 132, 136]), u64le(50_000_000n), u64le(1_000_000n)));
  assert.equal(buy.accountIndexes.length, 17);
  buy.accountIndexes.forEach((idx, i) => {
    const m = metaOf(parsed, idx);
    assert.equal(m.pubkey, keys[i].pubkey, 'account ' + i);
    assert.equal(m.isSigner, keys[i].isSigner, 'signer ' + i);
    // a key may be writable because another instruction marks it so; never the reverse
    if (keys[i].isWritable) assert.ok(m.isWritable, 'writable ' + i);
  });
  // read-only program / config accounts stay read-only
  for (const k of [pump.PUMP, pump.PUMP_FEE_CONFIG, pump.TOKEN_2022, pump.WSOL, SYSTEM_PROGRAM]) {
    assert.equal(metaOf(parsed, parsed.staticKeys.indexOf(k)).isWritable, false, k);
  }
  // sign
  const signed = await signTransaction(tx, kp);
  const p2 = parseTransaction(signed);
  const sig = signed.subarray(p2.sigOffsets[0], p2.sigOffsets[0] + 64);
  assert.ok(verifySig(p2.message, sig, kp.publicKey));
  assert.equal(transactionId(signed), b58encode(sig));
  assert.ok(signed.length <= 1232);
});

test('sell and PumpSwap sell instructions have the documented layouts', async () => {
  const kp = await Keypair.generate();
  const mint = '7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump';
  const { keys } = await pump.curveTradeAccounts(kp.address, mint, pump.TOKEN);
  const s = pump.sellV3Ix(keys, 123n, 45n);
  assert.deepEqual(s.data, concat(Uint8Array.from([28, 146, 222, 119, 38, 196, 105, 213]), u64le(123n), u64le(45n)));
  const pool = await pump.canonicalPoolAddress(mint);
  assert.equal(pool, 'GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
  const poolState = { poolBaseTokenAccount: '5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa', poolQuoteTokenAccount: '43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8' };
  const a = await pump.ammSellAccounts(kp.address, mint, pump.TOKEN, pool, poolState);
  assert.equal(a.keys.length, 17);
  assert.equal(a.keys[0].pubkey, pool);
  assert.ok(a.keys[1].isSigner && a.keys[1].pubkey === kp.address);
  assert.equal(a.keys[2].pubkey, pump.AMM_GLOBAL_CONFIG);
  assert.equal(a.keys[13].pubkey, pump.AMM_FEE_CONFIG);
  assert.equal(a.keys[16].pubkey, pump.PUMP_AMM);
  assert.equal(a.keys[12].pubkey, await pda(['user_volume_accumulator', toBytes(kp.address)], pump.PUMP_AMM));
  const buyback = pump.BUYBACK_FEE_RECIPIENTS.map((b) => associatedTokenAddress(b, pump.WSOL, pump.TOKEN));
  assert.ok((await Promise.all(buyback)).includes(a.keys[14].pubkey));
  const ix = pump.ammSellV2Ix(a.keys, 1000n, 1n);
  assert.deepEqual(ix.data.subarray(0, 8), Uint8Array.from([93, 246, 130, 60, 231, 233, 64, 178]));
  assert.throws(() => pump.sellV3Ix(keys, 0n, 0n));
  assert.throws(() => pump.buyExactQuoteInV3Ix(keys, 1n, 0n));
});

test('parse and sign v0 transactions (with a lookup table)', async () => {
  const kp = await Keypair.generate();
  const other = b58encode(new Uint8Array(32).fill(3));
  const table = b58encode(new Uint8Array(32).fill(9));
  const msg = concat(
    Uint8Array.of(0x80, 1, 0, 1),
    compactU16(3), kp.publicKey, b58decode(other), b58decode(SYSTEM_PROGRAM),
    b58decode(BLOCKHASH),
    compactU16(1), Uint8Array.of(2), compactU16(2), Uint8Array.of(0, 1), compactU16(12), concat(u32le(2), u64le(5000n)),
    compactU16(1), b58decode(table), compactU16(1), Uint8Array.of(4), compactU16(0),
  );
  const tx = concat(compactU16(1), new Uint8Array(64), msg);
  const p = parseTransaction(tx);
  assert.equal(p.version, 'v0');
  assert.equal(p.lookups.length, 1);
  assert.equal(p.lookups[0].table, table);
  assert.deepEqual(p.lookups[0].writable, [4]);
  const signed = await signTransaction(tx, kp);
  assert.ok(verifySig(msg, signed.subarray(1, 65), kp.publicKey));
});

test('parse and sign v1 transactions (signatures at the end)', async () => {
  const kp = await Keypair.generate();
  const other = b58encode(new Uint8Array(32).fill(4));
  const message = concat(
    Uint8Array.of(0x81, 1, 0, 1),
    u32le(0b11), // two config values present
    b58decode(BLOCKHASH),
    Uint8Array.of(1), // instructions
    Uint8Array.of(3), // addresses
    kp.publicKey, b58decode(other), b58decode(SYSTEM_PROGRAM),
    u32le(200000), u32le(1000),
    Uint8Array.of(2, 2), u16le(12),
    Uint8Array.of(0, 1), concat(u32le(2), u64le(5000n)),
  );
  const tx = concat(message, new Uint8Array(64));
  const p = parseTransaction(tx);
  assert.equal(p.version, 'v1');
  assert.equal(p.staticKeys[0], kp.address);
  assert.equal(p.instructions[0].accountIndexes.length, 2);
  const signed = await signTransaction(tx, kp);
  assert.ok(verifySig(message, signed.subarray(signed.length - 64), kp.publicKey));
  assert.equal(transactionId(signed), b58encode(signed.subarray(signed.length - 64)));
});

test('rejects malformed transactions and foreign signers', async () => {
  const kp = await Keypair.generate();
  const stranger = await Keypair.generate();
  const tx = buildLegacyTransaction({ payer: kp.address, recentBlockhash: BLOCKHASH, instructions: [systemTransfer(kp.address, stranger.address, 1n)] });
  await assert.rejects(() => signTransaction(tx, stranger), /not a signer/);
  assert.throws(() => parseTransaction(tx.subarray(0, tx.length - 3)));
  assert.throws(() => parseTransaction(concat(tx, Uint8Array.of(0))));
});

test('bonding curve decoding: full and old short layouts', () => {
  const full = new Uint8Array(166);
  full.set([23, 183, 248, 55, 96, 216, 172, 96], 0);
  const dv = new DataView(full.buffer);
  dv.setBigUint64(8, 1_000_000_000_000_000n, true);
  dv.setBigUint64(16, 35_000_000_000n, true);
  dv.setBigUint64(24, 720_000_000_000_000n, true);
  dv.setBigUint64(32, 5_000_000_000n, true);
  dv.setBigUint64(40, 1_000_000_000_000_000n, true);
  full[48] = 0;
  full.set(new Uint8Array(32).fill(5), 49);
  full[81] = 1; // mayhem
  const c = pump.decodeBondingCurve(full);
  assert.equal(c.virtualQuoteReserves, 35_000_000_000n);
  assert.equal(c.isMayhemMode, true);
  assert.equal(c.quoteMint, pump.DEFAULT_PUBKEY);
  assert.ok(pump.isSolPaired(c));
  const short = full.slice(0, 49);
  const s = pump.decodeBondingCurve(short);
  assert.equal(s.creator, pump.DEFAULT_PUBKEY);
  assert.equal(s.isCashbackCoin, false);
  const wrong = full.slice(); wrong[0] = 0;
  assert.equal(pump.decodeBondingCurve(wrong), null);
  const usdc = full.slice(); usdc.set(b58decode('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), 83);
  assert.ok(!pump.isSolPaired(pump.decodeBondingCurve(usdc)));
});

test('price math on a fresh curve', () => {
  const fresh = {
    virtualTokenReserves: pump.INITIAL_VIRTUAL_TOKEN_RESERVES,
    virtualQuoteReserves: pump.INITIAL_VIRTUAL_SOL_RESERVES,
    realTokenReserves: pump.INITIAL_REAL_TOKEN_RESERVES,
    tokenTotalSupply: 1_000_000_000_000_000n,
    complete: false,
  };
  const mcap = pump.lamportsToSol(pump.curveMarketCapLamports(fresh));
  assert.ok(Math.abs(mcap - 27.958) < 0.01, 'start market cap ~27.96 SOL, got ' + mcap);
  assert.equal(pump.curveProgress(fresh), 0);
  const tokens = pump.curveBuyTokensOut(fresh, 1_000_000_000n);
  // 1 SOL less 1.25% fee buys ~34.2M tokens
  assert.ok(tokens > 34_000_000_000_000n && tokens < 34_400_000_000_000n, String(tokens));
  const after = { ...fresh,
    virtualTokenReserves: fresh.virtualTokenReserves - tokens,
    virtualQuoteReserves: fresh.virtualQuoteReserves + 1_000_000_000n * 10000n / 10125n,
    realTokenReserves: fresh.realTokenReserves - tokens };
  const back = pump.curveSellLamportsOut(after, tokens);
  // round trip loses ~2.5% to fees
  assert.ok(back > 970_000_000n && back < 980_000_000n, String(back));
  assert.ok(pump.curveProgress(after) > 0.04 && pump.curveProgress(after) < 0.05);
  // never more than the curve has
  assert.equal(pump.curveBuyTokensOut({ ...fresh, realTokenReserves: 10n }, 1_000_000_000n), 10n);
  assert.equal(pump.curveSellLamportsOut(fresh, 0n), 0n);
  assert.ok(pump.poolSellLamportsOut(1000n, 1000n, 10n) > 0n);
  assert.equal(pump.poolSellLamportsOut(1000n, -5n, 10n), 0n);
});

function borshString(s) { const b = new TextEncoder().encode(s); return concat(u32le(b.length), b); }

function createEventBytes({ name, symbol, mint, curve, creator }) {
  return concat(
    Uint8Array.from([27, 114, 169, 77, 222, 235, 99, 118]),
    borshString(name), borshString(symbol), borshString('https://ipfs.io/x'),
    b58decode(mint), b58decode(curve), b58decode(creator), b58decode(creator),
    u64le(1764000000n),
    u64le(1n), u64le(2n), u64le(3n), u64le(4n),
    b58decode(pump.TOKEN_2022), Uint8Array.of(0, 0), new Uint8Array(32), u64le(0n), u64le(0n), Uint8Array.of(0, 0),
  );
}

test('CreateEvent is read only from the pump program frame', async () => {
  const mint = 'Coyj3LtKn1BNSgWc9HsGK5SKoGfEoDaymig4wrN6pump';
  const curve = await pump.bondingCurveAddress(mint);
  const creator = b58encode(new Uint8Array(32).fill(8));
  const data = toBase64(createEventBytes({ name: 'Doge\u0000 Moon‮', symbol: 'DGM', mint, curve, creator }));
  const logs = [
    `Program ${pump.PUMP} invoke [1]`,
    'Program log: Instruction: CreateV2',
    `Program ${pump.TOKEN_2022} invoke [2]`,
    `Program ${pump.TOKEN_2022} success`,
    `Program data: ${data}`,
    `Program ${pump.PUMP} success`,
  ];
  const evs = pump.createEventsFromLogs(logs);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].mint, mint);
  assert.equal(evs[0].bondingCurve, curve);
  assert.equal(evs[0].name, 'Doge Moon');
  assert.equal(evs[0].symbol, 'DGM');
  assert.equal(evs[0].tokenProgram, pump.TOKEN_2022);
  assert.equal(evs[0].isMayhemMode, false);
  // the same bytes emitted by another program are ignored
  const fake = [
    'Program Fake111111111111111111111111111111111 invoke [1]',
    `Program data: ${data}`,
    'Program Fake111111111111111111111111111111111 success',
  ];
  assert.equal(pump.createEventsFromLogs(fake).length, 0);
  // garbage is ignored
  assert.equal(pump.createEventsFromLogs([`Program ${pump.PUMP} invoke [1]`, 'Program data: !!!', 'Program data: AAAA']).length, 0);
});

test('pool decoding reads the signed virtual quote reserves', () => {
  const d = new Uint8Array(287);
  d.set([241, 154, 109, 4, 17, 177, 109, 188], 0);
  d.set(b58decode('5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa'), 139);
  d.set(b58decode('43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8'), 171);
  const dv = new DataView(d.buffer);
  dv.setBigUint64(245, 0xffffffffffffffffn - 99n, true); // -100 as i128 low word
  dv.setBigInt64(253, -1n, true);
  const p = pump.decodePool(d);
  assert.equal(p.poolBaseTokenAccount, '5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa');
  assert.equal(p.poolQuoteTokenAccount, '43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8');
  assert.equal(p.virtualQuoteReserves, -100n);
});
