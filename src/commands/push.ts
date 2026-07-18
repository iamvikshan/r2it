import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePaths, buildPathContext } from "../utils/fs"
import { readFile } from "node:fs/promises"
import { buildManifest, diffManifests } from "../utils/manifest"
import {
  uploadObjectIfMissing,
  uploadManifest,
  getLatestManifest,
  enforceManifestRetention,
} from "../utils/store"
import { objectKey } from "../utils/hash"
import {
  info,
  warn,
  error as logError,
  printPathResult,
  printPathSummary,
  formatSize,
  type PathResult,
} from "../utils/log"
import { hashBuffer } from "../utils/hash"
import type { ResolvedConfig } from "../utils/types"
import type { Manifest, PushResult } from "../utils/store-types"

function utcStamp(): string {
  const n = new Date()
  const y = n.getUTCFullYear()
  const m = String(n.getUTCMonth() + 1).padStart(2, "0")
  const d = String(n.getUTCDate()).padStart(2, "0")
  const h = String(n.getUTCHours()).padStart(2, "0")
  const min = String(n.getUTCMinutes()).padStart(2, "0")
  return `${y}-${m}-${d}T${h}-${min}Z`
}

/**
 * Validate paths and build local manifest.
 */
async function buildLocalManifest(cfg: ResolvedConfig): Promise<{
  manifest: Manifest
  objectDataMap: Map<string, Uint8Array>
  pathResults: PathResult[]
}> {
  const ctx = buildPathContext(cfg.project)
  const resolved = resolvePaths(cfg.backup.paths, ctx)

  // Validate paths first
  const pathResults: PathResult[] = []
  const validPaths: Array<{ original: string; absolute: string }> = []

  for (const r of resolved) {
    try {
      const { checkPathExists, getFileSize } = await import("../utils/fs")
      const exists = await checkPathExists(r.absolute)
      if (!exists) {
        pathResults.push({
          path: r.original,
          status: "skipped",
          reason: "file not found",
        })
        continue
      }
      const size = await getFileSize(r.absolute)
      pathResults.push({
        path: r.original,
        status: "ok",
        ...(size !== null && { size }),
      })
      validPaths.push({ original: r.original, absolute: r.absolute })
    } catch (e) {
      pathResults.push({
        path: r.original,
        status: "error",
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // Build manifest from valid paths
  const { manifest, objectDataMap, errors: buildErrors } = await buildManifest(
    validPaths,
    cfg.project,
    null, // parent set later
  )

  // Add build errors to pathResults
  for (const err of buildErrors) {
    pathResults.push({
      path: err.path,
      status: "error",
      reason: err.reason,
    })
  }

  return { manifest, objectDataMap, pathResults }
}

/**
 * Perform the incremental push:
 * 1. Build local manifest (hash all files)
 * 2. Fetch latest remote manifest
 * 3. Diff: find new/changed objects
 * 4. Upload only new objects
 * 5. Upload manifest
 */
async function performPush(
  cfg: ResolvedConfig,
  r2Prefix: string,
  retention: number,
): Promise<PushResult> {
  const result: PushResult = {
    manifestKey: "",
    totalFiles: 0,
    newObjects: 0,
    skippedObjects: 0,
    uploadedBytes: 0,
    errors: [],
  }

  // Step 1: Build local manifest
  const s = p.spinner()
  s.start("Hashing tracked files...")

  const { manifest, objectDataMap, pathResults } = await buildLocalManifest(cfg)
  result.totalFiles = Object.keys(manifest.entries).length

  s.stop(`Hashed ${result.totalFiles} file(s)`)

  // Show per-path results
  for (const r of pathResults) {
    printPathResult(r)
  }
  printPathSummary(pathResults)

  // Check for errors during manifest building
  const buildErrors = pathResults.filter(r => r.status === "error")
  if (buildErrors.length > 0) {
    logError(`${buildErrors.length} file(s) failed during hashing`, "push")
    result.errors = buildErrors.map(r => ({ path: r.path, reason: r.reason ?? "unknown error" }))
    return result
  }

  if (result.totalFiles === 0) {
    return result
  }

  // Step 2: Fetch latest remote manifest for diffing
  const s2 = p.spinner()
  s2.start("Checking remote state...")

  let parentKey: string | null = null
  let remoteManifest: Manifest | null = null
  try {
    const latest = await getLatestManifest(cfg.r2, r2Prefix)
    if (latest) {
      remoteManifest = latest.manifest
      parentKey = latest.key
      manifest.parent = parentKey
      s2.stop(`Found remote manifest (${Object.keys(latest.manifest.entries).length} entries)`)
    } else {
      s2.stop("No previous backup found — this will be a full backup")
    }
  } catch (e) {
    s2.stop("Could not fetch remote manifest — proceeding with full backup")
    warn(
      `Remote manifest fetch failed: ${e instanceof Error ? e.message : String(e)}`,
      "push",
    )
  }

  // Step 3: Diff to find what needs uploading
  let objectsToUpload: Array<{ hash: string; data?: Uint8Array }> = []
  let manifestNeedsUpdate = false

  if (remoteManifest) {
    const diff = diffManifests(manifest, remoteManifest)
    const changed = [...diff.added, ...diff.changed]

    info(
      `Changes: ${diff.added.length} added, ${diff.changed.length} changed, ${diff.removed.length} removed, ${diff.unchanged.length} unchanged`,
      "diff",
    )

    // Collect hashes that need uploading
    const neededHashes = new Set(changed.map(p => manifest.entries[p]!.hash))
    for (const hash of neededHashes) {
      const data = objectDataMap.get(hash)
      objectsToUpload.push({ hash, ...(data !== undefined && { data }) })
    }

    // Manifest needs update if there are added, changed, or removed entries
    manifestNeedsUpdate = diff.added.length > 0 || diff.changed.length > 0 || diff.removed.length > 0
  } else {
    // Full backup — all objects needed
    const seen = new Set<string>()
    for (const entry of Object.values(manifest.entries)) {
      if (!seen.has(entry.hash)) {
        seen.add(entry.hash)
        const data = objectDataMap.get(entry.hash)
        objectsToUpload.push({ hash: entry.hash, ...(data !== undefined && { data }) })
      }
    }
    manifestNeedsUpdate = true
  }

  result.newObjects = objectsToUpload.length

  if (result.newObjects === 0 && !manifestNeedsUpdate) {
    info("No changes detected — nothing to upload", "push")
    return result
  }

  // Step 4: Upload new objects
  const s3 = p.spinner()
  s3.start(`Uploading ${result.newObjects} object(s)...`)

  let uploaded = 0
  for (const obj of objectsToUpload) {
    try {
      let data = obj.data
      if (!data) {
        // Regular file — read from disk
        // Find the first entry with this hash to get the file path
        const entryPath = Object.entries(manifest.entries).find(
          ([, e]) => e.hash === obj.hash,
        )?.[0]
        if (!entryPath) continue

        const ctx = buildPathContext(cfg.project)
        const { resolvePath } = await import("../utils/fs")
        const absPath = resolvePath(entryPath, ctx)
        data = await readFile(absPath)
      }

      const wasUploaded = await uploadObjectIfMissing(
        cfg.r2,
        obj.hash,
        data,
        r2Prefix,
      )
      if (wasUploaded) {
        result.uploadedBytes += data.length
        uploaded++
        s3.message(`Uploading objects... (${uploaded}/${result.newObjects}, ${formatSize(result.uploadedBytes)})`)
      } else {
        result.skippedObjects++
      }
    } catch (e) {
      result.errors.push({
        path: obj.hash.slice(0, 12),
        reason: e instanceof Error ? e.message : String(e),
      })
      logError(
        `Failed to upload object ${obj.hash.slice(0, 12)}…: ${e instanceof Error ? e.message : String(e)}`,
        "upload",
      )
    }
  }

  s3.stop(
    `Uploaded ${uploaded} object(s), ${result.skippedObjects} already on R2, ${formatSize(result.uploadedBytes)} transferred`,
  )

  // Check for upload errors before proceeding to manifest upload
  if (result.errors.length > 0) {
    logError(`${result.errors.length} object(s) failed to upload`, "push")
    return result
  }

  // Step 5: Upload manifest
  const s4 = p.spinner()
  s4.start("Uploading manifest...")
  try {
    result.manifestKey = await uploadManifest(cfg.r2, manifest, r2Prefix)
    s4.stop(`Manifest uploaded: ${result.manifestKey}`)
  } catch (e) {
    s4.stop("Manifest upload failed!")
    logError(e instanceof Error ? e.message : String(e), "manifest")
    throw e
  }

  // Step 6: Retention cleanup
  const cleaned = await enforceManifestRetention(cfg.r2, r2Prefix, retention)
  if (cleaned > 0) {
    info(`Cleaned up ${cleaned} old manifest(s)`, "retention")
  }

  return result
}

export async function cmdPush(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const keepIdx = args.indexOf("--keep")
  let retention = cfg.backup.retention
  if (keepIdx !== -1) {
    const keepValue = args[keepIdx + 1]
    if (!keepValue || keepValue.trim() === "") {
      p.cancel("Error: --keep requires a numeric value")
      process.exit(1)
    }
    const parsed = Number(keepValue)
    if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 1) {
      p.cancel("Error: --keep must be a positive integer (minimum 1)")
      process.exit(1)
    }
    retention = parsed
  }
  const prefixIdx = args.indexOf("--prefix")
  const pkgPrefix =
    prefixIdx !== -1
      ? (args[prefixIdx + 1] ?? cfg.backup.prefix)
      : cfg.backup.prefix
  const dryRun = args.includes("--dry-run") || args.includes("-n")
  const verbose = args.includes("--verbose") || args.includes("-v")
  const quiet = args.includes("--quiet") || args.includes("-q")

  if (verbose) {
    const { setLogLevel } = await import("../utils/log")
    setLogLevel("debug")
  }

  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)

  if (!quiet) {
    info(`Project: ${cfg.project}`, "push")
    info(`Tracked paths: ${cfg.backup.paths.length}`, "push")
    info(`Retention: ${retention} backup(s)`, "push")
    console.log("")
  }

  if (dryRun) {
    // For dry-run, just hash and show what would happen
    const ctx = buildPathContext(cfg.project)
    const resolved = resolvePaths(cfg.backup.paths, ctx)

    console.log("[dry-run] Project:", cfg.project)
    console.log("[dry-run] Would hash and check these paths:")
    for (const r of resolved) {
      console.log(`  ${r.original} → ${r.absolute}`)
    }
    console.log(`[dry-run] Would compare against latest manifest in R2`)
    console.log(`[dry-run] Would upload only changed objects`)
    console.log(`[dry-run] Would retain ${retention} most recent manifests`)
    console.log("")
    return
  }

  const result = await performPush(cfg, r2Prefix, retention)

  if (result.totalFiles === 0) {
    p.cancel("No tracked paths exist locally. Nothing to backup.")
    process.exit(1)
  }

  if (result.errors.length > 0) {
    warn(`${result.errors.length} error(s) occurred during push`, "push")
  }

  console.log("")
  console.log(
    `\x1b[32m✔ Push complete:\x1b[0m ${result.totalFiles} files, ` +
      `${result.newObjects} new objects, ${formatSize(result.uploadedBytes)} uploaded`,
  )
  console.log(`  Manifest: ${result.manifestKey}`)
  console.log("")
}
