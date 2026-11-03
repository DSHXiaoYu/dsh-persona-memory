/**
 * 冒烟测试：用一个假的 DSH 宿主加载插件，把提示词段、四个工具、/memory 命令都跑一遍。
 * 它不依赖 DSH 本体，`npm run smoke` 就能验证「插件装上后大概长什么样」。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, name } from '../src/index.mjs'

const dir = mkdtempSync(join(tmpdir(), 'persona-smoke-'))

const tools = new Map()
const commands = new Map()
let promptSection = null

const ctx = {
  logger: { info() {}, warn: (m) => console.warn('[warn]', m), error: (m) => console.error(m) },
  get(service) {
    if (service === 'tools') return { register: (tool) => tools.set(tool.name, tool) }
    if (service === 'commands') return { register: (cmd) => commands.set(cmd.name, cmd) }
    return undefined
  },
  inject(deps, callback) {
    callback({
      effect: (fn) => {
        const disposer = fn()
        return () => disposer?.()
      },
      systemPrompt: {
        section: (def) => {
          promptSection = def
          return () => {}
        },
      },
    })
  },
}

try {
  apply(ctx, { dataDir: dir, autoDecay: true })
  console.log('plugin:', name)
  console.log('tools:', [...tools.keys()].join(', '))
  console.log('commands:', [...commands.keys()].join(', '))

  assert.ok(promptSection, '应该注册系统提示段')
  const emptyPrompt = promptSection.text()
  assert.equal(emptyPrompt, '', '空库时提示词段应为空')

  // 写三条
  const remember = tools.get('memory_remember')
  const r1 = await remember.execute({ text: '爸爸不喜欢别人叫他大佬', kind: 'preference', importance: 0.9 })
  const r2 = await remember.execute({ text: '每天晚上十一点左右会来问一句', kind: 'event', importance: 0.6 })
  const r3 = await remember.execute({ text: '不喜欢香菜', kind: 'preference', importance: 0.5 })
  console.log('remember:', r1.text, '|', r2.text, '|', r3.text)

  const filled = promptSection.text()
  assert.match(filled, /长期记忆/)
  assert.match(filled, /大佬/)
  console.log('prompt chars:', filled.length)
  console.log('--- 提示词段 ---')
  console.log(filled)
  console.log('----------------')

  const recall = tools.get('memory_recall')
  const hit = await recall.execute({ query: '大佬' })
  assert.match(hit.text, /大佬/)
  console.log('recall 大佬:', hit.text.replace(/\n/g, ' / '))

  const miss = await recall.execute({ query: '量子力学' })
  console.log('recall 量子力学:', miss.text)

  const status = await tools.get('memory_status').execute({})
  console.log('status:\n' + status.text)

  const memory = commands.get('memory')
  const cmdStatus = memory.handler({ rawInput: 'status' })
  assert.equal(cmdStatus.kind, 'success')
  const cmdSearch = memory.handler({ rawInput: 'search 香菜' })
  assert.match(cmdSearch.text, /香菜/)
  const cmdBad = memory.handler({ rawInput: 'nonsense' })
  assert.equal(cmdBad.kind, 'error')
  console.log('command ok:', cmdStatus.text.split('\n')[0], '|', cmdSearch.text)

  // 忘了再查
  const forget = tools.get('memory_forget')
  const id = hit.text.match(/\[(m\d{4})·/)[1]
  console.log('forget:', (await forget.execute({ id, reason: 'smoke test' })).text)
  const afterForget = await recall.execute({ query: '大佬' })
  assert.match(afterForget.text, /^没查到/)

  console.log('\n✅ smoke ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
