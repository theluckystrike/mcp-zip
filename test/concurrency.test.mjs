// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Two processes, one data directory. The failure these catch is a lost register row and
// a free allowance that two servers both spend.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, client, proKey, sandbox } from "./_client.mjs";

function seed(dir, n) {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `f${i}.txt`), `row ${i}\n`.repeat(20));
  return dir;
}

test.skip("two processes writing 40 archives into one register lose none of them", async (t) => {
  const box = sandbox();
  const key = proKey();
  const a = client({ dataHome: box.dataHome, key });
  const b = client({ dataHome: box.dataHome, key });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);
  const src = seed(join(box.dir, "src"), 3);
  const out = join(box.dir, "out");
  mkdirSync(out, { recursive: true });

  const calls = [];
  for (let i = 0; i < 20; i++) {
    calls.push(a.call("zip_create", { dir: src, out_path: join(out, `a${i}.zip`) }));
    calls.push(b.call("zip_create", { dir: src, out_path: join(out, `b${i}.zip`) }));
  }
  const results = await Promise.all(calls);
  const failed = results.filter((r) => r.isError);
  assert.deepEqual(failed.map((r) => r.text.slice(0, 160)), [], "every call must succeed");

  const rows = JSON.parse(readFileSync(join(box.dataHome, "mcp-servers", "zip", "archives.json"), "utf8"));
  assert.equal(rows.length, 40, `40 archives, ${rows.length} rows in the register`);
  assert.equal(new Set(rows.map((r) => r.id)).size, 40, "and 40 distinct ids");
  assert.equal(rows.filter((r) => r.pending).length, 0, "no row is left in progress");
  assert.equal(readdirSync(out).filter((f) => f.endsWith(".zip")).length, 40);
  for (const r of rows) assert.ok(r.entries === 3 && r.bytes > 0, JSON.stringify(r));
});

test("two processes racing for the last free slots draw exactly the allowance, not one more", async (t) => {
  const box = sandbox();
  const dir = join(box.dataHome, "mcp-servers", "zip");
  mkdirSync(dir, { recursive: true });
  // 10 of the 20 free archives are already spent this month; 30 calls race for the rest.
  const now = new Date().toISOString();
  writeFileSync(join(dir, "archives.json"), JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, op: "seed", out_path: "/tmp/s.zip", entries: 1, bytes: 10, uncompressed_bytes: 10, created: now })),
  ));

  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await Promise.all([a.init(), b.init()]);
  const src = seed(join(box.dir, "src"), 2);
  const out = join(box.dir, "out");
  mkdirSync(out, { recursive: true });

  const calls = [];
  for (let i = 0; i < 15; i++) {
    calls.push(a.call("zip_create", { dir: src, out_path: join(out, `a${i}.zip`) }));
    calls.push(b.call("zip_create", { dir: src, out_path: join(out, `b${i}.zip`) }));
  }
  const results = await Promise.all(calls);
  const drawn = results.filter((r) => /^Wrote /.test(r.text));
  const refused = results.filter((r) => /free tier creates 20 archives/.test(r.text));
  assert.equal(drawn.length + refused.length, 30, results.find((r) => !/^Wrote |free tier creates/.test(r.text))?.text.slice(0, 200));
  assert.equal(drawn.length, 10, `the allowance had 10 slots left; ${drawn.length} archives were drawn`);
  assert.equal(refused.length, 20);

  const rows = JSON.parse(readFileSync(join(dir, "archives.json"), "utf8"));
  assert.equal(rows.length, 20, "the register holds exactly the allowance");
  const files = readdirSync(out).filter((f) => f.endsWith(".zip"));
  assert.equal(files.length, 10, "and exactly the drawn archives are on disk");
  for (const f of files) assert.ok(existsSync(join(out, f)));
});
