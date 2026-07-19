import {
  existsSync,
  chmodSync,
  mkdirSync,
  copyFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { checkPathExists } from "./fs"
import { hashFile } from "./hash"
import { warn } from "./log"
import type { ManifestEntry } from "./store-types"

export type RestoreStatus = "restored" | "cached" | "error"

/**
 * Restore a single file or symlink from an extracted archive.
 * For symlinks, recreates the link at the destination.
 * For regular files, checks hash before copying.
 */
export async function restoreSingleFile(
  absolutePath: string,
  entry: ManifestEntry,
  tmpDir: string,
): Promise<RestoreStatus> {
  // Find the file in the extracted archive
  const extractedPath = `${tmpDir}${absolutePath}`
  let sourcePath: string | null = null

  if (existsSync(extractedPath)) {
    sourcePath = extractedPath
  } else {
    const stripped = absolutePath.startsWith("/")
      ? absolutePath.slice(1)
      : absolutePath
    const altPath = `${tmpDir}/${stripped}`
    if (existsSync(altPath)) {
      sourcePath = altPath
    }
  }

  if (!sourcePath) return "error"

  // Symlink restoration
  if (entry.type === "symlink-tar") {
    try {
      const linkTarget = readlinkSync(sourcePath)
      // Remove existing file/link at destination
      try {
        unlinkSync(absolutePath)
      } catch {}
      const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"))
      mkdirSync(dir, { recursive: true })
      symlinkSync(linkTarget, absolutePath)
      return "restored"
    } catch (e) {
      warn(
        `Could not restore symlink ${absolutePath}: ${e instanceof Error ? e.message : String(e)}`,
        "restore",
      )
      return "error"
    }
  }

  // Regular file — check if local already matches
  const exists = await checkPathExists(absolutePath)
  if (exists) {
    try {
      const localHash = await hashFile(absolutePath)
      if (localHash === entry.hash) {
        try {
          chmodSync(absolutePath, parseInt(entry.mode, 8))
        } catch {}
        return "cached"
      }
    } catch {
      // Can't hash — proceed with restore
    }
  }

  // Copy to final location
  const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"))
  mkdirSync(dir, { recursive: true })
  copyFileSync(sourcePath, absolutePath)
  try {
    chmodSync(absolutePath, parseInt(entry.mode, 8))
  } catch {
    warn(`Could not set permissions on ${absolutePath}`, "restore")
  }

  return "restored"
}
