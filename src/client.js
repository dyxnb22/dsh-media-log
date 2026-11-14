// dsh-media-log client half — the "资料库总览" sidebar tab.
//
// The DSH desktop loads this through the package.json `dsh.client` field
// (platform 'web'). The tab registers ONLY when the dsh-better-sidebar
// service exists: registration sits inside a scoped ctx.inject, so a desktop
// without that plugin (or a headless profile, which never loads this file at
// all) simply gets nothing — the 11 host tools are untouched either way.
//
// Data comes from the host half's GET /media-log/api/overview. The component
// fetches when the tab becomes visible and on manual refresh; there is no
// polling and no cache, because the query costs milliseconds and the tab is
// a glance, not a monitor. Zero write actions: anything the user wants to
// DO about a todo happens back in the conversation with the normal tools.

window.__ModuleLoader__.load({
  id: 'dsh-media-log',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const MEDIA_TYPE_ZH = { movie: '电影', tv: '剧集', anime: '动画', game: '游戏' }

    /** Display-only twin of the host's money(): minor units → '¥20.00'. */
    function money(minor, currency) {
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
      return `${symbol}${(minor / 100).toFixed(2)}`
    }

    /** '2026-12-10T00:00:00.000Z' → '12-10', in the machine's zone — the same
     * wall-clock convention as the journal's whenText on the host. */
    function dayText(iso) {
      const d = new Date(String(iso))
      if (Number.isNaN(d.getTime())) return String(iso)
      const two = (n) => String(n).padStart(2, '0')
      return `${two(d.getMonth() + 1)}-${two(d.getDate())}`
    }

    function whenText(iso) {
      const d = new Date(String(iso))
      if (Number.isNaN(d.getTime())) return String(iso)
      const two = (n) => String(n).padStart(2, '0')
      return `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
    }

    /** Badge cache: the overdue count the tab chip shows between fetches.
     *  Refreshed when the tab turns visible and (throttled) on sidebar state
     *  changes — the chip re-renders on those same store events, so the
     *  number can lag one event behind at worst. */
    let lastOverview = null
    let lastFetchAt = 0

    async function fetchOverview(service) {
      const url = service.hostRouteUrl('/media-log/api/overview')
      const res = await fetch(url, { method: 'GET' })
      const value = await res.json().catch(() => {
        throw new Error(`响应不是 JSON（HTTP ${res.status}），桌面网关可能尚未就绪。`)
      })
      if (!value || typeof value !== 'object' || !('ok' in value)) {
        throw new Error('总览返回了意外结构。')
      }
      if (value.ok !== true) throw new Error(value.error?.message ?? '总览请求失败。')
      lastOverview = value.data
      lastFetchAt = Date.now()
      return value.data
    }

    /** Quiet, theme-agnostic styling: inherit foreground, translucent
     * structure. No hardcoded palette on text or surfaces. */
    const muted = { opacity: 0.65 }
    const hairline = '1px solid rgba(127,127,127,0.3)'
    const section = { marginTop: 14, paddingTop: 10, borderTop: hairline }
    const sectionTitle = { fontWeight: 500, marginBottom: 6 }
    const row = { margin: '3px 0' }
    const dotStyle = {
      overdue: { background: '#e5484d' },
      next7: { background: '#f5a623' },
      inProgress: { background: 'rgba(127,127,127,0.5)' },
    }
    /** Meaning never rides on color alone — the label text carries it. */
    const Dot = ({ kind }) =>
      h('span', {
        'aria-hidden': 'true',
        style: {
          display: 'inline-block', width: 8, height: 8, borderRadius: 4,
          marginRight: 7, verticalAlign: 'middle', ...dotStyle[kind],
        },
      })

    const FilmIcon = (size) =>
      h(
        'svg',
        {
          width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }),
        h('path', { d: 'M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4' }),
      )

    function StatLine({ label, value }) {
      return h(
        'div',
        { style: row },
        h('span', { style: { ...muted, marginRight: 8 } }, label),
        h('span', { style: { fontWeight: 500 } }, String(value)),
      )
    }

    function TodoGroup({ kind, title, items, renderItem }) {
      if (!items || items.length === 0) return null
      return h(
        'div',
        { style: { marginBottom: 10 } },
        h('div', { style: sectionTitle }, h(Dot, { kind }), `${title}（${items.length}）`),
        ...items.map((item, i) => h('div', { key: i, style: { ...row, paddingLeft: 15 } }, renderItem(item))),
      )
    }

    function OverviewTab(props) {
      const { ctx, visible } = props
      const [data, setData] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [loading, setLoading] = React.useState(false)
      const [tick, setTick] = React.useState(0)

      React.useEffect(() => {
        if (!visible) return
        let live = true
        setLoading(true)
        setError(null)
        const service = typeof ctx?.get === 'function' ? ctx.get('betterSidebar') : undefined
        if (!service || typeof service.hostRouteUrl !== 'function') {
          if (live) {
            setLoading(false)
            setError('找不到 dsh-better-sidebar 的路由服务，无法拉取总览。')
          }
          return
        }
        fetchOverview(service)
          .then((payload) => {
            if (live) {
              setData(payload)
              setLoading(false)
            }
          })
          .catch((e) => {
            if (live) {
              setError(String(e?.message ?? e))
              setLoading(false)
            }
          })
        return () => {
          live = false
        }
      }, [visible, tick, ctx])

      const o = data?.overview
      const t = data?.todos
      const moneyBits = o
        ? Object.entries(o.subscriptions.monthlyTotals)
            .map(([currency, minor]) => money(minor, currency))
            .join(' + ')
        : ''
      const hasTodos =
        t && ((t.overdue?.length ?? 0) + (t.next7?.length ?? 0) + (t.next30Count ?? 0) + (t.pausedStalledTotal ?? 0) > 0 ||
          (t.inProgressTotal ?? 0) > 0)

      return h(
        'div',
        { style: { fontSize: '0.92em', lineHeight: 1.55, padding: '2px 0' } },
        // slim header: freshness + the only control on the page
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 } },
          h('span', { style: { fontWeight: 500 } }, '资料库总览'),
          data ? h('span', { style: { ...muted, fontSize: '0.9em' } }, `更新于 ${whenText(data.generatedAt)}`) : null,
          h('span', { style: { flex: 1 } }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => setTick((v) => v + 1),
              disabled: loading,
              style: { font: 'inherit', fontSize: '0.9em', padding: '2px 10px', borderRadius: 6, border: hairline, background: 'transparent', color: 'inherit', cursor: loading ? 'default' : 'pointer' },
            },
            loading ? '刷新中…' : '刷新',
          ),
        ),
        error && h('div', { role: 'alert', style: { ...muted, margin: '6px 0' } }, `拉取失败：${error}`),
        !error && loading && !data && h('div', { style: muted }, '正在读取资料库…'),
        data && o && t && h(
          'div',
          null,
          h('div', null, [
            h(StatLine, { key: 'a', label: '在看', value: o.media.inProgress }),
            h(StatLine, { key: 'b', label: '想看', value: o.media.planned }),
            h(StatLine, { key: 'c', label: '本月看完', value: o.media.completedThisMonth }),
            h(StatLine, { key: 'd', label: '在用软件', value: o.software.inUse }),
          ]),
          h(
            'div',
            { style: row },
            h('span', { style: { ...muted, marginRight: 8 } }, '订阅月均（估）'),
            moneyBits
              ? h('span', { style: { fontWeight: 500 } }, `${moneyBits} / 月`)
              : h('span', { style: muted }, '暂无可估算的订阅'),
            o.subscriptions.unestimated > 0 &&
              h('span', { style: { ...muted, marginLeft: 6 } }, `，${o.subscriptions.unestimated} 条按量/未记金额未计入`),
          ),
          (o.media.archived > 0 || data.journal?.lastAt) &&
            h(
              'div',
              { style: { ...muted, fontSize: '0.9em', marginTop: 2 } },
              [
                o.media.archived > 0 ? `已归档 ${o.media.archived} 条` : null,
                data.journal?.lastAt ? `库最后改动 ${whenText(data.journal.lastAt)}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ),
          h(
            'div',
            { style: section },
            h('div', { style: sectionTitle }, '待办'),
            hasTodos
              ? h('div', null, [
                  h(TodoGroup, {
                    key: 'overdue',
                    kind: 'overdue',
                    title: '续费日已过',
                    items: t.overdue,
                    renderItem: (item) =>
                      `《${item.name}》登记的续费日 ${dayText(item.nextRenewAt)} 已过——这次续了吗？要记一笔就在对话里说。`,
                  }),
                  h(TodoGroup, {
                    key: 'next7',
                    kind: 'next7',
                    title: '7 天内续费',
                    items: t.next7,
                    renderItem: (item) => `《${item.name}》${dayText(item.nextRenewAt)} 续费`,
                  }),
                  t.next30Count > 0 &&
                    h(
                      'div',
                      { key: 'next30', style: { ...row, paddingLeft: 15 } },
                      h(Dot, { kind: 'next7' }),
                      `另有 ${t.next30Count} 条在 30 天内到期`,
                    ),
                  h(TodoGroup, {
                    key: 'paused',
                    kind: 'inProgress',
                    title: '搁置久了',
                    items: t.pausedStalled,
                    renderItem: (item) => `《${item.title}》搁置 ${item.stalledDays} 天了——捡回来还是弃了？`,
                  }),
                  h(
                    'div',
                    { key: 'ip', style: { marginBottom: 0 } },
                    h('div', { style: sectionTitle }, h(Dot, { kind: 'inProgress' }), `在看中（${t.inProgressTotal}）`),
                    t.inProgressRecent.length > 0
                      ? h(
                          'div',
                          { style: { ...row, paddingLeft: 15 } },
                          t.inProgressRecent
                            .map((m) => `《${m.title}》${m.year ? `（${m.year}）` : ''}`)
                            .join(''),
                          ' …',
                        )
                      : null,
                  ),
                ])
              : h('div', { style: muted }, '没有待办。想看的片、要续费的订阅，都清清爽爽。'),
          ),
          h(
            'div',
            { style: { ...muted, fontSize: '0.85em', marginTop: 8 } },
            '“本月看完”按完成日期口径（同 media_log_list 的完成日期窗口）；续费日期已过不代表已扣款。',
          ),
        ),
      )
    }

    return {
      apply(ctx) {
        // Scoped on purpose: better-sidebar is an add-on. When it is absent
        // the callback never fires and nothing else in this plugin changes.
        ctx.inject(['betterSidebar'], (sctx) => {
          const service = sctx.betterSidebar
          sctx.effect(
            () =>
              service.registerTab({
                id: 'media-log:overview',
                title: '资料库总览',
                description: '媒体、订阅与软件的总览数字，以及续费/搁置/在看待办',
                icon: FilmIcon,
                order: 150,
                single: true,
                // The tab "finds you": the chip shows how many renewals have
                // slipped past their recorded date. Zero or unknown → null
                // (no badge), so silence stays the normal state.
                badge: () => {
                  const n = lastOverview?.todos?.overdue?.length ?? 0
                  return n > 0 ? n : null
                },
                component: OverviewTab,
              }),
            'dsh-media-log: register overview tab',
          )
          if (typeof service.hostRouteUrl === 'function') {
            // First fetch right away so the badge is real before the first
            // tab open; then a 60s-floored refresh on sidebar state changes
            // (session switches and the like) keeps it a glance, not a monitor.
            fetchOverview(service).catch(() => {})
            if (typeof service.subscribeState === 'function') {
              sctx.effect(
                () =>
                  service.subscribeState(() => {
                    if (Date.now() - lastFetchAt < 60000) return
                    fetchOverview(service).catch(() => {})
                  }),
                'dsh-media-log: badge refresh on state changes',
              )
            }
          }
        })
      },
    }
  },
})
