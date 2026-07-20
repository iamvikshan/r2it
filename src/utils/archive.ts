import { lstatSync, mkdirSync, readlinkSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { UploadSink } from "./r2"

const TAR_BLOCK_SIZE = 512
const TAR_SIZE_MAX = Number.parseInt("77777777777", 8)
const textEncoder = new TextEncoder()

type PreparedArchiveEntry =
  | {
      kind: "file"
      archivePath: string
      absolutePath: string
      originalPath: string
      expectedHash: string
      mode: number
      mtimeMs: number
      size: number
    }
  | {
      kind: "inline"
      archivePath: string
      data: Uint8Array<ArrayBuffer>
      originalPath: string
      expectedHash: string
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
): { needsPaxMtime?: boolean } {
  const truncated = Math.trunc(value)
  if (truncated < 0) {
    // Negative mtime: caller must emit PAX record
    writeTarString(target, offset, length, `${Array(length - 1).fill("0").join("")}\0`)
    return { needsPaxMtime: true }
  }
  const octal = truncated.toString(8)
  if (octal.length > length - 1) {
    throw new Error(`Tar numeric field exceeds ${length} bytes: ${value}`)
  }
  writeTarString(target, offset, length, `${octal.padStart(length - 1, "0")}\0`)
  return {}
}

function createTarHeader(
  entry: PreparedArchiveEntry,
  options: {
    archivePath?: string
    size?: number
    typeFlag?: number
  } = {},
): { header: Uint8Array<ArrayBuffer>; needsPaxMtime?: boolean } {
  const header = new Uint8Array(new ArrayBuffer(TAR_BLOCK_SIZE))
  writeTarString(header, 0, 100, options.archivePath ?? entry.archivePath)
  writeTarOctal(header, 100, 8, entry.mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, options.size ?? entry.size)
  const mtimeResult = writeTarOctal(header, 136, 12, Math.floor(entry.mtimeMs / 1000))
  header.fill(0x20, 148, 156)
  header[156] = options.typeFlag ?? 0x30
  writeTarString(header, 257, 6, "ustar\0")
  writeTarString(header, 263, 2, "00")

  let checksum = 0
  for (const byte of header) checksum += byte
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  if (mtimeResult.needsPaxMtime !== undefined) {
    return { header, needsPaxMtime: mtimeResult.needsPaxMtime }
  }
  return { header }
}

function createPaxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  let length = 0
  for (;;) {
    const bytes = textEncoder.encode(`${length} ${key}=${value}\n`)
    if (bytes.length === length) return bytes
    length = bytes.length
  }
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
        const data = Uint8Array.from(
          readlinkSync(path.absolute, { encoding: "buffer" }),
        )
        entries.push({
          kind: "inline",
          archivePath,
          data,
          originalPath: path.original,
          expectedHash: path.hash,
          mode,
          mtimeMs: stat.mtimeMs,
          size: data.length,
        })
      } else if (stat.isFile()) {
        entries.push({
          kind: "file",
          archivePath,
          absolutePath: path.absolute,
          originalPath: path.original,
          expectedHash: path.hash,
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

async function streamCompressedOutput(
  readable: ReadableStream<Uint8Array>,
  sink: UploadSink,
): Promise<number> {
  const reader = readable.getReader()
  let writtenBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return writtenBytes
      await sink.write(value)
      writtenBytes += value.length
    }
  } catch (e) {
    await reader.cancel(e).catch(() => undefined)
    throw e
  }
}

export async function createArchive(
  paths: Array<{ original: string; absolute: string; hash: string }>,
  openSink: () => UploadSink,
): Promise<{
  size: number
  errors: Array<{ path: string; reason: string }>
}> {
  const { entries, errors } = prepareArchiveEntries(paths)
  if (errors.length > 0 || entries.length === 0) {
    return { size: 0, errors }
  }

  const sink = openSink()
  const compression = new CompressionStream("gzip")
  const output = streamCompressedOutput(compression.readable, sink)
  const writer = compression.writable.getWriter()

  try {
    for (const entry of entries) {
      const paxRecords: string[] = []

      if (entry.size > TAR_SIZE_MAX) {
        paxRecords.push(`size=${String(entry.size)}`)
      }

      const mtimeSec = Math.floor(entry.mtimeMs / 1000)
      if (mtimeSec < 0) {
        paxRecords.push(`mtime=${(entry.mtimeMs / 1000).toFixed(9)}`)
      }

      if (paxRecords.length > 0) {
        let paxBody = ""
        for (const record of paxRecords) {
          const paxRec = createPaxRecord(record.split("=")[0] ?? "", record.split("=")[1] ?? "")
          paxBody += new TextDecoder().decode(paxRec)
        }
        const paxData = textEncoder.encode(paxBody)
        const paxHdr = createTarHeader(entry, {
          archivePath: `PaxHeaders/${entry.expectedHash}`,
          size: paxData.length,
          typeFlag: 0x78,
        })
        await writer.write(paxHdr.header)
        await writer.write(paxData)
        const paxPadding =
          (TAR_BLOCK_SIZE - (paxData.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
        if (paxPadding > 0) await writer.write(new Uint8Array(paxPadding))
      }

      const mainHdr = createTarHeader(entry, {
        size: entry.size > TAR_SIZE_MAX ? 0 : entry.size,
      })
      await writer.write(mainHdr.header)
      let writtenBytes = 0
      const hasher = new Bun.CryptoHasher("sha256")

      if (entry.kind === "inline") {
        await writer.write(entry.data)
        hasher.update(entry.data)
        writtenBytes = entry.data.length
      } else {
        const reader = Bun.file(entry.absolutePath).stream().getReader()
        let result = await reader.read()
        while (!result.done) {
          await writer.write(result.value)
          hasher.update(result.value)
          writtenBytes += result.value.length
          result = await reader.read()
        }
      }

      if (writtenBytes !== entry.size) {
        throw new Error(
          `File changed while archiving ${entry.originalPath}: expected ${entry.size} bytes, read ${writtenBytes}`,
        )
      }
      const actualHash = hasher.digest("hex")
      if (actualHash !== entry.expectedHash) {
        throw new Error(
          `File changed while archiving ${entry.originalPath}: expected hash ${entry.expectedHash}, read ${actualHash}`,
        )
      }

      const padding =
        (TAR_BLOCK_SIZE - (entry.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE
      if (padding > 0) await writer.write(new Uint8Array(padding))
    }

    await writer.write(new Uint8Array(TAR_BLOCK_SIZE * 2))
    await writer.close()
    const size = await output
    await sink.end()
    return { size, errors }
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    await writer.abort(error).catch(() => undefined)
    await output.catch(() => undefined)
    await Promise.resolve(sink.end(error)).catch(() => undefined)
    throw error
  }
}

export async function extractArchive(
  archive: ReadableStream<Uint8Array>,
  targetDir: string,
): Promise<{ errors: Array<{ path: string; reason: string }> }> {
  const errors: Array<{ path: string; reason: string }> = []

  // Harden setup failures
  try {
    mkdirSync(targetDir, { recursive: true })
  } catch (e) {
    errors.push({
      path: targetDir,
      reason: `Failed to create target directory: ${e instanceof Error ? e.message : String(e)}`,
    })
    return { errors }
  }

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["tar", "-xzf", "-", "-C", targetDir], {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    })
  } catch (e) {
    errors.push({
      path: targetDir,
      reason: `Failed to spawn tar: ${e instanceof Error ? e.message : String(e)}`,
    })
    return { errors }
  }

  const reader = archive.getReader()

  // Begin draining stderr immediately
  const stderrPromise = new Response(proc.stderr as ReadableStream<Uint8Array>).text()

  const stdin = proc.stdin
  if (!stdin || typeof stdin === "number") {
    errors.push({
      path: targetDir,
      reason: "Failed to get stdin pipe from tar process",
    })
    return { errors }
  }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await stdin.write(value)
    }
    await stdin.end()
  } catch (e) {
    await reader.cancel(e).catch(() => undefined)
    await Promise.resolve(
      stdin.end(e instanceof Error ? e : new Error(String(e))),
    ).catch(() => undefined)
  }

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = (await stderrPromise).trim()
    errors.push({ path: targetDir, reason: `Extraction failed: ${stderr}` })
    return { errors }
  }

  // Validate extracted archive members: only allow regular files and directories
  // under entries/<hash> or entries/<base64url>, reject symlinks, hardlinks, and special files
  try {
    validateExtractedArchive(targetDir, errors)
  } catch (e) {
    errors.push({
      path: targetDir,
      reason: `Validation failed: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  return { errors }
}

function validateExtractedArchive(
  targetDir: string,
  errors: Array<{ path: string; reason: string }>,
): void {
  function walkAndValidate(dir: string, relativePath: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch (e) {
      errors.push({
        path: relativePath,
        reason: `Cannot read directory: ${e instanceof Error ? e.message : String(e)}`,
      })
      return
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry)
      const relPath = relativePath ? `${relativePath}/${entry}` : entry

      try {
        const stat = lstatSync(fullPath)

        // Check if path is within allowed prefixes
        const isUnderEntries = relPath.startsWith("entries/")
        const isEntriesDir = relPath === "entries"
        const isPaxHeaders = relPath.startsWith("PaxHeaders/")

        if (!isUnderEntries && !isEntriesDir && !isPaxHeaders) {
          errors.push({
            path: relPath,
            reason: "Archive member outside entries/ directory",
          })
          try {
            rmSync(fullPath, { recursive: true, force: true })
          } catch {}
          continue
        }

        // Reject symlinks, special files, and anything that's not a regular file or directory
        if (stat.isSymbolicLink()) {
          errors.push({
            path: relPath,
            reason: "Symlinks not allowed in archive",
          })
          try {
            rmSync(fullPath, { recursive: true, force: true })
          } catch {}
          continue
        }

        if (!stat.isFile() && !stat.isDirectory()) {
          errors.push({
            path: relPath,
            reason: "Special file type not allowed in archive",
          })
          try {
            rmSync(fullPath, { recursive: true, force: true })
          } catch {}
          continue
        }

        // Recurse into directories
        if (stat.isDirectory()) {
          walkAndValidate(fullPath, relPath)
        }
      } catch (e) {
        errors.push({
          path: relPath,
          reason: `Validation error: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }
  }

  walkAndValidate(targetDir, "")
}
