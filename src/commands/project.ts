import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  loadLocalConfig,
  writeGlobalConfig,
  writeLocalConfig,
  resolveActiveProjectConfig,
  defaultProject,
} from "../utils/config"
import { listObjects } from "../utils/r2"
import { getCurrentDirBasename } from "../utils/git"
import type { GlobalConfig, LocalConfig } from "../utils/types"

async function cmdProjectList(
  global: GlobalConfig,
  local: LocalConfig | null,
): Promise<void> {
  const s = p.spinner()
  s.start("Scanning R2 for projects...")
  const remoteProjects = new Set<string>()
  try {
    const all = await listObjects(global.r2)
    all.forEach(obj => {
      const parts = obj.key.split("/")
      if (parts[0] && parts[1]) {
        remoteProjects.add(`${parts[0]}/${parts[1]}`)
      }
    })
    s.stop("Projects list loaded.")
  } catch {
    s.stop("Failed to scan R2. Showing local configured projects.")
  }

  const localProjects = Object.keys(global.projects)
  const combined = new Set([...localProjects, ...remoteProjects])

  console.log("\nProjects:")
  if (combined.size === 0) {
    console.log("  No projects found. Run 'r2git init' to create one.\n")
    return
  }

  const currentProject = local?.project ?? global.activeProject ?? "(none)"
  for (const proj of combined) {
    const isCurrent = proj === currentProject
    const isLocal = local?.project === proj
    const indicator = isCurrent ? `* ${proj}` : `  ${proj}`
    const details: string[] = []
    if (isLocal) details.push("local")
    if (global.projects[proj]) details.push("configured locally")
    if (remoteProjects.has(proj)) details.push("has remote backups")
    const detailStr = details.length > 0 ? ` (${details.join(", ")})` : ""
    console.log(`  ${indicator}${detailStr}`)
  }
  console.log("")
}

async function cmdProjectSwitch(
  global: GlobalConfig,
  local: LocalConfig | null,
  target: string | undefined,
): Promise<void> {
  if (!target) {
    const allProjects = Object.keys(global.projects)
    if (allProjects.length === 0) {
      p.cancel(
        "No projects available to switch to. Run 'r2git init' or pass project name.",
      )
      process.exit(1)
    }
    const picked = await p.select({
      message: "Select active project",
      options: allProjects.map(name => ({ value: name, label: name })),
    })
    if (p.isCancel(picked)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }

    global.activeProject = picked as string
    await writeGlobalConfig(global)
    p.note(`Switched default project to: "${picked}"`, "Success")
    return
  }

  if (local) {
    local.project = target
    await writeLocalConfig(local)
    p.note(`Switched local project configuration to: "${target}"`, "Success")
  } else {
    global.activeProject = target
    global.projects[target] ??= defaultProject(target)
    await writeGlobalConfig(global)
    p.note(`Switched global active project to: "${target}"`, "Success")
  }
}

export async function cmdProject(args: string[]): Promise<void> {
  const sub = args[0]
  const global = await loadGlobalConfig()
  const local = await loadLocalConfig()

  if (sub === "list") {
    await cmdProjectList(global, local)
    return
  }

  if (sub === "switch") {
    await cmdProjectSwitch(global, local, args[1])
    return
  }

  const autoName = getCurrentDirBasename()
  const cfg = await resolveActiveProjectConfig(autoName)
  console.log(
    `\nActive Project: ${cfg.project} (${cfg.isLocal ? "local .r2gitconfig" : "global activeProject fallback"})`,
  )
  console.log(`  Paths:      ${cfg.backup.paths.length} tracked path(s)`)
  console.log(`  Retention:  ${cfg.backup.retention} backup(s) to keep`)
  console.log("")
}
