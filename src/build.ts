export function buildJS(outfile = "dist/index.js"): boolean {
  console.log(`Building JS bundle → ${outfile}...`)
  const proc = Bun.spawnSync([
    "bun",
    "build",
    "src/main.ts",
    "--target=bun",
    "--outfile",
    outfile,
    "--banner.js=#!/usr/bin/env bun",
  ])
  if (!proc.success) {
    console.error(`JS build failed: ${proc.stderr.toString()}`)
    return false
  }
  console.log("JS build OK")
  return true
}

export function buildBinaries(): boolean {
  const targets = [
    { target: "bun-linux-x64", name: "r2git-linux-x64" },
    { target: "bun-linux-arm64", name: "r2git-linux-arm64" },
    { target: "bun-darwin-x64", name: "r2git-macos-x64" },
    { target: "bun-darwin-arm64", name: "r2git-macos-arm64" },
    { target: "bun-windows-x64", name: "r2git-windows-x64.exe" },
  ]
  console.log("Building platform binaries...")
  let allOk = true
  for (const t of targets) {
    const outfile = `dist/${t.name}`
    console.log(`  ${t.target} → ${outfile}`)
    const proc = Bun.spawnSync([
      "bun",
      "build",
      "--compile",
      "--target",
      t.target,
      "src/main.ts",
      "--outfile",
      outfile,
    ])
    if (!proc.success) {
      console.error(`  FAILED: ${proc.stderr.toString()}`)
      allOk = false
    }
  }
  return allOk
}

export function buildAll(): boolean {
  const ok = buildJS()
  const okBin = buildBinaries()
  return ok && okBin
}

if (import.meta.main) {
  buildAll()
}
