import { inflateSync } from "fflate";

/**
 * A zip reader that reads the central directory and nothing else until it is asked to.
 *
 * Every guard in this server is decided from the central directory (declared sizes,
 * names, external attributes), before one byte is inflated. That ordering is the whole
 * point: a bomb that is refused after decompression is not refused at all.
 */

export const SIG_EOCD = 0x06054b50;
export const SIG_CENTRAL = 0x02014b50;
export const SIG_LOCAL = 0x04034b50;

/** A per-entry ratio above this is a compression bomb, not a well packed file. */
export const DEFAULT_MAX_RATIO = 100;
/** Nothing is inflated past this in one call unless the caller raises it. */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
/** A ratio computed from a handful of bytes says nothing; below this the ratio is not judged. */
export const RATIO_FLOOR_BYTES = 1024;

export class ZipFormatError extends Error {}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 (IEEE), the checksum a zip central directory carries for each entry. */
export function crc32(buf: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export interface ZipEntry {
  name: string;
  /** Directory entries carry no data and are recreated, never written as files. */
  is_dir: boolean;
  is_symlink: boolean;
  encrypted: boolean;
  method: number;
  size: number;
  compressed_size: number;
  /** uncompressed / compressed, rounded to one decimal. */
  ratio: number;
  crc: number;
  modified: string;
  local_offset: number;
  unix_mode: number | null;
}

function u16(b: Uint8Array, o: number): number { return b[o] | (b[o + 1] << 8); }
function u32(b: Uint8Array, o: number): number { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/** DOS date/time to ISO. An unset stamp (0) becomes an empty string rather than 1980. */
function dosTime(time: number, date: number): string {
  if (date === 0) return "";
  const y = 1980 + ((date >> 9) & 0x7f);
  const mo = (date >> 5) & 0x0f;
  const d = date & 0x1f;
  const h = (time >> 11) & 0x1f;
  const mi = (time >> 5) & 0x3f;
  const s = (time & 0x1f) * 2;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${y}-${p(mo)}-${p(d)} ${p(h)}:${p(mi)}:${p(s)}`;
}

function decodeName(raw: Uint8Array, utf8: boolean): string {
  // Bit 11 of the flags is the "this name is UTF-8" promise. Without it the name is
  // CP437 by the specification; decoding it as UTF-8 anyway is what every modern tool
  // does and is right far more often, so latin1 is the fallback only when the UTF-8
  // decode produced a replacement character.
  const asUtf8 = Buffer.from(raw).toString("utf8");
  if (utf8 || !asUtf8.includes("�")) return asUtf8;
  return Buffer.from(raw).toString("latin1");
}

/** Locate the end-of-central-directory record, searching the last 64 KB plus its own size. */
function findEocd(buf: Uint8Array): number {
  const min = Math.max(0, buf.length - (0xffff + 22));
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD) return i;
  }
  throw new ZipFormatError(
    "no end-of-central-directory record was found in the last 64 KB, so this file is not a zip archive " +
    "(or it is truncated: a partial download loses the central directory, which lives at the end). Nothing was read.",
  );
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Bytes of the file itself. */
  archive_bytes: number;
  comment: string;
}

/** Parse the central directory. No entry data is touched. */
export function readDirectory(buf: Uint8Array): ZipDirectory {
  if (buf.length < 22) {
    throw new ZipFormatError(`the file is ${buf.length} bytes, shorter than the 22-byte end-of-central-directory record every zip archive ends with. It is not a zip file. Nothing was read.`);
  }
  const eocd = findEocd(buf);
  const count = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  const commentLen = u16(buf, eocd + 20);
  const comment = commentLen ? Buffer.from(buf.subarray(eocd + 22, eocd + 22 + commentLen)).toString("utf8") : "";

  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new ZipFormatError(
      "this archive is ZIP64 (over 65,535 entries or over 4 GB), which this server does not read. " +
      "Nothing was read. Unpack it with the system unzip instead.",
    );
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipFormatError(
      `the central directory is declared at offset ${cdOffset} with ${cdSize} bytes, which runs past the end of ` +
      `a ${buf.length}-byte file. The archive is truncated or corrupt. Nothing was read.`,
    );
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== SIG_CENTRAL) {
      throw new ZipFormatError(
        `the central directory is corrupt: entry ${i + 1} of ${count} does not start with the central-directory ` +
        `signature at offset ${p}. ${entries.length} entr${entries.length === 1 ? "y was" : "ies were"} read before it. Nothing was extracted.`,
      );
    }
    const madeBy = u16(buf, p + 4);
    const flags = u16(buf, p + 8);
    const method = u16(buf, p + 10);
    const time = u16(buf, p + 12);
    const date = u16(buf, p + 14);
    const crc = u32(buf, p + 16);
    const compressed = u32(buf, p + 20);
    const size = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commLen = u16(buf, p + 32);
    const external = u32(buf, p + 38);
    const localOffset = u32(buf, p + 42);
    if (p + 46 + nameLen > buf.length) {
      throw new ZipFormatError(`the central directory is corrupt: entry ${i + 1} declares a ${nameLen}-byte name that runs past the end of the file. Nothing was extracted.`);
    }
    const name = decodeName(buf.subarray(p + 46, p + 46 + nameLen), (flags & 0x800) !== 0);
    const hostUnix = (madeBy >> 8) === 3;
    const mode = hostUnix ? (external >>> 16) & 0xffff : null;
    const isDir = name.endsWith("/") || (mode !== null && (mode & 0xf000) === 0x4000);
    entries.push({
      name,
      is_dir: isDir,
      is_symlink: mode !== null && (mode & 0xf000) === 0xa000,
      encrypted: (flags & 0x1) !== 0,
      method,
      size,
      compressed_size: compressed,
      ratio: compressed > 0 ? Math.round((size / compressed) * 10) / 10 : (size > 0 ? size : 0),
      crc,
      modified: dosTime(time, date),
      local_offset: localOffset,
      unix_mode: mode,
    });
    p += 46 + nameLen + extraLen + commLen;
  }
  return { entries, archive_bytes: buf.length, comment };
}

export type Reason =
  | "absolute path" | "parent traversal" | "backslash separator" | "symlink"
  | "encrypted" | "unsupported method" | "ratio" | "empty name" | "control character";

export interface Finding { name: string; reason: Reason; detail: string }

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Everything wrong with one entry's name and headers, decided without reading data. */
export function inspectEntry(e: ZipEntry, maxRatio = DEFAULT_MAX_RATIO): Finding[] {
  const out: Finding[] = [];
  const n = e.name;
  if (n.trim() === "") out.push({ name: n, reason: "empty name", detail: "the entry has no name" });
  if (CONTROL.test(n)) out.push({ name: n, reason: "control character", detail: "the name carries a control character, which no real file name has" });
  if (n.startsWith("/") || n.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(n)) {
    out.push({ name: n, reason: "absolute path", detail: `the entry names an absolute path, so a careless extractor writes to ${n} rather than under out_dir` });
  }
  if (n.split(/[\\/]/).some((s) => s === "..")) {
    out.push({ name: n, reason: "parent traversal", detail: `the entry name walks up out of the archive root (${n}), which is how an archive overwrites a file outside the directory you unpacked it into` });
  }
  if (n.includes("\\")) {
    out.push({ name: n, reason: "backslash separator", detail: "the name uses a backslash, a directory separator on Windows and an ordinary character on POSIX, so the same archive unpacks to two different shapes" });
  }
  if (e.is_symlink) out.push({ name: n, reason: "symlink", detail: "the entry is a symlink; its content is a path, and following it on extraction writes wherever it points" });
  if (e.encrypted) out.push({ name: n, reason: "encrypted", detail: "the entry is password protected; this server neither sets nor reads zip passwords" });
  if (!e.is_dir && e.method !== 0 && e.method !== 8) {
    out.push({ name: n, reason: "unsupported method", detail: `compression method ${e.method} is not store (0) or deflate (8) and cannot be read here` });
  }
  if (!e.is_dir && e.compressed_size >= RATIO_FLOOR_BYTES && e.ratio > maxRatio) {
    out.push({ name: n, reason: "ratio", detail: `${e.compressed_size} compressed bytes declare ${e.size} uncompressed, a ratio of ${e.ratio}x against a ceiling of ${maxRatio}x` });
  }
  return out;
}

/**
 * Read one entry's bytes.
 *
 * The output buffer is sized from the central directory's declared size and the CRC is
 * verified afterwards. Both are needed: fflate's `inflateSync` with a fixed `out` buffer
 * TRUNCATES silently when the stream holds more than the buffer takes (measured: a
 * 100,000-byte entry inflated into a 10-byte buffer returns 10 bytes and throws nothing),
 * so the buffer bounds the memory but only the checksum proves the bytes are the file.
 */
export function readEntry(buf: Uint8Array, e: ZipEntry): Uint8Array {
  if (e.encrypted) throw new ZipFormatError(`"${e.name}" is password protected. This server does not read zip passwords, so it was not extracted.`);
  const off = e.local_offset;
  if (off + 30 > buf.length || u32(buf, off) !== SIG_LOCAL) {
    throw new ZipFormatError(`"${e.name}" points at offset ${off}, where there is no local file header. The archive is corrupt and nothing was extracted from it.`);
  }
  const nameLen = u16(buf, off + 26);
  const extraLen = u16(buf, off + 28);
  const start = off + 30 + nameLen + extraLen;
  const end = start + e.compressed_size;
  if (end > buf.length) {
    throw new ZipFormatError(`"${e.name}" declares ${e.compressed_size} compressed bytes at offset ${start}, which runs past the end of the file. The archive is truncated.`);
  }
  const raw = buf.subarray(start, end);
  let out: Uint8Array;
  if (e.method === 0) {
    out = raw.slice();
  } else if (e.method === 8) {
    out = inflateSync(raw, { out: new Uint8Array(e.size) });
  } else {
    throw new ZipFormatError(`"${e.name}" uses compression method ${e.method}, which is not store or deflate. It was not extracted.`);
  }
  if (out.length !== e.size) {
    throw new ZipFormatError(`"${e.name}" declared ${e.size} bytes and produced ${out.length}. The archive header disagrees with its own data; nothing from it is trustworthy and it was not written.`);
  }
  const got = crc32(out);
  if (got !== e.crc) {
    throw new ZipFormatError(`"${e.name}" fails its CRC check (header ${e.crc.toString(16)}, data ${got.toString(16)}). The entry is damaged, or the size in its header is a lie and the data was cut to fit it. It was not written.`);
  }
  return out;
}

/**
 * A minimal glob over a path relative to the root: `*` and `?` stay inside one segment,
 * `**` crosses segments. A pattern with no slash also matches the file name at any depth,
 * the way people expect `*.csv` to behave.
 */
export function globToRegExp(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` swallows the slash so that `**/x` also matches a bare `x`.
        if (pattern[i + 2] === "/") { src += "(?:.*/)?"; i += 2; } else { src += ".*"; i += 1; }
      } else src += "[^/]*";
    } else if (c === "?") src += "[^/]";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`);
}

export function matchesAny(rel: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const base = rel.split("/").pop() ?? rel;
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return re.test(rel) || (!p.includes("/") && re.test(base));
  });
}
