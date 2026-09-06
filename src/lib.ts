/**
 * Public surface for other servers in this repo that want to read or write a zip without
 * spawning this server. Everything here is pure: no MCP, no stdio.
 */
export {
  crc32, globToRegExp, inspectEntry, matchesAny, readDirectory, readEntry, ZipFormatError,
  DEFAULT_MAX_RATIO, DEFAULT_MAX_TOTAL_BYTES, RATIO_FLOOR_BYTES,
} from "./zipfile.js";
export type { Finding, Reason, ZipDirectory, ZipEntry } from "./zipfile.js";
export {
  expandPath, humanBytes, releaseReservation, reserveOutput, writeAtomic, MAX_INPUT_BYTES,
} from "./paths.js";
export type { Reservation } from "./paths.js";
export {
  CorruptDataError, countInMonth, dataDir, getArchives, lockPath, monthOf, registerPath,
  setArchives, siblingDir,
} from "./store.js";
export type { ArchiveRecord } from "./store.js";
export { VERSION } from "./version.js";
