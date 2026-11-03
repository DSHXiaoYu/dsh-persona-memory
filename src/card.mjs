/**
 * 卡片渲染：把「她是谁 + 你记得的事」压进一段有字数上限的文本，塞进系统提示。
 *
 * 为什么要有上限：系统提示每一步都会重新发一遍，卡片多 1000 字 = 每一步都多花
 * 1000 字的钱。900 字是实测下来「够她知道你是谁、又不至于烧钱」的折中。
 * 超出的部分不丢——留在 facts.json 里，用 memory_recall 按需取。
 */
import { join } from 'node:path'
import { KIND_LABEL, loadProfile, loadStore, strengthOf, tierOf } from './store.mjs'
import { oneLine, truncate } from './text.mjs'

const KIND_ORDER = ['relation', 'promise', 'preference', 'taboo', 'event', 'fact']

/**
 * 渲染记忆卡。
 * @returns {{text:string, chars:number, facts:number, truncated:number}}
 */
export function renderCard(dir, options = {}, now = Date.now()) {
  const maxChars = Math.max(200, Number(options.cardMaxChars) || 900)
  const maxFacts = Math.max(1, Number(options.cardMaxFacts) || 14)
  const withProfile = options.includeProfile !== false

  const profile = withProfile ? loadProfile(dir).trim() : ''
  const store = loadStore(dir)
  const active = store.facts.filter((f) => f.status !== 'archived')

  const ranked = active
    .map((f) => ({ f, s: strengthOf(f, now) }))
    .sort((a, b) => b.s - a.s || String(a.f.id).localeCompare(String(b.f.id)))

  // profile 最多占 40%，剩下的留给事实
  const profileBudget = Math.floor(maxChars * 0.4)
  const profileText = profile ? truncate(profile.replace(/\n{3,}/g, '\n\n'), profileBudget) : ''

  const picked = ranked.slice(0, maxFacts).map((x) => x.f)
  const lines = []
  const reserve = 48 // 给「另有 N 条…」这句留位置
  let used = profileText.length + 20 + reserve

  for (const f of picked) {
    const label = KIND_LABEL[f.kind] || '记忆'
    const line = `- 【${label}】${oneLine(f.text, 120)}`
    if (used + line.length + 1 > maxChars) break
    lines.push(line)
    used += line.length + 1
  }

  const truncated = ranked.length - lines.length
  const parts = []
  if (profileText) parts.push(profileText)
  if (lines.length) parts.push(lines.join('\n'))
  if (truncated > 0) parts.push(`（另有 ${truncated} 条没装进卡片，需要细节时用 memory_recall 查。）`)

  let text = parts.join('\n\n').trim()

  // 兜底：profile 太长或行尾字符让总长超限时，按行回退
  if (text.length > maxChars && lines.length) {
    while (text.length > maxChars && lines.length > 1) {
      lines.pop()
      parts[1] = lines.join('\n')
      text = parts.join('\n\n').trim()
    }
    text = text.slice(0, maxChars)
  }
  return { text, chars: text.length, facts: lines.length, truncated }
}

/**
 * 完整的系统提示段：卡片 + 一句使用说明。
 * 没有记忆时返回空串，避免空段污染提示词。
 */
export function renderPromptSection(dir, options = {}, now = Date.now()) {
  const card = renderCard(dir, options, now)
  if (!card.text) return ''
  return [
    '## 你的长期记忆（跨会话，重启后还在）',
    '',
    card.text,
    '',
    '上面这些是背景，不用复述。要想起细节用 `memory_recall`；主人说了值得长期记住的事，用 `memory_remember` 记一条（一句话，别写成日记）。',
  ].join('\n')
}

/** 给 /memory status 用的分组统计文本 */
export function renderStatus(dir, stats, now = Date.now()) {
  const byKind = Object.entries(stats.byKind || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${KIND_LABEL[k] || k} ${n}`)
    .join(' · ')
  return [
    `记忆库：${stats.active} 条在用 / ${stats.archived} 条归档（共 ${stats.total}）`,
    byKind ? `分布：${byKind}` : '',
    `平均印象：${(stats.avgStrength ?? 0).toFixed(2)}`,
    `数据目录：${dir}`,
    `文件：${join(dir, 'facts.json')} · ${join(dir, 'profile.md')}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** 导出成人类可读的 Markdown（备份 / 迁移用） */
export function renderExport(dir, now = Date.now()) {
  const store = loadStore(dir)
  const profile = loadProfile(dir).trim()
  const byKind = new Map()
  for (const f of store.facts) {
    if (f.status === 'archived') continue
    const k = f.kind || 'fact'
    if (!byKind.has(k)) byKind.set(k, [])
    byKind.get(k).push(f)
  }
  const out = ['# 长期记忆导出', '', profile ? `## 人设\n\n${profile}` : '']
  for (const k of [...KIND_ORDER, ...[...byKind.keys()].filter((x) => !KIND_ORDER.includes(x))]) {
    const list = byKind.get(k)
    if (!list?.length) continue
    out.push('', `## ${KIND_LABEL[k] || k}`)
    for (const f of list.sort((a, b) => strengthOf(b, now) - strengthOf(a, now))) {
      out.push(`- ${f.text}  <!-- ${f.id} · ${tierOf(f)} · ${(strengthOf(f, now)).toFixed(2)} -->`)
    }
  }
  return out.join('\n').trim() + '\n'
}
