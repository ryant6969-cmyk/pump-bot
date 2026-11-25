// Checks base58, Ed25519, keys and program-derived addresses against
// Node's native crypto and against addresses published by pump.fun.
import test from 'node:test';
import assert from 'node:assert/strict';
import nodeCrypto from 'node:crypto';

import { b58encode, b58decode, isAddress } from '../js/b58.js';
import * as ed from '../js/ed25519.js';
import { Keypair } from '../js/keys.js';
import { findProgramAddress, pda, associatedTokenAddress, toBytes } from '../js/pda.js';
import { compactU16, readCompactU16, toBase64, fromBase64, u64le, readU64, readI128 } from '../js/bytes.js';

function nodeKeyFromSeed(seed) {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed)]);
  return nodeCrypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}
function nodePublicKey(seed) {
  const pub = nodeCrypto.createPublicKey(nodeKeyFromSeed(seed)).export({ format: 'der', type: 'spki' });
  return new Uint8Array(pub.subarray(pub.length - 32));
}

test('base58 round trips and known values', () => {
  assert.equal(b58encode(new Uint8Array(32)), '11111111111111111111111111111111');
  assert.deepEqual(b58decode('11111111111111111111111111111111'), new Uint8Array(32));
  assert.equal(b58encode(Uint8Array.of(0, 0, 1)), '112');
  assert.equal(b58encode(new TextEncoder().encode('hello world')), 'StV1DL6CwTryKyV');
  for (let i = 0; i < 300; i++) {
    const len = i % 70;
    const b = nodeCrypto.randomBytes(len);
    if (i % 7 === 0 && len > 2) { b[0] = 0; b[1] = 0; }
    assert.deepEqual(b58decode(b58encode(b)), new Uint8Array(b));
  }
  assert.throws(() => b58decode('0OIl'));
  assert.ok(isAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'));
  assert.ok(!isAddress('hello'));
  assert.ok(!isAddress('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6Pxx'));
});

test('compact-u16, base64, u64 and i128 helpers', () => {
  for (const n of [0, 1, 127, 128, 255, 16383, 16384, 65535]) {
    const enc = compactU16(n);
    const [v, off] = readCompactU16(enc, 0);
    assert.equal(v, n); assert.equal(off, enc.length);
  }
  assert.deepEqual(compactU16(128), Uint8Array.of(0x80, 0x01));
  const r = nodeCrypto.randomBytes(1000);
  assert.deepEqual(fromBase64(toBase64(r)), new Uint8Array(r));
  assert.equal(toBase64(Uint8Array.of(1, 2, 3)), Buffer.from([1, 2, 3]).toString('base64'));
  assert.equal(readU64(u64le(1234567890123n), 0), 1234567890123n);
  assert.throws(() => u64le(-1n));
  const neg = new Uint8Array(16); new DataView(neg.buffer).setBigInt64(8, -1n, true); new DataView(neg.buffer).setBigUint64(0, 0xffffffffffffffffn - 4n, true);
  assert.equal(readI128(neg, 0), -5n);
});

test('Ed25519 public keys and signatures match Node exactly', async () => {
  for (let i = 0; i < 25; i++) {
    const seed = new Uint8Array(nodeCrypto.randomBytes(32));
    const pub = await ed.getPublicKey(seed);
    assert.deepEqual(pub, nodePublicKey(seed), 'public key');
    const msg = new Uint8Array(nodeCrypto.randomBytes(i * 37));
    const ours = await ed.sign(msg, seed);
    const theirs = new Uint8Array(nodeCrypto.sign(null, msg, nodeKeyFromSeed(seed)));
    assert.deepEqual(ours, theirs, 'signature');
    assert.ok(nodeCrypto.verify(null, msg, nodeCrypto.createPublicKey(nodeKeyFromSeed(seed)), ours));
  }
});

test('RFC 8032 test vector 1', async () => {
  const seed = Uint8Array.from(Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'));
  const pub = await ed.getPublicKey(seed);
  assert.equal(Buffer.from(pub).toString('hex'), 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
  const sig = await ed.sign(new Uint8Array(0), seed);
  assert.equal(Buffer.from(sig).toString('hex'),
    'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
});

test('Keypair: generate, export, import in every wallet format, native signing', async () => {
  const kp = await Keypair.generate();
  assert.ok(isAddress(kp.address));
  const secret = kp.exportSecret();
  assert.equal(b58decode(secret).length, 64);
  const again = await Keypair.fromSecretText(secret);
  assert.equal(again.address, kp.address);
  const cli = JSON.stringify(Array.from(b58decode(secret)));
  assert.equal((await Keypair.fromSecretText(cli)).address, kp.address);
  assert.equal((await Keypair.fromSecretText(b58encode(kp.seed))).address, kp.address);
  assert.equal((await Keypair.fromSecretText('  ' + secret + '\n')).address, kp.address);
  // mismatched halves are rejected
  const bad = b58decode(secret); bad[40] ^= 1;
  await assert.rejects(() => Keypair.fromSecretText(b58encode(bad)), /check out/);
  await assert.rejects(() => Keypair.fromSecretText('abc'), /doesn't look like|isn't valid/);
  await assert.rejects(() => Keypair.fromSecretText(''), /Paste/);
  // signing (native path in Node) equals pure-JS signing and verifies
  const msg = new TextEncoder().encode('hello');
  const sig = await kp.sign(msg);
  assert.ok(kp._native, 'native Ed25519 used when it matches');
  assert.deepEqual(sig, await ed.sign(msg, kp.seed));
});

test('PDA derivation reproduces pump.fun published addresses', async () => {
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const FEES = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
  assert.equal(await pda(['global'], PUMP), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(await pda(['fee_config', toBytes(PUMP)], FEES), '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt');
  assert.equal(await pda(['fee_config', toBytes(AMM)], FEES), '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx');
  assert.equal(await pda(['global_config'], AMM), 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw');
  // bump seeds published in pump.fun's FAQ
  const [, bump1] = await findProgramAddress(['bonding-curve', toBytes('Coyj3LtKn1BNSgWc9HsGK5SKoGfEoDaymig4wrN6pump')], PUMP);
  assert.equal(bump1, 255);
  const [, bump2] = await findProgramAddress(['bonding-curve', toBytes('3cLSxG6eXcCD9NSMawkhUcrvVCUC8KHKHMCxx6bhpump')], PUMP);
  assert.equal(bump2, 251);
});

test('isOnCurve: real public keys are on the curve; PDAs are not', async () => {
  for (let i = 0; i < 20; i++) {
    const pub = await ed.getPublicKey(new Uint8Array(nodeCrypto.randomBytes(32)));
    assert.ok(ed.isOnCurve(pub));
  }
  const addr = await pda(['global'], '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
  assert.ok(!ed.isOnCurve(b58decode(addr)));
});

test('associated token address is deterministic and differs by token program', async () => {
  const owner = 'So11111111111111111111111111111111111111112';
  const mint = 'Coyj3LtKn1BNSgWc9HsGK5SKoGfEoDaymig4wrN6pump';
  const a = await associatedTokenAddress(owner, mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const b = await associatedTokenAddress(owner, mint, 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
  assert.ok(isAddress(a) && isAddress(b) && a !== b);
  assert.equal(a, await associatedTokenAddress(owner, mint, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
});

test('PumpSwap pool, pool authority, LP mint and ATAs match the example pool in pump.fun docs', async () => {
  const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
  const AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
  const WSOL = 'So11111111111111111111111111111111111111112';
  const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const base = '7LSsEoJGhLeZzGvDofTdNg7M3JttxQqGWNLo6vWMpump';
  const authority = await pda(['pool-authority', toBytes(base)], PUMP);
  assert.equal(authority, '9XDYTfQKwW8sHPqnFdUreMmtmffmkHVPGTNV2e3LKxNW');
  const [pool, bump] = await findProgramAddress(['pool', Uint8Array.of(0, 0), toBytes(authority), toBytes(base), toBytes(WSOL)], AMM);
  assert.equal(pool, 'GseMAnNDvntR5uFePZ51yZBXzNSn7GdFPkfHwfr6d77J');
  assert.equal(bump, 254);
  assert.equal(await pda(['pool_lp_mint', toBytes(pool)], AMM), '6dpnPD6UWDw5hbJEuPQwnCCMba1JYwHANKuL6GQ6otAH');
  assert.equal(await associatedTokenAddress(pool, base, TOKEN), '5jMpkf4JF4noHftLgNKyPNh6roVfPSGSjuEk3U4eLKRa');
  assert.equal(await associatedTokenAddress(pool, WSOL, TOKEN), '43DVcZR4kQFjh4Xm2i3DcneRxNjZp7HMud8yDrJWrDr8');
});
