import {
  chmodSync,
  mkdirSync,
  copyFileSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  realpathSync,
} from "node:fs"
import { join, resolve, dirname } from "node:path"
import { archiveEntryPath, legacyArchiveEntryPath } from "./archive"
import { checkPathExists } from "./fs"
import { hashFile, hashBuffer } from "./hash"
import { warn } from "./log"
import type { ManifestEntry } from "./store-types"

export type RestoreStatus = "restored" | "cached" | "error"

/**
 * Restore a single file or symlink from an extracted archive.
 * For symlinks, recreates the link at the destination.
 * For regular files, checks hash before copying.
 */
export async function restoreSingleFile(
  originalPath: string,
  absolutePath: string,
  entry: ManifestEntry,
  tmpDir: string,
): Promise<RestoreStatus> {
  // Resolve tmpDir to canonical path for validation
  const canonicalTmpDir = realpathSync(tmpDir)

  const stripped = absolutePath.startsWith("/")
    ? absolutePath.slice(1)
    : absolutePath
  const candidates = [
    join(tmpDir, archiveEntryPath(entry.hash)),
    join(tmpDir, legacyArchiveEntryPath(originalPath)),
    `${tmpDir}${absolutePath}`,
    join(tmpDir, stripped),
  ]

  let sourcePath: string | undefined
  for (const candidate of candidates) {
    try {
      const stat = lstatSync(candidate)

      // Resolve candidate and validate it's within tmpDir
      const resolvedCandidate = realpathSync(candidate)
      if (!resolvedCandidate.startsWith(canonicalTmpDir + "/") && resolvedCandidate !== canonicalTmpDir) {
        warn(`Candidate ${candidate} resolves outside tmpDir, skipping`, "restore")
        continue
      }

      // For regular files, require the source to be a regular file (not a symlink)
      if (entry.type !== "symlink-tar" && !stat.isFile()) {
        warn(`Candidate ${candidate} is not a regular file, skipping`, "restore")
        continue
      }

      sourcePath = candidate
      break
    } catch {
      continue
    }
  }

  if (!sourcePath) return "error"

  if (entry.type === "symlink-tar") {
    try {
      const sourceStat = lstatSync(sourcePath)
      const linkTarget = sourceStat.isSymbolicLink()
        ? readlinkSync(sourcePath, { encoding: "buffer" })
        : readFileSync(sourcePath)

      // Validate symlink target hash and size match manifest
      const actualHash = hashBuffer(linkTarget)
      if (actualHash !== entry.hash) {
        warn(
          `Symlink ${originalPath} hash mismatch: expected ${entry.hash}, got ${actualHash}`,
          "restore",
        )
        return "error"
      }
      if (linkTarget.length !== entry.size) {
        warn(
          `Symlink ${originalPath} size mismatch: expected ${entry.size}, got ${linkTarget.length}`,
          "restore",
        )
        return "error"
      }

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

  // Validate source file hash and size match manifest before copying
  try {
    const sourceStat = lstatSync(sourcePath)
    if (sourceStat.size !== entry.size) {
      warn(
        `File ${originalPath} size mismatch in archive: expected ${entry.size}, got ${sourceStat.size}`,
        "restore",
      )
      return "error"
    }

    const sourceHash = await hashFile(sourcePath)
    if (sourceHash !== entry.hash) {
      warn(
        `File ${originalPath} hash mismatch in archive: expected ${entry.hash}, got ${sourceHash}`,
        "restore",
      )
      return "error"
    }
  } catch (e) {
    warn(
      `Failed to validate source file ${sourcePath}: ${e instanceof Error ? e.message : String(e)}`,
      "restore",
    )
    return "error"
  }

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
    } catch {}
  }

  // Validate destination path: reject symlinks in parent directories
  const dir = absolutePath.substring(0, absolutePath.lastIndexOf("/"))
  try {
    mkdirSync(dir, { recursive: true })

    // Check each component of the path to ensure no symlinks
    let checkPath = dir
    const components = checkPath.split("/").filter(c => c)
    let builtPath = ""
    for (const component of components) {
      builtPath += "/" + component
      try {
        const stat = lstatSync(builtPath)
        if (stat.isSymbolicLink()) {
          warn(
            `Destination path ${absolutePath} contains symlink component ${builtPath}`,
            "restore",
          )
          return "error"
        }
      } catch {
        // Path doesn't exist yet, that's OK
      }
    }
  } catch (e) {
    warn(
      `Failed to create directory ${dir}: ${e instanceof Error ? e.message : String(e)}`,
      "restore",
    )
    return "error"
  }

  // Check if destination is a symlink before copying
  try {
    const destStat = lstatSync(absolutePath)
    if (destStat.isSymbolicLink()) {
      warn(`Destination ${absolutePath} is a symlink, removing before copy`, "restore")
      unlinkSync(absolutePath)
    }
  } catch {
    // File doesn't exist, that's fine
  }

  copyFileSync(sourcePath, absolutePath)
  try {
    chmodSync(absolutePath, parseInt(entry.mode, 8))
  } catch {
    warn(`Could not set permissions on ${absolutePath}`, "restore")
  }

  return "restored"
}
