import * as p from "@clack/prompts"
import {
  resolveActiveProjectConfig,
  projectR2Prefix,
  resolveTarPaths,
} from "../utils/config"
import { uploadObject, listObjects, deleteObject } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"
import { checkPathExists, homeDir } from "../utils/fs"
import type { ResolvedConfig, R2Config } from "../utils/types"

const TMP_TAR = "/tmp/r2git-backup.tar.gz"

function utcStamp(): string {
  const n = new Date()
  const y = n.getUTCFullYear()
  const m = String(n.getUTCMonth() + 1).padStart(2, "0")
  const d = String(n.getUTCDate()).padStart(2, "0")
  const h = String(n.getUTCHours()).padStart(2, "0")
  const min = String(n.getUTCMinutes()).padStart(2, "0")
  return `${y}-${m}-${d}T${h}-${min}Z`
}

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

function tarPaths(paths: string[], label: string): boolean {
  console.log(`\nArchiving ${label}...`)
  const proc = Bun.spawnSync([
    "tar",
    "-czf",
    TMP_TAR,
    "--ignore-failed-read",
    "-C",
    "/",
    ...paths,
  ])
  if (!proc.success) {
    console.error(`tar failed: ${proc.stderr.toString()}`)
    return false
  }
  return true
}

async function getExistingPaths(
  paths: string[],
  cwd: string,
  home: string,
): Promise<string[]> {
  const resolved = resolveTarPaths(paths, cwd, home)
  const existing: string[] = []
  for (const path of resolved) {
    const abs = "/" + path
    if (await checkPathExists(abs)) {
      existing.push(path)
    }
  }
  return existing
}

async function enforceRetention(
  r2: R2Config,
  r2Prefix: string,
  retention: number,
  spinner: ReturnType<typeof p.spinner>,
): Promise<void> {
  try {
    const all = await listObjects(r2, r2Prefix)
    const backups = all
      .filter(a => a.key.startsWith(r2Prefix) && a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )
    if (backups.length > retention) {
      const stale = backups.slice(retention)
      for (const a of stale) {
        await deleteObject(r2, a.key)
      }
      spinner.stop(
        `Retention cleanup complete: deleted ${stale.length} older backup(s).`,
      )
    } else {
      spinner.stop(
        `Retention: ${backups.length} backup(s) on R2 (no cleanup needed).`,
      )
    }
  } catch (e) {
    spinner.stop(
      `Retention cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

async function performPush(
  cfg: ResolvedConfig,
  key: string,
  existingPaths: string[],
  retention: number,
  r2Prefix: string,
): Promise<void> {
  const s = p.spinner()
  s.start("Archiving files and uploading to R2...")

  if (!tarPaths(existingPaths, `backup for ${cfg.project}`)) {
    s.stop("Archiving failed.")
    process.exit(1)
  }

  try {
    const file = Bun.file(TMP_TAR)
    const size = file.size
    const buf = await file.arrayBuffer()
    await uploadObject(cfg.r2, key, buf, "application/gzip")
    s.stop(`Backup uploaded successfully: ${key} (${formatSize(size)})`)
  } catch (e) {
    s.stop("Upload failed.")
    console.error(e instanceof Error ? e.message : String(e))
    Bun.spawnSync(["rm", "-f", TMP_TAR])
    process.exit(1)
  }
  Bun.spawnSync(["rm", "-f", TMP_TAR])

  const cleanupSpinner = p.spinner()
  cleanupSpinner.start(
    `Enforcing backup retention policy (retaining last ${retention})...`,
  )
  await enforceRetention(cfg.r2, r2Prefix, retention, cleanupSpinner)
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
  const retention =
    keepIdx !== -1 ? Number(args[keepIdx + 1]) : cfg.backup.retention
  const prefixIdx = args.indexOf("--prefix")
  const pkgPrefix =
    prefixIdx !== -1
      ? (args[prefixIdx + 1] ?? cfg.backup.prefix)
      : cfg.backup.prefix
  const dryRun = args.includes("--dry-run") || args.includes("-n")
  const yes = args.includes("-y") || args.includes("--yes")

  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)
  const key = `${r2Prefix}${utcStamp()}.tar.gz`

  const existingPaths = await getExistingPaths(
    cfg.backup.paths,
    process.cwd(),
    homeDir(),
  )

  if (existingPaths.length === 0) {
    p.cancel("Error: No tracked paths exist locally. Nothing to backup.")
    process.exit(1)
  }

  if (dryRun) {
    console.log(`\n[dry-run] Project: ${cfg.project}`)
    console.log("[dry-run] Would archive these paths:")
    existingPaths.forEach(p => {
      console.log(`  /${p}`)
    })
    console.log(`[dry-run] Would upload to R2 as: ${key}`)
    console.log(`[dry-run] Would retain ${retention} most recent backups\n`)
    return
  }

  if (!yes) {
    const ok = await p.confirm({
      message: `Push backup for '${cfg.project}' (${existingPaths.length} paths) to R2?`,
      initialValue: true,
    })
    if (p.isCancel(ok) || !ok) {
      p.cancel("Operation cancelled.")
      process.exit(0)
    }
  }

  await performPush(cfg, key, existingPaths, retention, r2Prefix)
}
