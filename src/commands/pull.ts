import * as p from "@clack/prompts"
import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { downloadObject, listObjects } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"
import type { ResolvedConfig } from "../utils/types"

const TMP_TAR = "/tmp/r2git-backup.tar.gz"

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

async function resolvePullKey(
  cfg: ResolvedConfig,
  r2Prefix: string,
  specificKey: string | null,
  interactive: boolean,
): Promise<string> {
  if (specificKey) return specificKey

  if (interactive) {
    const all = await listObjects(cfg.r2, r2Prefix)
    const backups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )

    if (backups.length === 0) {
      p.cancel(`No backups found under prefix: ${r2Prefix}`)
      process.exit(1)
    }

    const picked = await p.select({
      message: "Select backup to restore",
      options: backups.map(b => ({
        value: b.key,
        label: `${b.key} (${formatSize(b.size)}, ${b.lastModified})`,
      })),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    return picked as string
  }

  const all = await listObjects(cfg.r2, r2Prefix)
  const latest = all
    .filter(a => a.key.endsWith(".tar.gz"))
    .sort(
      (a, b) =>
        new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime(),
    )[0]

  if (!latest) {
    p.cancel(
      `No backups found for project '${cfg.project}' under prefix ${r2Prefix}.`,
    )
    process.exit(1)
  }
  return latest.key
}

async function performPull(cfg: ResolvedConfig, key: string): Promise<void> {
  const s = p.spinner()
  s.start("Downloading backup from R2...")

  try {
    const buf = await downloadObject(cfg.r2, key)
    await Bun.write(TMP_TAR, buf)
    s.stop(`Download completed: ${formatSize(buf.byteLength)}`)
  } catch (e) {
    s.stop("Download failed.")
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  const extSpinner = p.spinner()
  extSpinner.start("Extracting backup tarball...")
  try {
    const proc = Bun.spawnSync(["tar", "-xzf", TMP_TAR, "-C", "/"])
    if (!proc.success) {
      extSpinner.stop("Extraction failed.")
      console.error(proc.stderr.toString())
      Bun.spawnSync(["rm", "-f", TMP_TAR])
      process.exit(1)
    }
    extSpinner.stop("Extraction completed.")
  } finally {
    Bun.spawnSync(["rm", "-f", TMP_TAR])
  }
}

export async function cmdPull(args: string[]): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  const specificKey =
    args.indexOf("--backup") !== -1
      ? (args[args.indexOf("--backup") + 1] ?? null)
      : null
  const dryRun = args.includes("--dry-run") || args.includes("-n")
  const interactive = args.includes("--interactive") || args.includes("-i")

  const pkgPrefix = cfg.backup.prefix
  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)

  const key = await resolvePullKey(cfg, r2Prefix, specificKey, interactive)

  if (dryRun) {
    console.log(`\n[dry-run] Project: ${cfg.project}`)
    console.log(`[dry-run] Would download and restore backup: ${key}\n`)
    return
  }

  await performPull(cfg, key)

  p.outro("Workspace successfully restored from backup (^_<) ~*")
}
