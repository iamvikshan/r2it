import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  writeLocalConfig,
  projectR2Prefix,
  DEFAULT_PATHS,
} from "../utils/config"
import { listObjects, downloadObject } from "../utils/r2"
import { getLatestManifest, downloadObjectByHash } from "../utils/store"
import { buildPathContext, resolvePath } from "../utils/fs"
import { info, warn, error as logError, formatSize } from "../utils/log"
import type { LocalConfig } from "../utils/types"
import type { Manifest } from "../utils/store-types"
import { mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { dirname } from "node:path"

const TMP_TAR = "/tmp/r2git-backup.tar.gz"

/**
 * Restore from a manifest (new format).
 */
async function restoreFromManifest(
  globalConfig: ReturnType<typeof loadGlobalConfig> extends Promise<infer T> ? T : never,
  manifest: Manifest,
  r2Prefix: string,
  projectName: string,
): Promise<{ restored: number; errors: number }> {
  const entries = Object.entries(manifest.entries)
  const s = p.spinner()
  s.start(`Restoring ${entries.length} file(s) from manifest...`)

  const ctx = buildPathContext(projectName)
  let restored = 0
  let errors = 0

  for (const [path, entry] of entries) {
    try {
      const absolutePath = resolvePath(path, ctx)

      if (entry.type === "symlink-tar") {
        const data = await downloadObjectByHash(globalConfig.r2, entry.hash, r2Prefix)
        const tmpTar = `/tmp/r2git-symlink-${entry.hash.slice(0, 8)}.tar`
        await Bun.write(tmpTar, data)
        const proc = Bun.spawnSync(["tar", "-xf", tmpTar, "-C", "/"])
        const { unlinkSync } = await import("node:fs")
        try { unlinkSync(tmpTar) } catch {}
        if (!proc.success) errors++
        else restored++
      } else {
        const data = await downloadObjectByHash(globalConfig.r2, entry.hash, r2Prefix)
        const dir = dirname(absolutePath)
        mkdirSync(dir, { recursive: true })
        writeFileSync(absolutePath, new Uint8Array(data))
        try {
          chmodSync(absolutePath, parseInt(entry.mode, 8))
        } catch {}
        restored++
      }
    } catch (e) {
      errors++
      logError(
        `Failed to restore ${path}: ${e instanceof Error ? e.message : String(e)}`,
        "clone",
      )
    }

    if ((restored + errors) % 10 === 0) {
      s.message(`Restoring files... (${restored + errors}/${entries.length})`)
    }
  }

  s.stop(`Restored ${restored} file(s), ${errors} error(s)`)
  return { restored, errors }
}

/**
 * Legacy restore from tar (backward compat).
 */
async function restoreFromTar(
  globalConfig: ReturnType<typeof loadGlobalConfig> extends Promise<infer T> ? T : never,
  key: string,
): Promise<void> {
  const s = p.spinner()
  s.message("Downloading project backup...")
  try {
    const buf = await downloadObject(globalConfig.r2, key)
    await Bun.write(TMP_TAR, buf)
    info(`Downloaded ${formatSize(buf.byteLength)}`, "clone")
  } catch (e) {
    s.stop("Download failed.")
    logError(e instanceof Error ? e.message : String(e), "download")
    process.exit(1)
  }

  s.message("Extracting project files...")
  try {
    const proc = Bun.spawnSync(["tar", "-xzf", TMP_TAR, "-C", "/"])
    if (!proc.success) {
      s.stop("Extraction failed.")
      const stderr = proc.stderr.toString().trim()
      if (stderr) {
        for (const line of stderr.split("\n").slice(0, 10)) {
          logError(`  ${line}`, "tar")
        }
      }
      Bun.spawnSync(["rm", "-f", TMP_TAR])
      process.exit(1)
    }
  } finally {
    Bun.spawnSync(["rm", "-f", TMP_TAR])
  }
}

export async function cmdClone(projectName: string | undefined): Promise<void> {
  p.intro("r2git clone")
  const global = await loadGlobalConfig()
  if (
    !global.r2.accountId ||
    !global.r2.accessKeyId ||
    !global.r2.secretAccessKey
  ) {
    p.cancel(
      "Error: Missing Cloudflare R2 credentials. Run 'r2git init' or 'r2git auth login' first.",
    )
    process.exit(1)
  }

  let name = projectName
  if (!name) {
    const typed = await p.text({
      message: "Enter project name to clone (format: [org]/[repo])",
      validate(val) {
        if (!val?.trim()) return "Project name is required"
        return undefined
      },
    })
    if (p.isCancel(typed)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    name = typed as string
  }

  // Use configured backup prefix (if any) from global config or default
  const projectCfg = global.projects[name]
  const pkgPrefix = projectCfg?.backup?.prefix
  const r2Prefix = projectR2Prefix(name, pkgPrefix)

  // Try manifest-based restore first (new format)
  const s = p.spinner()
  s.start(`Looking up backups for '${name}'...`)

  try {
    const latest = await getLatestManifest(global.r2, r2Prefix)
    if (latest) {
      s.stop(`Found manifest: ${latest.key}`)
      const result = await restoreFromManifest(global, latest.manifest, r2Prefix, name)

      if (result.errors > 0) {
        warn(`${result.errors} file(s) failed to restore`, "clone")
        p.cancel(`Clone incomplete: ${result.restored} restored, ${result.errors} failed.`)
        process.exit(1)
      }

      // Populate paths from manifest entries so subsequent status/push track everything
      const restoredPaths = Object.keys(latest.manifest.entries)
      const newLocal: LocalConfig = {
        project: name,
        backup: {
          retention: projectCfg?.backup?.retention ?? 5,
          ...(pkgPrefix !== undefined && { prefix: pkgPrefix }),
          paths: restoredPaths.length > 0 ? restoredPaths : [...DEFAULT_PATHS],
        },
      }
      await writeLocalConfig(newLocal)
      p.outro(
        "Local .r2gitconfig created. Ready to run r2git status and r2git push (^_<) ~*",
      )
      return
    }
  } catch {
    // No manifests found, try legacy tar
  }

  // Fall back to legacy tar-based restore
  s.stop("No manifest found, checking for legacy tar backups...")
  try {
    const all = await listObjects(global.r2, r2Prefix)
    const latest = all
      .filter(a => a.key.endsWith(".tar.gz"))
      .sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime(),
      )[0]

    if (latest) {
      info("Found legacy tar backup — restoring...", "clone")
      await restoreFromTar(global, latest.key)
      await writeLocalConfig({
        project: name,
        backup: {
          retention: projectCfg?.backup?.retention ?? 5,
          ...(pkgPrefix !== undefined && { prefix: pkgPrefix }),
          paths: [...DEFAULT_PATHS]
        },
      })
      p.outro(
        "Local .r2gitconfig created. Ready to run r2git status and r2git push (^_<) ~*",
      )
      return
    }
  } catch (e) {
    s.stop("Failed to query R2 backups.")
    logError(e instanceof Error ? e.message : String(e), "clone")
    process.exit(1)
  }

  s.stop("Clone failed.")
  p.cancel(
    `No backups found on R2 for project '${name}' under prefix '${r2Prefix}'.`,
  )
  process.exit(1)
}
