// A raw zip writer for the adversarial suite. fflate cannot produce the archives this
// server has to refuse (an absolute name, "..", a symlink entry, two entries with one
// name, a header whose declared size is a lie), so the tests build the bytes themselves.
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * entries: [{ name, data (Buffer|string), deflate?, symlink?, dirMode?, madeByUnix?,
 *             declaredSize?, declaredCrc?, method?, encrypted? }]
 * opts: { breakCentral?: true, comment?: string }
 */
export function makeZip(entries, opts = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? "", "utf8");
    const deflate = e.deflate ?? false;
    const body = deflate ? deflateRawSync(raw, { level: 9 }) : raw;
    const method = e.method ?? (deflate ? 8 : 0);
    const usize = e.declaredSize ?? raw.length;
    const crc = e.declaredCrc ?? crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.encrypted ? 0x0801 : 0x0800, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0x6000, 10); // 12:00:00
    lh.writeUInt16LE(0x590e, 12); // 2024-08-14, a real DOS date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(e.madeByUnix === false ? 20 : (3 << 8) | 20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.encrypted ? 0x0801 : 0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0x6000, 12);
    ch.writeUInt16LE(0x590e, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    const mode = e.symlink ? 0xa1ff : e.dirMode ? 0x41ed : 0x81a4;
    ch.writeUInt32LE((mode << 16) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const localBuf = Buffer.concat(locals);
  let centralBuf = Buffer.concat(centrals);
  if (opts.breakCentral) {
    // Wipe the signature of the LAST central-directory record: the count in the EOCD
    // still says every entry is there, which is what a truncated or patched archive
    // looks like from the outside.
    const idx = centralBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    centralBuf.writeUInt32LE(0xdeadbeef, idx);
  }
  const comment = Buffer.from(opts.comment ?? "", "utf8");
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([localBuf, centralBuf, eocd, comment]);
}

/** A classic compression bomb: one entry of `mb` megabytes of zeros, deflated. */
export function bombZip(mb = 40, name = "bomb.bin") {
  return makeZip([{ name, data: Buffer.alloc(mb * 1024 * 1024, 0), deflate: true }]);
}
