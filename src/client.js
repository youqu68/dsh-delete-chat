/**
 * dsh-delete-chat — browser half.
 *
 * Registers a "会话管理" settings page listing every session, with archive /
 * unarchive / two-step-confirm delete actions. Every mutation crosses to the
 * host through the hand-written `delChat` Remote namespace.
 *
 * Bundled by `scripts/build.mjs` into the `window.__ModuleLoader__.load({...})`
 * format the DSH client module system consumes; `react` stays external and is
 * resolved from the shell's static module table.
 */
import React from 'react'

export const inject = ['remote']

const PACKAGE = 'dsh-delete-chat'
const NAMESPACE = 'delChat'
const SECTION_ID = 'del-chat'
/** Bumped whenever the stylesheet below changes (the shell keys style tags by it). */
const CSS_TAG = 'dsh-delete-chat/client.css'

const e = React.createElement

/* ── client-side codecs ───────────────────────────────────────────────────────
 * The client half of a Typert contribution only needs `{ parse }`; validation
 * happens again host-side against the zod codecs in ./typert. */

function codecOf(parse) {
  return { parse }
}

const anyCodec = codecOf((value) => value)
/**
 * The `{ mode, typeSymbol, schema }` shape every generated descriptor uses —
 * for parameters as well as results. The client half only ever calls
 * `schema.parse`, so a duck-typed codec is enough here.
 */
const codec = (typeName) => ({
  mode: 'strict',
  typeSymbol: `${PACKAGE}#${typeName}`,
  schema: anyCodec,
})

const REMOTE_CONTRIBUTION = {
  package: PACKAGE,
  descriptors: [
    {
      id: `${PACKAGE}#${NAMESPACE}/list`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'list',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('ListRequest') }],
      result: codec('ListResult'),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/archive`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'archive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('SessionRequest') }],
      result: codec('ArchivedIdsResult'),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/unarchive`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'unarchive',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('SessionRequest') }],
      result: codec('ArchivedIdsResult'),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/inspectDelete`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'inspectDelete',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('SessionRequest') }],
      result: codec('InspectDeleteResult'),
    },
    {
      id: `${PACKAGE}#${NAMESPACE}/deleteSession`,
      service: NAMESPACE,
      namespace: NAMESPACE,
      method: 'deleteSession',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codec('SessionRequest') }],
      result: codec('DeleteResult'),
    },
  ],
}

const CSS = [
  '.dc-root{display:flex;flex-direction:column;gap:16px;font-size:13px}',
  '.dc-head{display:flex;align-items:center;justify-content:space-between}',
  '.dc-head-title{font-weight:600;font-size:15px}',
  '.dc-section{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.35));border-radius:10px;padding:10px 12px}',
  '.dc-section-title{font-weight:600;margin-bottom:8px;opacity:.85}',
  '.dc-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18))}',
  '.dc-row:first-of-type{border-top:0}',
  '.dc-row-main{min-width:0;flex:1}',
  '.dc-row-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.dc-row-sub{opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}',
  '.dc-empty{opacity:.5;padding:4px 0}',
  '.dc-live{color:var(--dsw-alias-state-info-primary,#4aa3e0);font-size:11px;margin-top:2px}',
  '.dc-warn{color:var(--dsw-alias-state-warn-primary,#e0a060);font-size:11px;margin-top:4px;word-break:break-all}',
  '.dc-actions{display:flex;align-items:center;gap:8px;flex-shrink:0}',
  '.dc-btn{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-button-elevated-fill,transparent);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.4));border-radius:7px;padding:4px 10px;cursor:pointer;white-space:nowrap}',
  '.dc-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.15))}',
  '.dc-btn:disabled{opacity:.4;cursor:default}',
  '.dc-btn-restore{border-color:var(--dsw-alias-state-ok-primary,rgba(80,160,120,.6))}',
  '.dc-btn-delete{color:var(--dsw-alias-state-error-primary,#d06c6c);border-color:var(--dsw-alias-state-error-primary,rgba(208,108,108,.5))}',
  '.dc-btn-danger{background:var(--dsw-alias-state-error-primary,#b5433f);border-color:transparent;color:var(--dsw-alias-label-primary-inverted,#fff)}',
  '.dc-error{color:var(--dsw-alias-state-error-primary,#e06c6c);font-size:12px;white-space:pre-wrap}',
  '.dc-loading{opacity:.6}',
].join('')

function insertCss() {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = PACKAGE
  style.dataset.pluginCss = CSS_TAG
  style.textContent = CSS
  document.head.appendChild(style)
  return () => {
    if (style.parentNode !== null) style.parentNode.removeChild(style)
  }
}

/** Unwrap one Remote call: transport envelope → business value. */
async function call(remote, method, args) {
  const carried = await remote[method](...(args ?? []))
  if (carried === null || typeof carried !== 'object' || carried.ok !== true) {
    throw new Error((carried && carried.error && carried.error.message) || `${method} 调用失败`)
  }
  return carried.value
}

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return String(ms)
  }
}

function SessionManagerPage(props) {
  const api = props.api
  const [view, setView] = React.useState({
    loading: true,
    sessions: [],
    error: null,
    busyId: null,
    confirmId: null,
    confirmPath: null,
  })

  const load = async () => {
    setView((s) => ({ ...s, loading: true }))
    try {
      const value = await call(api, 'list', [{}])
      setView({
        loading: false,
        sessions: (value && value.sessions) || [],
        error: null,
        busyId: null,
        confirmId: null,
        confirmPath: null,
      })
    } catch (error) {
      setView({
        loading: false,
        sessions: [],
        error: String((error && error.message) || error),
        busyId: null,
        confirmId: null,
        confirmPath: null,
      })
    }
  }

  // `api` is a stable per-plugin Remote namespace, so a mount-once effect is
  // enough; every mutation re-runs `load` explicitly.
  React.useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleArchive = async (sessionId, archived) => {
    setView((s) => ({ ...s, busyId: sessionId, error: null }))
    try {
      await call(api, archived ? 'unarchive' : 'archive', [{ sessionId }])
      await load()
    } catch (error) {
      setView((s) => ({ ...s, busyId: null, error: String((error && error.message) || error) }))
    }
  }

  const askDelete = async (sessionId) => {
    setView((s) => ({ ...s, busyId: sessionId, error: null, confirmPath: null }))
    try {
      const info = await call(api, 'inspectDelete', [{ sessionId }])
      if (info && info.deletable === true) {
        setView((s) => ({ ...s, busyId: null, confirmId: sessionId, confirmPath: info.path }))
      } else {
        setView((s) => ({
          ...s,
          busyId: null,
          confirmId: null,
          confirmPath: null,
          error: (info && info.reason) || '无法删除',
        }))
      }
    } catch (error) {
      setView((s) => ({
        ...s,
        busyId: null,
        confirmId: null,
        confirmPath: null,
        error: String((error && error.message) || error),
      }))
    }
  }

  const doDelete = async (sessionId) => {
    setView((s) => ({ ...s, busyId: sessionId, error: null }))
    try {
      await call(api, 'deleteSession', [{ sessionId }])
      await load()
    } catch (error) {
      setView((s) => ({
        ...s,
        busyId: null,
        confirmId: null,
        confirmPath: null,
        error: String((error && error.message) || error),
      }))
    }
  }

  const renderRow = (session) => {
    const confirming = view.confirmId === session.id
    const busy = view.busyId === session.id
    return e(
      'div',
      { key: session.id, className: 'dc-row' },
      e(
        'div',
        { className: 'dc-row-main' },
        e('div', { className: 'dc-row-title' }, session.title || '(未命名会话)'),
        e(
          'div',
          { className: 'dc-row-sub' },
          (session.cwd || '(无工作目录)') + ' · ' + formatTime(session.createdAt),
        ),
        session.live ? e('div', { className: 'dc-live' }, '● 运行中（不可删除）') : null,
        confirming
          ? e(
              'div',
              { className: 'dc-warn' },
              '将永久删除该会话日志文件，不可撤销：' + (view.confirmPath || ''),
            )
          : null,
      ),
      e(
        'div',
        { className: 'dc-actions' },
        e(
          'button',
          {
            className: 'dc-btn' + (session.archived ? ' dc-btn-restore' : ''),
            disabled: busy,
            onClick: () => toggleArchive(session.id, session.archived),
          },
          session.archived ? '取消归档' : '归档',
        ),
        confirming
          ? e(
              'button',
              { className: 'dc-btn dc-btn-danger', disabled: busy, onClick: () => doDelete(session.id) },
              '确认删除',
            )
          : e(
              'button',
              {
                className: 'dc-btn dc-btn-delete',
                disabled: session.live || busy,
                onClick: () => askDelete(session.id),
              },
              '删除',
            ),
        confirming
          ? e(
              'button',
              {
                className: 'dc-btn',
                onClick: () => setView((s) => ({ ...s, confirmId: null, confirmPath: null })),
              },
              '取消',
            )
          : null,
      ),
    )
  }

  const renderSection = (title, sessions) =>
    e(
      'div',
      { className: 'dc-section' },
      e('div', { className: 'dc-section-title' }, title + '（' + sessions.length + '）'),
      sessions.length === 0 ? e('div', { className: 'dc-empty' }, '无') : sessions.map(renderRow),
    )

  const archived = view.sessions.filter((s) => s.archived)
  const active = view.sessions.filter((s) => !s.archived)

  return e(
    'div',
    { className: 'dc-root' },
    e(
      'div',
      { className: 'dc-head' },
      e('div', { className: 'dc-head-title' }, '会话管理'),
      e('button', { className: 'dc-btn', onClick: load }, '刷新'),
    ),
    view.error ? e('div', { className: 'dc-error' }, '错误：' + view.error) : null,
    view.loading
      ? e('div', { className: 'dc-loading' }, '加载中…')
      : e('div', null, renderSection('已归档（可恢复显示）', archived), renderSection('正常会话', active)),
  )
}

export async function apply(ctx) {
  const remote = ctx.remote
  if (remote === undefined || typeof remote.$mount !== 'function') return

  const unmount = await remote.$mount(REMOTE_CONTRIBUTION)
  ctx.effect(() => () => {
    unmount()
  }, 'del-chat: remote contribution')

  const api = ctx.get('remote.' + NAMESPACE)
  if (api === undefined) return

  const removeCss = insertCss()
  ctx.effect(() => () => removeCss(), 'del-chat: stylesheet')

  const slots = ctx.get('slots')
  if (slots === undefined) return

  slots.inject('settings.section', () =>
    slots.register({ name: 'settings.section', id: SECTION_ID, order: 50, label: '会话管理' }, (props) =>
      e(SessionManagerPage, { ...props, api }),
    ),
  )
}
