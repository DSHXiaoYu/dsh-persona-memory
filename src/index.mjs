/**
 * dsh-persona-memory —— 给 DSH agent 的跨会话长期记忆。
 *
 * 它只做四件事：
 *   1. 每次模型调用前，把「她是谁 + 她记得的事」压成一段 ≤900 字的卡片塞进系统提示；
 *   2. 提供 memory_remember / memory_recall / memory_forget / memory_status 四个工具；
 *   3. 每天做一次衰减：很久没被提起的记忆自动降权、归档（不删除）；
 *   4. 数据全是本地 JSON / Markdown，人可以直接看、直接改、直接备份。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ensureDir, readJson, resolveDataDir, writeFileAtomic, writeJson } from './paths.mjs'
import {
  FACT_KINDS,
  KIND_LABEL,
  decayStore,
  forgetFact,
  loadStore,
  saveFact,
  searchFacts,
  statsOf,
} from './store.mjs'
import { renderCard, renderExport, renderPromptSection, renderStatus } from './card.mjs'
import { oneLine } from './text.mjs'

export const name = 'persona-memory'

/** 只强依赖工具服务；commands / systemPrompt 都是可选的 */
export const inject = ['tools']

const DEFAULTS = {
  dataDir: '',
  cardMaxChars: 900,
  cardMaxFacts: 14,
  includeProfile: true,
  injectPrompt: true,
  promptOrder: 100,
  autoDecay: true,
  rememberSource: 'agent',
}

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

function mergeConfig(config) {
  const out = { ...DEFAULTS }
  for (const [k, v] of Object.entries(config || {})) {
    if (v !== undefined && v !== null && v !== '') out[k] = v
  }
  return out
}

const PROFILE_TEMPLATE = `# 她是谁

<!--
  这段会原样进入系统提示（最多占卡片的 40%）。
  写「稳定的东西」：身份、称呼、说话习惯、底线。
  不要写「今天做了什么」——那属于 facts.json，会随时间衰减。
-->

你是……（一句话人设）

## 称呼

- 对方希望被叫作：
- 你自称：

## 说话习惯

- 句子短，不用括号写动作。
- 不说「作为 AI」这种话。

## 底线

- 不编造没发生过的事；不记得就说「我记不清了」。
`

const COMMAND_HELP = [
  '用法：',
  '  /memory                看状态',
  '  /memory card           看当前卡片（会塞进系统提示的那段）',
  '  /memory search <词>    搜记忆',
  '  /memory remember <一句话>  记一条',
  '  /memory forget <id>    忘掉一条',
  '  /memory decay          手动跑一次衰减',
  '  /memory export         导出成 Markdown',
].join('\n')

export function apply(ctx, rawConfig) {
  const config = mergeConfig(rawConfig)
  const dir = ensureDir(resolveDataDir(config))
  bootstrap(dir, config)

  if (config.autoDecay) decayOnceADay(dir)

  // ── 提示词段 ──────────────────────────────────────────────────────────
  if (config.injectPrompt) {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        scope.effect(
          () =>
            scope.systemPrompt.section({
              name: 'persona-memory:card',
              order: Number(config.promptOrder) || 100,
              text: () => {
                try {
                  return renderPromptSection(dir, config)
                } catch (err) {
                  ctx.logger?.warn?.(`persona-memory 卡片渲染失败：${err.message}`)
                  return ''
                }
              },
            }),
          '跨会话记忆卡片',
        )
      })
    } catch (err) {
      ctx.logger?.warn?.(`persona-memory 注册提示词失败：${err.message}`)
    }
  }

  // ── 工具 ──────────────────────────────────────────────────────────────
  const tools = ctx.get('tools')
  if (!tools?.register) {
    ctx.logger?.warn?.('persona-memory：没有可用的 tools 服务，工具未注册')
  } else {
    tools.register({
      name: 'memory_remember',
      description:
        '把关于主人的长期信息记下来（跨会话、重启后还在，上下文压缩也不会丢）。适合：身份、工作/作息、喜好与雷区、两个人的约定、重要日子、最近在忙的事。一句话一条，别记寒暄和一次性的小事；重复的内容会自动合并，不用怕记重。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '一句话，写成陈述句，例如「爸爸不喜欢别人叫他大佬」' },
          kind: {
            type: 'string',
            enum: FACT_KINDS,
            description: 'relation 关系 / preference 喜好 / fact 事实 / promise 约定 / event 近况 / taboo 别碰（默认 fact）',
          },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，最多 8 个' },
          importance: {
            type: 'number',
            description: '0..1，决定多快被忘掉；默认 0.5，核心事实给 0.85 以上',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          const r = saveFact(dir, {
            text: args.text,
            kind: args.kind,
            tags: args.tags,
            importance: args.importance,
            source: config.rememberSource,
          })
          if (!r.ok) return { text: `没记住：${r.error}` }
          return {
            text: r.merged
              ? `记下了（和已有的「${oneLine(r.fact.text, 40)}」合并了，现在 ${r.fact.mentions} 次提及）：${r.fact.id}`
              : `记下了：${r.fact.id} · ${KIND_LABEL[r.fact.kind]} · ${oneLine(r.fact.text, 60)}`,
          }
        } catch (err) {
          return { text: `记忆写入失败：${err.message}` }
        }
      },
    })

    tools.register({
      name: 'memory_recall',
      description:
        '查长期记忆里的细节（不只是最近这段对话）。不填 query 就按印象强度列出最重要的几条。查不到就说不记得，别编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，例如「生日」「不吃什么」「上次说的约定」' },
          kind: { type: 'string', enum: FACT_KINDS, description: '只看某一类' },
          limit: { type: 'number', description: '返回几条，默认 8，最多 30' },
        },
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        try {
          const rows = searchFacts(dir, args.query, { kind: args.kind, limit: Math.min(30, args.limit || 8) })
          if (!rows.length) return { text: args.query ? `没查到「${args.query}」相关的记忆。` : '记忆库还是空的。' }
          const lines = rows.map((r, i) => {
            const f = r.fact
            const tags = f.tags?.length ? ` #${f.tags.join(' #')}` : ''
            return `${i + 1}. [${f.id}·${KIND_LABEL[f.kind] || f.kind}·${r.score.toFixed(2)}] ${f.text}${tags}`
          })
          return { text: lines.join('\n') }
        } catch (err) {
          return { text: `记忆检索失败：${err.message}` }
        }
      },
    })

    tools.register({
      name: 'memory_forget',
      description: '忘掉一条长期记忆（归档，不是物理删除；只有记错了或主人明确要求时才用）。id 从 memory_recall 拿。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id，例如 m0007' },
          reason: { type: 'string', description: '为什么忘掉（会写进归档记录）' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      output: TEXT_OUTPUT,
      async execute(args) {
        const r = forgetFact(dir, String(args.id || '').trim(), args.reason)
        if (!r.ok) return { text: r.error }
        return { text: r.already ? `${args.id} 早就归档了。` : `忘了：${args.id}` }
      },
    })

    tools.register({
      name: 'memory_status',
      description: '看记忆库的规模、分布和文件位置（排障 / 汇报用）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: TEXT_OUTPUT,
      async execute() {
        return { text: renderStatus(dir, statsOf(dir)) }
      },
    })
  }

  // ── 命令 ──────────────────────────────────────────────────────────────
  try {
    const commands = ctx.get('commands')
    if (commands?.register) {
      commands.register({
        name: 'memory',
        description: '查看/维护长期记忆（status / card / search / remember / forget / decay / export）',
        input: { hint: 'status | card | search <词> | remember <一句话> | forget <id> | decay | export' },
        handler: (invocation) => {
          try {
            return handleCommand(invocation?.rawInput ?? '', dir, config)
          } catch (err) {
            return { kind: 'error', text: `记忆命令出错：${err.message}` }
          }
        },
      })
    }
  } catch (err) {
    ctx.logger?.warn?.(`persona-memory 注册命令失败：${err.message}`)
  }
}

function handleCommand(raw, dir, config) {
  const text = String(raw || '').trim()
  const [sub, ...rest] = text.split(/\s+/)
  const arg = rest.join(' ').trim()

  switch ((sub || 'status').toLowerCase()) {
    case 'status': {
      const stats = statsOf(dir)
      return { kind: 'success', text: renderStatus(dir, stats) + `\n卡片：${renderCard(dir, config).chars} 字 / ${renderCard(dir, config).facts} 条` }
    }
    case 'card': {
      const c = renderCard(dir, config)
      return { kind: 'success', text: c.text ? `${c.text}\n\n— ${c.chars} 字，${c.facts} 条，另有 ${c.truncated} 条没装下` : '卡片是空的：facts.json 和 profile.md 都还没有内容。' }
    }
    case 'search': {
      if (!arg) return { kind: 'error', text: '要搜什么？例如 /memory search 生日' }
      const rows = searchFacts(dir, arg, { limit: 10 })
      if (!rows.length) return { kind: 'success', text: `没查到「${arg}」。` }
      return {
        kind: 'success',
        text: rows.map((r, i) => `${i + 1}. [${r.fact.id}] ${r.fact.text}`).join('\n'),
      }
    }
    case 'remember': {
      if (!arg) return { kind: 'error', text: '要记什么？例如 /memory remember 爸爸不喜欢别人叫他大佬' }
      const r = saveFact(dir, { text: arg, source: 'command' })
      return { kind: 'success', text: r.merged ? `合并进 ${r.id}` : `记下了 ${r.id}` }
    }
    case 'forget': {
      if (!arg) return { kind: 'error', text: '要忘掉哪条？先用 /memory search 找 id' }
      const r = forgetFact(dir, arg, 'command')
      return r.ok ? { kind: 'success', text: `忘了 ${arg}` } : { kind: 'error', text: r.error }
    }
    case 'decay': {
      const r = decayStore(dir)
      return { kind: 'success', text: `衰减完成：${r.decayed} 条降权，${r.archived} 条归档，共 ${r.total} 条。` }
    }
    case 'export': {
      return { kind: 'success', text: renderExport(dir) }
    }
    default:
      return { kind: 'error', text: COMMAND_HELP }
  }
}

// ── 初始化与维护 ────────────────────────────────────────────────────────

function bootstrap(dir, config) {
  const factsFile = join(dir, 'facts.json')
  if (!readJson(factsFile, null)) {
    writeJson(factsFile, { version: 1, facts: [], updatedAt: new Date().toISOString() })
  }
  // 不自动写 profile.md：模板会污染提示词。只放一份 example 供人复制。
  const exampleFile = join(dir, 'profile.example.md')
  if (!existsSync(exampleFile)) writeFileAtomic(exampleFile, PROFILE_TEMPLATE)
  void config
}

/** 一天最多跑一次衰减（用 state.json 记日期） */
function decayOnceADay(dir) {
  const stateFile = join(dir, '.state.json')
  const state = readJson(stateFile, {}) || {}
  const today = new Date().toISOString().slice(0, 10)
  if (state.lastDecayDay === today) return
  try {
    const r = decayStore(dir)
    state.lastDecayDay = today
    state.lastDecay = { ...r, at: new Date().toISOString() }
    writeJson(stateFile, state)
  } catch {
    /* 衰减失败不影响主流程 */
  }
}
