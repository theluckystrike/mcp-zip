// D-R83: a URL handed to `path` must be refused by name, not resolved as a relative
// filesystem path (which used to leak the server's own cwd in the error text).
import test from "node:test";
import assert from "node:assert/strict";
import { client, cleanup, sandbox } from "./_client.mjs";

test("zip_list refuses a URL instead of resolving it against cwd", async () => {
  const s = sandbox();
  const c = client({ dataHome: s.dataHome });
  try {
    await c.init();
    const r = await c.call("zip_list", { path: "http://127.0.0.1:8794/archive.zip" });
    assert.equal(r.isError, true);
    assert.match(r.text, /is a URL, not a file path/);
    assert.match(r.text, /zip_upload/);
    assert.doesNotMatch(r.text, /no such file|does not exist/);
    // never leaks the server's cwd
    assert.equal(r.text.includes(process.cwd()), false);
  } finally { c.close(); cleanup(s.dir); }
});

test("zip_create refuses a URL for out_path the same way", async () => {
  const s = sandbox();
  const c = client({ dataHome: s.dataHome });
  try {
    await c.init();
    const r = await c.call("zip_create", { out_path: "out.zip", paths: ["https://example.com/a.txt"] });
    assert.equal(r.isError, true);
    assert.match(r.text, /is a URL, not a file path/);
  } finally { c.close(); cleanup(s.dir); }
});
