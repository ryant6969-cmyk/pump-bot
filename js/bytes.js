// Byte helpers shared by the Solana code. Plain ES module, no dependencies.

export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equalBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function u8(n) { return Uint8Array.of(n & 0xff); }

export function u16le(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

export function u32le(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

export function u64le(v) {
  const x = BigInt(v);
  if (x < 0n || x > 0xffffffffffffffffn) throw new RangeError('u64 out of range: ' + x);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, x, true);
  return b;
}

function view(bytes) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

export function readU8(bytes, off) { return bytes[off]; }
export function readU16(bytes, off) { return view(bytes).getUint16(off, true); }
export function readU32(bytes, off) { return view(bytes).getUint32(off, true); }
export function readU64(bytes, off) { return view(bytes).getBigUint64(off, true); }
export function readI64(bytes, off) { return view(bytes).getBigInt64(off, true); }
export function readI128(bytes, off) {
  const lo = view(bytes).getBigUint64(off, true);
  const hi = view(bytes).getBigInt64(off + 8, true);
  return (hi << 64n) + lo;
}

// Solana "compact-u16" (shortvec) length prefix.
export function compactU16(n) {
  if (n < 0 || n > 0xffff) throw new RangeError('compact-u16 out of range');
  const out = [];
  let rem = n;
  for (;;) {
    let elem = rem & 0x7f;
    rem >>= 7;
    if (rem === 0) { out.push(elem); break; }
    elem |= 0x80;
    out.push(elem);
  }
  return Uint8Array.from(out);
}

export function readCompactU16(bytes, off) {
  let value = 0, size = 0;
  for (;;) {
    if (off + size >= bytes.length) throw new Error('Truncated compact-u16');
    const elem = bytes[off + size];
    value |= (elem & 0x7f) << (size * 7);
    size++;
    if ((elem & 0x80) === 0) break;
    if (size >= 3) throw new Error('Bad compact-u16');
  }
  return [value, off + size];
}

export function toBase64(bytes) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return btoa(s);
}

export function fromBase64(str) {
  const s = atob(str);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function toHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = hex.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}
