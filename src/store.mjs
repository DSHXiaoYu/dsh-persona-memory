/**
 * 事实库：长期记忆的存取、合并、衰减、检索。
 *
 * 一条记忆长这样：
 *   { id, text, kind, tags[], importance, weight, tier, status,
 *     createdAt, updatedAt, lastMentionedAt, mentions, source }
 *
 * 为什么重要度/权重分开：
 *   importance 是这个信息本身有多重要（人定的，不随时间变）；
 *   weight 是「现在还剩下多少印象」，会随时间和被提及衰减/回涨。
 *   卡片和检索都按 weight 排，衰减永远不删数据，只是把它挪到冷宫（status: archived）。
 */
import { join } from 'node:path'
import { compareKey, jaccard, normalizeText, tokenize } from './text.mjs'
import { readJson, readText, writeJson } from './paths.mjs'

export const FACT_KINDS = ['relation', 'preference', 'fact', 'promise', 'event', 'taboo']
export const MEMORY_TIERS = ['core', 'important', 'normal', 'trivial']

export const KIND_LABEL = {
  relation: '关系',
  preference: '喜好',
  fact: '事实',
  promise: '约定',
  event: '近况',
  taboo: '别碰',
}

/** 每种 tier 的衰减半衰期（天）。core 永不衰减。 */
const HALF_LIFE_DAYS = { core: Infinity, important: 180, normal: 60, trivial: 14 }

/** 低于这个权重就归档（core 除外） */
const ARCHIVE_BELOW = 0.12


export function tierOf(fact, importance) {
  if (fact?.tier && MEMORY_TIERS.includes(fact.tier)) return fact.tier
  const imp = Number(importance ?? fact?.importance ?? 0.5)
  if (imp >= 0.85) return 'core'
  if (imp >= 0.65) return 'important'
  if (imp >= 0.35) return 'normal'
  return 'trivial'
}

/** 印象强度：底层权重 × 新鲜度，0..1，用于排序 */
export function strengthOf(fact, now = Date.now()) {
  const base = clamp01(Number(fact.weight ?? fact.importance ?? 0.5))
  const last = Number(fact.lastMentionedAt || fact.updatedAt || fact.createdAt || now)
  const days = Math.max(0, (now - last) / 86_400_000)
  const half = HALF_LIFE_DAYS[tierOf(fact)] ?? 60
  if (!Number.isFinite(half)) return base
  const freshness = Math.pow(0.5, days / half)
  return clamp01(base * (0.55 + 0.45 * freshness))
}

export function clamp01(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return 0
  return Math.max(0, Math.min(1, x))
}

// ── 读写 ────────────────────────────────────────────────────────────────

export function storeFile(dir) {
  return join(dir, 'facts.json')
}

export function archiveFile(dir) {
  return join(dir, 'facts.archive.json')
}

export function profileFile(dir) {
  return join(dir, 'profile.md')
}

export function loadStore(dir) {
  const raw = readJson(storeFile(dir), null)
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.facts)) {
    return { version: 1, facts: [], updatedAt: new Date().toISOString() }
  }
  return {
    version: 1,
    facts: raw.facts.filter((f) => f && typeof f.text === 'string' && f.text.trim()),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  }
}

export function saveStore(dir, store) {
  store.updatedAt = new Date().toISOString()
  writeJson(storeFile(dir), store)
}

export function loadProfile(dir) {
  return readText(profileFile(dir), '')
}

export function loadArchive(dir) {
  const raw = readJson(archiveFile(dir), null)
  return Array.isArray(raw?.facts) ? raw.facts : []
}

// ── 写入 ────────────────────────────────────────────────────────────────

function nextId(facts) {
  let max = 0
  for (const f of facts) {
    const m = /^m(\d+)$/.exec(String(f.id || ''))
    if (m) max = Math.max(max, Number(m[1]))
  }
  return 'm' + String(max + 1).padStart(4, '0')
}

/**
 * 写一条记忆。同义/近似重复的会合并到已有条目上（而不是堆两条）。
 * @returns {{ok:true, id:string, merged:boolean, fact:object}}
 */
export function saveFact(dir, input = {}, now = Date.now()) {
  const text = String(input.text ?? '').trim()
  if (!text) return { ok: false, error: 'text 不能为空' }
  const kind = FACT_KINDS.includes(input.kind) ? input.kind : 'fact'
  const importance = clamp01(input.importance ?? 0.5)
  const tier = MAGIC_TIER(input.tier) ?? tierOf(null, importance)
  const tags = Array.isArray(input.tags)
    ? [...new Set(input.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 8)
    : []

  const store = loadStore(dir)
  const key = compareKey(text)
  const hit = store.facts.find(
    (f) => f.status !== 'archived' && compareKey(f.text) === key,
  ) || store.facts.find(
    (f) =>
      f.status !== 'archived' &&
      f.kind === kind &&
      isRestatement(f.text, text),
  )

  if (hit) {
    // 合并：保留更完整的表述，标签取并集，重要度取高，提及次数累加
    if (text.length > hit.text.length) hit.text = text
    hit.tags = [...new Set([...(hit.tags ?? []), ...tags])].slice(0, 8)
    hit.importance = Math.max(Number(hit.importance) || 0, importance)
    hit.tier = rankTier(hit.tier, tier)
    hit.weight = clamp01(Math.max(Number(hit.weight) || 0, importance) + 0.05)
    hit.mentions = (Number(hit.mentions) || 1) + 1
    hit.lastMentionedAt = now
    hit.updatedAt = now
    if (input.source) hit.source = input.source
    saveStore(dir, store)
    return { ok: true, id: hit.id, merged: true, fact: hit }
  }

  const fact = {
    id: nextId(store.facts),
    text,
    kind,
    tags,
    importance,
    weight: importance,
    tier,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    lastMentionedAt: now,
    mentions: 1,
    source: input.source || 'manual',
  }
  store.facts.push(fact)
  saveStore(dir, store)
  return { ok: true, id: fact.id, merged: false, fact }
}

/** 手写 tier 的合法值校验；非法返回 null（回落按 importance 推导） */
/**
 * 判断 b 是不是 a 的重述（用来合并，而不是堆两条）。
 * 只认两种：比较键完全相同（只差标点/空白），或者短的那句几乎整句被长的那句包含。
 * 刻意保守——词法层面分不清「改写」和「另一件事」，宁可少合并也别把两条记忆搅在一起。
 */
function isRestatement(a, b) {
  const ka = compareKey(a)
  const kb = compareKey(b)
  if (!ka || !kb) return false
  if (ka === kb) return true
  const [short, long] = ka.length <= kb.length ? [ka, kb] : [kb, ka]
  return short.length / long.length >= 0.85 && long.includes(short)
}

function MAGIC_TIER(value) {
  return value && MEMORY_TIERS.includes(value) ? value : null
}

/** core > important > normal > trivial 里取更高的一档 */
function rankTier(a, b) {
  const ia = MEMORY_TIERS.indexOf(a)
  const ib = MEMORY_TIERS.indexOf(b)
  return ia <= ib ? (MEMORY_TIERS[ia] ?? 'normal') : (MEMORY_TIERS[ib] ?? 'normal')
}

export function forgetFact(dir, id, reason = '', now = Date.now()) {
  const store = loadStore(dir)
  const fact = store.facts.find((f) => f.id === id)
  if (!fact) return { ok: false, error: `没有这条记忆：${id}` }
  if (fact.status === 'archived') return { ok: true, already: true, fact }
  fact.status = 'archived'
  fact.archivedAt = now
  fact.archiveReason = String(reason || '').slice(0, 120)
  saveStore(dir, store)
  return { ok: true, fact }
}

// ── 检索 ────────────────────────────────────────────────────────────────

/**
 * 词法检索（BM25-lite）。返回按相关度排序的条目。
 * query 为空时按印象强度返回最近/最重的条目（给「她记得什么」用）。
 */
export function searchFacts(dir, query, options = {}, now = Date.now()) {
  const store = loadStore(dir)
  const limit = clampInt(options.limit, 1, 50, 8)
  const kind = options.kind
  const includeArchived = options.includeArchived === true
  const candidates = store.facts.filter(
    (f) => (includeArchived || f.status !== 'archived') && (!kind || f.kind === kind),
  )

  const q = normalizeText(query)
  if (!q) {
    return candidates
      .map((f) => ({ fact: f, score: strengthOf(f, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  const qTokens = [...new Set(tokenize(q))]
  const df = new Map()
  const docs = candidates.map((f) => {
    const toks = tokenize(f.text)
    const tf = new Map()
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1)
    for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1)
    return { fact: f, tf, len: toks.length }
  })

  const N = docs.length || 1
  const avgLen = docs.reduce((s, d) => s + d.len, 0) / N || 1
  const k1 = 1.2
  const b = 0.75

  const scored = docs.map((d) => {
    let score = 0
    for (const t of qTokens) {
      const tf = d.tf.get(t) ?? 0
      if (!tf) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (d.len / avgLen))))
    }
    if (compareKey(d.fact.text).includes(compareKey(q))) score += 2 // 整串命中
    const strength = strengthOf(d.fact, now)
    return { fact: d.fact, score: score * (0.6 + 0.8 * strength) }
  })

  return scored
    .filter((r) => r.score > 0)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, limit)
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(n)))
}

// ── 维护 ────────────────────────────────────────────────────────────────

/**
 * 每日衰减：把 weight 按各 tier 的半衰期往下推，太弱的归档。
 * 幂等：同一天跑多次结果一致（按 lastDecayAt 到 now 的天数计算）。
 */
export function decayStore(dir, now = Date.now()) {
  const store = loadStore(dir)
  let decayed = 0
  let archived = 0
  for (const f of store.facts) {
    if (f.status === 'archived') continue
    const tier = tierOf(f)
    if (tier === 'core') {
      f.weight = clamp01(Math.max(Number(f.weight) || 0, 0.9))
      continue
    }
    const last = Number(f.lastMentionedAt || f.updatedAt || f.createdAt || now)
    const days = Math.max(0, (now - last) / 86_400_000)
    const half = HALF_LIFE_DAYS[tier] ?? 60
    const factor = Math.pow(0.5, days / half)
    const next = clamp01((Number(f.weight) || 0) * factor)
    if (next < (Number(f.weight) || 0)) decayed++
    f.weight = next
    if (next < ARCHIVE_BELOW) {
      f.status = 'archived'
      f.archivedAt = now
      f.archiveReason = `weight ${next.toFixed(2)} < ${ARCHIVE_BELOW}（${days.toFixed(0)} 天没被提起）`
      archived++
    }
  }
  saveStore(dir, store)
  return { decayed, archived, total: store.facts.length }
}

export function statsOf(dir, now = Date.now()) {
  const store = loadStore(dir)
  const byKind = {}
  const byTier = {}
  let active = 0
  for (const f of store.facts) {
    if (f.status === 'archived') continue
    active++
    byKind[f.kind] = (byKind[f.kind] ?? 0) + 1
    const t = tierOf(f)
    byTier[t] = (byTier[t] ?? 0) + 1
  }
  return {
    total: store.facts.length,
    active,
    archived: store.facts.length - active,
    byKind,
    byTier,
    updatedAt: store.updatedAt,
    avgStrength: active
      ? store.facts.filter((f) => f.status !== 'archived').reduce((s, f) => s + strengthOf(f, now), 0) / active
      : 0,
  }
}
