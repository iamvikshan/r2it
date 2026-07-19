import { uploadObject, downloadObject, listObjects, deleteObject } from "./r2"
import type { R2Config } from "./types"
import type { Manifest } from "./store-types"
import { serializeManifest, deserializeManifest } from "./manifest"
import { debug, info } from "./log"

/**
 * Upload an archive to R2.
 */
export async function uploadArchive(
  r2: R2Config,
  archive: Uint8Array,
  projectPrefix: string,
): Promise<string> {
  const key = archiveKey(projectPrefix)
  await uploadObject(r2, key, archive, "application/gzip")
  debug(`Uploaded archive ${key}`, "store")
  return key
}

/**
 * Download an archive from R2.
 */
export async function downloadArchive(
  r2: R2Config,
  archiveKey: string,
): Promise<ArrayBuffer> {
  return downloadObject(r2, archiveKey)
}

/**
 * Upload a manifest to R2. On failure, cleans up the archive to prevent orphans.
 */
export async function uploadManifest(
  r2: R2Config,
  manifest: Manifest,
  projectPrefix: string,
): Promise<string> {
  const key = manifestKey(manifest.timestamp, projectPrefix)
  const json = serializeManifest(manifest)
  try {
    await uploadObject(r2, key, json, "application/json")
    debug(`Uploaded manifest ${key}`, "store")
    return key
  } catch (e) {
    // Clean up the archive that was uploaded before this manifest
    if (manifest.archiveKey) {
      try {
        await deleteObject(r2, manifest.archiveKey)
        debug(`Cleaned up orphaned archive ${manifest.archiveKey}`, "store")
      } catch {
        debug(
          `Failed to clean up orphaned archive ${manifest.archiveKey}`,
          "store",
        )
      }
    }
    throw e
  }
}

/**
 * Download a manifest from R2 by key.
 */
export async function downloadManifest(
  r2: R2Config,
  key: string,
): Promise<Manifest> {
  const buf = await downloadObject(r2, key)
  const text = new TextDecoder().decode(buf)
  return deserializeManifest(text)
}

/**
 * List all manifests for a project, sorted newest first.
 */
export async function listManifests(
  r2: R2Config,
  projectPrefix: string,
): Promise<Array<{ key: string; lastModified: string; size: number }>> {
  const prefix = `${projectPrefix}manifests/`
  const all = await listObjects(r2, prefix)
  return all
    .filter(a => a.key.endsWith(".json"))
    .sort(
      (a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
    )
}

/**
 * Get the latest manifest for a project. Returns null if none exist.
 */
export async function getLatestManifest(
  r2: R2Config,
  projectPrefix: string,
): Promise<{ manifest: Manifest; key: string } | null> {
  const manifests = await listManifests(r2, projectPrefix)
  if (manifests.length === 0) return null

  const latest = manifests[0]
  if (!latest) return null
  const manifest = await downloadManifest(r2, latest.key)
  return { manifest, key: latest.key }
}

/**
 * Enforce retention on manifests and their archives.
 * Deletes the manifest first, then its archive. If manifest deletion succeeds
 * but archive deletion fails, the archive is orphaned but the backup is no
 * longer selectable — safer than the reverse order.
 */
export async function enforceManifestRetention(
  r2: R2Config,
  projectPrefix: string,
  retention: number,
): Promise<number> {
  if (
    typeof retention !== "number" ||
    !Number.isInteger(retention) ||
    retention < 1
  ) {
    debug(`Invalid retention value ${retention}, skipping cleanup`, "retention")
    return 0
  }
  let manifests: Array<{ key: string; lastModified: string; size: number }>
  try {
    manifests = await listManifests(r2, projectPrefix)
  } catch (e) {
    info(
      `Failed to list manifests for retention, aborting: ${e instanceof Error ? e.message : String(e)}`,
      "retention",
    )
    return 0
  }

  if (manifests.length <= retention) return 0

  const stale = manifests.slice(retention)

  let deleted = 0
  for (const m of stale) {
    let archiveKeyToDelete: string | undefined

    try {
      // Read the manifest to find its archive key
      const manifest = await downloadManifest(r2, m.key)
      archiveKeyToDelete = manifest.archiveKey
    } catch (e) {
      // If we can't read the manifest, abort this entry — don't risk
      // deleting an archive that might still be referenced
      info(
        `Failed to read manifest ${m.key} for cleanup, skipping: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
      continue
    }

    try {
      // Delete the manifest first — if this succeeds, the backup is no
      // longer selectable even if archive deletion fails
      await deleteObject(r2, m.key)
      deleted++
      info(`Deleted old manifest: ${m.key}`, "retention")
    } catch (e) {
      info(
        `Failed to delete manifest ${m.key}: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
      continue
    }

    // Now safe to delete the archive
    if (archiveKeyToDelete) {
      try {
        await deleteObject(r2, archiveKeyToDelete)
        debug(`Deleted archive ${archiveKeyToDelete}`, "retention")
      } catch (e) {
        debug(
          `Failed to delete archive ${archiveKeyToDelete}: ${e instanceof Error ? e.message : String(e)}`,
          "retention",
        )
      }
    }
  }

  return deleted
}

function archiveKey(projectPrefix: string): string {
  const suffix = Math.random().toString(36).substring(2, 8)
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  return `${projectPrefix}archives/${ts}-${suffix}.tar.gz`
}

function manifestKey(timestamp: string, projectPrefix: string): string {
  const sanitized = timestamp.replace(/[:.]/g, "-")
  const suffix = Math.random().toString(36).substring(2, 8)
  return `${projectPrefix}manifests/${sanitized}-${suffix}.json`
}

/**
 * Clean up orphaned archives that are not referenced by any manifest.
 * This is a utility function for manual cleanup or periodic sweeps.
 * Returns the number of orphaned archives deleted.
 */
export async function cleanupOrphanedArchives(
  r2: R2Config,
  projectPrefix: string,
): Promise<number> {
  try {
    // Get all manifests
    const manifests = await listManifests(r2, projectPrefix)

    // Collect all referenced archive keys
    const referencedArchives = new Set<string>()
    for (const m of manifests) {
      try {
        const manifest = await downloadManifest(r2, m.key)
        if (manifest.archiveKey) {
          referencedArchives.add(manifest.archiveKey)
        }
      } catch (e) {
        // Skip manifests that fail to download
        debug(
          `Failed to download manifest ${m.key}: ${e instanceof Error ? e.message : String(e)}`,
          "cleanup",
        )
      }
    }

    // List all archives
    const archivePrefix = `${projectPrefix}archives/`
    const allArchives = await listObjects(r2, archivePrefix)

    // Delete orphaned archives
    let deleted = 0
    for (const archive of allArchives) {
      if (!referencedArchives.has(archive.key)) {
        try {
          await deleteObject(r2, archive.key)
          deleted++
          info(`Deleted orphaned archive: ${archive.key}`, "cleanup")
        } catch (e) {
          debug(
            `Failed to delete archive ${archive.key}: ${e instanceof Error ? e.message : String(e)}`,
            "cleanup",
          )
        }
      }
    }

    return deleted
  } catch (e) {
    info(
      `Failed to cleanup orphaned archives: ${e instanceof Error ? e.message : String(e)}`,
      "cleanup",
    )
    return 0
  }
}
