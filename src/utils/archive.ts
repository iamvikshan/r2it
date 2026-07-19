import { Glob } from "bun"
import type { ManifestEntry, ObjectType } from "./store-types"
import {
  lstatSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Create a tar.gz archive from a list of absolute paths.
 * Returns the archive buffer and a map of relative path → entry metadata.
 * Note: Hash field in entries is set to empty string; caller should preserve hashes from buildManifest.
 */
export function createArchive(
  paths: Array<{ original: string; absolute: string; relative: string }>,
): {
  archive: Uint8Array
  entries: Record<string, ManifestEntry>
  errors: Array<{ path: string; reason: string }>
} {
  const entries: Record<string, ManifestEntry> = {}
  const errors: Array<{ path: string; reason: string }> = []
  const validPaths: string[] = []

  // Validate and collect metadata for each path
  for (const p of paths) {
    try {
      const stat = lstatSync(p.absolute)
      const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0")
      const mtime = new Date(stat.mtimeMs).toISOString()

      if (stat.isSymbolicLink()) {
        // Symlinks get stored as-is in the tar
        entries[p.original] = {
          hash: "",
          mode,
          size: 0,
          mtime,
          type: "symlink-tar" as ObjectType,
        }
        validPaths.push(p.absolute)
      } else if (stat.isDirectory()) {
        // Expand directory
        const glob = new Glob("**/*")
        for (const entry of glob.scanSync({
          cwd: p.absolute,
          absolute: true,
          onlyFiles: false,
          dot: true,
        })) {
          try {
            const entryStat = lstatSync(entry)
            if (entryStat.isDirectory()) continue
            const relPath = entry.slice(p.absolute.length).replace(/^\//, "")
            const originalPath = `${p.original}/${relPath}`
            const entryMode = (entryStat.mode & 0o7777)
              .toString(8)
              .padStart(4, "0")
            const entryMtime = new Date(entryStat.mtimeMs).toISOString()
            entries[originalPath] = {
              hash: "", // Caller should preserve hash from buildManifest
              mode: entryMode,
              size: entryStat.size,
              mtime: entryMtime,
              type: "file",
            }
            validPaths.push(entry)
          } catch (e) {
            errors.push({
              path: entry,
              reason: e instanceof Error ? e.message : String(e),
            })
          }
        }
      } else {
        entries[p.original] = {
          hash: "", // Caller should preserve hash from buildManifest
          mode,
          size: stat.size,
          mtime,
          type: "file",
        }
        validPaths.push(p.absolute)
      }
    } catch (e) {
      errors.push({
        path: p.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  if (validPaths.length === 0) {
    return { archive: new Uint8Array(0), entries, errors }
  }

  // Create tar.gz using system tar
  // Use a private temp directory to avoid symlink races and simultaneous-push corruption
  const tmpDir = mkdtempSync(join(tmpdir(), "r2git-archive-"))
  const tmpList = join(tmpDir, "files.txt")
  // NUL-delimited so filenames containing newlines don't break
  writeFileSync(tmpList, validPaths.join("\0"))

  try {
    const proc = Bun.spawnSync(
      ["tar", "-czf", "-", "--null", "--files-from", tmpList],
      { stdin: null },
    )
    if (!proc.success) {
      throw new Error(`tar failed: ${proc.stderr.toString()}`)
    }

    return { archive: proc.stdout, entries, errors }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Extract a tar.gz archive to the filesystem.
 * Returns the list of extracted paths.
 */
export function extractArchive(
  archive: ArrayBuffer | Uint8Array,
  targetDir: string,
): { extracted: string[]; errors: Array<{ path: string; reason: string }> } {
  const extracted: string[] = []
  const errors: Array<{ path: string; reason: string }> = []

  // Ensure target directory exists
  mkdirSync(targetDir, { recursive: true })

  const proc = Bun.spawnSync(["tar", "-xzf", "-", "-C", targetDir], {
    stdin: new Uint8Array(archive),
  })

  if (!proc.success) {
    const stderr = proc.stderr.toString().trim()
    errors.push({ path: targetDir, reason: `Extraction failed: ${stderr}` })
    return { extracted, errors }
  }

  // List extracted files
  const listProc = Bun.spawnSync(["tar", "-tzf", "-"], {
    stdin: new Uint8Array(archive),
  })
  if (listProc.success) {
    const listing = listProc.stdout.toString().trim()
    for (const line of listing.split("\n")) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.endsWith("/")) {
        extracted.push(trimmed)
      }
    }
  }

  return { extracted, errors }
}
