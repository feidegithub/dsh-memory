/**
 * dsh-memory —— client 半端（设置页里的一页「记忆」）
 * ============================================================================
 * 挂到 `settings.section`（list，id/order/label），数据全走宿主 `/api/memory/*`：
 *   GET  /stats /entries /entry
 *   POST /pin /forget /restore /consolidate /backup /export
 * 只读展示 + 三个动作（置顶 / 忘记 / 恢复），不做编辑 —— 改内容走 memory_remember。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const api = async (path, init) => {
      const res = await fetch(`/api/memory${path}`, {
        headers: { 'content-type': 'application/json' },
        ...init,
      })
      if (!res.ok) throw new Error(`${res.status}`)
      return res.json()
    }

    const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`
    const when = (ms) => {
      if (!ms) return '—'
      const d = new Date(ms)
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    }

    const KIND_LABEL = {
      fact: '事实', preference: '偏好', episode: '情景', procedure: '做法', commitment: '约定',
    }
    const LAYER_LABEL = { core: '常驻', warm: '热区', longterm: '长期', history: '历史' }
    const STATUS_LABEL = { active: '活跃', faded: '淡忘', archived: '已归档', superseded: '已覆盖' }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 14, color: 'inherit', fontSize: 13 },
      row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      input: {
        flex: '1 1 220px', minWidth: 160, padding: '6px 10px', borderRadius: 8,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        background: 'color-mix(in srgb, currentColor 4%, transparent)',
        color: 'inherit', fontSize: 13, outline: 'none',
      },
      select: {
        padding: '6px 8px', borderRadius: 8,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        background: 'color-mix(in srgb, currentColor 4%, transparent)',
        color: 'inherit', fontSize: 13,
      },
      btn: {
        padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
        background: 'color-mix(in srgb, currentColor 6%, transparent)',
        color: 'inherit', whiteSpace: 'nowrap',
      },
      btnPrimary: {
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: '1px solid color-mix(in srgb, currentColor 30%, transparent)',
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        color: 'inherit', fontWeight: 600,
      },
      btnDanger: {
        padding: '5px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
        border: '1px solid #d9534f', background: 'transparent', color: '#d9534f', whiteSpace: 'nowrap',
      },
      card: {
        border: '1px solid color-mix(in srgb, currentColor 14%, transparent)',
        borderRadius: 10, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6,
      },
      meta: { opacity: 0.62, fontSize: 11.5, display: 'flex', gap: 10, flexWrap: 'wrap' },
      badge: {
        fontSize: 11, padding: '1px 6px', borderRadius: 999,
        border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
        opacity: 0.85,
      },
      text: { lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      note: { opacity: 0.7, fontSize: 12 },
      empty: { opacity: 0.55, padding: '18px 4px', textAlign: 'center' },
      bar: { height: 4, borderRadius: 2, background: 'color-mix(in srgb, currentColor 12%, transparent)', overflow: 'hidden', width: 80 },
      barFill: (v) => ({ height: '100%', width: `${Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100)}%`, background: 'currentColor', opacity: 0.55 }),
    }

    function MemoryPanel() {
      const [q, setQ] = useState('')
      const [status, setStatus] = useState('')
      const [entries, setEntries] = useState([])
      const [total, setTotal] = useState(0)
      const [stats, setStats] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [editing, setEditing] = useState(null)       // { id, text }
      const [pendingPurge, setPendingPurge] = useState(null)
      const timer = useRef(null)
      const fileRef = useRef(null)

      // 分页：100 条一页，别把几千条一次性塞给浏览器（这也是"消息多了会不会打不开"的答案）
      const load = useCallback(async (query, st, quiet, offset = 0) => {
        if (!quiet) setLoading(true)
        try {
          const [list, s] = await Promise.all([
            api(`/entries?q=${encodeURIComponent(query || '')}&status=${encodeURIComponent(st || '')}&limit=100&offset=${offset}`),
            api('/stats'),
          ])
          const rows = list.entries || []
          setEntries((prev) => (offset === 0 ? rows : [...prev, ...rows]))
          setTotal(list.total || 0)
          setStats(s)
        } catch (e) {
          setNote(`读取失败：${e.message}`)
        } finally {
          if (!quiet) setLoading(false)
        }
      }, [])

      useEffect(() => { load(q, status) }, [status])   // eslint-disable-line

      const onSearch = (value) => {
        setQ(value)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => load(value, status, true), 260)
      }

      const onImport = async (ev) => {
        const file = ev.target.files && ev.target.files[0]
        try { ev.target.value = '' } catch { /* 允许重复选同一个文件 */ }
        if (!file) return
        if (file.size > 20 * 1024 * 1024) { setNote('文件太大（上限 20 MB）'); return }
        setBusy('import')
        try {
          const payload = JSON.parse(await file.text())
          const rows = Array.isArray(payload) ? payload : (payload.entries || [])
          const r = await api('/import', { method: 'POST', body: JSON.stringify({ entries: rows, mode: 'merge' }) })
          setNote(r.ok === false
            ? `导入失败：${r.error}`
            : `导入完成：新增 ${r.added}、覆盖 ${r.replaced}、跳过 ${r.skipped}、无效 ${r.invalid}`)
          await load(q, status, true)
        } catch (e) {
          setNote(`导入失败：${e.message}`)
        } finally {
          setBusy('')
        }
      }

      const act = async (label, fn) => {
        setBusy(label)
        try {
          const res = await fn()
          setNote(res && res.ok === false ? `失败：${res.error || '未知错误'}` : '')
          await load(q, status, true)
        } catch (e) {
          setNote(`失败：${e.message}`)
        } finally {
          setBusy('')
        }
      }

      const summary = useMemo(() => {        if (!stats) return null
        const t = stats.stats?.totals || {}
        const hit = t.recalls ? Math.round((t.hits / t.recalls) * 100) : 0
        return {
          active: stats.layers?.active ?? 0,
          faded: stats.layers?.faded ?? 0,
          archived: stats.layers?.archived ?? 0,
          core: stats.layers?.core ?? 0,
          hit,
          avg: stats.stats?.latency?.avgMs,
          injected: stats.stats?.today?.injectedTokens ?? 0,
          modelCalls: t.modelCalls ?? 0,
          bytes: stats.storageBytes ?? 0,
          maxEntries: stats.counts?.maxEntries ?? 20000,
          total,
        }
      }, [stats, total])

      return h('div', { style: S.wrap },
        h('div', { style: S.row },
          h('input', {
            style: S.input,
            value: q,
            placeholder: '搜记忆（用你原本的说法就行）',
            onChange: (e) => onSearch(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(q, status) },
          }),
          h('select', {
            style: S.select,
            value: status,
            onChange: (e) => setStatus(e.target.value),
          },
            h('option', { value: '' }, '全部'),
            h('option', { value: 'active' }, '活跃'),
            h('option', { value: 'faded' }, '淡忘'),
            h('option', { value: 'archived' }, '已归档'),
          ),
          h('button', { style: S.btn, onClick: () => load(q, status) }, '刷新'),
        ),

        summary && h('div', { style: { ...S.meta, opacity: 0.75 } },
          h('span', null, `活跃 ${summary.active}`),
          h('span', null, `淡忘 ${summary.faded}`),
          h('span', null, `归档 ${summary.archived}`),
          h('span', null, `常驻 ${summary.core}`),
          h('span', null, `命中率 ${summary.hit}%`),
          h('span', null, `平均回忆 ${summary.avg == null ? '—' : `${summary.avg}ms`}`),
          h('span', null, `今日注入 ${summary.injected} token`),
          h('span', null, `模型调用 ${summary.modelCalls}`),
          h('span', null, `磁盘 ${(summary.bytes / 1024).toFixed(1)} KB`),
          h('span', null, `上限 ${summary.maxEntries} 条`),
          h('span', null, `当前 ${summary.total} 条命中`),
        ),

        h('div', { style: S.row },
          h('button', {
            style: S.btnPrimary,
            disabled: !!busy,
            onClick: () => act('consolidate', () => api('/consolidate', { method: 'POST', body: '{}' })),
          }, busy === 'consolidate' ? '巩固中…' : '立即巩固'),
          h('button', {
            style: S.btn,
            disabled: !!busy,
            onClick: () => act('backup', async () => {
              const r = await api('/backup', { method: 'POST', body: '{}' })
              setNote(r.skipped ? 'E 盘不在，跳过冷备（不影响主存）' : `已冷备到 ${r.dest || ''}`)
              return r
            }),
          }, '冷备到 E 盘'),
          h('button', {
            style: S.btn,
            disabled: !!busy,
            onClick: () => act('export', async () => {
              const r = await api('/export', { method: 'POST', body: '{}' })
              setNote(r.file ? `已导出 ${r.count} 条到 ${r.file}` : '导出失败')
              return r
            }),
          }, '导出 JSON'),
          h('button', {
            style: S.btn,
            disabled: !!busy,
            onClick: () => { if (fileRef.current) fileRef.current.click() },
          }, busy === 'import' ? '导入中…' : '导入 JSON'),
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: '.json,application/json',
            style: { display: 'none' },
            onChange: onImport,
          }),
        ),

        note ? h('div', { style: S.note }, note) : null,

        loading
          ? h('div', { style: S.empty }, '读记忆中…')
          : entries.length === 0
            ? h('div', { style: S.empty }, q ? `没想起和「${q}」有关的记忆` : '还没有记忆。跟我聊点事，或者让我"记住…"')
            : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              entries.map((e) => h('div', { key: e.id, style: S.card },
                h('div', { style: S.row },
                  h('span', { style: S.badge }, KIND_LABEL[e.kind] || e.kind),
                  h('span', { style: S.badge }, LAYER_LABEL[e.layer] || e.layer),
                  e.pinned ? h('span', { style: S.badge }, '置顶') : null,
                  e.status !== 'active' ? h('span', { style: S.badge }, STATUS_LABEL[e.status] || e.status) : null,
                  h('span', { style: { ...S.badge, opacity: 0.6 } }, `重要度 ${e.importance}`),
                  h('div', { style: S.bar }, h('div', { style: S.barFill(e.strength) })),
                  h('span', { style: { ...S.meta, marginLeft: 'auto' } }, `强度 ${pct(e.strength)} · 熟练 ${pct(e.fluency)}`),
                ),
                editing && editing.id === e.id
                  ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                    h('textarea', {
                      style: { ...S.input, minHeight: 56, width: '100%', resize: 'vertical' },
                      value: editing.text,
                      onChange: (ev) => setEditing({ id: e.id, text: ev.target.value }),
                    }),
                    h('div', { style: S.row },
                      h('button', {
                        style: S.btnPrimary,
                        disabled: !!busy || !editing.text.trim(),
                        onClick: async () => {
                          await act(e.id, () => api('/update', { method: 'POST', body: JSON.stringify({ id: e.id, text: editing.text }) }))
                          setEditing(null)
                        },
                      }, '保存'),
                      h('button', { style: S.btn, onClick: () => setEditing(null) }, '取消'),
                      h('span', { style: S.meta }, '旧内容会留在 history 里，可回溯'),
                    ),
                  )
                  : h('div', { style: S.text }, e.text),
                h('div', { style: S.row },
                  h('span', { style: S.meta },
                    `想起 ${e.recallCount} 次 · 提及 ${e.mentionCount} 次 · ${e.ageDays} 天前`,
                    e.source?.sessionId ? ` · 源 ${String(e.source.sessionId).replace(/^session-/, '').slice(0, 8)}` : '',
                  ),
                  h('div', { style: { ...S.row, marginLeft: 'auto', gap: 6 } },
                    h('button', {
                      style: S.btn,
                      disabled: !!busy,
                      onClick: () => setEditing({ id: e.id, text: e.text }),
                    }, '改'),
                    h('button', {
                      style: S.btn,
                      disabled: !!busy,
                      onClick: () => act(e.id, () => api('/pin', { method: 'POST', body: JSON.stringify({ id: e.id, pinned: !e.pinned }) })),
                    }, e.pinned ? '取消置顶' : '置顶'),
                    e.status === 'archived' || e.status === 'faded'
                      ? h('button', {
                        style: S.btn,
                        disabled: !!busy,
                        onClick: () => act(e.id, () => api('/restore', { method: 'POST', body: JSON.stringify({ id: e.id }) })),
                      }, '恢复')
                      : h('button', {
                        style: S.btn,
                        disabled: !!busy,
                        onClick: () => act(e.id, () => api('/forget', { method: 'POST', body: JSON.stringify({ id: e.id, mode: 'archive' }) })),
                      }, '忘记'),
                    pendingPurge === e.id
                      ? h('button', {
                        style: S.btnDanger,
                        disabled: !!busy,
                        onClick: async () => {
                          setPendingPurge(null)
                          await act(e.id, () => api('/purge', { method: 'POST', body: JSON.stringify({ id: e.id, confirm: true }) }))
                          setNote('已真删（只留一条不含原文的墓碑）')
                        },
                      }, '确认真删？')
                      : h('button', {
                        style: S.btnDanger,
                        disabled: !!busy,
                        onClick: () => setPendingPurge(e.id),
                      }, '真删'),
                  ),
                ),
              )),
            ),
        entries.length < total
          ? h('div', { style: S.row },
            h('button', {
              style: S.btn,
              disabled: !!busy,
              onClick: () => load(q, status, true, entries.length),
            }, `加载更多（已显示 ${entries.length} / ${total}）`),
          )
          : null,
      )
    }

    /**
     * 错误边界：面板里任何一处抛错，只把这一页变成一行提示，
     * 不要让整个设置面板跟着白掉（douyin 的 client 也是这么包的）。
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          return h('div', { style: { ...S.note, color: 'inherit', opacity: 0.8, padding: '12px 4px' } },
            `记忆面板出错了：${String(this.state.error?.message || this.state.error)}`)
        }
        return this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // ⚠️ 2026-10-25：这一版里 `ctx.slots` 不一定直接挂得上，要 `ctx.get('slots')` 兜底。
        //    之前只写 ctx.slots.inject → 拿不到就抛错，整块客户端静默不注册（设置里就没有这一页）。
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots || typeof slots.inject !== 'function') {
          try { console.warn('[dsh-memory] 拿不到 slots 服务，记忆面板未注册') } catch { /* 无 console */ }
          return
        }
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory', order: 32, label: '记忆' },
          () => h(Boundary, null, h(MemoryPanel)),
        ))
        try { console.info('[dsh-memory] 记忆面板已注册到 设置 → 记忆') } catch { /* 无 console */ }
      },
    }
  },
})
