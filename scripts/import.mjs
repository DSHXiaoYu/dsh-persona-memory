/**
 * 从别的格式导入记忆（迁移用）。
 *
 * 支持：
 *   node scripts/import.mjs --from path/to/facts.json --data-dir ~/.dsh/persona-memory
 *   node scripts/import.mjs --from old.json --dry        # 只看看会导入多少条
 *
 * 能认的输入：数组，或 { facts: [...] } / { items: [...] }；每条至少有 text 字段。
 * 字段映射：text / kind / tags / importance|weight / tier / createdAt|lastMentionedAt（毫秒或 ISO 都行）。
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { ensureDir, writeJson } from '../src/paths.mjs'
import { loadStore, saveFact } from '../src/store.mjs'

function parseArgs(argv) {
  const out = { from: '', dataDir: '', dry: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') out.from = argv[++i] || ''
    else if (a === '--data-dir') out.dataDir = argv[++i] || ''
    else if (a === '--dry') out.dry = true
  }
  return out
}

function toMs(value) {
  if (!value) return 0
  if (typeof value === 'number') return value
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

const args = parseArgs(process.argv.slice(2))
if (!args.from) {
  console.error('用法：node scripts/import.mjs --from <facts.json> [--data-dir <目录>] [--dry]')
  process.exit(1)
}

const dataDir = args.dataDir
  ? resolve(args.dataDir.replace(/^~/, homedir()))
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'persona-memory')

const raw = JSON.parse(readFileSync(isAbsolute(args.from) ? args.from : resolve(args.from), 'utf8'))
const items = Array.isArray(raw) ? raw : raw.facts || raw.items || []
if (!items.length) {
  console.error('没找到可导入的条目（期望数组或 { facts: [...] } / { items: [...] }）')
  process.exit(1)
}

ensureDir(dataDir)
const before = loadStore(dataDir).facts.length
let imported = 0
let skipped = 0

for (const item of items) {
  const text = String(item.text || item.content || '').trim()
  if (!text) {
    skipped++
    continue
  }
  const importance = Number(item.importance ?? item.weight ?? 0.5)
  if (!args.dry) {
    const r = saveFact(dataDir, {
      text,
      kind: item.kind,
      tags: item.tags,
      importance: Number.isFinite(importance) ? importance : 0.5,
      tier: item.tier,
      source: 'import',
    })
    if (!r.ok) {
      skipped++
      continue
    }
    // 保留原始时间，让衰减从正确的时间点算起
    const created = toMs(item.createdAt || item.created_at)
    const mentioned = toMs(item.lastMentionedAt || item.lastMentioned || item.mentionedAt)
    if (created || mentioned) {
      const store = loadStore(dataDir)
      const f = store.facts.find((x) => x.id === r.id)
      if (f) {
        if (created) f.createdAt = created
        if (mentioned) f.lastMentionedAt = mentioned
        f.updatedAt = Math.max(created, mentioned, f.updatedAt || 0) || f.updatedAt
        writeJson(join(dataDir, 'facts.json'), store)
      }
    }
    imported++
  } else {
    imported++
  }
}

const after = args.dry ? before : loadStore(dataDir).facts.length
console.log(
  `${args.dry ? '[dry-run] 会导入' : '导入完成：'} ${imported} 条，跳过 ${skipped} 条；库从 ${before} 条变成 ${after} 条。`,
)
console.log(`数据目录：${dataDir}`)
