/**
 * dsh-rewind-branch / lib/store.js —— 持久层：内容寻址 blob + 追加式 journal。
 *
 * 设计要点（为什么不是 git）：
 *
 * - 只记录**文件工具真正要改的文件**的原始字节（write/edit 的 pre-execute 读一次），
 *   因此不依赖工作区是不是 git 仓库，也不碰用户仓库的 index / objects / refs。
 * - blob 按内容 SHA-256 去重；journal 每行一条 JSON（pre = 写前状态，post = 写后状态）。
 * - 恢复所需的一切都在磁盘上：Host 重启后仍能回退旧回合（这是与
 *   `dsh-workspace-changes` 的临时快照最大的差别——那是只读展示用的，Session 一销毁就没了）。
 *
 * journal 只增不减；超过 64MB 时把当前文件轮转为 journal.1.jsonl、再开新文件。
 * 读取时两份都读，所以「最近两个窗口」的检查点仍可恢复。
 */
import { createHash } from 'node:crypto'
import { appendFile, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : undefined

/** 插件数据根目录：优先落在 DSH home 下，回退到插件目录（两者都不在工作区里）。 */
export const DATA_DIR = HOME === undefined ? join(HERE, '..', 'data') : join(HOME, 'dsh-rewind-branch')
export const BLOB_DIR = join(DATA_DIR, 'blobs')
export const JOURNAL_FILE = join(DATA_DIR, 'journal.jsonl')
export const JOURNAL_OLD_FILE = join(DATA_DIR, 'journal.1.jsonl')
export const SAFETY_DIR = join(DATA_DIR, 'safety')

/** 单文件捕获上限。超过就记 skip，恢复时按冲突处理（宁可不动，也不写坏）。 */
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
/** 对比「当前文件」时的读取上限。 */
export const MAX_COMPARE_BYTES = 64 * 1024 * 1024
/** journal 轮转阈值。 */
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024

let loggerWarn = () => {}
/** @param {(message: string) => void} warn */
export function setStoreLogger(warn) {
  loggerWarn = typeof warn === 'function' ? warn : () => {}
}

/**
 * @param {Uint8Array} bytes
 * @returns {string} hex SHA-256
 */
export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 路径身份：绝对路径；Windows 下大小写不敏感。
 * @param {string} value
 * @returns {string}
 */
export function pathKey(value) {
  const absolute = resolve(String(value))
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * 两份「文件态」是否相同。
 * @param {any} left
 * @param {any} right
 * @returns {boolean}
 */
export function sameState(left, right) {
  if (left?.k !== right?.k) return false
  if (left.k === 'absent') return true
  if (left.k === 'file') return left.h === right.h
  return left.r === right.r
}

/**
 * 读一个路径的捕获态；只有普通文件才带回字节。
 *
 * 返回：{ state: {k:'absent'} | {k:'file',h,n} | {k:'skip',r}, bytes }
 * @param {string} absPath
 * @param {number} [maxBytes]
 */
export async function readState(absPath, maxBytes = MAX_CAPTURE_BYTES) {
  let info
  try {
    info = await lstat(absPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: { k: 'absent' }, bytes: null }
    return { state: { k: 'skip', r: 'stat-error' }, bytes: null }
  }
  if (info.isSymbolicLink()) return { state: { k: 'skip', r: 'symlink' }, bytes: null }
  if (!info.isFile()) return { state: { k: 'skip', r: 'not-file' }, bytes: null }
  if (info.size > maxBytes) return { state: { k: 'skip', r: 'too-large', n: info.size }, bytes: null }
  try {
    const bytes = await readFile(absPath)
    return { state: { k: 'file', h: sha256(bytes), n: bytes.length }, bytes }
  } catch {
    return { state: { k: 'skip', r: 'read-error' }, bytes: null }
  }
}

/**
 * @param {string} hash
 * @returns {string} blob 的绝对路径
 */
export function blobPath(hash) {
  return join(BLOB_DIR, String(hash).slice(0, 2), String(hash))
}

/**
 * 写入一个 blob（已存在则跳过）。
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} 内容 hash
 */
export async function putBlob(bytes) {
  const hash = sha256(bytes)
  const target = blobPath(hash)
  try {
    await stat(target)
    return hash
  } catch {
    /* 不存在，继续写 */
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
  return hash
}

/**
 * @param {string} hash
 * @returns {Promise<Buffer>}
 */
export async function readBlob(hash) {
  return readFile(blobPath(hash))
}

let appendChain = Promise.resolve()
let journalBytes = 0
let journalInitialized = false

async function ensureJournal() {
  await mkdir(DATA_DIR, { recursive: true })
  if (journalInitialized) return
  try {
    const info = await stat(JOURNAL_FILE)
    journalBytes = info.size
  } catch {
    journalBytes = 0
  }
  journalInitialized = true
}

/**
 * 追加一条 journal 记录；内部串行化，失败只告警、不抛给工具路径。
 * @param {Record<string, unknown>} record
 * @returns {Promise<void>}
 */
export function appendRecord(record) {
  appendChain = appendChain
    .then(async () => {
      await ensureJournal()
      if (journalBytes > MAX_JOURNAL_BYTES) {
        try {
          await rename(JOURNAL_FILE, JOURNAL_OLD_FILE)
        } catch {
          /* 轮转失败也继续写，最多文件大一点 */
        }
        journalBytes = 0
      }
      const line = `${JSON.stringify(record)}\n`
      await appendFile(JOURNAL_FILE, line, 'utf8')
      journalBytes += Buffer.byteLength(line)
    })
    .catch((error) => {
      loggerWarn(`dsh-rewind-branch: journal append failed — ${String(error)}`)
    })
  return appendChain
}

/** 等所有已排队的 journal 写入落盘。 */
export async function flushJournal() {
  await appendChain
}

/**
 * 读取全部 journal 记录（旧文件在前，新文件在后）；坏行跳过。
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function readJournalRecords() {
  const records = []
  for (const file of [JOURNAL_OLD_FILE, JOURNAL_FILE]) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.length < 2 || line[0] !== '{') continue
      try {
        const record = JSON.parse(line)
        if (record !== null && typeof record === 'object') records.push(record)
      } catch {
        /* 半行/损坏行：跳过 */
      }
    }
  }
  return records
}
