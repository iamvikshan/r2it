import * as p from "@clack/prompts"
import {
  loadLocalConfig,
  writeLocalConfig,
  LOCAL_CONFIG_FILENAME,
} from "../utils/config"
import { getAbsolutePath } from "../utils/fs"

export async function cmdAdd(args: string[]): Promise<void> {
  const local = await loadLocalConfig()

  if (!local) {
    p.cancel(
      "No local .r2gitconfig found in this directory. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  let pathsToAdd = args.filter(Boolean)

  if (pathsToAdd.length === 0) {
    const typed = await p.text({
      message: "Enter path(s) to add (comma-separated)",
      placeholder: ".env, secrets.json",
      validate(val) {
        if (!val?.trim()) return "Path is required"
        return undefined
      },
    })
    if (p.isCancel(typed)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    pathsToAdd = typed
      .split(",")
      .map(s => s.trim())
      .filter(Boolean)
  }

  const currentPaths = new Set(local.backup.paths)
  let addedCount = 0

  for (const path of pathsToAdd) {
    let resolved = path
    const absPath = getAbsolutePath(path)
    if (absPath.startsWith(process.cwd())) {
      const rel = absPath.slice(process.cwd().length).replace(/^\//, "")
      resolved = `{cwd}/${rel}`
    }

    if (!currentPaths.has(resolved)) {
      local.backup.paths.push(resolved)
      currentPaths.add(resolved)
      addedCount++
      console.log(`  \x1b[32m+ Stage tracked path:\x1b[0m ${resolved}`)
    } else {
      console.log(`  \x1b[33mℹ Path already tracked:\x1b[0m ${resolved}`)
    }
  }

  if (addedCount > 0) {
    await writeLocalConfig(local)
    p.note(`Added ${addedCount} path(s) to ${LOCAL_CONFIG_FILENAME}`, "Success")
  } else {
    p.note("No new paths were added.", "Info")
  }
}
