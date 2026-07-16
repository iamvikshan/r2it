import * as p from "@clack/prompts"
import {
  loadLocalConfig,
  writeLocalConfig,
  LOCAL_CONFIG_FILENAME,
} from "../utils/config"

export async function cmdRm(args: string[]): Promise<void> {
  const local = await loadLocalConfig()

  if (!local) {
    p.cancel(
      "No local .r2gitconfig found in this directory. Run 'r2git init' first.",
    )
    process.exit(1)
  }

  if (local.backup.paths.length === 0) {
    p.note("No tracked paths to remove.", "Info")
    return
  }

  let pathsToRemove = args.filter(Boolean)

  if (pathsToRemove.length === 0) {
    const selectPaths = await p.multiselect({
      message: "Select tracked paths to remove (untrack)",
      options: local.backup.paths.map(path => ({
        value: path,
        label: path,
      })),
      required: false,
    })
    if (p.isCancel(selectPaths)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }
    pathsToRemove = selectPaths as string[]
  }

  const currentPaths = new Set(local.backup.paths)
  let removedCount = 0

  for (const path of pathsToRemove) {
    let found = false
    const matchers = [
      path,
      `{cwd}/${path}`,
      path.startsWith(process.cwd())
        ? `{cwd}/${path.slice(process.cwd().length).replace(/^\//, "")}`
        : "",
    ]

    for (const m of matchers) {
      if (m && currentPaths.has(m)) {
        local.backup.paths = local.backup.paths.filter(p => p !== m)
        currentPaths.delete(m)
        removedCount++
        console.log(`  \x1b[31m- Untrack path:\x1b[0m ${m}`)
        found = true
        break
      }
    }
    if (!found) {
      console.log(`  \x1b[33mℹ Path not found in tracked list:\x1b[0m ${path}`)
    }
  }

  if (removedCount > 0) {
    await writeLocalConfig(local)
    p.note(
      `Removed ${removedCount} path(s) from ${LOCAL_CONFIG_FILENAME}`,
      "Success",
    )
  } else {
    p.note("No paths were removed.", "Info")
  }
}
