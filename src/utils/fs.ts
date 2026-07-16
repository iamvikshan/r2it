import { Glob } from "bun"

export function homeDir(): string {
  return process.env.HOME ?? "/root"
}

export function joinPaths(a: string, b: string): string {
  const cleanA = a.endsWith("/") ? a.slice(0, -1) : a
  const cleanB = b.startsWith("/") ? b.slice(1) : b
  return `${cleanA}/${cleanB}`
}

export function getAbsolutePath(p: string): string {
  let resolved = p
  if (resolved.startsWith("~")) {
    resolved = resolved.replace("~", homeDir())
  } else if (resolved.startsWith("{cwd}")) {
    resolved = resolved.replace("{cwd}", process.cwd())
  } else if (!resolved.startsWith("/")) {
    resolved = joinPaths(process.cwd(), resolved)
  }
  return resolved
}

export async function checkPathExists(p: string): Promise<boolean> {
  return Bun.file(getAbsolutePath(p)).exists()
}

export async function getMaxMTime(path: string): Promise<number | null> {
  const abs = getAbsolutePath(path)
  try {
    const file = Bun.file(abs)
    if (await file.exists()) {
      return file.lastModified
    }
    // If it's a directory
    const glob = new Glob("**/*")
    let max = 0
    let hasFiles = false
    for (const entry of glob.scanSync({
      cwd: abs,
      absolute: true,
      onlyFiles: true,
    })) {
      hasFiles = true
      const f = Bun.file(entry)
      if (f.lastModified > max) {
        max = f.lastModified
      }
    }
    return hasFiles ? max : null
  } catch {
    return null
  }
}

export async function copyToClipboard(text: string): Promise<boolean> {
  const platform = process.platform
  try {
    let cmd: string[] = []
    if (platform === "darwin") {
      cmd = ["pbcopy"]
    } else if (platform === "linux") {
      if (Bun.which("wl-copy")) {
        cmd = ["wl-copy"]
      } else if (Bun.which("xclip")) {
        cmd = ["xclip", "-selection", "clipboard"]
      } else if (Bun.which("xsel")) {
        cmd = ["xsel", "--clipboard", "--input"]
      } else {
        return false
      }
    } else if (platform === "win32") {
      cmd = ["clip"]
    } else {
      return false
    }

    const proc = Bun.spawn(cmd, { stdin: "pipe" })
    await proc.stdin.write(text)
    await proc.stdin.end()
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}
