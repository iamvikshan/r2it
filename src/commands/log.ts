import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { listObjects } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

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

  const s = p.spinner()
  s.start("Querying backup history...")
  let backups: Awaited<ReturnType<typeof listObjects>> = []
  try {
    const all = await listObjects(cfg.r2, r2Prefix)
    backups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )
    s.stop("History loaded.")
  } catch (e) {
    s.stop("Failed to retrieve history.")
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  if (backups.length === 0) {
    console.log(
      `No backups found for project "${cfg.project}" under prefix "${r2Prefix}".`,
    )
    return
  }

  console.log(
    `\nHistory for project "${cfg.project}" (${backups.length} backups):`,
  )
  console.log(
    "--------------------------------------------------------------------------------",
  )
  for (const b of backups) {
    const size = formatSize(b.size)
    const keyParts = b.key.split("/")
    const filename = keyParts[keyParts.length - 1] ?? b.key
    const date = new Date(b.lastModified)
    const dateStr = date.toLocaleString()
    console.log(`  backup ${filename}`)
    console.log(`  Date:   ${dateStr}`)
    console.log(`  Size:   ${size}`)
    console.log(
      "--------------------------------------------------------------------------------",
    )
  }
}
