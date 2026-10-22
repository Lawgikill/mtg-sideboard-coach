// A minimal ZIP writer, enough to bundle a set of text files into one download.
//
// Hand-written rather than pulling in a zip library, for the reason recorded against
// tesseract in CLAUDE.md: every runtime dependency is another thing that works in dev
// and then fails in a packaged .exe. This has no dependencies, runs in the renderer,
// and is verified by round-tripping through a real unzip implementation.
//
// Files are **stored, not deflated** (method 0). Compression would want either a
// third-party deflate or `CompressionStream`, and so a second code path to fall back
// on; the files here are tens of kilobytes going to local disk, so the saving is not
// worth a branch that can only be exercised on some machines. The result opens in
// Windows Explorer, macOS Archive Utility and every unzip tool, uncompressed.

const LOCAL_HEADER = 0x04034b50
const CENTRAL_HEADER = 0x02014b50
const END_OF_DIRECTORY = 0x06054b50

// Flag bit 11 declares the filename as UTF-8, which matters because card and player
// names reach these filenames.
const UTF8_FLAG = 0x0800

export type ZipEntry = { name: string; contents: string }

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let value = i
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[i] = value >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ZIP stores timestamps in the MS-DOS format: seconds in 2-second steps, and years
// counted from 1980. Anything earlier cannot be represented, so it clamps.
function dosDateTime(when: Date): { time: number; date: number } {
  const year = Math.max(when.getFullYear(), 1980)
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  }
}

// Allocated from an explicit ArrayBuffer so the result is `Uint8Array<ArrayBuffer>`,
// not `<ArrayBufferLike>`. TextEncoder.encode returns the looser type, which spreads
// through anything built from it and is then rejected as a BlobPart.
function concat(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(new ArrayBuffer(total))
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

// A little-endian field writer, since every number in a ZIP header is little-endian.
function record(fields: Array<[size: 2 | 4, value: number]>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(fields.reduce((sum, [size]) => sum + size, 0)))
  const view = new DataView(out.buffer)
  let at = 0
  for (const [size, value] of fields) {
    if (size === 2) view.setUint16(at, value, true)
    else view.setUint32(at, value >>> 0, true)
    at += size
  }
  return out
}

export function buildZip(entries: ZipEntry[], when = new Date()): Blob {
  const encoder = new TextEncoder()
  const { time, date } = dosDateTime(when)

  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const body = encoder.encode(entry.contents)
    const crc = crc32(body)

    const header = record([
      [4, LOCAL_HEADER], [2, 20], [2, UTF8_FLAG], [2, 0], [2, time], [2, date],
      [4, crc], [4, body.length], [4, body.length], [2, name.length], [2, 0],
    ])
    local.push(header, name, body)

    central.push(record([
      [4, CENTRAL_HEADER], [2, 20], [2, 20], [2, UTF8_FLAG], [2, 0], [2, time], [2, date],
      [4, crc], [4, body.length], [4, body.length], [2, name.length], [2, 0], [2, 0],
      [2, 0], [2, 0], [4, 0], [4, offset],
    ]), name)

    offset += header.length + name.length + body.length
  }

  const directory = concat(central)
  const end = record([
    [4, END_OF_DIRECTORY], [2, 0], [2, 0], [2, entries.length], [2, entries.length],
    [4, directory.length], [4, offset], [2, 0],
  ])

  return new Blob([concat(local), directory, end], { type: 'application/zip' })
}

// Two matches played on the same day against the same opponent produce the same
// filename, and a zip holding duplicate names is a file you cannot fully extract.
export function uniqueNames(entries: ZipEntry[]): ZipEntry[] {
  const seen = new Map<string, number>()

  return entries.map((entry) => {
    const taken = seen.get(entry.name) ?? 0
    seen.set(entry.name, taken + 1)
    if (taken === 0) return entry

    const dot = entry.name.lastIndexOf('.')
    const stem = dot === -1 ? entry.name : entry.name.slice(0, dot)
    const extension = dot === -1 ? '' : entry.name.slice(dot)
    return { ...entry, name: `${stem}-${taken + 1}${extension}` }
  })
}
