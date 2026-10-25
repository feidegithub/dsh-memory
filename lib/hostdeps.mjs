/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退到安全兜底）
 * ============================================================================
 * 为什么要有它（踩过的坑，照抄 dsh-douyin-scroll 的结论）：
 *   桌面版 profile（autoInstallPeers: false）**不会**把 optional peer 装上，
 *   所以 `import '@deepseek-ai/schemastery'` 会让整条插件 fiber 起不来。
 *   而本插件是以 junction 装进 profile 的，
 *   Node 按真实路径解析，够不到 profile 树 —— 只能手动找文件再 import。
 *
 * 策略：
 *   ① schemastery 从宿主树里找；找不到 → Config = undefined（插件照常跑，只是设置页没表单）
 *   ② dsh-tools 的 defineTool；找不到 → 本地等价实现（我们的 parameters 本来就是标准 JSON Schema）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

/** 可能藏着宿主 @deepseek-ai 包的地方（按可能性排） */
function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }

  push(process.env.DSH_PROFILE_DIR && join(process.env.DSH_PROFILE_DIR, 'node_modules', '@deepseek-ai'))

  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(home, 'profiles'))) {
      push(join(home, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  push(SELF_MODULES)
  return out
}

/** 按包 exports['.'] 找入口，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name, notes) {
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, name)
    if (!url) continue
    try {
      const mod = await import(url)
      notes.push(`${name}: ${url.replace(/^file:\/\/\//, '')}`)
      return mod
    } catch (e) {
      notes.push(`${name}: ${e?.code || 'ERR'} @ ${root}`)
    }
  }
  return null
}

/** 兜底 defineTool：只补宿主那条"object 必须写 additionalProperties"的校验 */
function localDefineTool(options, notes) {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${options.name}): ${where} 是 object 却没写 additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
    if (schema.items) check(schema.items, `${where}.items`)
  }
  check(options.parameters, 'parameters')
  check(options.output?.schema, 'output.schema')
  notes.push(`dsh-tools 不可用 → 用本地等价实现（${options.name}）`)
  return options
}

export async function loadHostDeps() {
  const notes = []
  let zMod = null
  try { zMod = await import('@deepseek-ai/schemastery'); notes.push('schemastery: 直接解析') } catch { /* 继续找 */ }
  if (!zMod) zMod = await fromHostTree('schemastery', notes)
  const z = zMod?.default ?? zMod ?? null

  let dtMod = null
  try { dtMod = await import('@deepseek-ai/dsh-tools') } catch { /* 继续找 */ }
  if (!dtMod) dtMod = await fromHostTree('dsh-tools', notes)

  const defineTool = dtMod?.defineTool || ((options) => localDefineTool(options, notes))
  if (!z) notes.push('⚠️ schemastery 彻底拿不到 → 没有 Config，设置页会降级（插件本体照常工作）')

  return { z, defineTool, notes }
}
