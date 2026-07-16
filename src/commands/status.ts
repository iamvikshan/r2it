import { resolveActiveProjectConfig, projectR2Prefix } from "../utils/config"
import { listObjects } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"
import { checkPathExists, getMaxMTime } from "../utils/fs"
import type { ResolvedConfig } from "../utils/types"

function formatSize(bytes: number): string {
  if (bytes > 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  if (bytes > 1_000) return `${(bytes / 1_000).toFixed(0)} KB`
  return `${bytes} B`
}

async function printLocalStatus(cfg: ResolvedConfig): Promise<number> {
  console.log(
    `\nActive Project: ${cfg.project} (${cfg.isLocal ? "local .r2gitconfig" : "global fallback"})`,
  )
  console.log(`R2 Bucket:      ${cfg.r2.bucket ?? "(none)"}`)
  console.log(
    `Backup Prefix:  ${projectR2Prefix(cfg.project, cfg.backup.prefix)}\n`,
  )

  if (cfg.backup.paths.length === 0) {
    console.log(
      "No paths tracked for this project. Run 'r2git add <path>' to start tracking.",
    )
    return 0
  }

  console.log("Tracked Files & Directories:")
  let maxLocalTime = 0
  for (const path of cfg.backup.paths) {
    const exists = await checkPathExists(path)
    if (exists) {
      const mtime = await getMaxMTime(path)
      if (mtime) {
        maxLocalTime = Math.max(maxLocalTime, mtime)
        const dateStr = new Date(mtime)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19)
        console.log(
          `  \x1b[32m✔\x1b[0m ${path} \x1b[90m(exists, last modified: ${dateStr})\x1b[0m`,
        )
      } else {
        console.log(`  \x1b[32m✔\x1b[0m ${path} \x1b[90m(exists)\x1b[0m`)
      }
    } else {
      console.log(`  \x1b[31m✖\x1b[0m ${path} \x1b[90m(missing)\x1b[0m`)
    }
  }
  console.log("")
  return maxLocalTime
}

async function printRemoteStatus(
  cfg: ResolvedConfig,
  maxLocalTime: number,
): Promise<void> {
  if (!cfg.r2.accountId || !cfg.r2.accessKeyId || !cfg.r2.secretAccessKey)
    return

  try {
    const r2Prefix = projectR2Prefix(cfg.project, cfg.backup.prefix)
    const all = await listObjects(cfg.r2, r2Prefix)
    const backups = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )

    const latest = backups[0]
    if (latest) {
      const remoteTime = new Date(latest.lastModified).getTime()
      const sizeStr = formatSize(latest.size)
      console.log("Remote Backups:")
      console.log(
        `  Latest: ${latest.key} (${sizeStr}, ${latest.lastModified})`,
      )
      console.log(`  Total:  ${backups.length} backup(s) in R2\n`)

      if (maxLocalTime > 0) {
        if (maxLocalTime - remoteTime > 5000) {
          console.log(`\x1b[33mℹ Local files have newer modifications than the remote backup.
  Run 'r2git push' to upload the latest changes.\x1b[0m\n`)
        } else if (remoteTime - maxLocalTime > 5000) {
          console.log(`\x1b[36mℹ Remote backup is newer than local files.
  Run 'r2git pull' to restore remote changes.\x1b[0m\n`)
        } else {
          console.log(
            `\x1b[32m✔ Workspace is up-to-date with remote backup.\x1b[0m\n`,
          )
        }
      }
    } else {
      console.log(`\x1b[33mℹ No remote backups found in R2 for this project.
  Run 'r2git push' to create your first backup.\x1b[0m\n`)
    }
  } catch (e) {
    console.warn(
      `\x1b[33m⚠ Warning: Failed to query R2 backups: ${e instanceof Error ? e.message : String(e)}\x1b[0m\n`,
    )
  }
}

export async function cmdStatus(): Promise<void> {
  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  const maxLocalTime = await printLocalStatus(cfg)
  if (cfg.backup.paths.length > 0) {
    await printRemoteStatus(cfg, maxLocalTime)
  }
}
