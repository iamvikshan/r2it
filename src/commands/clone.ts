import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  writeLocalConfig,
  projectR2Prefix,
  DEFAULT_PATHS,
} from "../utils/config"
import { listObjects, downloadObject } from "../utils/r2"
import { info, error as logError, formatSize } from "../utils/log"
import type { LocalConfig } from "../utils/types"

const TMP_TAR = "/tmp/r2git-backup.tar.gz"

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

  const newLocal: LocalConfig = {
    project: name,
    backup: {
      retention: 5,
      paths: [...DEFAULT_PATHS],
    },
  }

  const s = p.spinner()
  s.start(`Cloning project '${name}'...`)

  const r2Prefix = projectR2Prefix(name)
  let latestKey: string | null = null
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
      latestKey = latest.key
    }
  } catch (e) {
    s.stop("Failed to query R2 backups.")
    logError(e instanceof Error ? e.message : String(e), "clone")
    process.exit(1)
  }

  if (!latestKey) {
    s.stop("Clone failed.")
    p.cancel(
      `No backups found on R2 for project '${name}' under prefix '${r2Prefix}'.`,
    )
    process.exit(1)
  }

  s.message("Downloading project backup...")
  try {
    const buf = await downloadObject(global.r2, latestKey)
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

  await writeLocalConfig(newLocal)

  s.stop(`Successfully cloned and restored project '${name}'`)
  p.outro(
    "Local .r2gitconfig created. Ready to run r2git status and r2git push (^_<) ~*",
  )
}
