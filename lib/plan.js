/**
 * dsh-rewind-branch / lib/plan.js —— 回退计划的纯逻辑（可单测，不直接依赖 cordis）。
 *
 * 输入：一次「回到第 N 轮之前」的请求 + 会话日志读取器 + journal 读取器 + 当前文件读取器。
 * 输出：要恢复/删除的文件清单、冲突清单、警告，以及 fork 用的边界 seq。
 *
 * 语义：检查点 = 目标回合 turn/start 之前那一刻。
 * 因此「该检查点的文件状态」= 检查点时间之后、同一个工作目录里所有被文件工具写过的路径的
 * **最早一份 before 快照**；「当前是否安全可覆盖」= 该路径当前内容等于 journal 里**最晚的 after 快照**。
 * 任何对不上的路径一律算冲突并跳过（绝不覆盖用户手动改过的内容）。
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathKey, readBlob, readJournalRecords, readState, SAFETY_DIR, sameState, sha256 } from './store.js'

const MAX_LIST = 200
const MAX_CONFLICTS = 50
const RISKY_TOOLS = new Set([
  'bash',
  'pwsh',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  'run_code',
  'workflow',
  'job_bash',
  'job_pwsh',
])
const SUBAGENT_TOOLS = new Set(['subagent', 'spawn_teammate', 'deep_ask', 'workflow', 'send_message', 'wait_agent', 'interrupt_agent'])

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string }}
 */
export function planError(code, message) {
  const error = new Error(message)
  error.code = code
  return /** @type {any} */ (error)
}

/**
 * @param {string} absPath
 * @param {string} cwd
 * @returns {string} 给人看的路径：工作区内用相对路径（/ 分隔），否则绝对路径
 */
export function displayPath(absPath, cwd) {
  try {
    const rel = relative(cwd, absPath)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel.split(sep).join('/')
  } catch {
    /* 跨盘符等情况直接用绝对路径 */
  }
  return String(absPath).split(sep).join('/')
}

/**
 * 从 lineage trace 里收集 root + descendants 的会话 id。
 * @param {any} trace
 * @returns {Set<string>}
 */
function collectLineage(trace) {
  const ids = new Set()
  const add = (record) => {
    const id = record?.header?.id ?? record?.session?.header?.id ?? record?.sessionId
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  add(trace?.target)
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return
    for (const node of nodes) {
      add(node)
      walk(node?.descendants)
    }
  }
  walk(trace?.descendants)
  return ids
}

/**
 * 读取会话日志（live 优先），并把底层错误翻译成计划错误。
 * @param {string} sessionId
 * @param {(id: string) => Promise<any>} readSession
 */
async function loadSnapshot(sessionId, readSession) {
  try {
    return await readSession(sessionId)
  } catch (error) {
    const code = `${String(error?.code ?? '')} ${String(error?.message ?? '')}`
    if (/NOT_FOUND|not[-_ ]?found/iu.test(code)) throw planError('session-not-found', `找不到会话 ${sessionId}`)
    throw planError('internal', `读取会话失败：${String(error?.message ?? error)}`)
  }
}

/**
 * @param {string} sessionId
 * @param {(id: string) => Promise<any>} [traceSession]
 * @returns {Promise<Set<string>>}
 */
async function loadLineage(sessionId, traceSession) {
  if (typeof traceSession !== 'function') return new Set([sessionId])
  try {
    const trace = await traceSession(sessionId)
    const ids = collectLineage(trace)
    ids.add(sessionId)
    return ids
  } catch {
    return new Set([sessionId])
  }
}

/**
 * 计算回退计划。
 * @param {{ sessionId?: unknown, turn?: unknown, seq?: unknown }} input
 * @param {{
 *   readSession: (id: string) => Promise<any>,
 *   traceSession?: (id: string) => Promise<any>,
 *   readJournal?: () => Promise<Array<Record<string, any>>>,
 *   readState?: (path: string) => Promise<{ state: any, bytes: any }>,
 *   flushPending?: () => Promise<void>,
 * }} env
 */
export async function buildPlan(input, env) {
  const sessionId = typeof input?.sessionId === 'string' ? input.sessionId : ''
  if (sessionId === '') throw planError('invalid', 'sessionId is required')
  if (typeof env?.readSession !== 'function') throw planError('unavailable', 'session query unavailable')

  const readStateFn = env.readState ?? readState
  const readJournal = env.readJournal ?? readJournalRecords

  if (typeof env.flushPending === 'function') await env.flushPending()
  const snapshot = await loadSnapshot(sessionId, env.readSession)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []
  const cwd = typeof snapshot?.session?.cwd === 'string' ? snapshot.session.cwd : ''
  if (cwd === '') throw planError('no-cwd', '这个会话没有工作目录，无法恢复文件')

  // 定位目标回合的 turn/start：优先用客户端传来的 turn；拿不到就用 seq 向前找。
  let turn = Number.isInteger(input?.turn) && input.turn >= 1 ? input.turn : undefined
  let start = turn === undefined ? undefined : events.find((event) => event?.type === 'turn/start' && event?.data?.turn === turn)
  if (start === undefined && Number.isInteger(input?.seq)) {
    let index = -1
    for (let i = events.length - 1; i >= 0; i--) {
      if (typeof events[i]?.seq === 'number' && events[i].seq <= input.seq) {
        index = i
        break
      }
    }
    for (let i = index; i >= 0; i--) {
      if (events[i]?.type === 'turn/start') {
        start = events[i]
        break
      }
    }
  }
  if (start === undefined) throw planError('turn-not-found', '找不到这一轮消息')
  if (turn === undefined) turn = start.data?.turn
  const turnStartSeq = Number(start.seq)
  const boundary = Number.isSafeInteger(turnStartSeq) ? turnStartSeq - 1 : -1
  if (!Number.isSafeInteger(boundary) || boundary < 0) {
    throw planError('cannot-fork-start', '这是会话的第一轮，前面没有可回退的检查点')
  }
  // 目标回合必须已经完整结束（客户端只在已完成的回合尾部显示入口；这里再做一次防御）。
  const turnEnd = events.find((event) => event?.type === 'turn/end' && event?.data?.turn === turn && event.seq > turnStartSeq)
  if (turnEnd === undefined) throw planError('turn-not-running', '这一轮还没有结束，等它结束后再回退')

  // 服务端兜底：会话最近一个 turn 没有 turn/end（agent 仍在跑）时不允许回退。
  // 不能只依赖 agent/status 事件：插件在本轮中途加载/重载时收不到之前的状态。
  let latestStart
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'turn/start') {
      latestStart = events[i]
      break
    }
  }
  if (latestStart !== undefined) {
    const latestEnd = events.find((event) => event?.type === 'turn/end' && event?.data?.turn === latestStart.data?.turn && event.seq > latestStart.seq)
    if (latestEnd === undefined) throw planError('session-running', '这个会话有未结束的回合（正在运行），结束后再回退')
  }

  const checkpointTime = Number(start.time) || 0
  const lineage = await loadLineage(sessionId, env.traceSession)
  const cwdKey = pathKey(cwd)
  const records = await readJournal()

  const entries = new Map()
  for (const record of records) {
    if (record === null || typeof record !== 'object') continue
    if (typeof record.t !== 'number' || record.t < checkpointTime) continue
    if (typeof record.cwd !== 'string' || pathKey(record.cwd) !== cwdKey) continue
    if (typeof record.p !== 'string' || record.p === '') continue
    const key = pathKey(record.p)
    let entry = entries.get(key)
    if (entry === undefined) {
      entry = { path: record.p, firstPre: null, lastPost: null, sessions: new Set() }
      entries.set(key, entry)
    }
    if (typeof record.sid === 'string') entry.sessions.add(record.sid)
    if (record.k === 'pre' && (entry.firstPre === null || record.t < entry.firstPre.t)) entry.firstPre = record
    if (record.k === 'post' && (entry.lastPost === null || record.t > entry.lastPost.t)) entry.lastPost = record
  }

  const actions = []
  const conflicts = []
  let noop = 0
  const warnings = []

  for (const entry of [...entries.values()].sort((left, right) => left.path.localeCompare(right.path))) {
    if (entry.firstPre === null) continue
    const target = entry.firstPre.b
    const display = displayPath(entry.path, cwd)
    if (target === null || target === undefined || target.k === 'skip') {
      conflicts.push({ path: entry.path, display, reason: 'unsupported-target', detail: String(target?.r ?? 'unknown') })
      continue
    }
    const expected = entry.lastPost === null ? null : entry.lastPost.a
    if (expected === null || expected === undefined) {
      // 没有 after 快照（写被拒绝 / 插件在写入后重启 / post 未及落盘）：
      // 当前内容与 before 相同 —— 视为没改过；不同 —— 无法判断，按冲突跳过。
      const current = await readStateFn(entry.path, undefined)
      if (sameState(current?.state, target)) {
        noop += 1
        continue
      }
      conflicts.push({ path: entry.path, display, reason: 'unverified' })
      continue
    }
    const current = await readStateFn(entry.path, undefined)
    if (expected.k === 'skip') {
      conflicts.push({ path: entry.path, display, reason: 'unsupported-after', detail: String(expected.r ?? 'unknown') })
      continue
    }
    if (!sameState(current?.state, expected)) {
      conflicts.push({ path: entry.path, display, reason: 'modified-since' })
      continue
    }
    if (sameState(target, expected)) {
      noop += 1
      continue
    }
    if (target.k === 'absent') actions.push({ kind: 'delete', path: entry.path, display, expected: expected.h ?? 'absent' })
    else actions.push({ kind: 'restore', path: entry.path, display, hash: target.h, size: target.n, expected: expected.h ?? 'absent' })
  }

  // 警告：被回退的回合里用过非文件工具 / 子代理 / 其他会话也写了同一工作区。
  const discarded = events.filter((event) => typeof event?.seq === 'number' && event.seq > boundary)
  const risky = new Set()
  const subagents = new Set()
  for (const event of discarded) {
    if (event?.type !== 'tool/call') continue
    const toolName = event?.data?.name
    if (typeof toolName !== 'string') continue
    if (RISKY_TOOLS.has(toolName)) risky.add(toolName)
    if (SUBAGENT_TOOLS.has(toolName)) subagents.add(toolName)
  }
  if (risky.size > 0) {
    warnings.push({ code: 'risky-tools', params: { tools: [...risky].sort().join(', ') } })
  }
  if (subagents.size > 0) {
    warnings.push({ code: 'subagents', params: { tools: [...subagents].sort().join(', ') } })
  }
  const foreign = new Set()
  for (const entry of entries.values()) {
    for (const sid of entry.sessions) if (!lineage.has(sid)) foreign.add(sid)
  }
  if (foreign.size > 0) warnings.push({ code: 'other-sessions', params: { count: foreign.size } })
  if (entries.size === 0) warnings.push({ code: 'no-captures' })

  return {
    sessionId,
    turn,
    boundary,
    turnStartSeq,
    checkpointTime,
    cwd,
    actions,
    conflicts,
    warnings,
    noop,
    stats: {
      restore: actions.filter((action) => action.kind === 'restore').length,
      remove: actions.filter((action) => action.kind === 'delete').length,
      conflict: conflicts.length,
      captured: entries.size,
      noop,
    },
    alreadyAtCheckpoint: actions.length === 0 && conflicts.length === 0,
  }
}

/**
 * 把计划压成可安全放进 JSON 响应的摘要（有界）。
 * @param {Awaited<ReturnType<typeof buildPlan>>} plan
 */
export function describePlan(plan) {
  const actions = plan.actions.slice(0, MAX_LIST).map((action) => ({
    path: action.display,
    kind: action.kind,
    ...(action.kind === 'restore' ? { size: action.size } : {}),
  }))
  const conflicts = plan.conflicts.slice(0, MAX_CONFLICTS).map((conflict) => ({
    path: conflict.display,
    reason: conflict.reason,
    ...(conflict.detail === undefined ? {} : { detail: conflict.detail }),
  }))
  return {
    sessionId: plan.sessionId,
    turn: plan.turn,
    boundary: plan.boundary,
    checkpointAt: plan.checkpointTime,
    cwd: plan.cwd,
    stats: plan.stats,
    alreadyAtCheckpoint: plan.alreadyAtCheckpoint,
    actions,
    conflicts,
    warnings: plan.warnings,
    truncated: {
      actions: Math.max(0, plan.actions.length - actions.length),
      conflicts: Math.max(0, plan.conflicts.length - conflicts.length),
    },
  }
}

/**
 * 执行恢复：先把当前内容完整备份到 safety 目录，再逐文件写回 / 删除。
 * 任何一步失败只影响该文件，并记进 errors。
 *
 * @param {Awaited<ReturnType<typeof buildPlan>>} plan
 * @param {{ readBlob?: (hash: string) => Promise<Uint8Array>, safetyDir?: string }} [env]
 */
export async function executePlan(plan, env = {}) {
  const readBlobFn = env.readBlob ?? readBlob
  const safetyRoot = env.safetyDir ?? SAFETY_DIR
  const now = Date.now()
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-')
  const safety = join(safetyRoot, stamp)
  await mkdir(safety, { recursive: true })

  const manifest = { createdAt: now, sessionId: plan.sessionId, turn: plan.turn, boundary: plan.boundary, files: [] }
  const blocked = new Set()
  for (const action of plan.actions) {
    let current = null
    let failure = null
    try {
      current = await readFile(action.path)
    } catch (error) {
      if (error?.code !== 'ENOENT') failure = error
    }
    if (failure !== null) {
      blocked.add(pathKey(action.path))
      continue
    }
    // 计划与执行之间可能又被改过（TOCTOU）：只有「当前态 == 计划里的 after 快照」才动手。
    if (typeof action.expected === 'string') {
      const currentState = current === null ? 'absent' : sha256(current)
      if (currentState !== action.expected) {
        blocked.add(pathKey(action.path))
        continue
      }
    }
    const name = `${String(manifest.files.length + 1).padStart(4, '0')}.bin`
    if (current !== null) await writeFile(join(safety, name), current)
    manifest.files.push({ path: action.path, kind: action.kind, existed: current !== null, blob: current === null ? null : name })
  }
  await writeFile(join(safety, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const errors = []
  let restored = 0
  let deleted = 0
  let skipped = 0
  let sequence = 0
  for (const action of plan.actions) {
    if (blocked.has(pathKey(action.path))) {
      skipped += 1
      continue
    }
    try {
      if (action.kind === 'delete') {
        await rm(action.path, { force: true })
        deleted += 1
        continue
      }
      const bytes = await readBlobFn(action.hash)
      await mkdir(dirname(action.path), { recursive: true })
      sequence += 1
      const temporary = `${action.path}.dsh-rewind-branch-${process.pid}-${sequence}.tmp`
      await writeFile(temporary, bytes)
      try {
        await rename(temporary, action.path)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
      restored += 1
    } catch (error) {
      errors.push({ path: action.path, message: String(error?.message ?? error) })
    }
  }

  return {
    restored,
    deleted,
    skipped,
    errors,
    safetyDir: safety,
    safetyBackedUp: manifest.files.length,
    stats: {
      restore: restored,
      remove: deleted,
      conflict: plan.conflicts.length,
      error: errors.length + skipped,
      skipped,
    },
  }
}

/** 暴露给单测/诊断：不要在运行时依赖这些内部符号。 */
export const internals = { collectLineage, RISKY_TOOLS, SUBAGENT_TOOLS }
