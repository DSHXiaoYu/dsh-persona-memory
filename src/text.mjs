/**
 * 文本处理：归一化、分词、相似度、截断。
 *
 * 为什么不用分词库：中文没有空格，最稳的零依赖做法是「字符二元组」（bigram）。
 * 它对「爸爸说想让我学画画」和「学画画那件事」能对上，对同义改写无能为力——
 * 这是词法检索的固有上限，README 里写明了；想要语义召回请接向量服务。
 */

/** 全角转半角 + 去掉多余空白 + 小写。保留标点（分词时会丢掉）。 */
export function normalizeText(input) {
  return String(input ?? '')
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 用于「是不是同一条记忆」的比较键：去掉所有空白和标点 */
export function compareKey(input) {
  return normalizeText(input).replace(/[\s\p{P}\p{S}]+/gu, '')
}

/**
 * 分词：
 * - 连续的中日韩字符切成二元组（单字也保留一个）；
 * - 拉丁字母/数字按词切，长度 2 以上保留。
 */
export function tokenize(input) {
  const text = normalizeText(input)
  const tokens = []
  const re = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]+|[a-z0-9]+/g
  let m
  while ((m = re.exec(text))) {
    const chunk = m[0]
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2) tokens.push(chunk)
      continue
    }
    if (chunk.length === 1) {
      tokens.push(chunk)
      continue
    }
    for (let i = 0; i < chunk.length - 1; i++) tokens.push(chunk.slice(i, i + 2))
  }
  return tokens
}

/** 二元组集合的 Jaccard 相似度，0..1 */
export function jaccard(a, b) {
  const setA = new Set(tokenize(a))
  const setB = new Set(tokenize(b))
  if (!setA.size || !setB.size) return 0
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter++
  return inter / (setA.size + setB.size - inter)
}

/** 按字符数截断，不切坏代理对 */
export function truncate(text, max) {
  const s = String(text ?? '')
  const limit = Math.max(0, Number(max) || 0)
  if (s.length <= limit) return s
  if (limit <= 1) return '…'.slice(0, limit)
  return s.slice(0, limit - 1) + '…'
}

/** 压缩成一行，用于卡片和列表 */
export function oneLine(text, max = 120) {
  return truncate(normalizeText(text).replace(/\s+/g, ' '), max)
}
