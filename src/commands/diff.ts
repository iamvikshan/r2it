import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { getCurrentDirBasename } from "../utils/git"
import { resolvePaths, buildPathContext, checkPathExists } from "../utils/fs"
import { buildManifest, diffManifests } from "../utils/manifest"
import { getLatestManifest } from "../utils/store"
import { formatSize, info } from "../utils/log"
import type { Manifest } from "../utils/store-types"

export async function cmdDiff(): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  const r2Prefix = projectR2Prefix(cfg.project, cfg.backup.prefix)
  const ctx = buildPathContext(cfg.project)

  // Build local manifest
  const s = p.spinner()
  s.start("Hashing local files...")

  const validPaths: Array<{ original: string; absolute: string }> = []
  const resolved = resolvePaths(cfg.backup.paths, ctx)
  for (const r of resolved) {
    const exists = await checkPathExists(r.absolute)
    if (exists) {
      validPaths.push({ original: r.original, absolute: r.absolute })
    }
  }

  const { manifest: localManifest } = await buildManifest(
    validPaths,
    cfg.project,
    null,
  )
  s.stop(`Hashed ${Object.keys(localManifest.entries).length} local file(s)`)

  // Fetch remote manifest
  const s2 = p.spinner()
  s2.start("Fetching remote manifest...")

  let remoteManifest: Manifest | null = null
  try {
    const latest = await getLatestManifest(cfg.r2, r2Prefix)
    if (latest) {
      remoteManifest = latest.manifest
      s2.stop(`Found remote manifest (${Object.keys(latest.manifest.entries).length} entries)`)
    } else {
      s2.stop("No remote backups found.")
      console.log("\nNo remote backups to compare against.\n")
      return
    }
  } catch (e) {
    s2.stop("Failed to fetch remote manifest.")
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  // Diff
  const diff = diffManifests(localManifest, remoteManifest)

  console.log(`\nDiff: local vs remote backup`)
  console.log("─".repeat(60))

  if (diff.added.length > 0) {
    console.log(`\n\x1b[32mAdded (local only, not in backup):\x1b[0m`)
    for (const p of diff.added) {
      const entry = localManifest.entries[p]
      console.log(`  + ${p} ${entry ? `(${formatSize(entry.size)})` : ""}`)
    }
  }

  if (diff.changed.length > 0) {
    console.log(`\n\x1b[33mChanged (content differs):\x1b[0m`)
    for (const p of diff.changed) {
      const local = localManifest.entries[p]
      const remote = remoteManifest.entries[p]
      if (local && remote) {
        console.log(
          `  ~ ${p} (${formatSize(remote.size)} → ${formatSize(local.size)})`,
        )
      }
    }
  }

  if (diff.removed.length > 0) {
    console.log(`\n\x1b[36mRemoved (in backup but not local):\x1b[0m`)
    for (const p of diff.removed) {
      const entry = remoteManifest.entries[p]
      console.log(`  - ${p} ${entry ? `(${formatSize(entry.size)})` : ""}`)
    }
  }

  if (diff.unchanged.length > 0) {
    console.log(`\n\x1b[90mUnchanged: ${diff.unchanged.length} file(s)\x1b[0m`)
  }

  const hasChanges =
    diff.added.length > 0 ||
    diff.changed.length > 0 ||
    diff.removed.length > 0

  if (!hasChanges) {
    console.log("\n\x1b[32m✔ Local files match the latest backup.\x1b[0m")
  }

  console.log("")
}
