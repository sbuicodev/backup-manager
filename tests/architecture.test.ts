import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f))
}

test('engine and scheduler never import electron', () => {
  const files = [...tsFiles('src/main/engine'), ...tsFiles('src/main/scheduler')]
  for (const f of files) {
    expect(readFileSync(f, 'utf8'), f).not.toMatch(
      /from ["']electron["']|require\(["']electron["']\)/
    )
  }
})
