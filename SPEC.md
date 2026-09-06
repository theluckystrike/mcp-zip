# zip - contract spec

Written in the shape `scripts/gen-spec.mjs` emits; the tool table below was read off the built server over
stdio (`initialize`, `tools/list`), not off `src`. This server is not yet in the generator's list.

| | |
| --- | --- |
| package | `@theluckystrike/mcp-zip` |
| version | 0.8.0 |
| bin | `mcp-zip` |
| serverInfo.name | `mcp-zip` |
| transport | stdio, JSON-RPC 2.0 |
| tools | 9 |
| resources | 0 |
| prompts | 0 |

## What it does

Creates, inspects and extracts zip archives locally, with no network call of any kind. Packing takes a file
list or a directory tree with glob patterns and stores relative names only. Reading parses the central
directory itself and decides every guard from the headers before anything is inflated: absolute paths, `..`,
symlinks, encrypted entries, duplicate names, unsupported compression methods, per-entry compression ratio and
total uncompressed size. Every archive created is recorded in a local register under the data directory.

Compression is `fflate` 0.8 (pure JS, no native build); the container format, the central-directory reader and
every safety decision are in `src/zipfile.ts`.

## Tools (9)

| tool | description |
| --- | --- |
| `license_activate` | Activate a Pro license key (format MCPL1.xxx.yyy). Verified offline and saved locally. |
| `license_status` | Show whether this server runs in free or Pro mode and where to upgrade. |
| `zip_add` | Call this tool to add files to an existing archive. The archive is rebuilt from its entries and written tmp-then-rename, so a failure part way leaves the original file exactly as it was. |
| `zip_bundle_month` | Call this tool to zip one month of invoices, quotes and exports written by the sibling servers into their default output folders. Best effort: it names every folder it looked in and what it found. |
| `zip_create` | Call this tool to pack files or a whole directory (with glob patterns) into a new .zip at out_path. Entry names are always relative, so the archive cannot write outside where it is unpacked. |
| `zip_extract` | Call this tool to unpack an archive into out_dir. Traversal, absolute-path and symlink entries are refused, a size and ratio cap stops a zip bomb, and dry_run reports exactly what would be written. |
| `zip_extract_text` | Call this tool to read one text entry out of an archive without unpacking anything: give the entry name and the text comes back inline. Binary entries are refused by name rather than printed as noise. |
| `zip_history` | List the archives this server created, newest first, with their entry counts and sizes, plus how many of this month's free allowance are left. |
| `zip_list` | Call this tool to list an archive's entries with sizes, compressed sizes and ratios, and to flag what is dangerous in it: absolute paths, .., symlinks, encrypted entries, duplicate names and compression bombs. |

## Shared arguments

Writing tools take `out_path` and `overwrite` (default false: an existing file is never replaced). Packing
tools take `level` (0 to 9, default 6) and a `password` argument that exists only so that passing one is
refused by name rather than silently dropped. Reading tools take `patterns` (globs: `*` and `?` inside a
segment, `**` across segments; a pattern with no slash also matches the file name at any depth).
`zip_extract` additionally takes `dry_run`, `skip_unsafe`, `max_total_mb` (default 1024) and `max_ratio`
(default 100).

## Invariants

1. **stdout carries JSON-RPC and nothing else.** `console.*` is redirected to stderr and any non-protocol
   write to stdout is diverted, so a dependency that prints cannot break the transport.
2. **A tier limit is an answer, not a protocol error.** Free-tier refusals return `isError: false` with the
   upgrade text; malformed input and unsafe archives return `isError: true`.
3. **Every guard is decided from the central directory, before anything is inflated.** Refusing a 500 MB bomb
   reads headers only and creates no output directory.
4. **An entry's bytes are proved by its CRC-32, not by the size in its header.** A bounded inflate buffer
   truncates silently, so the checksum is what refuses a header that lies.
5. **Nothing extracted can land outside `out_dir`.** The name is checked (absolute, `..`, backslash, symlink)
   and the resolved target is checked again against `out_dir`. A symlink entry is never recreated, as a link
   or as a file.
6. **One bad entry refuses the whole extraction** unless `skip_unsafe: true`, which extracts the rest and
   names what was left out.
7. **Nothing is half-written.** `out_path` is checked (directory, missing parent, existing file without
   `overwrite`) before anything is read, and every archive is written tmp + rename.
8. **An archive this server writes carries relative names only**, so it can never be a traversal archive; and
   `zip_add` refuses to rebuild an archive that already holds an entry this server would not write.
9. **The register is the only counter.** The free monthly allowance is read and the row appended in one
   critical section, so two processes on one data directory cannot both take the last slot. A write that
   fails afterwards gives the slot back.
10. **A corrupt register blocks reads and writes.** It is quarantined byte-for-byte as
    `archives.json.corrupt-<ts>` with a `.corrupt` marker beside it; it is never reported as "no archives yet".
11. **The version is one number**: `package.json`, the generated `src/version.ts`, `serverInfo.version`,
    `server.json` and `server.mcpb.json` agree (asserted in `test/contract.test.mjs`).

## Limits and refusals that are not tier limits

| condition | what happens |
| --- | --- |
| ZIP64 archive (over 4 GB or over 65,535 entries) | refused by name; the system `unzip` is suggested |
| archive over 512 MB | refused: it is read into memory whole |
| inputs to one pack over 512 MB | refused: the archive is built in memory |
| compression method other than store (0) or deflate (8) | the entry is refused, not skipped silently |
| a password argument | refused with the reason |
| an encrypted entry | refused on read; nothing is decrypted or guessed |
| an entry over 800 KB in `zip_extract_text` | refused with a pointer to `zip_extract` |
| an entry with a zero byte in its first 8 KB | refused as binary rather than printed |

## Storage

`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/zip/archives.json`, an array of records (`id`, `op`, `out_path`,
`entries`, `bytes`, `uncompressed_bytes`, `created`, and `pending` while a call holds the slot), trimmed to the
last 1000 rows. Lock directory `.lock` in the same directory. `zip_bundle_month` writes its default output to
`bundles/<YYYY-MM>.zip` in the same directory, and reads (never writes) these sibling folders:

| server | folder | what |
| --- | --- | --- |
| invoice | `mcp-servers/invoice/pdf` | invoice PDFs |
| quotes | `mcp-servers/quotes/pdf` | quote PDFs |
| expense-tracker | `mcp-servers/expense-tracker/exports` | expense exports (CSV, JSON) |
| docx | `mcp-servers/docx/documents` | generated .docx documents |
| resume | `mcp-servers/resume/documents` | generated resumes |

These are the default output folders those servers use when the caller gives no `out_path`. A folder that is
not there is reported, not an error. Files are chosen by modification date, and the answer always names every
folder it looked in and how many files it saw in each.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Archives per calendar month | 20 | Unlimited |
| Archive size | 25 MB | Unlimited |
| Entries per archive | 200 | Unlimited |
| `zip_list`, `zip_extract`, `zip_extract_text` | Unlimited | Unlimited |
