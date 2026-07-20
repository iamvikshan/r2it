import { lstatSync, mkdirSync, readlinkSync } from "node:fs"

const TAR_BLOCK_SIZE = 512
const textEncoder = new TextEncoder()

type PreparedArchiveEntry =
  | {
      kind: "file"
      archivePath: string
      absolutePath: string
      mode: number
      mtimeMs: number
      size: number
    }
  | {
      kind: "inline"
      archivePath: string
      data: Uint8Array<ArrayBuffer>
      mode: number
      mtimeMs: number
      size: number
    }

export function archiveEntryPath(entryHash: string): string {
  return `entries/${entryHash}`
}

export function legacyArchiveEntryPath(originalPath: string): string {
  return `entries/${Buffer.from(originalPath).toString("base64url")}`
}

function writeTarString(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = textEncoder.encode(value)
  if (bytes.length > length) {
    throw new Error(`Tar field exceeds ${length} bytes: ${value}`)
  }
  target.set(bytes, offset)
}

function writeTarOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const octal = Math.trunc(value).toString(8)
  if (octal.length > length - 1) {
    throw new Error(`Tar numeric field exceeds ${length} bytes: ${value}`)
  }
  writeTarString(target, offset, length, `${octal.padStart(length - 1, "0")}\0`)
}

function createTarHeader(entry: PreparedArchiveEntry): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(new ArrayBuffer(TAR_BLOCK_SIZE))
  writeTarString(header, 0, 100, entry.archivePath)
  writeTarOctal(header, 100, 8, entry.mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, entry.size)
  writeTarOctal(header, 136, 12, Math.floor(entry.mtimeMs / 1000))
  header.fill(0x20, 148, 156)
  header[156] = 0x30
  writeTarString(header, 257, 6, "ustar\0")
  writeTarString(header, 263, 2, "00")

  let checksum = 0
  for (const byte of header) checksum += byte
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function prepareArchiveEntries(
  paths: Array<{ original: string; absolute: string; hash: string }>,
): {
  entries: PreparedArchiveEntry[]
  errors: Array<{ path: string; reason: string }>
} {
  const entries: PreparedArchiveEntry[] = []
  const errors: Array<{ path: string; reason: string }> = []
  const archivedPaths = new Set<string>()

  for (const path of paths) {
    const archivePath = archiveEntryPath(path.hash)
    if (archivedPaths.has(archivePath)) continue

    try {
      const stat = lstatSync(path.absolute)
      const mode = stat.mode & 0o7777
      if (stat.isSymbolicLink()) {
        const data = new Uint8Array(
          textEncoder.encode(readlinkSync(path.absolute)),
        )
        entries.push({
          kind: "inline",
          archivePath,
          data,
          mode,
          mtimeMs: stat.mtimeMs,
          size: data.length,
        })
      } else if (stat.isFile()) {
        entries.push({
          kind: "file",
          archivePath,
          absolutePath: path.absolute,
          mode,
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        })
      } else {
        errors.push({ path: path.original, reason: "Unsupported file type" })
        continue
      }
      archivedPaths.add(archivePath)
    } catch (e) {
      errors.push({
        path: path.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { entries, errors }
}

export async function createArchive(
  paths: Array<{ original: string; absolute: string; hash: string }>,
): Promise<{
  archive: Uint8Array
  errors: Array<{ path: string; reason: string }>
}> {
  const { entries, errors } = prepareArchiveEntries(paths)
  if (entries.length === 0) {
    return { archive: new Uint8Array(0), errors }
  }

  const compression = new CompressionStream("gzip")
  const output = new Response(compression.readable).arrayBuffer()
  const writer = compression.writable.getWriter()

  try {
    for (const entry of entries) {
      await writer.write(createTarHeader(entry))
      let writtenBytes = 0

      if (entry.kind === "inline") {
        await writer.write(entry.data)
        writtenBytes = entry.data.length
      } else {
        const reader = Bun.file(entry.absolutePath).stream().getReader()
        let result = await reader.read()
        while (!result.done) {
          await writer.write(result.value)
          writtenBytes += result.value.length
          result = await reader.read()
        }
      }

      if (writtenBytes !== entry.size) {
        throw new Error(
          `File changed while archiving ${entry.archivePath}: expected ${entry.size} bytes, read ${writtenBytes}`,
        )
      }

      const padding =
        (TAR_BLOCK_SIZE - (entry.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
      if (padding > 0) await writer.write(new Uint8Array(padding))
    }

    await writer.write(new Uint8Array(TAR_BLOCK_SIZE * 2))
    await writer.close()
    return { archive: new Uint8Array(await output), errors }
  } catch (e) {
    await writer.abort(e)
    await output.catch(() => undefined)
    throw e
  }
}

export function extractArchive(
  archive: ArrayBuffer | Uint8Array,
  targetDir: string,
): { errors: Array<{ path: string; reason: string }> } {
  const errors: Array<{ path: string; reason: string }> = []
  mkdirSync(targetDir, { recursive: true })

  const proc = Bun.spawnSync(["tar", "-xzf", "-", "-C", targetDir], {
    stdin: new Uint8Array(archive),
  })

  if (!proc.success) {
    const stderr = proc.stderr.toString().trim()
    errors.push({ path: targetDir, reason: `Extraction failed: ${stderr}` })
  }

  return { errors }
}
