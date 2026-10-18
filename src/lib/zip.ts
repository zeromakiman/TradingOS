/**
 * Minimal ZIP archives for "Download my data (.zip)" (docs/V2_ARCHITECTURE.md §10.5). The browser assembles the
 * archive from the export parts and the evidence images, so this module is client-safe: no Node-only imports.
 *
 * Writer: PKWARE APPNOTE stored entries (method 0, no compression), CRC-32, UTF-8 entry names (general purpose
 * flag bit 11), no ZIP64 (at most 65,535 entries, every offset and size below 4 GiB), no data descriptors.
 * Reader: a strict parser for archives in exactly that form; it verifies every header against the central
 * directory and every CRC-32, and is used to check archives byte for byte.
 */

export interface ZipEntryInput {
  /** Relative path with "/" separators, for example `trading-os-export/core.json`. */
  name: string;
  /** Raw bytes; a string is stored as UTF-8. */
  data: Uint8Array | string;
  /** Stored as an MS-DOS date and time: local time, 2-second resolution, clamped to 1980-2107. Defaults to now. */
  modifiedAt?: Date;
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
  crc32: number;
  modifiedAt: Date;
}

export class ZipError extends Error {
  override name = "ZipError";
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const END_SIZE = 22;
/** 2.0: the APPNOTE version that defines stored entries with a UTF-8 name flag; host 0 (MS-DOS attributes). */
const VERSION = 20;
const UTF8_NAMES = 0x0800;
const STORED = 0;
const MAX_ENTRIES = 0xffff;
const MAX_UINT32 = 0xffffffff;
const MAX_NAME_BYTES = 0xffff;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const values = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    values[n] = c >>> 0;
  }
  crcTable = values;
  return values;
}

/** CRC-32 (IEEE 802.3, as used by ZIP). Pass the previous result to continue over a following chunk. */
export function crc32(data: Uint8Array, previous = 0): number {
  const values = table();
  let crc = (previous ^ MAX_UINT32) >>> 0;
  for (let i = 0; i < data.length; i += 1) crc = values[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ MAX_UINT32) >>> 0;
}

const MAX_SEGMENT_CHARACTERS = 120;

/** Characters that are not portable inside one path segment: separators, Windows-reserved, control characters. */
function unsafeCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f || '/\\:*?"<>|'.includes(character);
}

/** Turns arbitrary text (an uploaded file name, an account name) into one safe, portable path segment. */
export function zipPathSegment(text: string): string {
  const cleaned = [...text].map((character) => (unsafeCharacter(character) ? "_" : character)).slice(0, MAX_SEGMENT_CHARACTERS)
    .join("").replace(/^[.\s]+|[.\s]+$/g, "");
  return cleaned === "" ? "_" : cleaned;
}

function validName(name: string): string {
  const invalid = name.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || [...segment].some(unsafeCharacter));
  if (invalid) throw new ZipError(`Invalid archive entry name: ${JSON.stringify(name)}`);
  return name;
}

function dosDateTime(at: Date): { date: number; time: number } {
  if (Number.isNaN(at.getTime())) throw new ZipError("Invalid entry modification time.");
  const year = at.getFullYear();
  if (year < 1980) return { date: (1 << 5) | 1, time: 0 };
  if (year > 2107) return { date: (127 << 9) | (12 << 5) | 31, time: (23 << 11) | (59 << 5) | 29 };
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}

function fromDosDateTime(date: number, time: number): Date {
  return new Date(1980 + (date >> 9), ((date >> 5) & 0x0f) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

/** Builds a complete archive in memory. Entry order is kept; duplicate names are rejected. */
export function createZip(entries: readonly ZipEntryInput[]): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new ZipError(`An archive holds at most ${MAX_ENTRIES} entries.`);
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    const name = validName(entry.name);
    if (seen.has(name)) throw new ZipError(`Duplicate archive entry name: ${JSON.stringify(name)}`);
    seen.add(name);
    const nameBytes = encoder.encode(name);
    if (nameBytes.length > MAX_NAME_BYTES) throw new ZipError("Archive entry name is too long.");
    const data = typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    return { nameBytes, data, crc: crc32(data), ...dosDateTime(entry.modifiedAt ?? new Date()) };
  });
  const localSize = prepared.reduce((sum, entry) => sum + LOCAL_HEADER_SIZE + entry.nameBytes.length + entry.data.length, 0);
  const centralSize = prepared.reduce((sum, entry) => sum + CENTRAL_HEADER_SIZE + entry.nameBytes.length, 0);
  if (localSize + centralSize > MAX_UINT32) throw new ZipError("Archive exceeds 4 GiB; split the export.");

  const archive = new Uint8Array(localSize + centralSize + END_SIZE);
  const view = new DataView(archive.buffer);
  const offsets: number[] = [];
  let at = 0;
  for (const entry of prepared) {
    offsets.push(at);
    view.setUint32(at, LOCAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, UTF8_NAMES, true);
    view.setUint16(at + 8, STORED, true);
    view.setUint16(at + 10, entry.time, true);
    view.setUint16(at + 12, entry.date, true);
    view.setUint32(at + 14, entry.crc, true);
    view.setUint32(at + 18, entry.data.length, true);
    view.setUint32(at + 22, entry.data.length, true);
    view.setUint16(at + 26, entry.nameBytes.length, true);
    view.setUint16(at + 28, 0, true);
    archive.set(entry.nameBytes, at + LOCAL_HEADER_SIZE);
    archive.set(entry.data, at + LOCAL_HEADER_SIZE + entry.nameBytes.length);
    at += LOCAL_HEADER_SIZE + entry.nameBytes.length + entry.data.length;
  }
  const centralStart = at;
  prepared.forEach((entry, index) => {
    view.setUint32(at, CENTRAL_HEADER, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, VERSION, true);
    view.setUint16(at + 8, UTF8_NAMES, true);
    view.setUint16(at + 10, STORED, true);
    view.setUint16(at + 12, entry.time, true);
    view.setUint16(at + 14, entry.date, true);
    view.setUint32(at + 16, entry.crc, true);
    view.setUint32(at + 20, entry.data.length, true);
    view.setUint32(at + 24, entry.data.length, true);
    view.setUint16(at + 28, entry.nameBytes.length, true);
    // Extra field, comment, disk number, internal and external attributes stay zero.
    view.setUint32(at + 42, offsets[index], true);
    archive.set(entry.nameBytes, at + CENTRAL_HEADER_SIZE);
    at += CENTRAL_HEADER_SIZE + entry.nameBytes.length;
  });
  view.setUint32(at, END_OF_CENTRAL_DIRECTORY, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return archive;
}

function fail(reason: string): never {
  throw new ZipError(`Malformed archive: ${reason}.`);
}

/** Parses an archive written by createZip (stored entries, UTF-8 names, no ZIP64) and verifies every CRC-32. */
export function readZip(archive: Uint8Array): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const end = archive.length - END_SIZE;
  if (end < 0 || view.getUint32(end, true) !== END_OF_CENTRAL_DIRECTORY) fail("no end of central directory record (comments are not supported)");
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralStart = view.getUint32(end + 16, true);
  if (view.getUint32(end + 4, true) !== 0 || view.getUint16(end + 8, true) !== count || view.getUint16(end + 20, true) !== 0) fail("multi-disk archive or comment");
  if (centralStart + centralSize !== end) fail("central directory bounds");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let at = centralStart;
  let expectedLocal = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_HEADER_SIZE > end || view.getUint32(at, true) !== CENTRAL_HEADER) fail("central directory header");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const time = view.getUint16(at + 12, true);
    const date = view.getUint16(at + 14, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const localStart = view.getUint32(at + 42, true);
    if (flags !== UTF8_NAMES || method !== STORED || view.getUint32(at + 24, true) !== size) fail("only stored entries with UTF-8 names are supported");
    if (view.getUint16(at + 30, true) !== 0 || view.getUint16(at + 32, true) !== 0) fail("extra fields or comments");
    if (at + CENTRAL_HEADER_SIZE + nameLength > end) fail("central directory name");
    const nameBytes = archive.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLength);
    at += CENTRAL_HEADER_SIZE + nameLength;

    // Entries are contiguous and in central directory order: nothing hides between them.
    if (localStart !== expectedLocal || localStart + LOCAL_HEADER_SIZE > centralStart) fail("local header offset");
    if (view.getUint32(localStart, true) !== LOCAL_HEADER) fail("local header signature");
    const sameHeader = view.getUint16(localStart + 6, true) === flags && view.getUint16(localStart + 8, true) === method
      && view.getUint16(localStart + 10, true) === time && view.getUint16(localStart + 12, true) === date
      && view.getUint32(localStart + 14, true) === crc && view.getUint32(localStart + 18, true) === size
      && view.getUint32(localStart + 22, true) === size && view.getUint16(localStart + 26, true) === nameLength
      && view.getUint16(localStart + 28, true) === 0;
    if (!sameHeader) fail("local header differs from the central directory");
    const dataStart = localStart + LOCAL_HEADER_SIZE + nameLength;
    if (dataStart + size > centralStart) fail("entry data bounds");
    const localName = archive.subarray(localStart + LOCAL_HEADER_SIZE, dataStart);
    if (localName.some((byte, i) => byte !== nameBytes[i])) fail("local name differs from the central directory");
    const data = archive.slice(dataStart, dataStart + size);
    if (crc32(data) !== crc) fail("CRC-32 mismatch");
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      fail("entry name is not UTF-8");
    }
    entries.push({ name, data, crc32: crc, modifiedAt: fromDosDateTime(date, time) });
    expectedLocal = dataStart + size;
  }
  if (at !== end || expectedLocal !== centralStart) fail("trailing or unreferenced bytes");
  return entries;
}
