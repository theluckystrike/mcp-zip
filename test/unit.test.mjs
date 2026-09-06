// Unit suite: the pure functions, called directly from dist/lib.js. No server, no stdio.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { crc32, globToRegExp, inspectEntry, matchesAny, readDirectory, readEntry } from "../dist/lib.js";
import { makeZip, bombZip, crc32 as refCrc } from "./_zipgen.mjs";

test("crc32 matches the reference implementation the tests build archives with", () => {
  // The check value from the CRC-32 specification: "123456789" is 0xCBF43926.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  for (const s of ["", "a", "hello world", "\u0000\u0000\u0000", "a".repeat(5000)]) {
    assert.equal(crc32(Buffer.from(s)), refCrc(Buffer.from(s)), JSON.stringify(s.slice(0, 20)));
  }
});

test("glob: * and ? stay inside a segment, ** crosses them, a bare pattern matches the file name", () => {
  assert.equal(globToRegExp("*.csv").test("a.csv"), true);
  assert.equal(globToRegExp("*.csv").test("sub/a.csv"), false, "* must not cross a slash");
  assert.equal(globToRegExp("**/*.csv").test("sub/deep/a.csv"), true);
  assert.equal(globToRegExp("**/*.csv").test("a.csv"), true, "**/ must also match nothing");
  assert.equal(globToRegExp("a?.txt").test("ab.txt"), true);
  assert.equal(globToRegExp("a?.txt").test("abc.txt"), false);
  // A dot is a literal, not "any character": *.csv must not match a file called axcsv.
  assert.equal(globToRegExp("*.csv").test("axcsv"), false);

  assert.equal(matchesAny("sub/deep/a.csv", ["*.csv"]), true, "a pattern with no slash matches the base name at any depth");
  assert.equal(matchesAny("sub/deep/a.csv", ["sub/*.csv"]), false);
  assert.equal(matchesAny("anything", []), true, "no patterns means everything");
});

test("readDirectory reads names, sizes, ratios and dates without touching the data", () => {
  const zip = makeZip([
    { name: "notes.txt", data: "hello" },
    { name: "big.txt", data: "x".repeat(10000), deflate: true },
    { name: "sub/", data: "", dirMode: true },
  ]);
  const dir = readDirectory(new Uint8Array(zip));
  assert.equal(dir.entries.length, 3);
  const byName = Object.fromEntries(dir.entries.map((e) => [e.name, e]));
  assert.equal(byName["notes.txt"].size, 5);
  assert.equal(byName["notes.txt"].method, 0);
  assert.equal(byName["big.txt"].size, 10000);
  assert.ok(byName["big.txt"].compressed_size < 200, `deflated 10 KB of one letter is small, got ${byName["big.txt"].compressed_size}`);
  assert.ok(byName["big.txt"].ratio > 50);
  assert.equal(byName["sub/"].is_dir, true);
  assert.equal(dir.archive_bytes, zip.length);
});

test("inspectEntry names every dangerous shape, and a plain entry produces nothing", () => {
  const zip = makeZip([
    { name: "ok.txt", data: "fine" },
    { name: "/etc/passwd", data: "x" },
    { name: "../../up.txt", data: "x" },
    { name: "C:\\Windows\\evil.dll", data: "x" },
    { name: "link", data: "/etc/passwd", symlink: true },
    { name: "secret.txt", data: "x", encrypted: true },
  ]);
  const found = Object.fromEntries(readDirectory(new Uint8Array(zip)).entries.map((e) => [e.name, inspectEntry(e).map((f) => f.reason).sort()]));
  assert.deepEqual(found["ok.txt"], []);
  assert.deepEqual(found["/etc/passwd"], ["absolute path"]);
  assert.deepEqual(found["../../up.txt"], ["parent traversal"]);
  assert.deepEqual(found["C:\\Windows\\evil.dll"], ["absolute path", "backslash separator"]);
  assert.deepEqual(found["link"], ["symlink"]);
  assert.deepEqual(found["secret.txt"], ["encrypted"]);
});

test("a ratio is only judged above the floor, so a tiny well-compressed file is not a bomb", () => {
  const tiny = readDirectory(new Uint8Array(makeZip([{ name: "t.txt", data: "a".repeat(3000), deflate: true }]))).entries[0];
  assert.ok(tiny.ratio > 100, `the ratio itself is high: ${tiny.ratio}`);
  assert.ok(tiny.compressed_size < 1024, "and the compressed size is under the floor");
  assert.deepEqual(inspectEntry(tiny).map((f) => f.reason), [], "under the floor a ratio says nothing about intent");

  const bomb = readDirectory(new Uint8Array(bombZip(40))).entries[0];
  assert.ok(bomb.compressed_size >= 1024, `40 MB of zeros deflates to ${bomb.compressed_size} bytes`);
  assert.deepEqual(inspectEntry(bomb).map((f) => f.reason), ["ratio"]);
  assert.equal(bomb.size, 40 * 1024 * 1024);
});

test("readEntry returns the bytes and verifies the checksum", () => {
  const zip = new Uint8Array(makeZip([{ name: "a.txt", data: "the quick brown fox", deflate: true }]));
  const dir = readDirectory(zip);
  assert.equal(Buffer.from(readEntry(zip, dir.entries[0])).toString("utf8"), "the quick brown fox");
});

test("a header that lies about its size is caught: the bounded inflate truncates silently, the CRC does not", () => {
  // This is the reason both checks exist. fflate's inflateSync with a fixed `out` buffer
  // returns a short buffer and throws nothing, so sizing the buffer from the declared
  // size bounds the memory but proves nothing about the bytes.
  const real = Buffer.from("A".repeat(100000));
  const zip = new Uint8Array(makeZip([{ name: "lie.txt", data: real, deflate: true, declaredSize: 10 }]));
  const dir = readDirectory(zip);
  assert.equal(dir.entries[0].size, 10, "the central directory declares 10 bytes");
  assert.throws(() => readEntry(zip, dir.entries[0]), /fails its CRC check/);

  // And a truthful size with a wrong checksum is refused too.
  const zip2 = new Uint8Array(makeZip([{ name: "b.txt", data: "hello", declaredCrc: 1 }]));
  assert.throws(() => readEntry(zip2, readDirectory(zip2).entries[0]), /fails its CRC check/);
});

test("a corrupt central directory is refused with the entry number, not read half way", () => {
  const zip = new Uint8Array(makeZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }], { breakCentral: true }));
  assert.throws(() => readDirectory(zip), /central directory is corrupt: entry 2 of 2/);
});

test("a file that is not a zip at all is refused by name, not parsed", () => {
  assert.throws(() => readDirectory(new Uint8Array(Buffer.from("%PDF-1.7\nnot a zip file, but long enough to reach the end-of-central-directory search"))), /not a zip archive/);
  assert.throws(() => readDirectory(new Uint8Array(0)), /shorter than the 22-byte/);
});

test("an entry with no compression and one with maximum deflate both round-trip", () => {
  const payload = Buffer.from(JSON.stringify({ rows: Array.from({ length: 500 }, (_, i) => ({ i, s: "value" })) }));
  for (const deflate of [false, true]) {
    const zip = new Uint8Array(makeZip([{ name: "d.json", data: payload, deflate }]));
    const dir = readDirectory(zip);
    assert.equal(dir.entries[0].method, deflate ? 8 : 0);
    assert.deepEqual(Buffer.from(readEntry(zip, dir.entries[0])), payload);
  }
  // And the raw deflate stream the test writer produces is the same shape fflate reads.
  assert.ok(deflateRawSync(payload).length < payload.length);
});
