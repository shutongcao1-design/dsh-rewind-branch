/**
 * dsh-rewind-branch — Client 半（浏览器里跑）。
 *
 * 送达通道有两条，本文件对两条都幂等：
 *   ① `package.json` 的 `dsh.client` 声明（Web 形态）；
 *   ② Host 半通过 `webserver/index-inject` 推的内联行（桌面 Electron 壳形态）。
 * 两条可能在同一次页面加载里都生效，所以顶层先立全局守卫、再调 `__ModuleLoader__.load`；
 * 所有声明都放在 factory 闭包里，避免两份脚本被拼进同一作用域时重复声明。
 *
 * UI 只有一个入口：每个已结束回合的尾部（`conversation.chat.turnTail`）一个
 * 「回到这轮提问前」按钮。点开先向宿主取计划（preview），确认后：
 *   1. 宿主恢复文件（并先备份当前内容）；
 *   2. 这里用 `ctx.sessions.fork({ atSeq: boundary })` 从该消息之前开新分支；
 *   3. `uiWorkspace.openSession(childId)` 切到子会话。
 * fork 不交给 Host：`sessionController.fork` 才拥有重建 agent / 挂 workspace 的完整语义。
 */
(function () {
  if (typeof window === 'undefined') return
  if (window.__DSH_REWIND_BRANCH_MODULE_LOADED__ === true) return
  try {
    window.__ModuleLoader__.load({
    id: 'dsh-rewind-branch',
    factory(require) {
      const React = require('react')
      const h = React.createElement

      const NS = 'rewind'
      const PKG = 'dsh-rewind-branch'
      const BRIDGE = '/_dsh/dsh-rewind-branch'
      const REQUEST_TIMEOUT_MS = 30000

      const zh = {
        action: '回到这轮提问前',
        actionTitle: '新开一个分支会话，并把工作区文件恢复到这条消息之前；原会话保留。',
        runningHint: '会话运行中，结束后可用',
        panelTitle: '回退到这个检查点？',
        panelHint: '会在新分支里继续，原会话保留不动。恢复前会自动备份当前文件。',
        cancel: '取消',
        confirm: '确认回退',
        working: '正在计算…',
        forking: '正在打开新会话…',
        errorTitle: '回退失败',
        retry: '重试',
        restoreMark: '恢复',
        deleteMark: '删除',
        sep: ' · ',
        restoreCount: '恢复 {n} 个文件',
        removeCount: '删除 {n} 个新建文件',
        conflictCount: '{n} 个冲突未动',
        noFileChanges: '没有需要恢复的文件（该回合没有被捕获到文件改动）',
        truncated: '…还有 {n} 项未列出',
        errRunning: '会话正在运行，结束后再回退。',
        errNoCwd: '这个会话没有工作目录。',
        errNoSession: '找不到该会话。',
        errNoTurn: '找不到这一轮消息。',
        errNotFinished: '这一轮还没结束。',
        errFirstTurn: '这是会话的第一轮，前面没有可回退的检查点。',
        errBusy: '已有回退在进行中。',
        errUnavailable: '宿主缺少会话查询能力，暂时无法回退。',
        errGeneric: '回退失败：{detail}',
        errNetwork: '网络错误：{detail}',
        errFork: '文件已恢复，但创建分支失败：{detail}。可以再点一次「确认回退」重试。',
        reasonModified: '检查点后被改动过，已跳过',
        reasonUnverified: '无法确认写后状态，已跳过',
        reasonUnsupportedTarget: '该文件类型不支持快照，已跳过',
        reasonUnsupportedAfter: '写后状态不可用，已跳过',
        warnRiskyTools: '这些回合用过 shell/代码执行（{tools}）；绕过文件工具写入的改动不会被还原。',
        warnSubagents: '这些回合用过子代理/工作流（{tools}）；非文件工具的写入不会被还原。',
        warnOtherSessions: '同一工作区还有 {count} 个其他会话的改动被一并纳入回退。',
        warnNoCaptures: '插件没有记录到任何文件快照（可能是插件安装前的回合）。',
      }
      const en = {
        action: 'Rewind to before this prompt',
        actionTitle: 'Open a new branch session and restore the workspace files to before this message; the original session is kept.',
        runningHint: 'Session is running; available when it finishes',
        panelTitle: 'Rewind to this checkpoint?',
        panelHint: 'Continue in a new branch; the original session is untouched. Current files are backed up before restoring.',
        cancel: 'Cancel',
        confirm: 'Rewind',
        working: 'Calculating…',
        forking: 'Opening the new session…',
        errorTitle: 'Rewind failed',
        retry: 'Retry',
        restoreMark: 'restore',
        deleteMark: 'delete',
        sep: ' · ',
        restoreCount: 'restore {n} file(s)',
        removeCount: 'delete {n} file(s)',
        conflictCount: '{n} conflict(s) left untouched',
        noFileChanges: 'No file changes captured for this turn',
        truncated: '…and {n} more not listed',
        errRunning: 'The session is running; rewind after it finishes.',
        errNoCwd: 'This session has no working directory.',
        errNoSession: 'Session not found.',
        errNoTurn: 'Turn not found.',
        errNotFinished: 'This turn has not finished yet.',
        errFirstTurn: 'This is the first turn; there is no earlier checkpoint.',
        errBusy: 'Another rewind is already running.',
        errUnavailable: 'The host lacks session query support; rewind is unavailable.',
        errGeneric: 'Rewind failed: {detail}',
        errNetwork: 'Network error: {detail}',
        errFork: 'Files were restored, but opening the branch failed: {detail}. Click Rewind again to retry.',
        reasonModified: 'changed after the checkpoint, skipped',
        reasonUnverified: 'cannot verify the post-write state, skipped',
        reasonUnsupportedTarget: 'file type not snapshotted, skipped',
        reasonUnsupportedAfter: 'post-write state unavailable, skipped',
        warnRiskyTools: 'These turns used shell/code execution ({tools}); changes written outside the file tools are not restored.',
        warnSubagents: 'These turns used subagents/workflows ({tools}); writes made outside the file tools are not restored.',
        warnOtherSessions: 'Changes from {count} other session(s) in the same workspace are included in this rewind.',
        warnNoCaptures: 'No file snapshots were recorded (likely turns before the plugin was installed).',
      }

      const CSS = `
.dsh-rw{display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:2px 0}
.dsh-rw-btn{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-rw-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.dsh-rw-btn:disabled{opacity:.55;cursor:default}
.dsh-rw-glyph{display:block;flex:none}
.dsh-rw-panel{max-width:560px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);
  border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);
  font-size:12px;line-height:1.55;box-shadow:0 6px 20px rgba(0,0,0,.08)}
.dsh-rw-title{font-weight:600;margin-bottom:3px}
.dsh-rw-sub{color:var(--dsw-alias-label-secondary);font-size:11px}
.dsh-rw-stats{margin-top:6px}
.dsh-rw-list{margin:5px 0 0;padding-left:16px;max-height:132px;overflow:auto;
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}
.dsh-rw-warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-rw-err{color:var(--dsw-alias-state-error-primary)}
.dsh-rw-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:9px}
.dsh-rw-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.dsh-rw-primary:hover:not(:disabled){background:var(--dsw-alias-brand-primary);filter:brightness(1.08);color:#fff}
`

      function format(template, params) {
        if (params === undefined) return template
        return String(template).replace(/\{(\w+)\}/gu, (_, key) => (params[key] === undefined ? '' : String(params[key])))
      }

      async function callBridge(path, payload) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        try {
          const response = await fetch(path, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: controller.signal,
          })
          let body = null
          try {
            body = await response.json()
          } catch {
            body = null
          }
          return { response, body }
        } finally {
          clearTimeout(timer)
        }
      }

      function errorText(t, response, body) {
        const code = body?.error?.code
        switch (code) {
          case 'session-running': return t('errRunning')
          case 'no-cwd': return t('errNoCwd')
          case 'session-not-found': return t('errNoSession')
          case 'turn-not-found': return t('errNoTurn')
          case 'turn-not-running': return t('errNotFinished')
          case 'cannot-fork-start': return t('errFirstTurn')
          case 'busy': return t('errBusy')
          case 'unavailable': return t('errUnavailable')
          default: {
            const detail = body?.error?.message ?? (response?.status === undefined ? 'network error' : `HTTP ${response.status}`)
            return format(t('errGeneric'), { detail })
          }
        }
      }

      function reasonText(t, reason) {
        switch (reason) {
          case 'modified-since': return t('reasonModified')
          case 'unverified': return t('reasonUnverified')
          case 'unsupported-target': return t('reasonUnsupportedTarget')
          case 'unsupported-after': return t('reasonUnsupportedAfter')
          default: return String(reason)
        }
      }

      function warningText(t, warning) {
        const params = warning?.params ?? {}
        switch (warning?.code) {
          case 'risky-tools': return format(t('warnRiskyTools'), params)
          case 'subagents': return format(t('warnSubagents'), params)
          case 'other-sessions': return format(t('warnOtherSessions'), params)
          case 'no-captures': return t('warnNoCaptures')
          default: return String(warning?.code ?? '')
        }
      }

      function summaryLine(t, plan) {
        const stats = plan?.stats ?? {}
        const parts = []
        if (stats.restore > 0) parts.push(format(t('restoreCount'), { n: stats.restore }))
        if (stats.remove > 0) parts.push(format(t('removeCount'), { n: stats.remove }))
        if (stats.conflict > 0) parts.push(format(t('conflictCount'), { n: stats.conflict }))
        if (parts.length === 0) return t('noFileChanges')
        return parts.join(t('sep'))
      }

      function RewindGlyph() {
        return h('svg', {
          viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, className: 'dsh-rw-glyph',
        },
        h('path', {
          d: 'M8.8 3.2 3.8 7.4l5 4.2', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M4.2 7.4h5.1a4.1 4.1 0 0 1 0 8.2H6.6', fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.6, strokeLinecap: 'round',
        }))
      }

      function RewindAction(props) {
        const t = props.t
        const useSession = props.useSession
        const commitFork = props.commitFork
        const sessionId = props.sessionId
        const turn = props.turn
        const seq = props.seq

        const [phase, setPhase] = React.useState('idle')
        const [plan, setPlan] = React.useState(null)
        const [message, setMessage] = React.useState('')

        let running = false
        if (typeof useSession === 'function') {
          running = useSession((snapshot) => snapshot?.running === true) === true
        }

        const turnNumber = typeof turn === 'number' ? turn : Number(turn?.turn ?? turn?.value ?? turn)
        if (typeof sessionId !== 'string' || !Number.isInteger(turnNumber)) return null

        const reset = () => {
          setPlan(null)
          setMessage('')
          setPhase('idle')
        }

        const openPreview = async () => {
          setPhase('working')
          setMessage('')
          try {
            const { response, body } = await callBridge(`${BRIDGE}/preview`, { sessionId, turn: turnNumber, seq })
            if (response.ok !== true || body?.ok !== true) {
              setMessage(errorText(t, response, body))
              setPhase('error')
              return
            }
            setPlan(body.value)
            setPhase('confirm')
          } catch (error) {
            setMessage(format(t('errNetwork'), { detail: String(error?.message ?? error) }))
            setPhase('error')
          }
        }

        const confirm = async () => {
          setPhase('working')
          setMessage('')
          let boundary
          try {
            const { response, body } = await callBridge(`${BRIDGE}/rewind`, { sessionId, turn: turnNumber, seq })
            if (response.ok !== true || body?.ok !== true) {
              setMessage(errorText(t, response, body))
              setPhase('error')
              return
            }
            boundary = body.value.boundary
          } catch (error) {
            setMessage(format(t('errNetwork'), { detail: String(error?.message ?? error) }))
            setPhase('error')
            return
          }
          setPhase('forking')
          try {
            await commitFork(sessionId, boundary)
            // 会话切到子分支后本组件会被卸载；这里不再改状态。
          } catch (error) {
            setMessage(format(t('errFork'), { detail: String(error?.message ?? error) }))
            setPhase('error')
          }
        }

        const busy = phase === 'working' || phase === 'forking'
        const disabled = running || busy

        const button = h('button', {
          type: 'button',
          className: 'dsh-rw-btn',
          title: running ? t('runningHint') : t('actionTitle'),
          'aria-label': t('actionTitle'),
          disabled,
          onMouseDown: (event) => event.preventDefault(),
          onClick: () => {
            if (disabled) return
            void openPreview()
          },
        }, RewindGlyph(), h('span', null, phase === 'working' ? t('working') : phase === 'forking' ? t('forking') : t('action')))

        const children = [button]

        if (phase === 'confirm' && plan !== null) {
          const warnings = Array.isArray(plan.warnings) ? plan.warnings : []
          const conflicts = Array.isArray(plan.conflicts) ? plan.conflicts : []
          const actions = Array.isArray(plan.actions) ? plan.actions : []
          const truncated = plan.truncated ?? { actions: 0, conflicts: 0 }
          children.push(h('div', { className: 'dsh-rw-panel', role: 'group', 'aria-label': t('panelTitle') },
            h('div', { className: 'dsh-rw-title' }, t('panelTitle')),
            h('div', { className: 'dsh-rw-sub' }, t('panelHint')),
            h('div', { className: 'dsh-rw-stats' }, summaryLine(t, plan)),
            warnings.length > 0
              ? h('ul', { className: 'dsh-rw-list dsh-rw-warn' }, warnings.map((warning, index) => h('li', { key: `w${index}` }, warningText(t, warning))))
              : null,
            conflicts.length > 0
              ? h('ul', { className: 'dsh-rw-list dsh-rw-warn' }, conflicts.map((conflict, index) => h('li', { key: `c${index}` },
                `${conflict.path} — ${reasonText(t, conflict.reason)}`)))
              : null,
            actions.length > 0
              ? h('ul', { className: 'dsh-rw-list' }, actions.map((action, index) => h('li', { key: `a${index}` },
                `${action.kind === 'delete' ? t('deleteMark') : t('restoreMark')} ${action.path}`)))
              : null,
            truncated.actions + truncated.conflicts > 0
              ? h('div', { className: 'dsh-rw-sub' }, format(t('truncated'), { n: truncated.actions + truncated.conflicts }))
              : null,
            h('div', { className: 'dsh-rw-actions' },
              h('button', {
                type: 'button', className: 'dsh-rw-btn',
                onMouseDown: (event) => event.preventDefault(),
                onClick: reset,
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-rw-btn dsh-rw-primary',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => { void confirm() },
              }, t('confirm')))))
        }

        if (phase === 'error') {
          children.push(h('div', { className: 'dsh-rw-panel dsh-rw-err', role: 'alert' },
            h('div', { className: 'dsh-rw-title' }, t('errorTitle')),
            h('div', null, message),
            h('div', { className: 'dsh-rw-actions' },
              h('button', {
                type: 'button', className: 'dsh-rw-btn',
                onMouseDown: (event) => event.preventDefault(),
                onClick: reset,
              }, t('cancel')),
              h('button', {
                type: 'button', className: 'dsh-rw-btn',
                onMouseDown: (event) => event.preventDefault(),
                onClick: () => {
                  reset()
                  void openPreview()
                },
              }, t('retry')))))
        }

        return h('div', { className: 'dsh-rw' }, children)
      }

      function apply(ctx) {
        if (window.__DSH_REWIND_BRANCH_APPLIED__ === true) return
        window.__DSH_REWIND_BRANCH_APPLIED__ = true

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'rewind: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = PKG
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        }, 'rewind: styles')

        const t = ctx.locale.bind(NS)

        const commitFork = async (sessionId, boundary) => {
          const sessions = ctx.get('sessions')
          if (sessions?.fork === undefined) throw new Error('sessions service unavailable')
          const childId = await sessions.fork({ sessionId, atSeq: boundary, increaseTitle: true })
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace?.openSession !== undefined) uiWorkspace.openSession(childId)
          return childId
        }

        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({
          name: 'conversation.chat.turnTail',
          id: 'dsh-rewind-branch',
          order: 40,
          locale: NS,
        }, (props) => h(RewindAction, { ...props, t: props?.t ?? t, commitFork })))
      }

      return { inject: ['slots', 'locale'], apply }
    },
    })
    window.__DSH_REWIND_BRANCH_MODULE_LOADED__ = true
  } catch (error) {
    // 两条送达通道：这一条失败时不要立守卫，留给另一条通道重试。
    try {
      console.error('[dsh-rewind-branch] client module registration failed', error)
    } catch {
      /* ignore */
    }
  }
})()
