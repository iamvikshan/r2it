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

  // Try manifest-based history first
  try {
    const manifests = await listManifests(cfg.r2, r2Prefix)
    if (manifests.length > 0) {
      s.stop(`Found ${manifests.length} manifest(s).`)

      console.log(
        `\nHistory for project "${cfg.project}" (${manifests.length} backups):`,
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
      return
    }
  } catch {
    // Fall through to legacy tar listing
  }

  // Legacy: list tar files
  try {
    const all = await listObjects(cfg.r2, r2Prefix)
    const backups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )
    s.stop("History loaded.")

    if (backups.length === 0) {
      console.log(
        `No backups found for project "${cfg.project}" under prefix "${r2Prefix}".`,
      )
      return
    }

    console.log(
      `\nHistory for project "${cfg.project}" (${backups.length} legacy backups):`,
    )
    console.log("─".repeat(70))
    for (const b of backups) {
      const size = formatSize(b.size)
      const keyParts = b.key.split("/")
      const filename = keyParts[keyParts.length - 1] ?? b.key
      const date = new Date(b.lastModified).toLocaleString()
      console.log(`  backup ${filename}`)
      console.log(`  Date:   ${date}`)
      console.log(`  Size:   ${size}`)
      console.log("─".repeat(70))
    }
  } catch (e) {
    s.stop("Failed to retrieve history.")
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
