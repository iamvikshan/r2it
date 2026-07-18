import type { Manifest, ManifestEntry, ObjectType } from "./store-types"
import { hashFile, hashBuffer } from "./hash"
import { checkPathExists, isSymlink, isDirectory, getFileSize, type PathContext } from "./fs"
import { lstatSync, readlinkSync } from "node:fs"
import { Glob } from "bun"

/**
 * Get file mode as octal string (e.g. "0644").
 */
function getFileMode(filePath: string): string {
  try {
    const mode = lstatSync(filePath).mode & 0o7777
    return mode.toString(8).padStart(4, "0")
  } catch {
    return "0644"
  }
}

/**
 * Get file mtime as ISO string.
 */
function getFileMTime(filePath: string): string {
  try {
    const stat = lstatSync(filePath)
    return stat.mtime.toISOString()
  } catch {
    return new Date().toISOString()
  }
}

/**
 * Create a tar of a single symlink, preserving the link target.
 * Returns the tar buffer.
 */
export async function tarSymlink(filePath: string): Promise<Uint8Array> {
  const target = readlinkSync(filePath)
  // Use tar to create a minimal archive with just this symlink
  const proc = Bun.spawnSync([
    "tar",
    "-cf",
    "-",
    "-C",
    "/",
    "--",
    filePath.slice(1), // strip leading /
  ])
  if (!proc.success) {
    throw new Error(`Failed to tar symlink ${filePath}: ${proc.stderr.toString()}`)
  }
  return proc.stdout
}

/**
 * Build a manifest entry for a single file path.
 * Handles regular files and symlinks differently.
 */
export async function buildEntry(
  absolutePath: string,
  entryType?: ObjectType,
): Promise<{ entry: ManifestEntry; objectData: Uint8Array | null } | null> {
  const exists = await checkPathExists(absolutePath)
  if (!exists) return null

  const symlink = await isSymlink(absolutePath)
  const mode = getFileMode(absolutePath)
  const mtime = getFileMTime(absolutePath)

  if (symlink || entryType === "symlink-tar") {
    // Tar the symlink individually
    const tarData = await tarSymlink(absolutePath)
    const hash = hashBuffer(tarData)
    return {
      entry: {
        hash,
        mode,
        size: tarData.length,
        mtime,
        type: "symlink-tar",
      },
      objectData: tarData,
    }
  }

  // Regular file — hash content, data will be read on upload
  const size = (await getFileSize(absolutePath)) ?? 0
  const hash = await hashFile(absolutePath)
  return {
    entry: {
      hash,
      mode,
      size,
      mtime,
      type: "file",
    },
    objectData: null, // caller reads the file directly for upload
  }
}

/**
 * Build a full manifest from resolved paths.
 */
export async function buildManifest(
  paths: Array<{ original: string; absolute: string }>,
  project: string,
  parentKey: string | null,
): Promise<{
  manifest: Manifest
  objectDataMap: Map<string, Uint8Array>
  errors: Array<{ path: string; reason: string }>
}> {
  const entries: Record<string, ManifestEntry> = {}
  const objectDataMap = new Map<string, Uint8Array>()
  const errors: Array<{ path: string; reason: string }> = []

  // Expand directories into individual files
  const expandedPaths: Array<{ original: string; absolute: string }> = []
  for (const p of paths) {
    const isDir = await isDirectory(p.absolute)
    if (isDir) {
      // Recursively expand directory into individual file entries
      try {
        const glob = new Glob("**/*")
        for (const entry of glob.scanSync({
          cwd: p.absolute,
          absolute: true,
          onlyFiles: false, // Include symlinks
          dot: true,
        })) {
          const relPath = entry.slice(p.absolute.length).replace(/^\//, "")
          const originalPath = `${p.original}/${relPath}`
          expandedPaths.push({ original: originalPath, absolute: entry })
        }
      } catch (e) {
        errors.push({
          path: p.original,
          reason: `Failed to expand directory: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    } else {
      expandedPaths.push(p)
    }
  }

  for (const p of expandedPaths) {
    try {
      const result = await buildEntry(p.absolute)
      if (!result) {
        errors.push({ path: p.original, reason: "file not found" })
        continue
      }
      entries[p.original] = result.entry
      if (result.objectData) {
        objectDataMap.set(result.entry.hash, result.objectData)
      }
    } catch (e) {
      errors.push({
        path: p.original,
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // Generate unique timestamp with milliseconds and random suffix
  const now = new Date()
  const isoWithMs = now.toISOString() // Keep full precision including milliseconds
  const randomSuffix = Math.random().toString(36).substring(2, 8)
  const uniqueTimestamp = `${isoWithMs.replace(/:/g, "-").replace(/\./g, "-")}-${randomSuffix}`

  const manifest: Manifest = {
    version: 1,
    timestamp: uniqueTimestamp,
    project,
    parent: parentKey,
    entries,
  }

  return { manifest, objectDataMap, errors }
}

/**
 * Diff two manifests. Returns entries that are new, changed, or removed.
 */
export function diffManifests(
  local: Manifest,
  remote: Manifest,
): {
  added: string[]
  changed: string[]
  removed: string[]
  unchanged: string[]
} {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  const unchanged: string[] = []

  for (const [path, localEntry] of Object.entries(local.entries)) {
    const remoteEntry = remote.entries[path]
    if (!remoteEntry) {
      added.push(path)
    } else if (
      remoteEntry.hash !== localEntry.hash ||
      remoteEntry.mode !== localEntry.mode ||
      remoteEntry.type !== localEntry.type
    ) {
      changed.push(path)
    } else {
      unchanged.push(path)
    }
  }

  for (const path of Object.keys(remote.entries)) {
    if (!local.entries[path]) {
      removed.push(path)
    }
  }

  return { added, changed, removed, unchanged }
}

/**
 * Serialize a manifest to JSON string.
 */
export function serializeManifest(manifest: Manifest): string {
  return JSON.stringify(manifest, null, 2)
}

/**
 * Deserialize a manifest from JSON string.
 */
export function deserializeManifest(json: string): Manifest {
  return JSON.parse(json) as Manifest
}
