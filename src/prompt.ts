function isTTY(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY
}

function readLine(): Promise<string> {
  return new Promise(resolve => {
    process.stdin.once("data", (data: Buffer) => {
      resolve(data.toString().replace(/\r?\n$/, ""))
    })
  })
}

function firstChoice<T>(choices: { value: T }[]): T {
  const first = choices[0]
  if (!first) throw new Error("no choices available")
  return first.value
}

export async function confirm(
  message: string,
  defaultVal = true,
): Promise<boolean> {
  if (!isTTY()) return defaultVal
  const hint = defaultVal ? "[Y/n]" : "[y/N]"
  process.stdout.write(`${message} ${hint} `)
  const input = await readLine()
  if (!input) return defaultVal
  return input.toLowerCase() === "y" || input.toLowerCase() === "yes"
}

export async function select<T>(
  message: string,
  choices: { name: string; value: T }[],
): Promise<T> {
  if (!isTTY() || choices.length === 0) {
    return firstChoice(choices)
  }
  console.log(`${message}:`)
  choices.forEach((c, i) => {
    console.log(`  ${i + 1}. ${c.name}`)
  })
  process.stdout.write(`Enter number (1-${choices.length}): `)
  const input = await readLine()
  const idx = parseInt(input, 10) - 1
  if (!isNaN(idx) && idx >= 0 && idx < choices.length) {
    const picked = choices[idx]
    if (picked) return picked.value
  }
  return firstChoice(choices)
}

export async function textInput(
  message: string,
  defaultVal?: string,
): Promise<string> {
  if (!isTTY()) return defaultVal ?? ""
  const hint = defaultVal ? ` (${defaultVal})` : ""
  process.stdout.write(`${message}${hint}: `)
  const result = await readLine()
  return result ? result : (defaultVal ?? "")
}
