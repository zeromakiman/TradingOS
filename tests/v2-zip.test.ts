import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 as nodeCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, createZip, readZip, ZipError } from "@/lib/zip";

// docs/V2_ARCHITECTURE.md §10.5: the browser builds "Download my data (.zip)" with src/lib/zip.ts (store method,
// CRC-32, UTF-8 names). Golden bytes below are derived by hand from PKWARE APPNOTE 6.3 §4.3.7, §4.3.12, §4.3.16.

const utf8 = (text: string) => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const u16 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint16(at, true);
const u32 = (bytes: Uint8Array, at: number) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);
// Local time, so the MS-DOS fields are the same in every time zone.
const STAMP = new Date(2026, 9, 17, 12, 34, 56);

describe("crc32", () => {
  it.each([
    ["", 0x00000000],
    ["a", 0xe8b7be43],
    ["abc", 0x352441c2],
    ["123456789", 0xcbf43926],
    ["The quick brown fox jumps over the lazy dog", 0x414fa339],
    ["hello", 0x3610a686],
  ])("matches the IEEE 802.3 check value for %j", (text, expected) => {
    expect(crc32(utf8(text))).toBe(expected);
  });

  it("agrees with zlib on random data and continues across chunks", () => {
    for (const size of [1, 7, 256, 4096, 65_537]) {
      const data = new Uint8Array(randomBytes(size));
      expect(crc32(data), `size ${size}`).toBe(nodeCrc32(data));
      const split = Math.floor(size / 3);
      expect(crc32(data.subarray(split), crc32(data.subarray(0, split)))).toBe(nodeCrc32(data));
    }
  });
});

describe("createZip", () => {
  it("writes the exact APPNOTE layout for a stored entry with a UTF-8 name flag", () => {
    const archive = createZip([{ name: "a.txt", data: "hello", modifiedAt: STAMP }]);
    expect(hex(archive)).toBe([
      // Local file header: signature, version 2.0, flags (bit 11: UTF-8), stored, time 12:34:56, date 2026-10-17,
      // CRC-32, compressed and uncompressed size 5, name length 5, no extra field; then the name and the data.
      "504b0304", "1400", "0008", "0000", "5c64", "515d", "86a61036", "05000000", "05000000", "0500", "0000", hex(utf8("a.txt")), hex(utf8("hello")),
      // Central directory header: made by 2.0 (MS-DOS), needs 2.0, same fields, no extra/comment/disk/attributes, offset 0.
      "504b0102", "1400", "1400", "0008", "0000", "5c64", "515d", "86a61036", "05000000", "05000000", "0500", "0000", "0000", "0000", "0000",
      "00000000", "00000000", hex(utf8("a.txt")),
      // End of central directory: one entry, directory of 51 bytes at offset 40, no comment.
      "504b0506", "0000", "0000", "0100", "0100", "33000000", "28000000", "0000",
    ].join(""));
  });

  it("writes an empty archive as a bare end-of-central-directory record", () => {
    const archive = createZip([]);
    expect(hex(archive)).toBe(`504b0506${"00".repeat(18)}`);
    expect(readZip(archive)).toEqual([]);
  });

  it("round-trips binary, empty, large and non-ASCII entries byte for byte, in order", () => {
    const binary = new Uint8Array(randomBytes(4096));
    const large = new Uint8Array(randomBytes(1_048_576));
    const inputs = [
      { name: "trading-os-export/core.json", data: JSON.stringify({ equity: "10000.00", note: "Ünïcödé € 日本" }) },
      { name: "trading-os-export/screenshots/EURUSD long · Oct 14/évidence 1.png", data: binary },
      { name: "trading-os-export/empty.txt", data: new Uint8Array(0) },
      { name: "日本語/チャート.webp", data: large },
    ];
    const entries = readZip(createZip(inputs.map((input) => ({ ...input, modifiedAt: STAMP }))));
    expect(entries.map((entry) => entry.name)).toEqual(inputs.map((input) => input.name));
    entries.forEach((entry, index) => {
      const expected = typeof inputs[index].data === "string" ? utf8(inputs[index].data) : inputs[index].data;
      expect(Buffer.from(entry.data).equals(Buffer.from(expected)), entry.name).toBe(true);
      expect(entry.crc32).toBe(nodeCrc32(expected));
      expect(entry.modifiedAt).toEqual(STAMP);
    });
  });

  it("stores names as UTF-8 and flags them in every local and central header", () => {
    const name = "évidence/€ 日本.png";
    const archive = createZip([{ name, data: "x", modifiedAt: STAMP }]);
    const nameBytes = utf8(name);
    expect(u16(archive, 6)).toBe(0x0800);
    expect(u16(archive, 26)).toBe(nameBytes.length);
    expect(hex(archive.subarray(30, 30 + nameBytes.length))).toBe(hex(nameBytes));
    const central = 30 + nameBytes.length + 1;
    expect(u32(archive, central)).toBe(0x02014b50);
    expect(u16(archive, central + 8)).toBe(0x0800);
    expect(hex(archive.subarray(central + 46, central + 46 + nameBytes.length))).toBe(hex(nameBytes));
  });

  it("stores MS-DOS times at two-second resolution and clamps them to 1980-2107", () => {
    const [odd, early, late] = readZip(createZip([
      { name: "odd", data: "", modifiedAt: new Date(2026, 0, 2, 3, 4, 5) },
      { name: "early", data: "", modifiedAt: new Date(1970, 0, 1) },
      { name: "late", data: "", modifiedAt: new Date(2200, 0, 1) },
    ]));
    expect(odd.modifiedAt).toEqual(new Date(2026, 0, 2, 3, 4, 4));
    expect(early.modifiedAt).toEqual(new Date(1980, 0, 1));
    expect(late.modifiedAt).toEqual(new Date(2107, 11, 31, 23, 59, 58));
    expect(() => createZip([{ name: "bad", data: "", modifiedAt: new Date(Number.NaN) }])).toThrow(ZipError);
  });

  it.each(["", "/absolute.json", "a/../b.json", "./a.json", "a//b.json", "folder/", "back\\slash.json", "c:/drive.json", "tab\tname", "nul\u0000.json"])(
    "rejects the unsafe entry name %j",
    (name) => {
      expect(() => createZip([{ name, data: "x" }])).toThrow(ZipError);
    },
  );

  it("rejects duplicate names", () => {
    expect(() => createZip([{ name: "a.json", data: "1" }, { name: "a.json", data: "2" }])).toThrow(/Duplicate/);
  });
});

describe("readZip", () => {
  const sample = () => createZip([{ name: "a.txt", data: "hello", modifiedAt: STAMP }, { name: "b.txt", data: "world", modifiedAt: STAMP }]);

  it("rejects a changed data byte through the CRC-32", () => {
    const archive = sample();
    archive[35] ^= 0xff;
    expect(() => readZip(archive)).toThrow(/CRC-32 mismatch/);
  });

  it("rejects a local header that disagrees with the central directory", () => {
    const archive = sample();
    archive[22] = 4;
    expect(() => readZip(archive)).toThrow(/local header differs/);
  });

  it("rejects truncated archives, trailing bytes and archive comments", () => {
    const archive = sample();
    expect(() => readZip(archive.subarray(0, archive.length - 1))).toThrow(ZipError);
    expect(() => readZip(new Uint8Array([...archive, 0]))).toThrow(ZipError);
    const commented = new Uint8Array([...archive, 0x41, 0x42]);
    new DataView(commented.buffer).setUint16(archive.length - 2, 2, true);
    expect(() => readZip(commented)).toThrow(ZipError);
    expect(() => readZip(new Uint8Array(10))).toThrow(ZipError);
  });

  it("rejects data hidden between entries", () => {
    const archive = sample();
    const view = new DataView(archive.buffer);
    const end = archive.length - 22;
    const second = view.getUint32(end + 16, true) + 46 + 5;
    view.setUint32(second + 42, view.getUint32(second + 42, true) + 1, true);
    expect(() => readZip(archive)).toThrow(/local header offset/);
  });
});

describe("client safety", () => {
  it("imports nothing, so client components can bundle it", () => {
    expect(readFileSync("src/lib/zip.ts", "utf8")).not.toMatch(/^\s*import\s|require\(/m);
  });
});
