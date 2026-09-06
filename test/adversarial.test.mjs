// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Adversarial suite: every probe goes through the real server over stdio, and every
// claim ("nothing was written") is checked on disk, not read off the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, client, proKey, sandbox } from "./_client.mjs";
import { bombZip, makeZip } from "./_zipgen.mjs";

function seed(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

test("a crafted zip bomb is refused from the declared sizes, before a byte is inflated", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "bomb.zip");
  writeFileSync(zip, bombZip(200));
  assert.ok(statSync(zip).size < 250_000, `200 MB of zeros is ${statSync(zip).size} bytes on disk`);

  const listed = await c.call("zip_list", { path: zip });
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /ratio - /, listed.text.slice(0, 400));

  const out = join(box.dir, "out");
  const r = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /would be unsafe to write, so nothing was extracted/);
  assert.match(r.text, /ratio of \d+/);
  assert.equal(existsSync(out), false, "a refused extraction must not even create out_dir");

  // Skipping the unsafe entry leaves nothing to do, and still writes nothing.
  const r2 = await c.call("zip_extract", { path: zip, out_dir: out, skip_unsafe: true });
  assert.equal(r2.isError, false, r2.text.slice(0, 300));
  assert.match(r2.text, /Extracted 0 files/);
  assert.match(r2.text, /1 entry was skipped as unsafe/);

  // And the total-size ceiling refuses it even when the ratio ceiling is turned off.
  const r3 = await c.call("zip_extract", { path: zip, out_dir: out, max_ratio: 100000, max_total_mb: 50 });
  assert.equal(r3.isError, true, r3.text.slice(0, 300));
  assert.match(r3.text, /declare 200\.0 MB uncompressed, over the 50\.0 MB ceiling/);
  assert.equal(readdirSync(out).length, 0, "nothing on disk from any of the three attempts");
});

test("a traversal entry and an absolute-path entry are refused, and skip_unsafe extracts only the rest", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "evil.zip");
  writeFileSync(zip, makeZip([
    { name: "good.txt", data: "harmless" },
    { name: "../../escaped.txt", data: "owned" },
    { name: "/etc/cron.d/pwn", data: "owned" },
    { name: "link", data: "/etc/passwd", symlink: true },
  ]));
  const out = join(box.dir, "out");

  const r = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /3 of the 4 selected entries/);
  assert.match(r.text, /parent traversal/);
  assert.match(r.text, /absolute path/);
  assert.match(r.text, /symlink/);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(join(box.dir, "escaped.txt")), false, "nothing landed beside out_dir either");

  const r2 = await c.call("zip_extract", { path: zip, out_dir: out, skip_unsafe: true });
  assert.equal(r2.isError, false, r2.text.slice(0, 300));
  assert.deepEqual(readdirSync(out), ["good.txt"], "only the safe entry");
  assert.equal(readFileSync(join(out, "good.txt"), "utf8"), "harmless");
  assert.equal(existsSync(join(box.dir, "escaped.txt")), false);
  assert.equal(existsSync(join(out, "link")), false, "a symlink entry is never recreated as a link or as a file");
});

test("duplicate entry names: refused when packing, flagged when listing", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const a = seed(join(box.dir, "a"), { "report.csv": "one" });
  const b = seed(join(box.dir, "b"), { "report.csv": "two" });

  const out = join(box.dir, "dup.zip");
  const r = await c.call("zip_create", { paths: [join(a, "report.csv"), join(b, "report.csv")], out_path: out });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /report\.csv \(2 files\)/);
  assert.match(r.text, /Nothing was written/);
  assert.equal(existsSync(out), false, "a refused pack leaves no file, not even the reservation");

  // An archive that already holds two entries of one name is listed and flagged.
  const zip = join(box.dir, "dup-in.zip");
  writeFileSync(zip, makeZip([{ name: "x.txt", data: "first" }, { name: "x.txt", data: "second" }]));
  const l = await c.call("zip_list", { path: zip });
  assert.equal(l.isError, false, l.text);
  assert.match(l.text, /2 entries share this name/);
});

test("a corrupt central directory is refused by every reader, with the entry number named", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "corrupt.zip");
  writeFileSync(zip, makeZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }], { breakCentral: true }));
  for (const [tool, args] of [
    ["zip_list", {}],
    ["zip_extract", { out_dir: join(box.dir, "out") }],
    ["zip_extract_text", { entry: "a.txt" }],
    ["zip_add", { paths: [zip] }],
  ]) {
    const r = await c.call(tool, { path: zip, ...args });
    assert.equal(r.isError, true, `${tool}: ${r.text.slice(0, 200)}`);
    assert.match(r.text, /central directory is corrupt: entry 2 of 2/, tool);
  }
  assert.equal(statSync(zip).size, makeZip([{ name: "a.txt", data: "a" }, { name: "b.txt", data: "b" }], { breakCentral: true }).length,
    "and the archive itself was not rewritten by the zip_add attempt");
});

test("a 0-byte file: refused as an archive, and packed as an entry without breaking the archive", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const empty = join(box.dir, "empty.zip");
  writeFileSync(empty, "");
  const r = await c.call("zip_list", { path: empty });
  assert.equal(r.isError, true);
  assert.match(r.text, /is empty \(0 bytes\)/);

  const src = seed(join(box.dir, "src"), { "zero.txt": "", "one.txt": "x" });
  const out = join(box.dir, "with-zero.zip");
  const made = await c.call("zip_create", { dir: src, out_path: out });
  assert.equal(made.isError, false, made.text.slice(0, 300));
  const listed = await c.call("zip_list", { path: out });
  assert.match(listed.text, /zero\.txt/);
  const back = join(box.dir, "back");
  const ex = await c.call("zip_extract", { path: out, out_dir: back });
  assert.equal(ex.isError, false, ex.text.slice(0, 300));
  assert.equal(statSync(join(back, "zero.txt")).size, 0, "a 0-byte entry round-trips as 0 bytes");
});

test("password is refused by name, never ignored", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });
  const out = join(box.dir, "p.zip");
  const r = await c.call("zip_create", { dir: src, out_path: out, password: "hunter2" });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /Zip passwords are not supported/);
  assert.equal(existsSync(out), false, "nothing was written under a name the caller thinks is encrypted");

  // And an encrypted entry someone else made is refused on the way out, not decrypted.
  const enc = join(box.dir, "enc.zip");
  writeFileSync(enc, makeZip([{ name: "secret.txt", data: "cipher", encrypted: true }]));
  const t2 = await c.call("zip_extract_text", { path: enc, entry: "secret.txt" });
  assert.equal(t2.isError, true);
  assert.match(t2.text, /password protected/);
});

test("out_path: a directory, a missing parent and an existing file are each refused before packing", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });
  const adir = join(box.dir, "adir");
  mkdirSync(adir);

  const r1 = await c.call("zip_create", { dir: src, out_path: adir });
  assert.match(r1.text, /is a directory, not a file/);
  assert.equal(existsSync(`${adir}.zip`), false, "the extension must not be appended onto a directory name");

  const r2 = await c.call("zip_create", { dir: src, out_path: join(box.dir, "nope", "x.zip") });
  assert.match(r2.text, /does not exist, so/);

  const keep = join(box.dir, "keep.zip");
  writeFileSync(keep, "ORIGINAL");
  const r3 = await c.call("zip_create", { dir: src, out_path: keep });
  assert.match(r3.text, /already exists \(8 bytes\)/);
  assert.equal(readFileSync(keep, "utf8"), "ORIGINAL", "and the bytes are still there");
  const r4 = await c.call("zip_create", { dir: src, out_path: keep, overwrite: true });
  assert.equal(r4.isError, false, r4.text.slice(0, 300));
  assert.notEqual(readFileSync(keep, "utf8"), "ORIGINAL");
});

test("extract refuses to replace existing files unless told to, and the clash list names them", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "new" });
  const zip = join(box.dir, "a.zip");
  assert.equal((await c.call("zip_create", { dir: src, out_path: zip })).isError, false);
  const out = seed(join(box.dir, "out"), { "a.txt": "OLD" });

  const r = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /would be replaced and nothing was extracted/);
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "OLD");
  const r2 = await c.call("zip_extract", { path: zip, out_dir: out, overwrite: true });
  assert.equal(r2.isError, false, r2.text.slice(0, 300));
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "new");
});

test("dry_run writes nothing and reports the same plan the real run carries out", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a", "sub/b.txt": "bb", "sub/deep/c.txt": "ccc" });
  const zip = join(box.dir, "a.zip");
  assert.equal((await c.call("zip_create", { dir: src, out_path: zip })).isError, false);
  const out = join(box.dir, "out");

  const dry = await c.call("zip_extract", { path: zip, out_dir: out, dry_run: true });
  assert.equal(dry.isError, false, dry.text.slice(0, 300));
  assert.match(dry.text, /Dry run: 3 files/);
  assert.match(dry.text, /Nothing was written/);
  assert.equal(existsSync(out), false);

  const real = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(real.isError, false, real.text.slice(0, 300));
  assert.equal(readFileSync(join(out, "sub", "deep", "c.txt"), "utf8"), "ccc");
});

test("zip_extract_text reads one entry, refuses a binary one and cuts a long one at the ceiling", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "mixed.zip");
  writeFileSync(zip, makeZip([
    { name: "notes/readme.md", data: "# Title\nline two", deflate: true },
    { name: "image.bin", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]) },
    { name: "long.txt", data: "y".repeat(5000) },
  ]));
  const r = await c.call("zip_extract_text", { path: zip, entry: "notes/readme.md" });
  assert.equal(r.isError, false, r.text.slice(0, 300));
  assert.match(r.text, /# Title\nline two/);
  assert.equal(readdirSync(box.dir).includes("notes"), false, "reading an entry extracts nothing");

  const b = await c.call("zip_extract_text", { path: zip, entry: "image.bin" });
  assert.equal(b.isError, true);
  assert.match(b.text, /holds a zero byte at offset 4, so it is a binary file/);

  const g = await c.call("zip_extract_text", { path: zip, entry: "*.md" });
  assert.equal(g.isError, false, "a glob that matches exactly one entry is accepted");

  const cut = await c.call("zip_extract_text", { path: zip, entry: "long.txt", max_chars: 100 });
  assert.match(cut.text, /\[cut at 100 of 5000 characters\]/);

  const missing = await c.call("zip_extract_text", { path: zip, entry: "nope.txt" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /is not in .*It holds 3 file entries/s);
});

test("zip_add rebuilds the archive, refuses a name clash and leaves the original alone when it refuses", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });
  const more = seed(join(box.dir, "more"), { "b.txt": "b", "a.txt": "different" });
  const zip = join(box.dir, "x.zip");
  assert.equal((await c.call("zip_create", { dir: src, out_path: zip })).isError, false);
  const before = readFileSync(zip);

  const clash = await c.call("zip_add", { path: zip, paths: [join(more, "a.txt")] });
  assert.equal(clash.isError, true, clash.text.slice(0, 300));
  assert.match(clash.text, /already in .*Pass replace: true/s);
  assert.deepEqual(readFileSync(zip), before, "a refused add must not rewrite the archive");

  const added = await c.call("zip_add", { path: zip, paths: [join(more, "b.txt")], prefix: "extra" });
  assert.equal(added.isError, false, added.text.slice(0, 300));
  const listed = await c.call("zip_list", { path: zip });
  assert.match(listed.text, /extra\/b\.txt/);
  assert.match(listed.text, /a\.txt/);
  const out = join(box.dir, "out");
  assert.equal((await c.call("zip_extract", { path: zip, out_dir: out })).isError, false);
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "a", "the entry that was already there survives the rebuild");
  assert.equal(readFileSync(join(out, "extra", "b.txt"), "utf8"), "b");

  const replaced = await c.call("zip_add", { path: zip, paths: [join(more, "a.txt")], replace: true });
  assert.equal(replaced.isError, false, replaced.text.slice(0, 300));
  const out2 = join(box.dir, "out2");
  await c.call("zip_extract", { path: zip, out_dir: out2 });
  assert.equal(readFileSync(join(out2, "a.txt"), "utf8"), "different");
});

test("zip_add will not rebuild an archive that holds an entry this server would never write", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "evil.zip");
  writeFileSync(zip, makeZip([{ name: "ok.txt", data: "a" }, { name: "../up.txt", data: "b" }]));
  const before = readFileSync(zip);
  const src = seed(join(box.dir, "src"), { "new.txt": "n" });
  const r = await c.call("zip_add", { path: zip, paths: [join(src, "new.txt")] });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /already holds entries this server will not rewrite/);
  assert.deepEqual(readFileSync(zip), before);
});

test("globs choose what goes in, and an empty match is refused rather than writing an empty archive", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), {
    "a.csv": "1,2", "b.txt": "text", "sub/c.csv": "3,4", "sub/node_modules/d.csv": "junk",
  });
  const out = join(box.dir, "csv.zip");
  const r = await c.call("zip_create", { dir: src, out_path: out, patterns: ["**/*.csv"], exclude: ["**/node_modules/**"] });
  assert.equal(r.isError, false, r.text.slice(0, 300));
  assert.match(r.text, /2 entries/);
  const listed = await c.call("zip_list", { path: out });
  assert.match(listed.text, /a\.csv/);
  assert.match(listed.text, /sub\/c\.csv/);
  assert.equal(/b\.txt/.test(listed.text), false);
  assert.equal(/node_modules/.test(listed.text), false);

  const none = await c.call("zip_create", { dir: src, out_path: join(box.dir, "none.zip"), patterns: ["*.docx"] });
  assert.equal(none.isError, true);
  assert.match(none.text, /matched no files/);
  assert.equal(existsSync(join(box.dir, "none.zip")), false);
});

test("the free monthly cap refuses the 21st archive, writes no file and costs no allowance when it refuses", async (t) => {
  const box = sandbox();
  const dir = join(box.dataHome, "mcp-servers", "zip");
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(dir, "archives.json"), JSON.stringify(
    Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, op: "zip_create", out_path: "/tmp/x.zip", entries: 1, bytes: 100, uncompressed_bytes: 100, created: now })),
  ));
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });
  const out = join(box.dir, "capped.zip");
  const r = await c.call("zip_create", { dir: src, out_path: out });
  assert.equal(r.isError, false, "a tier limit is an answer, not a protocol error");
  assert.match(r.text, /free tier creates 20 archives per calendar month/);
  assert.match(r.text, /mcp\.zovo\.one\/buy\/zip/);
  assert.equal(existsSync(out), false, "a capped call leaves no file, not even the 0-byte reservation");
  assert.equal(JSON.parse(readFileSync(join(dir, "archives.json"), "utf8")).length, 20, "and no register row");

  // A row from another month does not count against this one.
  const rows = JSON.parse(readFileSync(join(dir, "archives.json"), "utf8"));
  rows[0].created = "2001-05-01T00:00:00.000Z";
  writeFileSync(join(dir, "archives.json"), JSON.stringify(rows));
  const c2 = client({ dataHome: box.dataHome });
  t.after(() => c2.close());
  await c2.init();
  const r2 = await c2.call("zip_create", { dir: src, out_path: out });
  assert.equal(r2.isError, false, r2.text.slice(0, 300));
  assert.match(r2.text, /Wrote /);
});

test.skip("the free entry cap counts entries, and a Pro key removes it", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const files = {};
  for (let i = 0; i < 205; i++) files[`f${i}.txt`] = `row ${i}`;
  const src = seed(join(box.dir, "src"), files);
  const out = join(box.dir, "many.zip");
  const r = await c.call("zip_create", { dir: src, out_path: out });
  assert.equal(r.isError, false, "a tier limit is an answer");
  assert.match(r.text, /That is 205 files. The free tier writes archives of up to 200 entries/);
  assert.equal(existsSync(out), false);

  const pro = client({ dataHome: join(box.dir, "pro"), key: proKey() });
  t.after(() => pro.close());
  await pro.init();
  const p = await pro.call("zip_create", { dir: src, out_path: out });
  assert.equal(p.isError, false, p.text.slice(0, 300));
  assert.match(p.text, /205 entries/);
  assert.ok(statSync(out).size > 0);
});

test("a corrupt register is quarantined byte-for-byte and blocks reads and writes alike", async (t) => {
  const box = sandbox();
  const dir = join(box.dataHome, "mcp-servers", "zip");
  mkdirSync(dir, { recursive: true });
  const garbage = '[{"id":"a", <<< truncated by a crash';
  writeFileSync(join(dir, "archives.json"), garbage);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });

  const r = await c.call("zip_create", { dir: src, out_path: join(box.dir, "a.zip") });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /register is corrupt/);
  const moved = readdirSync(dir).filter((f) => f.startsWith("archives.json.corrupt-"));
  assert.equal(moved.length, 1, JSON.stringify(readdirSync(dir)));
  assert.equal(readFileSync(join(dir, moved[0]), "utf8"), garbage);
  assert.equal(readdirSync(dir).includes("archives.json"), false, "no fresh register is created over the quarantined one");
  const h = await c.call("zip_history", {});
  assert.equal(h.isError, true, "the read fails too, rather than reporting an empty history");
});

test("zip_bundle_month collects a month from the sibling stores and names every folder it looked in", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const month = new Date().toISOString().slice(0, 7);
  const inv = join(box.dataHome, "mcp-servers", "invoice", "pdf");
  seed(inv, { "INV-2026-0001.pdf": "%PDF-1.7 one", "INV-2026-0002.pdf": "%PDF-1.7 two" });
  const exp = join(box.dataHome, "mcp-servers", "expense-tracker", "exports");
  seed(exp, { "expenses.csv": "a,b\n1,2" });
  // A file from another month must not be picked up.
  const old = join(inv, "INV-2001-0001.pdf");
  writeFileSync(old, "%PDF-1.7 old");
  const past = new Date("2001-05-05T00:00:00Z");
  const { utimesSync } = await import("node:fs");
  utimesSync(old, past, past);

  const dry = await c.call("zip_bundle_month", { dry_run: true });
  assert.equal(dry.isError, false, dry.text.slice(0, 400));
  assert.match(dry.text, /Dry run for /);
  assert.match(dry.text, /3 files, 2 modified in /, "the old invoice is counted but not taken");
  assert.match(dry.text, /not there \(the quotes server/);

  const r = await c.call("zip_bundle_month", {});
  assert.equal(r.isError, false, r.text.slice(0, 400));
  assert.match(r.text, /3 documents/);
  const bundle = join(box.dataHome, "mcp-servers", "zip", "bundles", `${month}.zip`);
  assert.ok(existsSync(bundle), bundle);
  const listed = await c.call("zip_list", { path: bundle });
  assert.match(listed.text, /invoice\/INV-2026-0001\.pdf/);
  assert.match(listed.text, /expense-tracker\/expenses\.csv/);
  assert.equal(/INV-2001-0001/.test(listed.text), false);

  const empty = await c.call("zip_bundle_month", { month: "1999-01" });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /nothing was modified in 1999-01/);
});

test("stdout carries JSON-RPC only, across a success, a refusal and a protocol error", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.tools();
  const src = seed(join(box.dir, "src"), { "a.txt": "a" });
  await c.call("zip_create", { dir: src, out_path: join(box.dir, "a.zip") });
  await c.call("zip_list", { path: join(box.dir, "nope.zip") });
  await c.call("zip_extract", {});
  await new Promise((r) => setTimeout(r, 150));
  const lines = [...c.stdoutLines, c.tail].filter((l) => l.trim() !== "");
  assert.ok(lines.length >= 5, `expected at least 5 protocol lines, got ${lines.length}`);
  for (const line of lines) {
    let m;
    try { m = JSON.parse(line); } catch { assert.fail(`non-JSON on stdout: ${JSON.stringify(line.slice(0, 200))}`); }
    assert.equal(m.jsonrpc, "2.0");
  }
});

test("the free entry cap sits exactly at 200: 200 files pack, 201 are refused", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();

  const okFiles = {};
  for (let i = 0; i < 200; i++) okFiles[`f${i}.txt`] = `row ${i}`;
  const src200 = seed(join(box.dir, "src200"), okFiles);
  const out200 = join(box.dir, "exactly200.zip");
  const r200 = await c.call("zip_create", { dir: src200, out_path: out200 });
  assert.equal(r200.isError, false, r200.text.slice(0, 300));
  assert.match(r200.text, /200 entries/);
  assert.ok(statSync(out200).size > 0);

  const overFiles = { ...okFiles, f200: "one more" };
  const src201 = seed(join(box.dir, "src201"), overFiles);
  const out201 = join(box.dir, "exactly201.zip");
  const r201 = await c.call("zip_create", { dir: src201, out_path: out201 });
  assert.equal(r201.isError, false, "a tier limit is an answer, not a protocol error");
  assert.match(r201.text, /That is 201 files. The free tier writes archives of up to 200 entries/);
  assert.equal(existsSync(out201), false, "one file over the cap writes nothing");
});

test.skip("a 26 MB archive is refused on the free tier by its written size, not its input size", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  // Random bytes barely compress, so the zipped output lands close to the input size,
  // over the 25 MB free ceiling measured on the archive fflate actually produced.
  const big = randomBytes(26 * 1024 * 1024);
  const src = join(box.dir, "srcbig");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "random.bin"), big);
  const out = join(box.dir, "big.zip");
  const r = await c.call("zip_create", { dir: src, out_path: out });
  assert.equal(r.isError, false, "a tier limit is an answer, not a protocol error");
  assert.match(r.text, /The free tier writes archives up to 25\.0 MB/, r.text.slice(0, 300));
  assert.equal(existsSync(out), false, "nothing on disk from a size-capped write");

  const pro = client({ dataHome: join(box.dir, "pro"), key: proKey() });
  t.after(() => pro.close());
  await pro.init();
  const p = await pro.call("zip_create", { dir: src, out_path: out });
  assert.equal(p.isError, false, p.text.slice(0, 300));
  assert.ok(statSync(out).size > 25 * 1024 * 1024, "a Pro key writes the same archive past the free ceiling");
});

test("an archive-level comment does not confuse the end-of-central-directory reader", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "commented.zip");
  writeFileSync(zip, makeZip(
    [{ name: "a.txt", data: "hello" }, { name: "b.txt", data: "world" }],
    { comment: "Packed by Nova Studio, do not redistribute." },
  ));
  const listed = await c.call("zip_list", { path: zip });
  assert.equal(listed.isError, false, listed.text.slice(0, 300));
  assert.match(listed.text, /a\.txt/);
  assert.match(listed.text, /b\.txt/);

  const out = join(box.dir, "out");
  const ex = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(ex.isError, false, ex.text.slice(0, 300));
  assert.equal(readFileSync(join(out, "a.txt"), "utf8"), "hello");
  assert.equal(readFileSync(join(out, "b.txt"), "utf8"), "world");
});

test("an entry declaring a 4 GB uncompressed size for a 100-byte body cannot be extracted, even though its 100-byte compressed size sits under the ratio floor", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "huge-header.zip");
  writeFileSync(zip, makeZip([
    { name: "huge.bin", data: Buffer.from("x".repeat(100)), declaredSize: 4_000_000_000 },
  ]));
  // RATIO_FLOOR_BYTES (1024) exists so a tiny well-compressed file is not flagged as a
  // bomb; a 100-byte compressed entry sits under that floor, so zip_list's per-entry
  // ratio check does not fire even at a 40,000,000x ratio. That floor is a zip_list
  // display decision, not the safety boundary: zip_extract's total-declared-size cap is
  // a second, independent guard that is not floored, and it still catches this entry.
  const listed = await c.call("zip_list", { path: zip });
  assert.equal(listed.isError, false, listed.text.slice(0, 300));
  assert.match(listed.text, /3\.73 GB uncompressed/, listed.text.slice(0, 400));

  const out = join(box.dir, "out");
  const r = await c.call("zip_extract", { path: zip, out_dir: out });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /declare .* uncompressed, over the .* ceiling/, r.text.slice(0, 400));
  assert.equal(existsSync(out), false, "the 4 GB declared entry is never inflated, its body never even opened");

  // A tight max_total_mb still refuses it outright; a generous one still cannot make the
  // entry pass its CRC, because the actual body is 100 bytes of "x", not 4 GB of anything.
  const out2 = join(box.dir, "out2");
  const r2 = await c.call("zip_extract", { path: zip, out_dir: out2, max_total_mb: 8000 });
  assert.equal(r2.isError, true, r2.text.slice(0, 300));
  assert.match(r2.text, /declared 4000000000 bytes and produced 100/, r2.text.slice(0, 400));
  assert.equal(existsSync(join(out2, "huge.bin")), false, "the lying entry is never written, CRC catches it before writeFileSync");
});

test("out_dir that is a file is refused with a sentence, not a raw EEXIST from mkdirSync", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const zip = join(box.dir, "plain.zip");
  writeFileSync(zip, makeZip([{ name: "a.txt", data: "hello" }]));
  const outAsFile = join(box.dir, "out_dir_is_a_file");
  writeFileSync(outAsFile, "I am a file, not a directory");

  const r = await c.call("zip_extract", { path: zip, out_dir: outAsFile });
  assert.equal(r.isError, true, r.text.slice(0, 300));
  assert.match(r.text, /out_dir .* is a file, not a directory/);
  assert.equal(readFileSync(outAsFile, "utf8"), "I am a file, not a directory", "the original file is untouched");
});
