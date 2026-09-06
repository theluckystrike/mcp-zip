#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, withFileLock } from "@theluckystrike/mcp-license";
import { zipSync } from "fflate";
import { z } from "zod";
import {
  MAX_INPUT_BYTES, expandPath, humanBytes, releaseReservation, reserveOutput, writeAtomic,
  type Reservation,
} from "./paths.js";
import {
  DEFAULT_MAX_RATIO, DEFAULT_MAX_TOTAL_BYTES, ZipFormatError, inspectEntry, matchesAny,
  readDirectory, readEntry, type Finding, type ZipEntry,
} from "./zipfile.js";
import {
  CorruptDataError, type ArchiveRecord, countInMonth, dataDir, getArchives, lockPath, monthOf,
  registerPath, REGISTER_MAX, setArchives, siblingDir,
} from "./store.js";
import { VERSION } from "./version.js";

/**
 * stdout carries the JSON-RPC stream and nothing else. Nothing in this server prints, but
 * a dependency can: the same guard the barcode and image servers use is kept here so a
 * future decoder cannot break the transport with a console.log.
 */
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
  const s = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
  if (s.startsWith("{") || s.startsWith("[")) return stdoutWrite(chunk as string, enc as BufferEncoding, cb as () => void);
  process.stderr.write(s);
  if (typeof enc === "function") (enc as () => void)();
  else if (typeof cb === "function") (cb as () => void)();
  return true;
}) as typeof process.stdout.write;
const toStderr = (...a: unknown[]) => { process.stderr.write(a.map((x) => String(x)).join(" ") + "\n"); };
console.log = toStderr; console.info = toStderr; console.warn = toStderr; console.debug = toStderr;

/* ------------------------------------------------------------------ limits */

/** Free tier: an archive this big, this many entries, this many archives a month. */
const FREE_MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const FREE_MAX_ENTRIES = 200;
const FREE_PER_MONTH = 20;
/** zip_extract_text reads into one chat message, so the whole answer is capped. */
const MAX_TEXT_CHARS = 200_000;
/** Nothing above this is read as an archive at all: it is read into memory whole. */
const MAX_ARCHIVE_READ_BYTES = 512 * 1024 * 1024;

const gate = createLicenseGate({ product: "zip" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const });
/** A tier limit is an answer, not a protocol error: the model has to relay the upgrade line. */
const freeLimit = (text: string) => ok(text);

function locked<T>(fn: () => T | Promise<T>): Promise<T> {
  return withFileLock(lockPath(), fn);
}

async function wrap(fn: () => Promise<ReturnType<typeof ok>>): Promise<ReturnType<typeof ok>> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CorruptDataError || e instanceof ZipFormatError) return fail(String(e.message));
    return fail(String((e as Error).message ?? e));
  }
}

/* --------------------------------------------------------------- the register */

/**
 * Take a monthly slot and append the row that counts it in ONE critical section.
 *
 * Counting under one lock and appending under another lets two processes both read 19
 * and both write, which is how a 20-archive allowance becomes 23 archives. The row is
 * written `pending` and either finished by `finish()` or taken back by `release()`, so a
 * write that fails afterwards costs no allowance.
 */
async function reserveSlot(op: string): Promise<{ id: string } | { refused: string }> {
  return locked(() => {
    const rows = getArchives();
    const month = monthOf();
    const used = countInMonth(rows, month);
    if (!gate.isPro() && used >= FREE_PER_MONTH) {
      return {
        refused:
          `The free tier creates ${FREE_PER_MONTH} archives per calendar month and ${used} have been created in ${month}. ` +
          `Nothing was written. The next free archive is available on the 1st.\n\n` +
          gate.upgradeText(`more than ${FREE_PER_MONTH} archives a month`, op),
      };
    }
    const id = randomBytes(4).toString("hex");
    rows.push({ id, op, out_path: "", entries: 0, bytes: 0, uncompressed_bytes: 0, created: new Date().toISOString(), pending: true });
    setArchives(rows.slice(-REGISTER_MAX));
    return { id };
  });
}

async function finish(id: string, patch: Partial<ArchiveRecord>): Promise<string> {
  try {
    await locked(() => {
      const rows = getArchives();
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      Object.assign(row, patch);
      delete row.pending;
      setArchives(rows);
    });
    return "";
  } catch (e) {
    return `\n\nThe archive was written, but the register at ${registerPath()} could not be updated: ${String((e as Error).message ?? e)}`;
  }
}

async function release(id: string): Promise<void> {
  try {
    await locked(() => setArchives(getArchives().filter((r) => r.id !== id)));
  } catch { /* the slot stays taken; better than losing a real row */ }
}

/* ------------------------------------------------------------------ walking */

interface Candidate { abs: string; entry: string; size: number }

function walkDir(root: string, prefix: string, out: Candidate[]): void {
  for (const name of readdirSync(root)) {
    const abs = join(root, name);
    let st;
    try { st = statSync(abs); } catch { continue; } // a broken symlink or a race
    const entry = prefix ? `${prefix}/${name}` : name;
    if (st.isDirectory()) walkDir(abs, entry, out);
    else if (st.isFile()) out.push({ abs, entry, size: st.size });
    // Anything that is neither (a socket, a device, a symlink to nowhere) is skipped:
    // a zip written from this server holds regular files and nothing else.
  }
}

/**
 * Collect the files to pack. `dir` walks a directory tree with glob patterns; `paths`
 * takes an explicit list, where a directory contributes its tree under its own name.
 * Entry names are always relative, always forward-slashed, and never start with a slash
 * or a drive letter, so an archive from this server cannot be a traversal archive.
 */
function collect(a: { paths?: string[]; dir?: string; patterns?: string[]; exclude?: string[] }): Candidate[] {
  const patterns = a.patterns ?? [];
  const exclude = a.exclude ?? [];
  const out: Candidate[] = [];
  if (a.dir) {
    const root = expandPath(a.dir);
    if (!existsSync(root)) throw new Error(`${root} does not exist. Give the path of a directory that is there. Nothing was written.`);
    if (!statSync(root).isDirectory()) throw new Error(`${root} is a file, not a directory. Pass it in paths instead of dir. Nothing was written.`);
    walkDir(root, "", out);
  }
  for (const raw of a.paths ?? []) {
    const abs = expandPath(raw);
    if (!existsSync(abs)) throw new Error(`${abs} does not exist. Nothing was written.`);
    const st = statSync(abs);
    if (st.isDirectory()) walkDir(abs, basename(abs), out);
    else if (st.isFile()) out.push({ abs, entry: basename(abs), size: st.size });
    else throw new Error(`${abs} is neither a file nor a directory, so it cannot be added to an archive. Nothing was written.`);
  }
  const kept = out.filter((c) => matchesAny(c.entry, patterns) && !(exclude.length && matchesAny(c.entry, exclude)));
  kept.sort((x, y) => (x.entry < y.entry ? -1 : x.entry > y.entry ? 1 : 0));
  return kept;
}

/** Two files that would land on the same entry name: the second silently replaces the first. */
function findDuplicates(names: string[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const n of names) seen.set(n, (seen.get(n) ?? 0) + 1);
  return new Map([...seen].filter(([, n]) => n > 1));
}

function buildArchive(files: Candidate[], level: number): { bytes: Uint8Array; uncompressed: number } {
  const payload: Record<string, [Uint8Array, { level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 }]> = {};
  let uncompressed = 0;
  for (const f of files) {
    const data = new Uint8Array(readFileSync(f.abs));
    uncompressed += data.length;
    payload[f.entry] = [data, { level: level as 0 }];
  }
  return { bytes: zipSync(payload), uncompressed };
}

function readArchive(input: string): { path: string; buf: Uint8Array } {
  const path = expandPath(input);
  if (!existsSync(path)) throw new Error(`${path} does not exist. Give the full path of a .zip file.`);
  const st = statSync(path);
  if (st.isDirectory()) throw new Error(`${path} is a directory, not a zip file.`);
  if (st.size === 0) throw new Error(`${path} is empty (0 bytes). An empty file is not a zip archive; even an archive with no entries is 22 bytes. Nothing was read.`);
  if (st.size > MAX_ARCHIVE_READ_BYTES) {
    throw new Error(`${path} is ${humanBytes(st.size)}; this server reads an archive into memory whole and refuses anything over ${humanBytes(MAX_ARCHIVE_READ_BYTES)}. Nothing was read.`);
  }
  return { path, buf: new Uint8Array(readFileSync(path)) };
}

function findingLines(findings: Finding[]): string {
  return findings.map((f) => `  - ${f.name || "(no name)"}: ${f.reason} - ${f.detail}`).join("\n");
}

/* ------------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-zip", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

gate.registerTools(server);

const PASSWORD_NOTE =
  "Zip passwords are not supported: the classic zip cipher is broken and AES zip encryption is a vendor extension " +
  "no two tools agree on, so a \"password protected\" archive from here would be a false promise. Nothing was written. " +
  "Encrypt the file itself, or send it over a channel that is already encrypted.";

server.registerTool("zip_create", {
  title: "Create a zip archive",
  description: "Call this tool to pack files or a whole directory (with glob patterns) into a new .zip at out_path. Entry names are always relative, so the archive cannot write outside where it is unpacked.",
  inputSchema: {
    out_path: z.string().describe("Where to write the .zip. A directory, a missing parent or an existing file without overwrite is refused before anything is packed"),
    paths: z.array(z.string()).optional().describe("Files to pack, each stored under its own file name. A directory here contributes its whole tree under its own name"),
    dir: z.string().optional().describe("Pack this directory's tree; entry names are relative to it"),
    patterns: z.array(z.string()).optional().describe("Only entries matching one of these globs (* and ? inside a segment, ** across segments; a pattern with no slash also matches the file name at any depth)"),
    exclude: z.array(z.string()).optional().describe("Drop entries matching one of these globs, applied after patterns"),
    level: z.number().int().min(0).max(9).optional().describe("Deflate level 0 to 9, default 6. 0 stores without compressing"),
    overwrite: z.boolean().optional().describe("Replace out_path if a file is already there. Default false: an existing file is never overwritten"),
    password: z.string().optional().describe("Not supported. Passing it is refused rather than ignored, so no one believes an archive is encrypted when it is not"),
  },
}, async (a: { out_path: string; paths?: string[]; dir?: string; patterns?: string[]; exclude?: string[]; level?: number; overwrite?: boolean; password?: string }) => wrap(async () => {
  if (a.password !== undefined) return fail(PASSWORD_NOTE);
  if (!a.paths?.length && !a.dir) return fail("nothing to pack: give paths (a list of files) or dir (a directory to walk), or both. Nothing was written.");

  const files = collect(a);
  if (files.length === 0) {
    const what = a.dir ? `${expandPath(a.dir)} matched no files` : "none of the given paths matched";
    return fail(`${what}${a.patterns?.length ? ` for patterns ${a.patterns.join(", ")}` : ""}. An archive with no entries is not written. Nothing was written.`);
  }
  const dupes = findDuplicates(files.map((f) => f.entry));
  if (dupes.size) {
    const lines = [...dupes].map(([n, c]) => `  - ${n} (${c} files)`).join("\n");
    return fail(
      `${dupes.size} entry name${dupes.size === 1 ? " is" : "s are"} claimed by more than one file, and a zip with two entries of the same name ` +
      `unpacks to whichever one is written last:\n${lines}\n\nPack them with dir (which keeps the directory prefix that tells them apart) or rename them first. Nothing was written.`,
    );
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (total > MAX_INPUT_BYTES) {
    return fail(`the ${files.length} files add up to ${humanBytes(total)}; this server builds an archive in memory and refuses inputs over ${humanBytes(MAX_INPUT_BYTES)}. Pack them in parts. Nothing was written.`);
  }
  if (!gate.isPro() && files.length > FREE_MAX_ENTRIES) {
    return freeLimit(
      `That is ${files.length} files. The free tier writes archives of up to ${FREE_MAX_ENTRIES} entries and nothing was written. ` +
      `Narrow it with patterns or exclude, or pack it in parts.\n\n${gate.upgradeText(`archives over ${FREE_MAX_ENTRIES} entries`, "zip_create")}`,
    );
  }

  let reservation: Reservation | null = null;
  let slot: string | null = null;
  try {
    reservation = reserveOutput(a.out_path, a.overwrite === true);
    const taken = await reserveSlot("zip_create");
    if ("refused" in taken) { releaseReservation(reservation); return freeLimit(taken.refused); }
    slot = taken.id;

    const built = buildArchive(files, a.level ?? 6);
    if (!gate.isPro() && built.bytes.length > FREE_MAX_ARCHIVE_BYTES) {
      await release(slot); slot = null;
      releaseReservation(reservation);
      return freeLimit(
        `The archive came to ${humanBytes(built.bytes.length)}. The free tier writes archives up to ${humanBytes(FREE_MAX_ARCHIVE_BYTES)} ` +
        `and nothing was written; the ${files.length} files were read but the file was not created.\n\n` +
        gate.upgradeText(`archives over ${humanBytes(FREE_MAX_ARCHIVE_BYTES)}`, "zip_create"),
      );
    }
    const bytes = writeAtomic(reservation.path, built.bytes);
    const note = await finish(slot, { out_path: reservation.path, entries: files.length, bytes, uncompressed_bytes: built.uncompressed });
    slot = null;
    const ratio = built.uncompressed > 0 ? (built.uncompressed / bytes).toFixed(2) : "1.00";
    const head = `Wrote ${reservation.path}: ${files.length} entr${files.length === 1 ? "y" : "ies"}, ${humanBytes(bytes)} from ${humanBytes(built.uncompressed)} (${ratio}x smaller).`;
    const sample = files.slice(0, 20).map((f) => `  ${f.entry}  ${humanBytes(f.size)}`).join("\n");
    const more = files.length > 20 ? `\n  ... and ${files.length - 20} more` : "";
    return ok(`${head}\n\n${sample}${more}${note}`);
  } catch (e) {
    if (slot) await release(slot);
    releaseReservation(reservation);
    throw e;
  }
}));

server.registerTool("zip_list", {
  title: "List a zip archive",
  description: "Call this tool to list an archive's entries with sizes, compressed sizes and ratios, and to flag what is dangerous in it: absolute paths, .., symlinks, encrypted entries, duplicate names and compression bombs.",
  inputSchema: {
    path: z.string().describe("Path to the .zip file. Read-only: the archive is never modified and nothing is extracted"),
    limit: z.number().int().min(1).max(2000).optional().describe("How many entries to print, largest first (default 50). The totals always cover every entry"),
    patterns: z.array(z.string()).optional().describe("Only entries matching one of these globs"),
    max_ratio: z.number().min(2).optional().describe(`Flag an entry whose uncompressed/compressed ratio is above this. Default ${DEFAULT_MAX_RATIO}`),
  },
}, async (a: { path: string; limit?: number; patterns?: string[]; max_ratio?: number }) => wrap(async () => {
  const { path, buf } = readArchive(a.path);
  const dir = readDirectory(buf);
  const maxRatio = a.max_ratio ?? DEFAULT_MAX_RATIO;
  const all = dir.entries;
  const shown = a.patterns?.length ? all.filter((e) => matchesAny(e.name, a.patterns!)) : all;

  const files = all.filter((e) => !e.is_dir);
  const totalRaw = files.reduce((s, e) => s + e.size, 0);
  const totalComp = files.reduce((s, e) => s + e.compressed_size, 0);
  const findings: Finding[] = [];
  for (const e of all) findings.push(...inspectEntry(e, maxRatio));
  const dupes = findDuplicates(all.map((e) => e.name));
  for (const [name, count] of dupes) {
    findings.push({ name, reason: "empty name", detail: `${count} entries share this name; unpacking the archive leaves whichever one was written last` });
  }

  const rows = [...shown].sort((x, y) => y.size - x.size).slice(0, a.limit ?? 50).map((e) => {
    const kind = e.is_dir ? "dir " : e.is_symlink ? "link" : "file";
    const ratio = e.is_dir ? "" : `  ${e.ratio}x`;
    return `  ${kind}  ${humanBytes(e.size).padStart(9)}  ${humanBytes(e.compressed_size).padStart(9)}${ratio}  ${e.modified || "no date"}  ${e.name}`;
  }).join("\n");

  const head =
    `${path}\n${humanBytes(dir.archive_bytes)} on disk, ${all.length} entr${all.length === 1 ? "y" : "ies"} ` +
    `(${files.length} file${files.length === 1 ? "" : "s"}), ${humanBytes(totalRaw)} uncompressed, ` +
    `overall ${totalComp > 0 ? (totalRaw / totalComp).toFixed(2) : "1.00"}x.` +
    (dir.comment ? `\nArchive comment: ${dir.comment.slice(0, 300)}` : "");
  const listed = shown.length === all.length ? "" : `\n${shown.length} of ${all.length} entries match.`;
  const flagged = findings.length
    ? `\n\n${findings.length} thing${findings.length === 1 ? "" : "s"} to know before extracting this archive:\n${findingLines(findings.slice(0, 40))}` +
      (findings.length > 40 ? `\n  ... and ${findings.length - 40} more` : "") +
      `\n\nzip_extract refuses the whole archive when a selected entry is an absolute path, a traversal, a symlink or over the ratio ceiling; pass skip_unsafe: true to extract the rest and be told what was left out.`
    : "\n\nNothing suspicious: no absolute paths, no \"..\", no symlinks, no duplicate names, no entry over the ratio ceiling.";
  return ok(`${head}${listed}\n\n${rows}${flagged}`);
}));

server.registerTool("zip_extract", {
  title: "Extract a zip archive",
  description: "Call this tool to unpack an archive into out_dir. Traversal, absolute-path and symlink entries are refused, a size and ratio cap stops a zip bomb, and dry_run reports exactly what would be written.",
  inputSchema: {
    path: z.string().describe("Path to the .zip file"),
    out_dir: z.string().describe("Directory to unpack into. It is created if missing; every file written is checked to land inside it"),
    patterns: z.array(z.string()).optional().describe("Only entries matching one of these globs (* and ? inside a segment, ** across segments)"),
    dry_run: z.boolean().optional().describe("Report what would be written, byte counts included, and write nothing"),
    overwrite: z.boolean().optional().describe("Replace files that already exist in out_dir. Default false: the whole extraction is refused if any would be replaced"),
    skip_unsafe: z.boolean().optional().describe("Skip the dangerous entries and extract the rest, naming what was skipped. Default false: one bad entry refuses the whole archive"),
    max_total_mb: z.number().min(1).optional().describe(`Refuse if the selected entries declare more than this uncompressed. Default ${Math.round(DEFAULT_MAX_TOTAL_BYTES / 1024 / 1024)}`),
    max_ratio: z.number().min(2).optional().describe(`Refuse an entry whose uncompressed/compressed ratio is above this. Default ${DEFAULT_MAX_RATIO}`),
  },
}, async (a: { path: string; out_dir: string; patterns?: string[]; dry_run?: boolean; overwrite?: boolean; skip_unsafe?: boolean; max_total_mb?: number; max_ratio?: number }) => wrap(async () => {
  const { path, buf } = readArchive(a.path);
  const dir = readDirectory(buf);
  const maxRatio = a.max_ratio ?? DEFAULT_MAX_RATIO;
  const maxTotal = a.max_total_mb ? a.max_total_mb * 1024 * 1024 : DEFAULT_MAX_TOTAL_BYTES;
  const outDir = expandPath(a.out_dir);
  if (existsSync(outDir) && !statSync(outDir).isDirectory()) {
    return fail(`out_dir ${outDir} is a file, not a directory. Give a directory to unpack into, for example ${outDir}-extracted. Nothing was extracted.`);
  }

  const selected = dir.entries.filter((e) => !a.patterns?.length || matchesAny(e.name, a.patterns));
  if (selected.length === 0) {
    return fail(`no entry in ${path} matches ${a.patterns?.join(", ")}. The archive holds ${dir.entries.length} entries; run zip_list to see them. Nothing was extracted.`);
  }

  // Every guard below is decided from the central directory, before one byte is inflated.
  const unsafe = new Map<string, Finding[]>();
  for (const e of selected) {
    const f = inspectEntry(e, maxRatio);
    if (f.length) unsafe.set(e.name, f);
  }
  const safe = selected.filter((e) => !unsafe.has(e.name));
  if (unsafe.size && !a.skip_unsafe) {
    const flat = [...unsafe.values()].flat();
    return fail(
      `${unsafe.size} of the ${selected.length} selected entries in ${path} would be unsafe to write, so nothing was extracted:\n${findingLines(flat.slice(0, 40))}` +
      (flat.length > 40 ? `\n  ... and ${flat.length - 40} more` : "") +
      `\n\nPass skip_unsafe: true to extract the ${safe.length} safe entr${safe.length === 1 ? "y" : "ies"} and leave these out, or run zip_list first to see the whole archive.`,
    );
  }
  const declared = safe.filter((e) => !e.is_dir).reduce((s, e) => s + e.size, 0);
  if (declared > maxTotal) {
    return fail(
      `the selected entries declare ${humanBytes(declared)} uncompressed, over the ${humanBytes(maxTotal)} ceiling, ` +
      `and nothing was extracted. The archive itself is only ${humanBytes(dir.archive_bytes)}, a ${(declared / dir.archive_bytes).toFixed(0)}x expansion. ` +
      `Raise max_total_mb if that is really what you meant, or extract part of it with patterns.`,
    );
  }

  // Targets are resolved against out_dir and each one is checked to land inside it, so a
  // name that survived the header checks still cannot escape.
  const planned: { e: ZipEntry; target: string }[] = [];
  const clashes: string[] = [];
  for (const e of safe) {
    if (e.is_dir) continue;
    const target = resolve(outDir, e.name);
    if (target !== outDir && !target.startsWith(outDir + sep)) {
      return fail(`"${e.name}" resolves to ${target}, outside ${outDir}. Nothing was extracted.`);
    }
    if (!a.overwrite && existsSync(target)) clashes.push(target);
    planned.push({ e, target });
  }
  if (clashes.length) {
    return fail(
      `${clashes.length} file${clashes.length === 1 ? "" : "s"} in ${outDir} would be replaced and nothing was extracted:\n` +
      clashes.slice(0, 20).map((c) => `  - ${c}`).join("\n") + (clashes.length > 20 ? `\n  ... and ${clashes.length - 20} more` : "") +
      `\n\nPass overwrite: true, or extract into an empty directory.`,
    );
  }

  const skipped = unsafe.size
    ? `\n\n${unsafe.size} entr${unsafe.size === 1 ? "y was" : "ies were"} skipped as unsafe:\n${findingLines([...unsafe.values()].flat().slice(0, 20))}`
    : "";
  if (a.dry_run) {
    const lines = planned.slice(0, 50).map((p) => `  ${humanBytes(p.e.size).padStart(9)}  ${p.target}`).join("\n");
    return ok(
      `Dry run: ${planned.length} file${planned.length === 1 ? "" : "s"}, ${humanBytes(declared)} uncompressed, would be written into ${outDir}. Nothing was written.\n\n${lines}` +
      (planned.length > 50 ? `\n  ... and ${planned.length - 50} more` : "") + skipped,
    );
  }

  mkdirSync(outDir, { recursive: true });
  let written = 0;
  let bytes = 0;
  const done: string[] = [];
  for (const p of planned) {
    const data = readEntry(buf, p.e);
    bytes += data.length;
    if (bytes > maxTotal) {
      return fail(`extraction passed the ${humanBytes(maxTotal)} ceiling at ${p.e.name} after ${written} files; ${humanBytes(bytes)} is already on disk under ${outDir}. The remaining entries were not written.`);
    }
    mkdirSync(dirname(p.target), { recursive: true });
    writeFileSync(p.target, data);
    written++;
    done.push(`  ${humanBytes(data.length).padStart(9)}  ${p.target}`);
  }
  return ok(
    `Extracted ${written} file${written === 1 ? "" : "s"} (${humanBytes(bytes)}) from ${path} into ${outDir}.\n\n` +
    done.slice(0, 50).join("\n") + (done.length > 50 ? `\n  ... and ${done.length - 50} more` : "") + skipped,
  );
}));

server.registerTool("zip_add", {
  title: "Add files to a zip",
  description: "Call this tool to add files to an existing archive. The archive is rebuilt from its entries and written tmp-then-rename, so a failure part way leaves the original file exactly as it was.",
  inputSchema: {
    path: z.string().describe("Path to the existing .zip file"),
    paths: z.array(z.string()).min(1).describe("Files to add, each stored under its own file name. A directory contributes its tree under its own name"),
    prefix: z.string().optional().describe("Put the new entries under this folder inside the archive, for example \"invoices\""),
    replace: z.boolean().optional().describe("Replace an entry whose name is already in the archive. Default false: a name clash is refused and nothing is changed"),
    level: z.number().int().min(0).max(9).optional().describe("Deflate level 0 to 9 for the new entries, default 6"),
    password: z.string().optional().describe("Not supported. Passing it is refused rather than ignored"),
  },
}, async (a: { path: string; paths: string[]; prefix?: string; replace?: boolean; level?: number; password?: string }) => wrap(async () => {
  if (a.password !== undefined) return fail(PASSWORD_NOTE);
  const { path, buf } = readArchive(a.path);
  const dir = readDirectory(buf);
  const bad = dir.entries.flatMap((e) => inspectEntry(e));
  if (bad.length) {
    return fail(
      `${path} already holds entries this server will not rewrite:\n${findingLines(bad.slice(0, 20))}\n\n` +
      `Rebuilding the archive would mean re-emitting them, and an archive written here never carries an absolute path, a traversal, a symlink or an encrypted entry. Nothing was changed.`,
    );
  }
  const clean = a.prefix ? a.prefix.replace(/^[/\\]+|[/\\]+$/g, "").replace(/\\/g, "/") : "";
  if (clean.split("/").some((s) => s === "..")) return fail(`prefix "${a.prefix}" walks up out of the archive root. Nothing was changed.`);

  const adds = collect({ paths: a.paths }).map((c) => ({ ...c, entry: clean ? `${clean}/${c.entry}` : c.entry }));
  if (adds.length === 0) return fail("none of the given paths matched a file. Nothing was changed.");
  const dupInAdds = findDuplicates(adds.map((c) => c.entry));
  if (dupInAdds.size) return fail(`the files given claim the same entry name more than once: ${[...dupInAdds.keys()].join(", ")}. Nothing was changed.`);

  const existing = new Map(dir.entries.filter((e) => !e.is_dir).map((e) => [e.name, e]));
  const clash = adds.filter((c) => existing.has(c.entry)).map((c) => c.entry);
  if (clash.length && !a.replace) {
    return fail(`${clash.length} name${clash.length === 1 ? " is" : "s are"} already in ${path}: ${clash.slice(0, 10).join(", ")}. Pass replace: true to replace them, or use prefix to put the new files in their own folder. Nothing was changed.`);
  }

  const kept = [...existing.values()].filter((e) => !adds.some((c) => c.entry === e.name));
  const keptBytes = kept.reduce((s, e) => s + e.size, 0);
  const addBytes = adds.reduce((s, c) => s + c.size, 0);
  if (keptBytes + addBytes > MAX_INPUT_BYTES) {
    return fail(`the rebuilt archive would hold ${humanBytes(keptBytes + addBytes)} of files, over the ${humanBytes(MAX_INPUT_BYTES)} in-memory ceiling. Nothing was changed.`);
  }
  const totalEntries = kept.length + adds.length;
  if (!gate.isPro() && totalEntries > FREE_MAX_ENTRIES) {
    return freeLimit(`The archive would hold ${totalEntries} entries. The free tier writes archives of up to ${FREE_MAX_ENTRIES} and nothing was changed.\n\n${gate.upgradeText(`archives over ${FREE_MAX_ENTRIES} entries`, "zip_add")}`);
  }

  const taken = await reserveSlot("zip_add");
  if ("refused" in taken) return freeLimit(taken.refused);
  const slot = taken.id;
  try {
    const level = (a.level ?? 6) as 0;
    const payload: Record<string, [Uint8Array, { level: 0 }]> = {};
    let uncompressed = 0;
    for (const e of kept) { const data = readEntry(buf, e); uncompressed += data.length; payload[e.name] = [data, { level }]; }
    for (const c of adds) { const data = new Uint8Array(readFileSync(c.abs)); uncompressed += data.length; payload[c.entry] = [data, { level }]; }
    const built = zipSync(payload);
    if (!gate.isPro() && built.length > FREE_MAX_ARCHIVE_BYTES) {
      await release(slot);
      return freeLimit(`The rebuilt archive came to ${humanBytes(built.length)}, over the free ceiling of ${humanBytes(FREE_MAX_ARCHIVE_BYTES)}, and ${path} was not changed.\n\n${gate.upgradeText(`archives over ${humanBytes(FREE_MAX_ARCHIVE_BYTES)}`, "zip_add")}`);
    }
    const bytes = writeAtomic(path, built);
    const note = await finish(slot, { out_path: path, entries: totalEntries, bytes, uncompressed_bytes: uncompressed });
    return ok(
      `Added ${adds.length} file${adds.length === 1 ? "" : "s"} to ${path}: ${totalEntries} entries now, ${humanBytes(bytes)}.\n\n` +
      adds.slice(0, 20).map((c) => `  + ${c.entry}  ${humanBytes(c.size)}`).join("\n") +
      (adds.length > 20 ? `\n  ... and ${adds.length - 20} more` : "") +
      (clash.length ? `\n\n${clash.length} existing entr${clash.length === 1 ? "y was" : "ies were"} replaced: ${clash.slice(0, 10).join(", ")}` : "") + note,
    );
  } catch (e) {
    await release(slot);
    throw e;
  }
}));

server.registerTool("zip_extract_text", {
  title: "Read one entry as text",
  description: "Call this tool to read one text entry out of an archive without unpacking anything: give the entry name and the text comes back inline. Binary entries are refused by name rather than printed as noise.",
  inputSchema: {
    path: z.string().describe("Path to the .zip file"),
    entry: z.string().describe("Exact entry name, as zip_list prints it. A glob is accepted when it matches exactly one entry"),
    max_chars: z.number().int().min(100).max(MAX_TEXT_CHARS).optional().describe(`Stop after this many characters (default ${MAX_TEXT_CHARS}). The answer says when it was cut`),
  },
}, async (a: { path: string; entry: string; max_chars?: number }) => wrap(async () => {
  const { path, buf } = readArchive(a.path);
  const dir = readDirectory(buf);
  const files = dir.entries.filter((e) => !e.is_dir);
  let hit = files.find((e) => e.name === a.entry);
  if (!hit) {
    const globbed = files.filter((e) => matchesAny(e.name, [a.entry]));
    if (globbed.length === 1) hit = globbed[0];
    else if (globbed.length > 1) return fail(`"${a.entry}" matches ${globbed.length} entries (${globbed.slice(0, 5).map((e) => e.name).join(", ")}...). Name one exactly.`);
    else return fail(`"${a.entry}" is not in ${path}. It holds ${files.length} file entries; run zip_list to see them.`);
  }
  const findings = inspectEntry(hit);
  if (findings.length) return fail(`"${hit.name}" was not read:\n${findingLines(findings)}`);
  const cap = a.max_chars ?? MAX_TEXT_CHARS;
  // The ceiling on what is READ is fixed; max_chars only trims what is printed. Sizing
  // the read from max_chars would make a small max_chars refuse the file outright, which
  // is the opposite of what asking for less of it means.
  if (hit.size > MAX_TEXT_CHARS * 4) {
    return fail(`"${hit.name}" is ${humanBytes(hit.size)}, past the ${humanBytes(MAX_TEXT_CHARS * 4)} this tool will read into one answer. Extract it with zip_extract and read the file instead.`);
  }
  const data = readEntry(buf, hit);
  const nulls = data.subarray(0, 8192).indexOf(0);
  if (nulls >= 0) {
    return fail(`"${hit.name}" holds a zero byte at offset ${nulls}, so it is a binary file, not text. Printing it would be noise. Extract it with zip_extract instead.`);
  }
  const text = Buffer.from(data).toString("utf8");
  const cut = text.length > cap;
  return ok(
    `${hit.name} (${humanBytes(hit.size)}, ${hit.modified || "no date"}) from ${path}:\n\n` +
    (cut ? `${text.slice(0, cap)}\n\n[cut at ${cap} of ${text.length} characters]` : text),
  );
}));

/**
 * The sibling stores this looks in. Each server writes its own documents under its own
 * data directory by default, so the paths below are the defaults those servers use, read
 * as plain directories rather than through a package dependency, the way kanban reads
 * time-tracker's data.json. A directory that is not there is reported, not an error:
 * most people run two or three of these servers, not all of them.
 */
const BUNDLE_SOURCES: { server: string; sub: string; what: string }[] = [
  { server: "invoice", sub: "pdf", what: "invoice PDFs" },
  { server: "quotes", sub: "pdf", what: "quote PDFs" },
  { server: "expense-tracker", sub: "exports", what: "expense exports (CSV, JSON)" },
  { server: "docx", sub: "documents", what: "generated .docx documents" },
  { server: "resume", sub: "documents", what: "generated resumes" },
];

server.registerTool("zip_bundle_month", {
  title: "Bundle a month of documents",
  description: "Call this tool to zip one month of invoices, quotes and exports written by the sibling servers into their default output folders. Best effort: it names every folder it looked in and what it found.",
  inputSchema: {
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("Month as YYYY-MM. Default: this month. Files are chosen by their modification date"),
    out_path: z.string().optional().describe("Where to write the .zip. Default: <data dir>/bundles/<month>.zip"),
    servers: z.array(z.string()).optional().describe("Only these sibling servers: invoice, quotes, expense-tracker, docx, resume. Default: all five"),
    overwrite: z.boolean().optional().describe("Replace out_path if it exists. Default false"),
    dry_run: z.boolean().optional().describe("Report what would go in and write nothing"),
  },
}, async (a: { month?: string; out_path?: string; servers?: string[]; overwrite?: boolean; dry_run?: boolean }) => wrap(async () => {
  const month = a.month ?? monthOf();
  const wanted = a.servers?.length ? BUNDLE_SOURCES.filter((s) => a.servers!.includes(s.server)) : BUNDLE_SOURCES;
  if (wanted.length === 0) {
    return fail(`none of ${a.servers?.join(", ")} is a server this tool reads. It knows: ${BUNDLE_SOURCES.map((s) => s.server).join(", ")}.`);
  }
  const looked: string[] = [];
  const files: Candidate[] = [];
  for (const s of wanted) {
    const root = join(siblingDir(s.server), s.sub);
    if (!existsSync(root) || !statSync(root).isDirectory()) { looked.push(`  ${root} - not there (the ${s.server} server has not written any ${s.what} in its default folder)`); continue; }
    const found: Candidate[] = [];
    walkDir(root, "", found);
    const inMonth = found.filter((c) => {
      try { return statSync(c.abs).mtime.toISOString().slice(0, 7) === month; } catch { return false; }
    });
    looked.push(`  ${root} - ${found.length} file${found.length === 1 ? "" : "s"}, ${inMonth.length} modified in ${month}`);
    for (const c of inMonth) files.push({ ...c, entry: `${s.server}/${c.entry}` });
  }
  const where = `Looked in:\n${looked.join("\n")}`;
  if (files.length === 0) {
    return fail(`nothing was modified in ${month} in any of the folders below, so no archive was written.\n\n${where}\n\nThese are the default output folders of the sibling servers. If you write invoices or exports somewhere else, pack that folder with zip_create and dir instead.`);
  }
  const total = files.reduce((s, f) => s + f.size, 0);
  if (a.dry_run) {
    return ok(`Dry run for ${month}: ${files.length} file${files.length === 1 ? "" : "s"}, ${humanBytes(total)}. Nothing was written.\n\n${where}\n\n` + files.slice(0, 50).map((f) => `  ${f.entry}  ${humanBytes(f.size)}`).join("\n"));
  }
  if (!gate.isPro() && files.length > FREE_MAX_ENTRIES) {
    return freeLimit(`${month} holds ${files.length} documents. The free tier writes archives of up to ${FREE_MAX_ENTRIES} entries and nothing was written.\n\n${gate.upgradeText(`archives over ${FREE_MAX_ENTRIES} entries`, "zip_bundle_month")}`);
  }

  const defaultOut = join(dataDir(), "bundles", `${month}.zip`);
  if (!a.out_path) mkdirSync(join(dataDir(), "bundles"), { recursive: true });
  let reservation: Reservation | null = null;
  let slot: string | null = null;
  try {
    reservation = reserveOutput(a.out_path ?? defaultOut, a.overwrite === true);
    const taken = await reserveSlot("zip_bundle_month");
    if ("refused" in taken) { releaseReservation(reservation); return freeLimit(taken.refused); }
    slot = taken.id;
    const built = buildArchive(files, 6);
    if (!gate.isPro() && built.bytes.length > FREE_MAX_ARCHIVE_BYTES) {
      await release(slot); slot = null;
      releaseReservation(reservation);
      return freeLimit(`The bundle came to ${humanBytes(built.bytes.length)}, over the free ceiling of ${humanBytes(FREE_MAX_ARCHIVE_BYTES)}. Nothing was written.\n\n${gate.upgradeText(`archives over ${humanBytes(FREE_MAX_ARCHIVE_BYTES)}`, "zip_bundle_month")}`);
    }
    const bytes = writeAtomic(reservation.path, built.bytes);
    const note = await finish(slot, { out_path: reservation.path, entries: files.length, bytes, uncompressed_bytes: built.uncompressed });
    slot = null;
    return ok(
      `Wrote ${reservation.path} for ${month}: ${files.length} document${files.length === 1 ? "" : "s"}, ${humanBytes(bytes)} from ${humanBytes(built.uncompressed)}.\n\n${where}\n\n` +
      files.slice(0, 50).map((f) => `  ${f.entry}  ${humanBytes(f.size)}`).join("\n") +
      (files.length > 50 ? `\n  ... and ${files.length - 50} more` : "") + note,
    );
  } catch (e) {
    if (slot) await release(slot);
    releaseReservation(reservation);
    throw e;
  }
}));

server.registerTool("zip_history", {
  title: "Archives created",
  description: "List the archives this server created, newest first, with their entry counts and sizes, plus how many of this month's free allowance are left.",
  inputSchema: {
    limit: z.number().int().min(1).max(200).optional().describe("How many rows to show, newest first (default 20)"),
  },
}, async (a: { limit?: number }) => wrap(async () => {
  const rows = await locked(() => getArchives());
  const used = countInMonth(rows, monthOf());
  const head = gate.isPro()
    ? `${rows.length} archive(s) in the register at ${dataDir()}, ${used} this month. Pro: no limit.`
    : `${rows.length} archive(s) in the register at ${dataDir()}. ${used} of ${FREE_PER_MONTH} free archives used in ${monthOf()}.`;
  if (rows.length === 0) return ok(`${head}\nNothing to list.`);
  const lines = rows.slice(-(a.limit ?? 20)).reverse().map((r) =>
    `${r.created.slice(0, 19).replace("T", " ")}  ${r.id}  ${r.op}  ${r.entries} entries  ${humanBytes(r.bytes)}${r.pending ? "  (in progress)" : ""}  ${r.out_path}`);
  return ok(`${head}\n\n${lines.join("\n")}`);
}));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-zip ${VERSION} ready (${gate.isPro() ? "pro" : "free"}), data in ${dataDir()}\n`);
