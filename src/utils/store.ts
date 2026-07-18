import { uploadObject, downloadObject, listObjects, headObject, deleteObject } from "./r2"
import { objectKey } from "./hash"
import type { R2Config } from "./types"
import type { Manifest } from "./store-types"
import { serializeManifest, deserializeManifest } from "./manifest"
import { debug, info } from "./log"

/**
 * Check if an object exists in R2 by hash.
 */
export async function objectExists(
  r2: R2Config,
  hash: string,
  projectPrefix: string,
): Promise<boolean> {
  const key = objectKey(hash, projectPrefix)
  return headObject(r2, key)
}

/**
 * Upload a single object to R2 if it doesn't already exist.
 * Returns true if uploaded, false if already present.
 */
export async function uploadObjectIfMissing(
  r2: R2Config,
  hash: string,
  data: ArrayBuffer | Uint8Array,
  projectPrefix: string,
): Promise<boolean> {
  const key = objectKey(hash, projectPrefix)

  // Check existence first (avoid unnecessary uploads)
  const exists = await headObject(r2, key)
  if (exists) {
    debug(`Object ${hash.slice(0, 12)}… already on R2, skipping`, "store")
    return false
  }

  await uploadObject(r2, key, data, "application/octet-stream")
  debug(`Uploaded object ${hash.slice(0, 12)}…`, "store")
  return true
}

/**
 * Download a single object from R2 by hash.
 */
export async function downloadObjectByHash(
  r2: R2Config,
  hash: string,
  projectPrefix: string,
): Promise<ArrayBuffer> {
  const key = objectKey(hash, projectPrefix)
  return downloadObject(r2, key)
}

/**
 * Upload a manifest to R2.
 */
export async function uploadManifest(
  r2: R2Config,
  manifest: Manifest,
  projectPrefix: string,
): Promise<string> {
  const key = manifestKey(manifest.timestamp, projectPrefix)
  const json = serializeManifest(manifest)
  await uploadObject(r2, key, json, "application/json")
  debug(`Uploaded manifest ${key}`, "store")
  return key
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
        new Date(b.lastModified).getTime() -
        new Date(a.lastModified).getTime(),
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

  const latest = manifests[0]!
  const manifest = await downloadManifest(r2, latest.key)
  return { manifest, key: latest.key }
}

/**
 * Enforce retention on manifests. Deletes old manifests and their orphaned objects.
 */
export async function enforceManifestRetention(
  r2: R2Config,
  projectPrefix: string,
  retention: number,
): Promise<number> {
  const manifests = await listManifests(r2, projectPrefix)
  if (manifests.length <= retention) return 0

  const stale = manifests.slice(retention)
  let deleted = 0

  for (const m of stale) {
    try {
      await deleteObject(r2, m.key)
      deleted++
      info(`Deleted old manifest: ${m.key}`, "retention")
    } catch (e) {
      debug(
        `Failed to delete manifest ${m.key}: ${e instanceof Error ? e.message : String(e)}`,
        "retention",
      )
    }
  }

  // Note: We don't delete orphaned objects here because they may be shared
  // with newer manifests (content-addressed). A garbage collection pass
  // could be added later.

  return deleted
}

// Re-export for convenience
function manifestKey(timestamp: string, projectPrefix: string): string {
  return `${projectPrefix}manifests/${timestamp}.json`
}
