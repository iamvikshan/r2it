import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { listObjects } from "../utils/r2"
import { listManifests, downloadManifest } from "../utils/store"
import { getCurrentDirBasename } from "../utils/git"
import { formatSize, info } from "../utils/log"

export async function cmdLog(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  const prefixIdx = args.indexOf("--prefix")
  const pkgPrefix =
    prefixIdx !== -1
      ? (args[prefixIdx + 1] ?? cfg.backup.prefix)
      : cfg.backup.prefix
  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)
  const detailed = args.includes("--verbose") || args.includes("-v")

  const s = p.spinner()
  s.start("Querying backup history...")

  // Query both manifest and legacy tar backups
  let manifests: Array<{ key: string; lastModified: string; size: number }> = []
  try {
    manifests = await listManifests(cfg.r2, r2Prefix)
  } catch {
    // Failed to list manifests, continue to legacy
  }

  let legacyBackups: Array<{ key: string; lastModified: string; size: number }> = []
  try {
    const all = await listObjects(cfg.r2, r2Prefix)
    legacyBackups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )
  } catch {
    // Failed to list legacy backups
  }

  s.stop("History loaded.")

  // Display manifests if found
  if (manifests.length > 0) {
    console.log(
      `\nHistory for project "${cfg.project}" (${manifests.length} manifest backups):`,
    )
    console.log("─".repeat(70))

    for (const m of manifests) {
      const date = new Date(m.lastModified).toLocaleString()
      const size = formatSize(m.size)

      if (detailed) {
        // Download manifest to show entry counts
        try {
          const manifest = await downloadManifest(cfg.r2, m.key)
          const entries = Object.keys(manifest.entries).length
          const totalSize = Object.values(manifest.entries).reduce(
            (sum, e) => sum + e.size,
            0,
          )
          const keyParts = m.key.split("/")
          const filename = keyParts[keyParts.length - 1] ?? m.key
          console.log(`  backup ${filename}`)
          console.log(`  Date:     ${date}`)
          console.log(`  Size:     ${size}`)
          console.log(`  Entries:  ${entries} file(s), ${formatSize(totalSize)} content`)
          if (manifest.parent) {
            console.log(`  Parent:   ${manifest.parent.split("/").pop()}`)
          }
        } catch {
          const keyParts = m.key.split("/")
          const filename = keyParts[keyParts.length - 1] ?? m.key
          console.log(`  backup ${filename}`)
          console.log(`  Date:   ${date}`)
          console.log(`  Size:   ${size}`)
        }
      } else {
        const keyParts = m.key.split("/")
        const filename = keyParts[keyParts.length - 1] ?? m.key
        console.log(`  backup ${filename}`)
        console.log(`  Date:   ${date}`)
        console.log(`  Size:   ${size}`)
      }
      console.log("─".repeat(70))
    }
  }

  // Display legacy backups if found
  if (legacyBackups.length > 0) {
    if (manifests.length > 0) {
      console.log("\nLegacy tar backups:")
      console.log("─".repeat(70))
    } else {
      console.log(
        `\nHistory for project "${cfg.project}" (${legacyBackups.length} legacy backups):`,
      )
      console.log("─".repeat(70))
    }
    for (const b of legacyBackups) {
      const size = formatSize(b.size)
      const keyParts = b.key.split("/")
      const filename = keyParts[keyParts.length - 1] ?? b.key
      const date = new Date(b.lastModified).toLocaleString()
      console.log(`  backup ${filename}`)
      console.log(`  Date:   ${date}`)
      console.log(`  Size:   ${size}`)
      console.log("─".repeat(70))
    }
  }

  if (manifests.length === 0 && legacyBackups.length === 0) {
    console.log(
      `No backups found for project "${cfg.project}" under prefix "${r2Prefix}".`,
    )
  }
}
