import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The register of archives this server created.
 *
 * It exists for two reasons: the free tier counts archives per calendar month, and an
 * archive is a document ("what did I send that client in August?"). Written with the same
 * discipline as every other store in this suite: tmp + rename, a cross-process lock
 * around read-modify-write, and a parse failure quarantined byte-for-byte rather than
 * reported as "no archives yet", because that report would let the next write erase a
 * history that is still on disk.
 */
export interface ArchiveRecord {
  id: string;
  op: string;
  out_path: string;
  entries: number;
  bytes: number;
  uncompressed_bytes: number;
  created: string;
  /** Set while a call holds the slot; cleared when the archive is on disk. */
  pending?: boolean;
}

/** Rows kept in the register. Older rows are dropped; the month counter is unaffected. */
export const REGISTER_MAX = 1000;

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  const dir = join(base, "mcp-servers", "zip");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function siblingDir(server: string): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "mcp-servers", server);
}

export function lockPath(): string { return join(dataDir(), ".lock"); }
export function registerPath(): string { return join(dataDir(), "archives.json"); }
export function markerPath(file: string): string { return `${file}.corrupt`; }

export class CorruptDataError extends Error {}

function blocked(file: string, moved: string): CorruptDataError {
  return new CorruptDataError(
    `the archive register is corrupt; it was moved to ${moved} and nothing was written. ` +
    `Restore a good copy to ${file}, then delete ${markerPath(file)} to continue.`,
  );
}

export function readJsonFile<T>(file: string, empty: T): T {
  const marker = markerPath(file);
  if (existsSync(marker)) {
    let moved = `${file}.corrupt-*`;
    try {
      const t = readFileSync(marker, "utf8").trim();
      if (t) {
        try { const j = JSON.parse(t) as { quarantined?: unknown }; moved = typeof j.quarantined === "string" && j.quarantined ? j.quarantined : t; }
        catch { moved = t; }
      }
    } catch { /* marker unreadable */ }
    throw blocked(file, moved);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return empty;
    throw new CorruptDataError(`cannot read the archive register ${file}: ${(e as Error).message}; nothing was written.`);
  }
  try {
    const parsed = JSON.parse(raw) as T;
    // A JSON file that parses to the wrong shape is as unusable as one that does not
    // parse, and silently treating it as empty is the same data loss.
    if (Array.isArray(empty) && !Array.isArray(parsed)) throw new Error("expected a JSON array");
    return parsed;
  } catch (e) {
    const moved = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(file, moved);
      writeFileSync(marker, JSON.stringify({
        quarantined: moved, at: new Date().toISOString(),
        hint: "the archive register failed to parse; it was moved, nothing was overwritten; restore it manually or delete this marker to start fresh",
      }) + "\n");
    } catch { /* keep the parse error */ }
    process.stderr.write(`${file} is not valid JSON (${(e as Error).message}); moved to ${moved}\n`);
    throw blocked(file, moved);
  }
}

export function getArchives(): ArchiveRecord[] { return readJsonFile<ArchiveRecord[]>(registerPath(), []); }

export function setArchives(rows: ArchiveRecord[]): void {
  const p = registerPath();
  const tmp = `${p}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, p);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Archives recorded in the given YYYY-MM. The free cap counts calendar months, not 30 days. */
export function countInMonth(rows: ArchiveRecord[], month: string): number {
  return rows.filter((r) => typeof r.created === "string" && r.created.slice(0, 7) === month).length;
}

export function monthOf(d = new Date()): string { return d.toISOString().slice(0, 7); }
