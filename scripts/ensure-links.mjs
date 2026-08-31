// Ensure node_modules/@deepseek-ai/<pkg> junctions into the local DSH checkout.
// Idempotent: existing valid links are left alone; missing ones are created.
// The checkout root comes from $DSH_CHECKOUT (or the known default).
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'

const checkout = process.env.DSH_CHECKOUT ?? 'D:/DeepseekHome/deepseek-harness'

/** package name → path inside the checkout (vendor forks + workspace packages). */
const LINKS = {
  cordis: 'vendor/cordis',
  schemastery: 'vendor/schemastery',
  'dsh-web': 'packages/web/web',
  'dsh-settings': 'packages/settings/settings',
  'dsh-credentials': 'packages/credentials/credentials',
  'dsh-launch-environment': 'packages/util/launch-environment',
  'dsh-llm': 'packages/llm/llm',
}

function isJunction(p) {
  try {
    return readlinkSync(p) !== undefined
  } catch {
    return false
  }
}

const scope = join(process.cwd(), 'node_modules', '@deepseek-ai')
mkdirSync(scope, { recursive: true })

for (const [name, rel] of Object.entries(LINKS)) {
  const target = join(checkout, rel)
  const link = join(scope, name)
  if (!existsSync(target)) {
    console.warn(`[ensure-links] SKIP ${name}: checkout target missing at ${target}`)
    continue
  }
  if (existsSync(link)) {
    if (isJunction(link)) {
      console.log(`[ensure-links] ok ${name}`)
      continue
    }
    console.warn(`[ensure-links] SKIP ${name}: ${link} exists but is not a junction`)
    continue
  }
  try {
    symlinkSync(target, link, 'junction')
    console.log(`[ensure-links] linked ${name} -> ${target}`)
  } catch (error) {
    console.warn(`[ensure-links] FAILED ${name}: ${String(error)}`)
  }
}

console.log(`[ensure-links] scope node_modules/@deepseek-ai now: ${readdirSync(scope).join(', ')}`)