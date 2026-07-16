import * as p from "@clack/prompts"
import {
  loadGlobalConfig,
  loadLocalConfig,
  writeLocalConfig,
  LOCAL_CONFIG_FILENAME,
  DEFAULT_PATHS,
} from "../utils/config"
import {
  getCurrentDirBasename,
  getGitRemoteOrigin,
  parseProjectFromRemote,
  gitInit,
} from "../utils/git"
import { cmdAuthDoppler, promptR2Credentials } from "./auth"
import type { LocalConfig } from "../utils/types"

function handleGitSetup(): void {
  if (!Bun.spawnSync(["git", "status"], { cwd: process.cwd() }).success) {
    if (gitInit(process.cwd())) {
      p.note("Git repository initialized.", "Git")
    }
  }
  Bun.spawnSync(["git", "add", LOCAL_CONFIG_FILENAME])
  p.note(`Staged ${LOCAL_CONFIG_FILENAME} in Git.`, "Git")
}

async function promptLocalConfig(local: LocalConfig | null): Promise<void> {
  const autoName = getCurrentDirBasename()
  const gitRemote = getGitRemoteOrigin()
  const defaultProjName = gitRemote
    ? (parseProjectFromRemote(gitRemote) ?? autoName)
    : autoName

  const projectName = await p.text({
    message: "Project name (format: [org]/[repo])",
    initialValue: local?.project ?? defaultProjName,
    validate(val) {
      if (!val?.trim()) return "Project name is required"
      return undefined
    },
  })
  if (p.isCancel(projectName)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const selectPaths = await p.multiselect({
    message: "Select default files/folders to track",
    options: DEFAULT_PATHS.map(path => ({
      value: path,
      label: path,
      hint: "workspace",
    })),
    required: false,
  })
  if (p.isCancel(selectPaths)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const paths = selectPaths as string[]

  const newLocal: LocalConfig = {
    project: projectName as string,
    backup: {
      retention: local?.backup.retention ?? 5,
      paths:
        paths.length > 0 ? paths : (local?.backup.paths ?? [...DEFAULT_PATHS]),
    },
  }
  await writeLocalConfig(newLocal)
  p.note(
    `Created local ${LOCAL_CONFIG_FILENAME} with project: "${projectName}"`,
    "Local Config",
  )

  handleGitSetup()
}

export async function cmdInit(): Promise<void> {
  p.intro("r2git init")

  const global = await loadGlobalConfig()
  const hasCreds =
    global.r2.accountId && global.r2.accessKeyId && global.r2.secretAccessKey

  const configureR2 =
    !hasCreds ||
    (await p.confirm({
      message:
        "Do you want to reconfigure global Cloudflare R2 / Doppler credentials?",
      initialValue: false,
    }))

  if (p.isCancel(configureR2)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  if (configureR2) {
    const authMethod = await p.select({
      message: "Select configuration source:",
      options: [
        { value: "doppler", label: "Import credentials from Doppler" },
        { value: "manual", label: "Manual credentials input" },
      ],
    })
    if (p.isCancel(authMethod)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }

    if (authMethod === "doppler") {
      await cmdAuthDoppler()
    } else {
      await promptR2Credentials(global)
    }
  }

  const local = await loadLocalConfig()
  await promptLocalConfig(local)

  p.outro(
    "r2git initialized! You are ready to run r2git push and r2git pull (^_<) ~*",
  )
}
