import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { renderCard, renderPromptSection } from '../src/card.mjs'
import { saveFact } from '../src/store.mjs'

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-card-'))
  writeFileSync(
    join(dir, 'profile.md'),
    '# 她是谁\n\n你是一只蓝毛小鲸鱼，说话简短，不用括号写动作。\n',
    'utf8',
  )
})
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('renderCard', () => {
  it('空库时只有 profile', () => {
    const c = renderCard(dir)
    assert.match(c.text, /蓝毛小鲸鱼/)
    assert.equal(c.facts, 0)
  })

  it('大量事实时不超过字数上限', () => {
    for (let i = 0; i < 40; i++) {
      saveFact(dir, {
        text: `测试记忆第 ${i} 条：这是一段用来撑字数的比较长的描述，确认卡片会被截断。`,
        kind: 'fact',
        importance: 0.5,
      })
    }
    const c = renderCard(dir, { cardMaxChars: 600, cardMaxFacts: 40 })
    assert.ok(c.chars <= 600, `card chars ${c.chars} > 600`)
    assert.ok(c.facts >= 1)
    assert.ok(c.truncated > 0)
    assert.match(c.text, /另有 \d+ 条/)
  })

  it('默认上限 900 且条数受 cardMaxFacts 约束', () => {
    const c = renderCard(dir, { cardMaxFacts: 5 })
    assert.ok(c.facts <= 5)
    assert.ok(c.chars <= 900)
  })
})

describe('renderPromptSection', () => {
  it('有内容时带标题和使用说明', () => {
    const s = renderPromptSection(dir)
    assert.match(s, /长期记忆/)
    assert.match(s, /memory_recall/)
  })

  it('空库时返回空串，不污染提示词', () => {
    const empty = mkdtempSync(join(tmpdir(), 'persona-empty-'))
    try {
      writeFileSync(join(empty, 'profile.md'), '', 'utf8')
      assert.equal(renderPromptSection(empty), '')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})
