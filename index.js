/**
 * dsh-rewind-branch — Host 半。
 *
 * 它做三件事：
 *
 * 1. **捕获**：在 `tools/pre-execute` 里，对文件工具（write / edit / str_replace_editor）
 *    在真正落盘**之前**读一次目标文件的原始字节，存进内容寻址库；工具结束（tools/result）
 *    或回合结束（session/event 的 turn/end）时再补一份 after 快照。全程旁路：只读文件、
 *    不碰工具参数、不改任何数据流向。
 * 2. **计算计划**：给定会话 + 回合号，找出「这一轮 turn/start 之前」的检查点时间，
 *    用 journal 里该时间之后的 before/after 快照算出要恢复/删除/冲突的文件。
 * 3. **同源 HTTP 桥**：`/_dsh/dsh-rewind-branch/preview|rewind`，每条路由先过
 *    `connection.requestRejection`（Host/Origin + 浏览器登录校验，拿不到就 fail-closed）。
 *    执行回退时先把当前文件备份到 `data/safety/<时间戳>/`，再逐文件写回或删除。
 *
 * fork 不在这里做：`sessions.fork` 的宿主入口由 `sessionController.fork` 拥有
 * （它会重建 agent / 挂 workspace / 继承标题），所以计划里只返回边界 seq，
 * 由 Client 半调用 `ctx.sessions.fork({ sessionId, atSeq })` 后打开子会话。
 */
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appendRecord, DATA_DIR, flushJournal, pathKey, putBlob, readJournalRecords, readState, setStoreLogger } from './lib/store.js'
import { buildPlan, describePlan, executePlan, planError } from './lib/plan.js'

export const name = 'dsh-rewind-branch'
/** 全部依赖都走 ctx.get()：缺 webServer/sessionQuery 时降级，而不是让整个插件 INACTIVE。 */
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = join(HERE, 'client.js')
const ROUTE = '/_dsh/dsh-rewind-branch'
const CLIENT_PATH = `${ROUTE}/client.js`
const PREVIEW_PATH = `${ROUTE}/preview`
const REWIND_PATH = `${ROUTE}/rewind`
const MAX_BODY_BYTES = 64 * 1024

/** 需要捕获"写前状态"的工具 → 参数里的路径字段。 */
const CAPTURE_TOOLS = new Map([
  ['write', 'file_path'],
  ['edit', 'file_path'],
  ['str_replace_editor', 'path'],
  ['multi_edit', 'file_path'],
])

/** 这些工具会绕过文件工具的捕获（shell / 代码执行），回退前要提醒。 */
const RISKY_TOOL_HINTS = new Set([
  'bash',
  'pwsh',
  'terminal_open',
  'terminal_send',
  'terminal_signal',
  'terminal_close',
  'run_code',
  'job_bash',
  'job_pwsh',
])

const pending = new Map()
const agentStatus = new Map()
const busy = new Set()
let warnLog = () => {}

/**
 * @param {any} ctx cordis Context
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  warnLog = (message) => {
    try {
      ctx.logger?.warn?.(message)
    } catch {
      /* 日志永不反噬 */
    }
  }
  setStoreLogger(warnLog)

  // ── 注入行：必须是 apply() 里的第一件事。
  // 桌面 Electron 壳的注入表在宿主启动时一次性收集（dsh-desktop-host → IPC → 渲染层）；
  // 订阅晚于那次收集，这一行就永远进不了表。它不依赖任何服务，所以直接同步订阅。
  ctx.on('webserver/index-inject', (table) => {
    try {
      pushInjectionRow(table)
    } catch (error) {
      warnLog(`dsh-rewind-branch: inject row failed — ${String(error)}`)
    }
  })

  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      await captureBefore(ctx, exec)
    } catch (error) {
      warnLog(`dsh-rewind-branch: capture failed — ${String(error)}`)
    }
    return next()
  })

  // 每次工具结束补 after 快照：把这一回合里还没落盘的 pending 路径一起读一遍。
  ctx.on('tools/result', (exec) => {
    const sessionId = exec?.agent?.id
    if (typeof sessionId === 'string' && pending.has(sessionId)) void flushSession(sessionId)
  })
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end') return
    const sessionId = session?.id
    if (typeof sessionId === 'string' && pending.has(sessionId)) void flushSession(sessionId)
  })
  ctx.on('agent/status', (payload) => {
    try {
      const sessionId = payload?.agent?.id
      if (typeof sessionId === 'string') agentStatus.set(sessionId, payload.status)
    } catch {
      /* ignore */
    }
  })
  ctx.on('agent/disposed', (payload) => {
    try {
      const sessionId = payload?.agent?.id
      if (typeof sessionId === 'string') {
        agentStatus.delete(sessionId)
        pending.delete(sessionId)
      }
    } catch {
      /* ignore */
    }
  })

  ctx.inject(['webServer', 'connection'], (scope) => {
    const disposers = []
    try {
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: CLIENT_PATH,
        handler: (req, res) => serveClientScript(scope.connection, req, res),
      }))
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: PREVIEW_PATH,
        handler: (req, res) => handlePreview(ctx, scope.connection, req, res),
      }))
      disposers.push(scope.webServer.register({
        kind: 'exact',
        path: REWIND_PATH,
        handler: (req, res) => handleRewind(ctx, scope.connection, req, res),
      }))
      warnLog(`dsh-rewind-branch: routes ready (data: ${DATA_DIR})`)
    } catch (error) {
      warnLog(`dsh-rewind-branch: route registration failed — ${String(error)}`)
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose?.()
        } catch {
          /* ignore */
        }
      }
    }
  })

  // 插件卸载：把还没落盘的 after 补上。
  ctx.effect(() => () => {
    void (async () => {
      try {
        await flushAll()
      } catch {
        /* ignore */
      }
    })()
  }, 'dsh-rewind-branch: flush pending writes')
}

// ── 捕获 ────────────────────────────────────────────────────────────────────

/**
 * @param {any} ctx
 * @param {any} exec
 */
async function captureBefore(ctx, exec) {
  const key = CAPTURE_TOOLS.get(exec?.name)
  if (key === undefined) return
  let args = exec?.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return
    }
  }
  if (args === null || typeof args !== 'object') return
  const raw = args[key] ?? args.file_path ?? args.path
  if (typeof raw !== 'string' || raw.trim() === '') return
  const sessionId = exec?.agent?.id
  if (typeof sessionId !== 'string') return
  const cwd = sessionCwd(ctx, exec.agent)
  if (cwd === undefined) return
  const absPath = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw)
  const keyPath = pathKey(absPath)
  const sessionPending = pending.get(sessionId)
  if (sessionPending?.has(keyPath) === true) return

  const { state, bytes } = await readState(absPath)
  let before = state
  if (state.k === 'file' && bytes !== null) {
    const hash = await putBlob(bytes)
    before = { k: 'file', h: hash, n: bytes.length }
  }
  await appendRecord({ v: 1, k: 'pre', t: Date.now(), sid: sessionId, cwd, p: absPath, b: before })
  const map = sessionPending ?? new Map()
  map.set(keyPath, { cwd, absPath })
  pending.set(sessionId, map)
}

/**
 * 把某个会话所有 pending 路径的当前内容写成 after 快照。
 * @param {string} sessionId
 */
async function flushSession(sessionId) {
  const map = pending.get(sessionId)
  if (map === undefined || map.size === 0) return
  for (const [keyPath, entry] of [...map.entries()]) {
    try {
      const { state, bytes } = await readState(entry.absPath)
      let after = state
      if (state.k === 'file' && bytes !== null) {
        const hash = await putBlob(bytes)
        after = { k: 'file', h: hash, n: bytes.length }
      }
      await appendRecord({ v: 1, k: 'post', t: Date.now(), sid: sessionId, cwd: entry.cwd, p: entry.absPath, a: after })
    } catch (error) {
      warnLog(`dsh-rewind-branch: after snapshot failed — ${String(error)}`)
    }
    if (map.get(keyPath) === entry) map.delete(keyPath)
  }
  if (map.size === 0) pending.delete(sessionId)
}

/** 等全部 pending 落盘。 */
async function flushAll() {
  const sessionIds = [...pending.keys()]
  await Promise.allSettled(sessionIds.map((sessionId) => flushSession(sessionId)))
  await flushJournal()
}

/**
 * 当前会话的有效工作目录。
 * @param {any} ctx
 * @param {{ id?: string }} agent
 * @returns {string | undefined}
 */
function sessionCwd(ctx, agent) {
  try {
    const sessionId = agent?.id
    if (typeof sessionId !== 'string') return undefined
    const sessions = ctx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (session === undefined) return undefined
    const workingDirectory = ctx.get('workingDirectory')
    if (workingDirectory?.get !== undefined) {
      try {
        const path = workingDirectory.get(session)
        if (typeof path === 'string' && path !== '') return path
      } catch {
        /* fall through to header cwd */
      }
    }
    const cwd = session?.header?.cwd
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

// ── 计划 / 回退 ─────────────────────────────────────────────────────────────

/**
 * @param {any} ctx
 * @param {any} body
 */
async function planFor(ctx, body) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') throw planError('invalid', 'sessionId is required')
  if (agentStatus.get(sessionId) === 'running') throw planError('session-running', '这个会话正在运行，结束后再回退')

  const sessionQuery = ctx.get('sessionQuery')
  if (sessionQuery?.readSession === undefined) throw planError('unavailable', '会话查询服务不可用')
  await flushAll()
  return buildPlan(
    { sessionId, turn: body?.turn, seq: body?.seq },
    {
      readSession: (id) => sessionQuery.readSession(id),
      traceSession: sessionQuery.traceSession === undefined ? undefined : (id) => sessionQuery.traceSession(id),
      readJournal: readJournalRecords,
      readState,
      flushPending: flushAll,
    },
  )
}

/**
 * @param {any} ctx
 * @param {any} connection
 * @param {any} req
 * @param {any} res
 */
async function handlePreview(ctx, connection, req, res) {
  if (rejected(connection, req, res)) return
  if (req.method !== 'POST') return methodNotAllowed(res)
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return failure(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, error?.code === 'BODY_TOO_LARGE' ? 'body-too-large' : 'bad-request', String(error?.message ?? error))
  }
  try {
    const plan = await planFor(ctx, body)
    json(res, 200, { ok: true, value: describePlan(plan) })
  } catch (error) {
    failPlanError(res, error)
  }
}

/**
 * @param {any} ctx
 * @param {any} connection
 * @param {any} req
 * @param {any} res
 */
async function handleRewind(ctx, connection, req, res) {
  if (rejected(connection, req, res)) return
  if (req.method !== 'POST') return methodNotAllowed(res)
  let body
  try {
    body = await readJsonBody(req)
  } catch (error) {
    return failure(res, error?.code === 'BODY_TOO_LARGE' ? 413 : 400, error?.code === 'BODY_TOO_LARGE' ? 'body-too-large' : 'bad-request', String(error?.message ?? error))
  }
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return failure(res, 400, 'invalid', 'sessionId is required')
  if (busy.has(sessionId)) return failure(res, 409, 'busy', '这个会话已有一个回退在进行中')
  busy.add(sessionId)
  try {
    const plan = await planFor(ctx, body)
    const outcome = await executePlan(plan)
    json(res, 200, {
      ok: true,
      value: {
        sessionId: plan.sessionId,
        turn: plan.turn,
        boundary: plan.boundary,
        cwd: plan.cwd,
        warnings: plan.warnings,
        conflicts: describePlan(plan).conflicts,
        restored: outcome.restored,
        deleted: outcome.deleted,
        skipped: outcome.skipped,
        errors: outcome.errors.slice(0, 20),
        safetyDir: outcome.safetyDir,
        stats: outcome.stats,
      },
    })
  } catch (error) {
    failPlanError(res, error)
  } finally {
    busy.delete(sessionId)
  }
}

// ── HTTP 管道 ──────────────────────────────────────────────────────────────

/**
 * 信任栅栏：拿不到 connection 时 fail-closed（拒绝服务，不是放行）。
 * @returns {boolean} true 表示已经拒绝并结束响应
 */
function rejected(connection, req, res) {
  if (connection?.requestRejection === undefined) {
    res.statusCode = 403
    res.end()
    return true
  }
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch {
    res.statusCode = 403
    res.end()
    return true
  }
  if (rejection === undefined) return false
  res.statusCode = Number(rejection) || 403
  res.end()
  return true
}

function json(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

function failure(res, status, code, message) {
  json(res, status, { ok: false, error: { code, message } })
}

function methodNotAllowed(res) {
  res.statusCode = 405
  res.setHeader('allow', 'POST')
  res.end()
}

/**
 * @param {any} error
 */
function failPlanError(res, error) {
  const code = typeof error?.code === 'string' ? error.code : 'internal'
  const status = code === 'invalid'
    ? 400
    : code === 'session-running' || code === 'busy' || code === 'turn-not-running' || code === 'cannot-fork-start'
      ? 409
      : code === 'session-not-found' || code === 'turn-not-found'
        ? 404
        : code === 'no-cwd' || code === 'unavailable'
          ? 422
          : 500
  failure(res, status, code, String(error?.message ?? error))
}

/**
 * @param {any} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = []
    let size = 0
    let settled = false
    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        settled = true
        const error = new Error('request body too large')
        error.code = 'BODY_TOO_LARGE'
        rejectPromise(error)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8')
      try {
        resolvePromise(text === '' ? {} : JSON.parse(text))
      } catch {
        const error = new Error('invalid JSON body')
        error.code = 'BAD_JSON'
        rejectPromise(error)
      }
    })
    req.on('error', (error) => {
      if (settled) return
      settled = true
      rejectPromise(error)
    })
  })
}

/**
 * 客户端模块的脚本路由：每次按需读盘（改客户端不用重启 Host）。
 * @param {any} connection
 * @param {any} req
 * @param {any} res
 */
async function serveClientScript(connection, req, res) {
  if (rejected(connection, req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405
    res.setHeader('allow', 'GET')
    res.end()
    return
  }
  try {
    const bytes = await readFile(CLIENT_FILE)
    res.statusCode = 200
    res.setHeader('content-type', 'text/javascript; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(req.method === 'HEAD' ? undefined : bytes)
  } catch (error) {
    warnLog(`dsh-rewind-branch: client script unavailable — ${String(error)}`)
    res.statusCode = 404
    res.end()
  }
}

// ── 桌面壳注入行 ────────────────────────────────────────────────────────────

/**
 * 给 index 注入表补一行：创建 <script src> 加载 client.js。
 * 两条送达通道（dsh.client 图 + 本注入行）可能同时生效，client.js 自己带全局守卫。
 * @param {any[]} table
 */
function pushInjectionRow(table) {
  if (!Array.isArray(table)) return
  let mtime = 0
  try {
    mtime = statSync(CLIENT_FILE).mtimeMs
  } catch {
    /* 取不到 mtime 就用不带版本号的路径；onerror 会吞掉 404 */
  }
  const source = mtime > 0 ? `${CLIENT_PATH}?v=${Math.round(mtime)}` : CLIENT_PATH
  for (const row of table) {
    if (row === null || typeof row !== 'object') continue
    if (row.kind === 'script-src' && row.src === source) return
    if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes(CLIENT_PATH)) return
  }
  table.push({ kind: 'script', placement: 'body', text: injectionText(source) })
}

/**
 * 一段自带 try/catch 的最小引导：宿主永远不会因为这行起不来。
 * @param {string} source
 */
function injectionText(source) {
  return (
    '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
    'if(window.__DSH_REWIND_BRANCH_INJECTED__)return;window.__DSH_REWIND_BRANCH_INJECTED__=true;' +
    `var s=document.createElement("script");s.src=${JSON.stringify(source)};` +
    's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
  )
}

/** 诊断用：数据结构与阈值让宿主侧也能看到。 */
export const internals = {
  CAPTURE_TOOLS,
  RISKY_TOOL_HINTS,
  pending,
  agentStatus,
  MAX_BODY_BYTES,
}
