import { Glob } from "bun"

export function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? "/root"
}

export function joinPaths(a: string, b: string): string {
  const cleanA = a.endsWith("/") ? a.slice(0, -1) : a
  const cleanB = b.startsWith("/") ? b.slice(1) : b
  return `${cleanA}/${cleanB}`
}

export type PathContext = {
  cwd: string
  home: string
  project?: string
}

/**
 * Resolve a path variable string to an absolute path.
 *
 * Supported variables:
 *   {cwd}         → process.cwd()
 *   {home}        → home directory
 *   ~             → home directory (shorthand)
 *   {project}     → project name from config
 *   {xdg_config}  → $XDG_CONFIG_HOME or ~/.config
 *   {xdg_data}    → $XDG_DATA_HOME or ~/.local/share
 *   {xdg_cache}   → $XDG_CACHE_HOME or ~/.cache
 *   {tmp}         → OS temp directory
 *
 * Absolute paths (starting with /) pass through unchanged.
 * Relative paths are resolved against cwd.
 */
export function resolvePath(input: string, ctx: PathContext): string {
  let resolved = input

  // ~ → home
  if (resolved.startsWith("~")) {
    resolved = resolved.replace("~", ctx.home)
  }

  // Variable substitution (order matters — do longest matches first)
  resolved = resolved.replace(/\{xdg_config\}/g, process.env.XDG_CONFIG_HOME ?? `${ctx.home}/.config`)
  resolved = resolved.replace(/\{xdg_data\}/g, process.env.XDG_DATA_HOME ?? `${ctx.home}/.local/share`)
  resolved = resolved.replace(/\{xdg_cache\}/g, process.env.XDG_CACHE_HOME ?? `${ctx.home}/.cache`)
  resolved = resolved.replace(/\{tmp\}/g, process.env.TMPDIR ?? process.env.TEMP ?? "/tmp")
  resolved = resolved.replace(/\{home\}/g, ctx.home)
  resolved = resolved.replace(/\{cwd\}/g, ctx.cwd)
  if (ctx.project) {
    resolved = resolved.replace(/\{project\}/g, ctx.project)
  }

  // Absolute path → pass through
  if (resolved.startsWith("/")) {
    return resolved
  }

  // Relative path → resolve against cwd
  return joinPaths(ctx.cwd, resolved)
}

/**
 * Build a PathContext from current environment.
 */
export function buildPathContext(project?: string): PathContext {
  return {
    cwd: process.cwd(),
    home: homeDir(),
    project,
  }
}

/**
 * Resolve an array of paths using the given context.
 * Returns [resolved, relative] where relative has leading / stripped (for tar).
 */
export function resolvePaths(
  paths: string[],
  ctx: PathContext,
): Array<{ original: string; absolute: string; relative: string }> {
  return paths.map(p => {
    const absolute = resolvePath(p, ctx)
    const relative = absolute.startsWith("/") ? absolute.slice(1) : absolute
    return { original: p, absolute, relative }
  })
}

/**
 * Check if a path exists. Accepts absolute paths directly.
 * The old version broke on absolute paths because it re-resolved them.
 */
export async function checkPathExists(absolutePath: string): Promise<boolean> {
  try {
    return await Bun.file(absolutePath).exists()
  } catch {
    return false
  }
}

/**
 * Check if a path is a symlink.
 */
export async function isSymlink(absolutePath: string): Promise<boolean> {
  try {
    const stat = await Bun.file(absolutePath).exists()
    if (!stat) return false
    // Bun doesn't have lstat directly, use fs
    const { lstatSync } = await import("node:fs")
    const s = lstatSync(absolutePath)
    return s.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Check if a path is a directory.
 */
export async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    const { statSync } = await import("node:fs")
    const s = statSync(absolutePath)
    return s.isDirectory()
  } catch {
    return false
  }
}

/**
 * Get file size in bytes. Returns null if file doesn't exist.
 */
export async function getFileSize(absolutePath: string): Promise<number | null> {
  try {
    const file = Bun.file(absolutePath)
    if (await file.exists()) {
      return file.size
    }
    return null
  } catch {
    return null
  }
}

export async function getMaxMTime(path: string): Promise<number | null> {
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      return file.lastModified
    }
    // If it's a directory
    const glob = new Glob("**/*")
    let max = 0
    let hasFiles = false
    for (const entry of glob.scanSync({
      cwd: path,
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
