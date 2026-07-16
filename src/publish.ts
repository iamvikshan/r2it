import * as p from "@clack/prompts"
import { buildAll } from "./build"
import { getDefaultBranch } from "./utils/git"

export async function publishRelease(): Promise<void> {
  p.intro("r2git release publisher")

  if (!Bun.which("gh")) {
    p.cancel(
      "GitHub CLI (gh) is required for publishing. Install it from https://cli.github.com/",
    )
    process.exit(1)
  }

  const proc = Bun.spawnSync(["git", "status", "--porcelain"])
  if (proc.stdout.toString().trim()) {
    p.cancel("Working directory is not clean. Commit or stash changes first.")
    process.exit(1)
  }

  const branch = getDefaultBranch()
  p.note(`Current branch: ${branch}`, "Git Information")

  const ok = await p.confirm({
    message: "Build binaries and create a GitHub release?",
    initialValue: true,
  })
  if (p.isCancel(ok) || !ok) {
    p.cancel("Operation cancelled.")
    process.exit(0)
  }

  const s = p.spinner()
  s.start("Building JS bundle and native binaries...")
  const built = buildAll()
  if (!built) {
    s.stop("Build failed.")
    p.cancel("Aborting release.")
    process.exit(1)
  }
  s.stop("Build completed successfully.")

  const tagProc = Bun.spawnSync(["git", "describe", "--tags", "--abbrev=0"])
  const latestTag = tagProc.success
    ? tagProc.stdout.toString().trim()
    : "v0.0.0"

  const nextTag = nextPatch(latestTag)
  const tagVal = await p.text({
    message: "Release tag",
    placeholder: nextTag,
    initialValue: nextTag,
    validate(val) {
      if (!val) return "Tag is required"
      return undefined
    },
  })
  if (p.isCancel(tagVal)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  const tag = tagVal as string

  const nameVal = await p.text({
    message: "Release name",
    placeholder: tag,
    initialValue: tag,
  })
  if (p.isCancel(nameVal)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  const name = (nameVal as string) || tag

  const notesVal = await p.text({
    message: "Release notes",
    placeholder: "Optional notes...",
  })
  if (p.isCancel(notesVal)) {
    p.cancel("Cancelled.")
    process.exit(0)
  }
  const notes = notesVal as string

  const tagSpinner = p.spinner()
  tagSpinner.start(`Creating tag ${tag}...`)
  const tagCreate = Bun.spawnSync(["git", "tag", tag])
  if (!tagCreate.success) {
    tagSpinner.stop("Failed to create tag.")
    p.cancel("Release aborted.")
    process.exit(1)
  }
  tagSpinner.stop(`Tag ${tag} created.`)

  const pushSpinner = p.spinner()
  pushSpinner.start(`Pushing tag ${tag} to origin...`)
  const pushTag = Bun.spawnSync(["git", "push", "origin", tag])
  if (!pushTag.success) {
    pushSpinner.stop("Failed to push tag.")
    p.cancel("Release aborted. Do you have push access?")
    process.exit(1)
  }
  pushSpinner.stop(`Tag ${tag} pushed to origin.`)

  const releaseSpinner = p.spinner()
  releaseSpinner.start("Creating GitHub release and uploading assets...")
  const ghArgs: string[] = [
    "release",
    "create",
    tag,
    "--title",
    name,
    "--target",
    branch,
    "dist/index.js#Universal JS Bundle (Node/Bun)",
    "dist/r2git-linux-x64#Linux (x64)",
    "dist/r2git-linux-arm64#Linux (ARM64)",
    "dist/r2git-macos-x64#macOS (x64)",
    "dist/r2git-macos-arm64#macOS (Apple Silicon)",
    "dist/r2git-windows-x64.exe#Windows (x64)",
  ]
  if (notes) {
    ghArgs.push("--notes", notes)
  }

  const gh = Bun.spawnSync(["gh", ...ghArgs])
  if (!gh.success) {
    releaseSpinner.stop("GitHub release failed.")
    console.error(gh.stderr.toString())
    p.cancel("Release aborted.")
    process.exit(1)
  }
  releaseSpinner.stop(`Release ${tag} created!`)

  p.outro(`Successfully published ${tag}! (^_<) ~*`)
}

function nextPatch(current: string): string {
  const m = current.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return "v0.1.0"
  return `v${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

if (import.meta.main) {
  publishRelease().catch((err: unknown) => {
    console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
