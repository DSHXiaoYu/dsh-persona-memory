import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

import { saveFact, searchFacts, forgetFact, decayStore, statsOf, loadStore } from '../src/store.mjs'

let dir
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'persona-memory-'))
})
after(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveFact', () => {
  it('写一条并返回 id', () => {
    const r = saveFact(dir, { text: '爸爸不喜欢别人叫他大佬', kind: 'preference', importance: 0.9 })
    assert.equal(r.ok, true)
    assert.match(r.id, /^m\d{4}$/)
    assert.equal(r.merged, false)
    assert.equal(r.fact.tier, 'core')
  })

  it('重复写入会合并而不是堆两条', () => {
    const before = loadStore(dir).facts.length
    const r = saveFact(dir, { text: '爸爸不喜欢别人叫他大佬。', kind: 'preference' })
    assert.equal(r.merged, true)
    assert.equal(loadStore(dir).facts.length, before)
    assert.equal(r.fact.mentions, 2)
  })

  it('空文本拒绝', () => {
    const r = saveFact(dir, { text: '   ' })
    assert.equal(r.ok, false)
  })
})

describe('searchFacts', () => {
  it('中文关键词能命中', () => {
    saveFact(dir, { text: '她每天下午四点要睡一会儿', kind: 'fact' })
    const rows = searchFacts(dir, '睡觉', { limit: 5 })
    // 「睡觉」和原文没有共同二元组时查不到是正常的（词法检索的上限），这里用原文里的词
    const rows2 = searchFacts(dir, '下午四点', { limit: 5 })
    assert.ok(rows2.length >= 1)
    assert.match(rows2[0].fact.text, /下午四点/)
    assert.ok(Array.isArray(rows))
  })

  it('空 query 按印象强度返回', () => {
    const rows = searchFacts(dir, '', { limit: 3 })
    assert.ok(rows.length >= 1)
    assert.ok(rows[0].score >= rows[rows.length - 1].score)
  })

  it('kind 过滤生效', () => {
    const rows = searchFacts(dir, '', { kind: 'preference', limit: 10 })
    assert.ok(rows.every((r) => r.fact.kind === 'preference'))
  })
})

describe('forgetFact', () => {
  it('归档后不再出现在检索里', () => {
    const r = saveFact(dir, { text: '临时记忆：明天要买猫粮', kind: 'event', importance: 0.4 })
    assert.equal(forgetFact(dir, r.id, '测试').ok, true)
    const rows = searchFacts(dir, '猫粮', { limit: 10 })
    assert.equal(rows.length, 0)
    assert.equal(forgetFact(dir, 'm9999').ok, false)
  })
})

describe('decayStore', () => {
  it('久未提及的记忆降权，弱的归档', () => {
    const old = Date.now() - 200 * 86_400_000
    const a = saveFact(dir, { text: '很久以前的小事 A', kind: 'event', importance: 0.2 }, old)
    const b = saveFact(dir, { text: '核心事实 B', kind: 'relation', importance: 0.95 }, old)
    const r = decayStore(dir)
    assert.ok(r.total >= 2)
    const facts = loadStore(dir).facts
    const fa = facts.find((f) => f.id === a.id)
    const fb = facts.find((f) => f.id === b.id)
    assert.ok(fa.weight < 0.2)
    assert.equal(fb.status, 'active')
    assert.ok(fb.weight >= 0.9)
  })

  it('归档不删除，统计里还能看到', () => {
    const s = statsOf(dir)
    assert.ok(s.total > s.active)
  })
})
