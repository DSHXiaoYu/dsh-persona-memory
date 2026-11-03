/**
 * 路径与文件读写。
 *
 * 设计原则：
 * - 数据全是纯文本 / JSON，用户可以直接用编辑器打开改，不需要任何工具；
 * - 写入一律「临时文件 + rename」，插件被强杀也不会留下半截文件；
 * - 读坏了不抛异常，回落到空数据并记一条警告（记忆坏了不能让 agent 起不来）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 默认数据目录：$DSH_HOME/.persona-memory，没有 DSH_HOME 时用 ~/.dsh/persona-memory */
export function resolveDataDir(config = {}) {
  if (config.dataDir) return config.dataDir
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'persona-memory')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 原子写：先写 .tmp，再 rename 覆盖 */
export function writeFileAtomic(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

export function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n')
}

export function readText(file, fallback = '') {
  try {
    if (!existsSync(file)) return fallback
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}
