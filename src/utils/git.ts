export function getGitRemoteOrigin(): string | null {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"])
  if (!proc.success) return null
  return proc.stdout.toString().trim()
}

export function parseProjectFromRemote(url: string): string | null {
  const patterns = [
    /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
    /gitlab\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
    /bitbucket\.org[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/,
  ]
  for (const pat of patterns) {
    const m = url.match(pat)
    if (m) return `${m[1]}/${m[2]}`
  }
  return null
}

export function getCurrentDirBasename(): string {
  const cwd = process.cwd()
  return cwd.split("/").filter(Boolean).pop() ?? "unknown"
}

export function gitInit(dir: string): boolean {
  const proc = Bun.spawnSync(["git", "init"], { cwd: dir })
  return proc.success
}

export function getDefaultBranch(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"])
  if (proc.success) {
    const branch = proc.stdout.toString().trim()
    if (branch) return branch
  }
  const remotes = Bun.spawnSync(["git", "remote", "show", "origin"])
  if (remotes.success) {
    for (const line of remotes.stdout.toString().split("\n")) {
      const m = line.match(/HEAD branch:\s*(.+)/)
      if (m?.[1]) return m[1].trim()
    }
  }
  return "main"
}
