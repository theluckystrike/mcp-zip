// Smoke suite: spawn dist/index.js and run initialize, tools/list and one tools/call
// over stdio JSON-RPC, the way a client does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, client, sandbox } from "./_client.mjs";

test("initialize, tools/list and one round trip through the real binary", async (t) => {
  const box = sandbox();
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });

  const info = await c.init();
  assert.equal(info.serverInfo.name, "mcp-zip");
  assert.match(info.serverInfo.version, /^\d+\.\d+\.\d+$/);

  const tools = (await c.tools()).map((x) => x.name).sort();
  assert.deepEqual(tools, [
    "license_activate", "license_status", "zip_add", "zip_bundle_month", "zip_create",
    "zip_extract", "zip_extract_text", "zip_history", "zip_list",
  ]);

  const src = join(box.dir, "src");
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "hello.txt"), "hello from a zip\n");
  const out = join(box.dir, "hello.zip");
  const made = await c.call("zip_create", { dir: src, out_path: out });
  assert.equal(made.isError, false, made.text);
  assert.ok(existsSync(out));

  const listed = await c.call("zip_list", { path: out });
  assert.equal(listed.isError, false, listed.text);
  assert.match(listed.text, /hello\.txt/);
  assert.match(listed.text, /Nothing suspicious/);

  const read = await c.call("zip_extract_text", { path: out, entry: "hello.txt" });
  assert.match(read.text, /hello from a zip/);

  const history = await c.call("zip_history", {});
  assert.match(history.text, /1 of 20 free archives used/);
});
