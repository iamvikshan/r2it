import * as p from "@clack/prompts"
import { loadGlobalConfig, writeGlobalConfig } from "../utils/config"
import {
  fetchDopplerSecrets,
  fetchDopplerProjects,
  fetchDopplerConfigs,
} from "../utils/doppler"
import { listObjects } from "../utils/r2"
import type { GlobalConfig } from "../utils/types"

async function promptTokenInput(loginMethod: string): Promise<string> {
  if (loginMethod === "browser") {
    p.note(
      "Generate or copy a Personal Access Token in your browser at:\n" +
        "https://dashboard.doppler.com/tokens/personal",
      "Doppler Token Creation",
    )
  }
  const typed = await p.password({
    message: "Enter Doppler Access Token (Service/Personal/CLI Token)",
    validate(val) {
      if (!val?.trim()) return "Token is required"
      return undefined
    },
  })
  if (p.isCancel(typed)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  return typed as string
}

async function selectDopplerProject(token: string): Promise<string> {
  const s = p.spinner()
  s.start("Retrieving projects from Doppler...")
  let projects: string[] = []
  try {
    projects = await fetchDopplerProjects(token)
    s.stop("Projects list loaded.")
  } catch (e) {
    s.stop("Failed to retrieve projects.")
    p.cancel(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  if (projects.length === 0) {
    p.cancel("No projects found in this Doppler workspace.")
    process.exit(1)
  }

  const picked = await p.select({
    message: "Select Doppler project:",
    options: projects.map(id => ({ value: id, label: id })),
  })
  if (p.isCancel(picked)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  return picked as string
}

async function selectDopplerConfig(
  token: string,
  project: string,
): Promise<string> {
  const s = p.spinner()
  s.start(`Retrieving configs for project '${project}'...`)
  let configs: string[] = []
  try {
    configs = await fetchDopplerConfigs(token, project)
    s.stop("Configs list loaded.")
  } catch (e) {
    s.stop("Failed to retrieve configs.")
    p.cancel(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }

  if (configs.length === 0) {
    p.cancel("No configs found in this Doppler project.")
    process.exit(1)
  }

  const picked = await p.select({
    message: "Select Doppler config:",
    options: configs.map(name => ({ value: name, label: name })),
  })
  if (p.isCancel(picked)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  return picked as string
}

export async function promptR2Credentials(global: GlobalConfig): Promise<void> {
  const accountId = await p.text({
    message: "R2 Account ID",
    initialValue: global.r2.accountId ?? "",
  })
  if (p.isCancel(accountId)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const accessKeyId = await p.text({
    message: "R2 Access Key ID",
    initialValue: global.r2.accessKeyId ?? "",
  })
  if (p.isCancel(accessKeyId)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const secretAccessKey = await p.password({
    message: "R2 Secret Access Key",
  })
  if (p.isCancel(secretAccessKey)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  const bucket = await p.text({
    message: "R2 Bucket Name",
    initialValue: global.r2.bucket ?? "r2git-backups",
  })
  if (p.isCancel(bucket)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }

  global.r2 = {
    accountId: (accountId as string) || global.r2.accountId,
    accessKeyId: (accessKeyId as string) || global.r2.accessKeyId,
    secretAccessKey: (secretAccessKey as string) || global.r2.secretAccessKey,
    bucket: (bucket as string) || global.r2.bucket,
  }
  await writeGlobalConfig(global)
  p.note(
    "Cloudflare R2 credentials updated globally in ~/.r2gitrc.",
    "Auth Config",
  )
}

async function verifyDopplerToken(token: string): Promise<void> {
  const verifySpinner = p.spinner()
  verifySpinner.start("Verifying token connection...")
  try {
    await fetchDopplerProjects(token)
    verifySpinner.stop("Token verified [OK]")
  } catch {
    verifySpinner.stop("Verification failed [ERROR]")
    p.cancel(
      "Error: Invalid or unauthorized Doppler token. Check your token and try again.",
    )
    process.exit(1)
  }
}

async function importSecretsFromDoppler(
  token: string,
  project?: string,
  config?: string,
): Promise<boolean> {
  const s = p.spinner()
  s.start("Fetching secrets from Doppler...")
  try {
    const secrets = await fetchDopplerSecrets(token, project, config)
    s.stop("Secrets fetched.")

    const accountId = secrets.R2_ACCOUNT_ID ?? secrets.CLOUDFLARE_ACCOUNT_ID
    const accessKeyId =
      secrets.R2_ACCESS_KEY_ID ?? secrets.CLOUDFLARE_ACCESS_KEY_ID
    const secretAccessKey =
      secrets.R2_SECRET_ACCESS_KEY ?? secrets.CLOUDFLARE_SECRET_ACCESS_KEY
    const bucket = secrets.R2_BUCKET ?? secrets.CLOUDFLARE_R2_BUCKET

    if (!accountId || !accessKeyId || !secretAccessKey) {
      p.note(
        "Error: Could not find R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, or R2_SECRET_ACCESS_KEY in Doppler secrets.",
        "Import Failed",
      )
      return false
    }

    const global = await loadGlobalConfig()
    global.r2 = {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucket: bucket ?? global.r2.bucket ?? "r2git-backups",
    }
    global.dopplerToken = token
    await writeGlobalConfig(global)
    p.outro(
      "Successfully imported Cloudflare R2 credentials from Doppler into ~/.r2gitrc (^_<) ~*",
    )
    return true
  } catch (e) {
    s.stop("Failed to fetch Doppler secrets.")
    console.error(e instanceof Error ? e.message : String(e))
    return false
  }
}

function cleanUpTempDoppler(): void {
  Bun.spawnSync(["rm", "-rf", "/tmp/r2git-doppler"])
}

async function runDopplerCliLogin(): Promise<string> {
  const installDir = "/tmp/r2git-doppler"
  let dopplerPath = Bun.which("doppler")
  let isTemp = false

  if (!dopplerPath) {
    const s = p.spinner()
    s.start("Doppler CLI not found. Downloading temporarily...")
    Bun.spawnSync(["mkdir", "-p", installDir])
    const download = Bun.spawnSync([
      "sh",
      "-c",
      `curl -sLf https://cli.doppler.com/install.sh | sh -s -- --install-path ${installDir}`,
    ])
    if (download.success) {
      dopplerPath = `${installDir}/doppler`
      isTemp = true
      s.stop("Doppler CLI downloaded temporarily.")
    } else {
      s.stop("Failed to download Doppler CLI.")
      p.cancel(
        "Error: Could not install Doppler CLI. Make sure curl is installed or paste your token manually.",
      )
      process.exit(1)
    }
  }

  p.note(
    "We will now run the Doppler CLI login flow to retrieve your credentials.",
    "Doppler Authentication",
  )
  const loginProc = Bun.spawn([dopplerPath, "login"], {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  })
  const exitCode = await loginProc.exited
  if (exitCode !== 0) {
    p.cancel("Doppler login was cancelled or failed.")
    if (isTemp) cleanUpTempDoppler()
    process.exit(1)
  }

  const tokenProc = Bun.spawnSync([
    dopplerPath,
    "configure",
    "get",
    "token",
    "--json",
  ])
  let token = ""
  try {
    const data = JSON.parse(tokenProc.stdout.toString()) as { token?: string }
    token = data.token ?? ""
  } catch {
    // fallback
  }

  return token
}

async function obtainDopplerToken(
  tokenVal?: string,
  globalConfigToken?: string,
): Promise<{ token: string; loggedInViaCli: boolean }> {
  let token = tokenVal ?? globalConfigToken
  let loggedInViaCli = false

  if (token) {
    const verifySpinner = p.spinner()
    verifySpinner.start("Verifying token connection...")
    try {
      await fetchDopplerProjects(token)
      verifySpinner.stop("Token verified [OK]")
    } catch {
      verifySpinner.stop("Saved token invalid [ERROR]")
      token = undefined
    }
  }

  if (!token) {
    const loginMethod = await p.select({
      message: "How would you like to authenticate to Doppler?",
      options: [
        {
          value: "cli",
          label:
            "Log in with Doppler CLI browser auth (1-click clipboard redirect)",
        },
        {
          value: "browser",
          label: "Open browser to copy a Personal Access Token",
        },
        {
          value: "token",
          label:
            "Paste an existing token directly (CLI, Personal, or Service Token)",
        },
      ],
    })
    if (p.isCancel(loginMethod)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }

    if (loginMethod === "cli") {
      token = await runDopplerCliLogin()
      loggedInViaCli = true
    } else {
      token = await promptTokenInput(loginMethod as string)
    }

    await verifyDopplerToken(token)
  }

  return { token, loggedInViaCli }
}

export async function cmdAuthDoppler(
  tokenVal?: string,
  projectVal?: string,
  configVal?: string,
): Promise<void> {
  p.intro("r2git auth doppler")

  const globalConfig = await loadGlobalConfig()
  const { token, loggedInViaCli } = await obtainDopplerToken(
    tokenVal,
    globalConfig.dopplerToken,
  )

  let project = projectVal
  let config = configVal
  let success = false

  while (!success) {
    const isPersonalOrCli =
      token.startsWith("dp.pt.") || token.startsWith("dp.ct.")

    let selProject = project
    let selConfig = config

    if (!selProject && isPersonalOrCli) {
      selProject = await selectDopplerProject(token)
    }
    if (!selConfig && selProject && isPersonalOrCli) {
      selConfig = await selectDopplerConfig(token, selProject)
    }

    success = await importSecretsFromDoppler(token, selProject, selConfig)

    if (!success) {
      const retry = await p.confirm({
        message:
          "Secrets import failed. Would you like to select a different project/config?",
        initialValue: true,
      })
      if (p.isCancel(retry) || !retry) {
        p.cancel("Import cancelled.")
        if (loggedInViaCli) {
          const dopplerPath =
            Bun.which("doppler") ?? "/tmp/r2git-doppler/doppler"
          Bun.spawnSync([dopplerPath, "logout", "-y"])
          cleanUpTempDoppler()
        }
        process.exit(1)
      }
      project = undefined
      config = undefined
    }
  }

  if (loggedInViaCli) {
    const dopplerPath = Bun.which("doppler") ?? "/tmp/r2git-doppler/doppler"
    Bun.spawnSync([dopplerPath, "logout", "-y"])
    cleanUpTempDoppler()
  }
}

async function cmdAuthLogin(global: GlobalConfig): Promise<void> {
  p.intro("r2git auth login")
  await promptR2Credentials(global)
  p.outro("Successfully logged in and saved credentials to ~/.r2gitrc (^_<) ~*")
}

async function cmdAuthStatus(global: GlobalConfig): Promise<void> {
  console.log("\nAuth Status:")
  if (
    !global.r2.accountId ||
    !global.r2.accessKeyId ||
    !global.r2.secretAccessKey
  ) {
    console.log("  Status: Logged out")
    console.log("  Run 'r2git auth login' to authenticate.\n")
    return
  }

  const mask = (s: string | undefined, keep = 4) => {
    if (!s) return "(none)"
    if (s.length <= keep * 2) return "••••••••"
    return s.slice(0, keep) + "••••••••" + s.slice(-keep)
  }

  console.log("  Status:            Logged in")
  console.log(`  R2 Account ID:     ${mask(global.r2.accountId)}`)
  console.log(`  R2 Access Key:     ${mask(global.r2.accessKeyId)}`)
  console.log("  R2 Secret Key:     ••••••••••••••••••••••••••••")
  console.log(`  R2 Bucket:         ${global.r2.bucket ?? "(none)"}`)

  const testSpinner = p.spinner()
  testSpinner.start("Testing connection to Cloudflare R2...")
  try {
    await listObjects(global.r2, "test-connection-prefix")
    testSpinner.stop("✔ Connection successful")
  } catch (e) {
    testSpinner.stop(
      `✖ Connection failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  console.log("")
}

export async function cmdAuth(args: string[]): Promise<void> {
  const sub = args[0]
  const global = await loadGlobalConfig()

  if (sub === "login") {
    const subsub = args[1]
    if (subsub === "doppler") {
      const token = args[2]
      await cmdAuthDoppler(token)
      return
    }

    const tokenIdx = args.indexOf("--token")
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined
    const projectIdx = args.indexOf("--project")
    const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined
    const configIdx = args.indexOf("--config")
    const config = configIdx !== -1 ? args[configIdx + 1] : undefined

    if (args.includes("--doppler") || token) {
      await cmdAuthDoppler(token, project, config)
      return
    }

    const method = await p.select({
      message: "Select login method:",
      options: [
        { value: "doppler", label: "Import credentials from Doppler" },
        { value: "manual", label: "Manual credentials input" },
      ],
    })
    if (p.isCancel(method)) {
      p.cancel("Cancelled.")
      process.exit(0)
    }

    if (method === "doppler") {
      await cmdAuthDoppler()
    } else {
      await cmdAuthLogin(global)
    }
    return
  }

  if (sub === "doppler") {
    const tokenIdx = args.indexOf("--token")
    const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined
    const projectIdx = args.indexOf("--project")
    const project = projectIdx !== -1 ? args[projectIdx + 1] : undefined
    const configIdx = args.indexOf("--config")
    const config = configIdx !== -1 ? args[configIdx + 1] : undefined
    await cmdAuthDoppler(token, project, config)
    return
  }

  if (sub === "status") {
    await cmdAuthStatus(global)
    return
  }

  console.log("Usage: r2git auth <login|status|doppler>")
  process.exit(1)
}
