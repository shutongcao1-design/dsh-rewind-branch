/**
 * dsh-rewind-branch 的纯逻辑测试：计划计算 + 恢复执行。
 * 运行：node --test test/plan.test.js
 *
 * 这些测试不碰真实 profile、不连宿主：会话日志、journal、当前文件态都由 fake 提供；
 * executePlan 只在系统临时目录里读写，跑完自行清理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPlan, executePlan } from '../lib/plan.js'
import { sha256 } from '../lib/store.js'

const WS = 'D:\\ws'
const path = (name) => `${WS}\\${name}`
const START = 1_700_000_000_000

const state = (hash) => ({ k: 'file', h: hash, n: hash.length })
const absent = { k: 'absent' }

function baseEvents() {
  return [
    { type: 'turn/start', seq: 0, time: START - 1000, data: { turn: 1 } },
    { type: 'turn/end', seq: 5, time: START - 500, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 6, time: START, data: { turn: 2 } },
    { type: 'tool/call', seq: 7, time: START + 10, data: { turn: 2, step: 1, callId: 'c1', name: 'write', arguments: '{}' } },
    { type: 'tool/call', seq: 8, time: START + 20, data: { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{}' } },
    { type: 'turn/end', seq: 9, time: START + 100, data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'turn/start', seq: 10, time: START + 200, data: { turn: 3 } },
    { type: 'turn/end', seq: 15, time: START + 300, data: { turn: 3, reason: { kind: 'completed' } } },
  ]
}

function baseRecords() {
  const record = (kind, time, name, payload) => ({
    v: 1, k: kind, t: time, sid: 's1', cwd: WS, p: path(name),
    ...(kind === 'pre' ? { b: payload } : { a: payload }),
  })
  return [
    // 检查点之后（t >= START）的改动。
    record('pre', START + 1, 'a.txt', state('h1')),
    record('post', START + 2, 'a.txt', state('h2')),
    record('pre', START + 1, 'b.txt', absent),
    record('post', START + 2, 'b.txt', state('h3')),
    record('pre', START + 1, 'c.txt', state('h1')),
    record('post', START + 2, 'c.txt', state('h2')),
    record('pre', START + 1, 'd.txt', state('h4')),
    record('post', START + 2, 'd.txt', state('h4')),
    record('pre', START + 1, 'e.txt', state('h5')),
    record('pre', START + 1, 'f.txt', state('h6')),
    // 其他会话也写了同一工作区的文件（会被纳入，并给出警告）。
    { v: 1, k: 'pre', t: START + 3, sid: 'other', cwd: WS, p: path('g.txt'), b: state('h7') },
    { v: 1, k: 'post', t: START + 4, sid: 'other', cwd: WS, p: path('g.txt'), a: state('h7') },
    // 检查点之前的记录必须被忽略。
    record('pre', START - 900, 'old.txt', state('h9')),
    record('post', START - 800, 'old.txt', state('h8')),
  ]
}

function currentStates() {
  return new Map([
    [path('a.txt'), state('h2')],
    [path('b.txt'), state('h3')],
    [path('c.txt'), state('hX')],
    [path('d.txt'), state('h4')],
    [path('e.txt'), state('h5')],
    [path('f.txt'), state('hY')],
    [path('g.txt'), state('h7')],
  ])
}

function makePlan(overrides = {}) {
  const events = overrides.events ?? baseEvents()
  const records = overrides.records ?? baseRecords()
  const current = overrides.current ?? currentStates()
  return buildPlan(
    { sessionId: 's1', turn: overrides.turn ?? 2, seq: overrides.seq },
    {
      readSession: async () => ({ session: { cwd: WS }, events }),
      traceSession: async () => ({ target: { header: { id: 's1' } }, descendants: [] }),
      readJournal: async () => records,
      readState: async (target) => ({ state: current.get(target) ?? absent, bytes: null }),
      flushPending: async () => {},
    },
  )
}

test('buildPlan: checkpoint splits restore / delete / conflict / noop', async () => {
  const plan = await makePlan()
  assert.equal(plan.turn, 2)
  assert.equal(plan.boundary, 5)
  assert.equal(plan.checkpointTime, START)

  const kinds = new Map(plan.actions.map((action) => [action.path, action.kind]))
  assert.equal(kinds.get(path('a.txt')), 'restore')
  assert.equal(kinds.get(path('b.txt')), 'delete')
  assert.equal(kinds.size, 2)

  const reasons = new Map(plan.conflicts.map((conflict) => [conflict.path, conflict.reason]))
  assert.equal(reasons.get(path('c.txt')), 'modified-since')
  assert.equal(reasons.get(path('f.txt')), 'unverified')

  assert.equal(plan.stats.restore, 1)
  assert.equal(plan.stats.remove, 1)
  assert.equal(plan.stats.conflict, 2)
  assert.equal(plan.stats.noop, 3) // d + e + g
  assert.equal(plan.stats.captured, 7)
  assert.equal(plan.actions.some((action) => action.path.endsWith('old.txt')), false)

  const warningCodes = plan.warnings.map((warning) => warning.code)
  assert.ok(warningCodes.includes('risky-tools'))
  assert.ok(warningCodes.includes('other-sessions'))
  assert.equal(warningCodes.includes('no-captures'), false)
})

test('buildPlan: turn 1 cannot fork before the session start', async () => {
  await assert.rejects(makePlan({ turn: 1 }), (error) => error.code === 'cannot-fork-start')
})

test('buildPlan: unknown turn is reported', async () => {
  await assert.rejects(makePlan({ turn: 99 }), (error) => error.code === 'turn-not-found')
})

test('buildPlan: an unfinished turn is refused', async () => {
  const events = baseEvents().filter((event) => !(event.type === 'turn/end' && event.data.turn === 3))
  await assert.rejects(makePlan({ turn: 3, events }), (error) => error.code === 'turn-not-running')
})

test('buildPlan: refuses while a later turn is still open (served-side running guard)', async () => {
  const events = [...baseEvents(), { type: 'turn/start', seq: 20, time: START + 400, data: { turn: 4 } }]
  await assert.rejects(makePlan({ turn: 2, events }), (error) => error.code === 'session-running')
})

test('buildPlan: seq fallback resolves the turn when the number is missing', async () => {
  const plan = await makePlan({ turn: undefined, seq: 7 })
  assert.equal(plan.turn, 2)
  assert.equal(plan.boundary, 5)
})

test('buildPlan: an empty journal reports no captures', async () => {
  const plan = await makePlan({ records: [] })
  assert.equal(plan.stats.captured, 0)
  assert.ok(plan.warnings.some((warning) => warning.code === 'no-captures'))
})

test('executePlan: restores, deletes, and backs up the current files first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rewind-branch-restore-'))
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    await writeFile(a, 'after-state')
    await writeFile(b, 'created-later')
    const plan = {
      sessionId: 's1',
      turn: 2,
      boundary: 5,
      actions: [
        { kind: 'restore', path: a, display: 'a.txt', hash: 'blob-1', size: 11 },
        { kind: 'delete', path: b, display: 'b.txt' },
      ],
      conflicts: [],
    }
    const outcome = await executePlan(plan, {
      safetyDir: join(dir, 'safety'),
      readBlob: async (hash) => {
        if (hash !== 'blob-1') throw new Error(`unknown blob ${hash}`)
        return Buffer.from('before-state')
      },
    })
    assert.equal(await readFile(a, 'utf8'), 'before-state')
    assert.equal(existsSync(b), false)
    assert.equal(outcome.restored, 1)
    assert.equal(outcome.deleted, 1)
    assert.equal(outcome.errors.length, 0)
    const manifest = JSON.parse(await readFile(join(outcome.safetyDir, 'manifest.json'), 'utf8'))
    assert.equal(manifest.files.length, 2)
    const backup = manifest.files.find((file) => file.path === a)
    assert.equal(await readFile(join(outcome.safetyDir, backup.blob), 'utf8'), 'after-state')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('executePlan: a missing blob is reported, other files still restored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rewind-branch-restore-'))
  try {
    const a = join(dir, 'a.txt')
    const b = join(dir, 'b.txt')
    await writeFile(a, 'one')
    await writeFile(b, 'two')
    const plan = {
      sessionId: 's1', turn: 2, boundary: 5,
      actions: [
        { kind: 'restore', path: a, display: 'a.txt', hash: 'blob-1', size: 3 },
        { kind: 'restore', path: b, display: 'b.txt', hash: 'missing', size: 3 },
      ],
      conflicts: [],
    }
    const outcome = await executePlan(plan, {
      safetyDir: join(dir, 'safety'),
      readBlob: async (hash) => {
        if (hash === 'blob-1') return Buffer.from('new-a')
        throw new Error('blob missing')
      },
    })
    assert.equal(await readFile(a, 'utf8'), 'new-a')
    assert.equal(outcome.restored, 1)
    assert.equal(outcome.errors.length, 1)
    assert.match(outcome.errors[0].message, /blob missing/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('executePlan: skips a file that changed between plan and execution (TOCTOU)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rewind-branch-restore-'))
  try {
    const a = join(dir, 'a.txt')
    await writeFile(a, 'user-edited-after-plan')
    const plan = {
      sessionId: 's1', turn: 2, boundary: 5,
      actions: [
        { kind: 'restore', path: a, display: 'a.txt', hash: 'blob-1', size: 5, expected: sha256(Buffer.from('the-after-snapshot')) },
      ],
      conflicts: [],
    }
    const outcome = await executePlan(plan, {
      safetyDir: join(dir, 'safety'),
      readBlob: async () => Buffer.from('before-state'),
    })
    assert.equal(await readFile(a, 'utf8'), 'user-edited-after-plan')
    assert.equal(outcome.restored, 0)
    assert.equal(outcome.skipped, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
