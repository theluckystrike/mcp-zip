import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";

/**
 * Nothing larger is read into memory. fflate builds a zip in one buffer, so the peak is
 * roughly the sum of the inputs plus the archive; half a gigabyte of input is already
 * more than a Node default heap wants to hold twice.
 */
export const MAX_INPUT_BYTES = 512 * 1024 * 1024;

/** A leading `<scheme>://` means the caller has a URL, not a local path. Checked BEFORE
 * any resolution, so a URL is never joined against the server's cwd and the refusal
 * never has a path in it, let alone one that leaks the cwd. */
const URL_SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

// D-R83: a URL handed to a path argument used to be silently resolved as a relative
// filesystem path, producing an error that leaked the server's own cwd. Refused by
// name instead.
export function expandPath(p: string): string {
  if (URL_SCHEME_RE.test(p)) {
    throw new Error(
      `"${p}" is a URL, not a file path; this tool reads and writes local files. On the hosted route, ` +
      `use the url argument of zip_upload. Locally, download it first and pass the path it was saved to.`,
    );
  }
  const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
  return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export interface Reservation { path: string; created: boolean }

/**
 * Reserve an output path with an exclusive create rather than an existence check, the
 * rule servers/pdf uses: two processes writing the same out_path with overwrite:false
 * would both pass a check and the second would clobber the first. The reservation is a
 * real 0-byte file, released again if the work that follows fails.
 *
 * The path is stat-ed exactly as given before any extension is appended, so an out_path
 * that is a directory is refused instead of becoming a new file beside it.
 */
export function reserveOutput(out: string, overwrite: boolean, ext = ".zip"): Reservation {
  const p = expandPath(out);
  if (existsSync(p) && statSync(p).isDirectory()) {
    throw new Error(`out_path ${p} is a directory, not a file. Give it a file name, for example ${join(p, "archive.zip")}. Nothing was written.`);
  }
  const withExt = p.toLowerCase().endsWith(ext) ? p : `${p}${ext}`;
  const parent = dirname(withExt);
  if (!existsSync(parent)) {
    throw new Error(`the directory ${parent} does not exist, so ${withExt} cannot be written. Create it first, or give an out_path inside a directory that exists. Nothing was written.`);
  }
  if (overwrite) return { path: withExt, created: false };
  try {
    closeSync(openSync(withExt, "wx"));
    return { path: withExt, created: true };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const size = (() => { try { return statSync(withExt).size; } catch { return 0; } })();
    throw new Error(`${withExt} already exists (${size} bytes) and nothing was written. Pass overwrite: true to replace it, or give a different out_path.`);
  }
}

export function releaseReservation(r: Reservation | null): void {
  if (!r || !r.created) return;
  try { if (statSync(r.path).size === 0) unlinkSync(r.path); } catch { /* leave it */ }
}

/** tmp + rename in the target directory, so a reader never sees a half-written archive. */
export function writeAtomic(path: string, bytes: Uint8Array): number {
  const tmp = `${path}.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
  return bytes.length;
}

export function ensureDir(dir: string): void { mkdirSync(dir, { recursive: true }); }
