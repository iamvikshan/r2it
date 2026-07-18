import * as p from "@clack/prompts"
import {
  resolveActiveProjectConfig,
  projectR2Prefix,
} from "../utils/config"
import { uploadObject, listObjects, deleteObject } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"
import {
  checkPathExists,
  resolvePaths,
  buildPathContext,
  getFileSize,
  isDirectory,
  isSymlink,
} from "../utils/fs"
import {
  info,
  warn,
  error as logError,
  printPathResult,
  printPathSummary,
  formatSize,
  type PathResult,
} from "../utils/log"
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

/**
 * Validate and resolve all tracked paths.
 * Returns detailed results for each path — exists, missing, error, etc.
 */
async function validatePaths(
  cfg: ResolvedConfig,
): Promise<{ results: PathResult[]; existing: string[] }> {
  const ctx = buildPathContext(cfg.project)
  const resolved = resolvePaths(cfg.backup.paths, ctx)
  const results: PathResult[] = []
  const existing: string[] = []

  for (const r of resolved) {
    try {
      const exists = await checkPathExists(r.absolute)
      if (!exists) {
        results.push({
          path: r.original,
          status: "skipped",
          reason: "file not found",
        })
        continue
      }

      // Check if it's a directory — tar handles these fine
      const dir = await isDirectory(r.absolute)
      if (dir) {
        const size = await getFileSize(r.absolute)
        results.push({
          path: r.original,
          status: "ok",
          size: size ?? 0,
        })
        existing.push(r.relative)
        continue
      }

      const size = await getFileSize(r.absolute)
      results.push({
        path: r.original,
        status: "ok",
        size: size ?? undefined,
      })
      existing.push(r.relative)
    } catch (e) {
      results.push({
        path: r.original,
        status: "error",
        reason: e instanceof Error ? e.message : String(e),
      })
    }
  }

  return { results, existing }
}

function tarPaths(paths: string[], label: string): boolean {
  info(`Archiving ${paths.length} path(s)...`, "tar")
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
    const stderr = proc.stderr.toString().trim()
    logError(`tar exited with code ${proc.exitCode}`, "tar")
    if (stderr) {
      for (const line of stderr.split("\n").slice(0, 10)) {
        logError(`  ${line}`, "tar")
      }
      if (stderr.split("\n").length > 10) {
        logError(`  ... (${stderr.split("\n").length - 10} more lines)`, "tar")
      }
    }
    return false
  }
  return true
}

async function enforceRetention(
  r2: R2Config,
  r2Prefix: string,
  retention: number,
): Promise<number> {
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
        info(`Deleted old backup: ${a.key}`, "retention")
      }
      return stale.length
    }
    return 0
  } catch (e) {
    warn(
      `Retention cleanup failed: ${e instanceof Error ? e.message : String(e)}`,
      "retention",
    )
    return 0
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
    s.message(`Uploading ${formatSize(size)} to R2...`)
    const buf = await file.arrayBuffer()
    await uploadObject(cfg.r2, key, buf, "application/gzip")
    s.stop(`Backup uploaded: ${key} (${formatSize(size)})`)
  } catch (e) {
    s.stop("Upload failed.")
    logError(e instanceof Error ? e.message : String(e), "upload")
    Bun.spawnSync(["rm", "-f", TMP_TAR])
    process.exit(1)
  }
  Bun.spawnSync(["rm", "-f", TMP_TAR])

  const cleaned = await enforceRetention(cfg.r2, r2Prefix, retention)
  if (cleaned > 0) {
    info(`Cleaned up ${cleaned} old backup(s)`, "retention")
  }
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
  const verbose = args.includes("--verbose") || args.includes("-v")
  const quiet = args.includes("--quiet") || args.includes("-q")

  if (verbose) {
    const { setLogLevel } = await import("../utils/log")
    setLogLevel("debug")
  }

  const r2Prefix = projectR2Prefix(cfg.project, pkgPrefix)
  const key = `${r2Prefix}${utcStamp()}.tar.gz`

  // Validate all tracked paths with detailed reporting
  if (!quiet) {
    info(`Project: ${cfg.project}`, "push")
    info(`Tracked paths: ${cfg.backup.paths.length}`, "push")
    console.log("")
  }

  const { results, existing } = await validatePaths(cfg)

  if (!quiet) {
    // Show per-path results
    for (const r of results) {
      printPathResult(r)
    }
    printPathSummary(results)
  }

  if (existing.length === 0) {
    p.cancel("Error: No tracked paths exist locally. Nothing to backup.")
    process.exit(1)
  }

  if (dryRun) {
    console.log(`[dry-run] Project: ${cfg.project}`)
    console.log(`[dry-run] Would archive ${existing.length} path(s):`)
    for (const p of existing) {
      console.log(`  /${p}`)
    }
    console.log(`[dry-run] Would upload to R2 as: ${key}`)
    console.log(`[dry-run] Would retain ${retention} most recent backups`)
    console.log("")
    return
  }

  await performPush(cfg, key, existing, retention, r2Prefix)
}
