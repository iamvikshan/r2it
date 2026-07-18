import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"

/**
 * Compute SHA-256 hash of a file, streaming for large files.
 * Returns hex-encoded hash string.
 */
export async function hashFile(filePath: string): Promise<string> {
  const fileStat = await stat(filePath)

  // For files under 4MB, read into memory (faster for small files)
  if (fileStat.size < 4 * 1024 * 1024) {
    const buf = await readFile(filePath)
    return createHash("sha256").update(buf).digest("hex")
  }

  // For larger files, stream to avoid memory pressure
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(filePath)
    stream.on("data", chunk => hash.update(chunk))
    stream.on("end", () => resolve(hash.digest("hex")))
    stream.on("error", reject)
  })
}

/**
 * Compute SHA-256 hash of a buffer.
 */
export function hashBuffer(buf: ArrayBuffer | Uint8Array): string {
  return createHash("sha256").update(new Uint8Array(buf)).digest("hex")
}

/**
 * Compute SHA-256 hash of a string.
 */
export function hashString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

/**
 * Get the R2 object key for a given hash.
 * Uses first 2 chars as directory prefix to avoid flat listing issues.
 * e.g. "a38f2c...d4" → "objects/a3/8f2c...d4"
 */
export function objectKey(hash: string, projectPrefix: string): string {
  const dir = hash.slice(0, 2)
  const rest = hash.slice(2)
  return `${projectPrefix}objects/${dir}/${rest}`
}

/**
 * Get the R2 manifest key for a given timestamp.
 * e.g. "2026-07-18T07-58Z" → "manifests/2026-07-18T07-58Z.json"
 */
export function manifestKey(timestamp: string, projectPrefix: string): string {
  return `${projectPrefix}manifests/${timestamp}.json`
}
