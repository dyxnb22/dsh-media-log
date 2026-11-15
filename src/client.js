// dsh-media-log client half — the "资料库总览" sidebar tab.
//
// The DSH desktop loads this through the package.json `dsh.client` field
// (platform 'web'). The tab registers ONLY when the dsh-better-sidebar
// service exists: registration sits inside a scoped ctx.inject, so a desktop
// without that plugin (or a headless profile, which never loads this file at
// all) simply gets nothing — the 12 host tools are untouched either way.
//
// Data comes from the host half's GET /media-log/api/overview. The component
// fetches when the tab becomes visible and on manual refresh; there is no
// polling and no cache, because the query costs milliseconds and the tab is
// a glance, not a monitor. Zero write actions: anything the user wants to
// DO about a todo happens back in the conversation with the normal tools.
//
// Design: a light card that belongs to the app — near-black type over
// whitespace, with colorful poster placeholders generated from titles (no
// external images) carrying the visual identity. Red appears only on the
// overdue count.

window.__ModuleLoader__.load({
  id: 'dsh-media-log',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Display-only twin of the host's money(): minor units → '¥20.00'. */
    function money(minor, currency) {
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : `${currency} `
      return `${symbol}${(minor / 100).toFixed(2)}`
    }

    /** Parses an ISO string into a Date, or null when unparseable — an
     * unparseable value renders as the raw text, never 'Invalid Date'. */
    function parsedDate(iso) {
      const d = new Date(String(iso))
      return Number.isNaN(d.getTime()) ? null : d
    }
    const two = (n) => String(n).padStart(2, '0')

    /** '2026-12-10T00:00:00.000Z' → '12-10', in the machine's zone — the same
     * wall-clock convention as the journal's whenText on the host. */
    function dayText(iso) {
      const d = parsedDate(iso)
      return d ? `${two(d.getMonth() + 1)}-${two(d.getDate())}` : String(iso)
    }

    /** → '20:31' wall clock, the same machine-zone convention. */
    function timeText(iso) {
      const d = parsedDate(iso)
      return d ? `${two(d.getHours())}:${two(d.getMinutes())}` : String(iso)
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

    /* ---------- the material: a light card that belongs to the app ---------- */
    const C = {
      surface: 'linear-gradient(180deg, #ffffff 0%, #fcfcfd 100%)',
      edge: '1px solid rgba(17,17,26,0.07)',
      text: '#17171c',
      textDim: 'rgba(23,23,28,0.55)',
      textFaint: 'rgba(23,23,28,0.38)',
      hair: '1px solid rgba(23,23,28,0.07)',
      red: '#e11d48',
      rowHover: 'rgba(23,23,28,0.04)',
    }
    const S = {
      card: {
        background: C.surface,
        border: C.edge,
        borderRadius: 16,
        padding: 16,
        color: C.text,
        fontSize: 13,
        lineHeight: 1.55,
        boxShadow: '0 6px 24px rgba(17,17,26,0.06)',
      },
      metaTop: { display: 'flex', alignItems: 'center', gap: 6 },
      metaTopText: { fontSize: 11, color: C.textFaint },
      hero: { fontSize: 13.5, lineHeight: 2.15, margin: '8px 0 2px' },
      heroNum: {
        fontSize: 26,
        fontWeight: 700,
        letterSpacing: '-0.02em',
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        background: 'linear-gradient(180deg, #17171c 55%, #4b4b55 100%)',
        WebkitBackgroundClip: 'text',
        backgroundClip: 'text',
        color: 'transparent',
        padding: '0 1px',
      },
      quiet: { fontSize: 12, margin: '6px 0 0', color: C.textDim },
      meta: { fontSize: 11, margin: '3px 0 0', color: C.textFaint },
      section: { borderTop: C.hair, marginTop: 14, paddingTop: 12 },
      sectionLabel: { fontSize: 11, color: C.textFaint, letterSpacing: '0.14em', marginBottom: 2 },
      // sectionLabel keeps the wide tracking: a quiet eyebrow for one section
      groupHead: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 8,
        fontSize: 12.5,
        fontWeight: 550,
        padding: '10px 0 4px',
        color: C.textDim,
      },
      groupCount: {
        marginLeft: 'auto',
        fontSize: 12,
        fontWeight: 500,
        fontVariantNumeric: 'tabular-nums',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '5px 8px 5px 6px',
        borderRadius: 10,
        minWidth: 0,
      },
      poster: {
        width: 26,
        height: 38,
        borderRadius: 5,
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 500,
        color: 'rgba(255,255,255,0.85)',
        textShadow: '0 1px 2px rgba(0,0,0,0.3)',
      },
      rowMain: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      rowSide: { marginLeft: 'auto', flex: 'none', fontSize: 11.5, color: C.textDim, fontVariantNumeric: 'tabular-nums' },
      hint: { fontSize: 11, margin: '2px 0 2px', color: C.textFaint },
      empty: { color: C.textDim, padding: '20px 0 10px', textAlign: 'center', lineHeight: 1.8 },
      footnote: { fontSize: 10.5, marginTop: 12, lineHeight: 1.6, color: C.textFaint },
      iconBtn: {
        marginLeft: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        borderRadius: 7,
        border: 'none',
        background: 'transparent',
        color: C.textDim,
        cursor: 'pointer',
      },
    }
    /** Inline display number for the hero sentence (marquee amber). */
    const Num = ({ children }) => h('span', { style: S.heroNum }, String(children))

    const RefreshIcon = () =>
      h(
        'svg',
        {
          width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M21 12a9 9 0 1 1-2.64-6.36' }),
        h('path', { d: 'M21 3v6h-6' }),
      )

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

    /** Poster placeholder: a 2:3 gradient tile keyed by the title — the
     *  media-app pattern (Spotify/Netflix placeholder art) without any
     *  external image. */
    const POSTER_PALETTES = [
      ['#2b3a67', '#4062bb'],
      ['#5f0f40', '#9a031e'],
      ['#0f4c5c', '#5fa8a0'],
      ['#6a4c93', '#b388eb'],
      ['#7f4f24', '#dda15e'],
      ['#1b4332', '#52b788'],
      ['#49306b', '#a06cd5'],
      ['#7d1128', '#e05780'],
    ]
    function posterFor(title) {
      let hash = 0
      for (const ch of String(title)) hash = (hash * 31 + ch.codePointAt(0)) >>> 0
      const [a, b] = POSTER_PALETTES[hash % POSTER_PALETTES.length]
      const ch = String(title).trim().charAt(0) || '·'
      return {
        background: `linear-gradient(155deg, ${a}, ${b})`,
        children: ch,
      }
    }

    /** One row of a group: optional poster, text left, the actionable detail
     *  right. The hover highlight lives on .mlrow (see the style tag below). */
    const Row = ({ poster, main, side, title }) =>
      h(
        'div',
        { className: 'mlrow', style: S.row, title },
        poster ?? null,
        h('span', { style: S.rowMain }, main),
        side ? h('span', { style: S.rowSide }, side) : null,
      )

    /** The media-flavored row: a poster tile keyed by the title rides along. */
    const PosterRow = ({ title, side, titleText }) => {
      const p = posterFor(title)
      return Row({
        poster: h('div', { style: { ...S.poster, background: p.background } }, p.children),
        main: title,
        side,
        title: titleText ?? title,
      })
    }

    /** A titled group; renders nothing when items is empty. The overdue
     *  count carries the only red on the panel. */
    const Group = ({ label, count, countColor, items, renderItem, note }) =>
      items && items.length > 0
        ? h(
            'div',
            { style: { marginBottom: 10 } },
            h(
              'div',
              { style: S.groupHead },
              h('span', null, label),
              h(
                'span',
                { style: { ...S.groupCount, ...(countColor ? { color: countColor } : { color: C.textDim }) } },
                `${count ?? items.length} 条`,
              ),
            ),
            ...items.map((item, i) => renderItem(item, i)),
            note ? h('div', { style: S.hint }, note) : null,
          )
        : null

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
      const libraryEmpty = o && o.media.total === 0
      const moneyBits = o
        ? Object.entries(o.subscriptions.monthlyTotals)
            .map(([currency, minor]) => money(minor, currency))
            .join('，')
        : ''
      const hasTodos =
        t && ((t.overdue?.length ?? 0) + (t.next7?.length ?? 0) + (t.next30Count ?? 0) + (t.pausedStalledTotal ?? 0) > 0 ||
          (t.inProgressTotal ?? 0) > 0)

      return h(
        'div',
        { id: 'media-log-overview-root' },
        h('style', null, `#media-log-overview-root .mlrow:hover { background: rgba(23,23,28,0.045); }`),
        h(
          'div',
          { style: S.card },
          // ── top meta: freshness left, the only control right ──
          h(
            'div',
            { style: S.metaTop },
            h('span', { style: S.metaTopText }, data ? `更新于 ${timeText(data.generatedAt)}` : '　'),
            h(
              'button',
              {
                type: 'button',
                'aria-label': '刷新总览',
                'data-tooltip': '刷新',
                onClick: () => setTick((v) => v + 1),
                disabled: loading,
                style: { ...S.iconBtn, opacity: loading ? 0.3 : 0.7 },
              },
              h(RefreshIcon),
            ),
          ),
          error && h('div', { role: 'alert', style: { color: C.red, margin: '8px 0' } }, `拉取失败：${error}`),
          !error && loading && !data && h('div', { style: { color: C.textDim, padding: '16px 0', textAlign: 'center' } }, '正在读取资料库…'),
          data && o && t && h(
            'div',
            null,
            // ── hero: the state of the library as one sentence, numbers in marquee amber ──
            libraryEmpty
              ? h('div', { style: S.hero }, '资料库还空着。想记一部片，说一句话就好。')
              : h(
                  'div',
                  { style: S.hero },
                  h('span', null, '在看 '),
                  h(Num, null, o.media.inProgress),
                  h('span', null, ' 部，想看 '),
                  h(Num, null, o.media.planned),
                  h('span', null, ' 部。'),
                  o.media.completedThisMonth > 0
                    ? h('span', null, '本月看完 ', h(Num, null, o.media.completedThisMonth), ' 部。')
                    : null,
                ),
            // ── quiet lines: only what is actually there ──
            moneyBits
              ? h(
                  'p',
                  { style: S.quiet },
                  '订阅月均 ',
                  h('span', { style: { color: C.text } }, moneyBits),
                  ' ／ 月',
                  o.subscriptions.unestimated > 0 ? `（另有 ${o.subscriptions.unestimated} 条未计入）` : '',
                )
              : null,
            o.software.inUse > 0 ? h('p', { style: S.quiet }, `在用软件 ${o.software.inUse} 个。`) : null,
            (o.media.archived > 0 || data.journal?.lastAt) &&
              h(
                'p',
                { style: S.meta },
                [
                  o.media.archived > 0 ? `已归档 ${o.media.archived} 条` : null,
                  data.journal?.lastAt ? `库最后改动 ${timeText(data.journal.lastAt)}` : null,
                ]
                  .filter(Boolean)
                  .join('，') + '。',
              ),
            // ── todos ──
            hasTodos
              ? h(
                  'div',
                  { style: S.section },
                  h('div', { style: S.sectionLabel }, '要处理的'),
                  h(Group, {
                    label: '续费日已过',
                    count: t.overdue.length,
                    countColor: C.red,
                    items: t.overdue,
                    renderItem: (item, i) =>
                      h(Row, {
                        key: i,
                        main: item.name,
                        side: dayText(item.nextRenewAt),
                        title: `登记的续费日 ${dayText(item.nextRenewAt)} 已过——这次续了吗？`,
                      }),
                    note: '登记日已过不代表已扣款；要记一笔就在对话里说。',
                  }),
                  h(Group, {
                    label: '7 天内要续费',
                    items: t.next7,
                    renderItem: (item, i) => h(Row, { key: i, main: item.name, side: dayText(item.nextRenewAt) }),
                  }),
                  t.next30Count > 0 &&
                    h('p', { style: { ...S.hint, margin: 0 } }, `另有 ${t.next30Count} 条在 30 天内要续费。`),
                  h(Group, {
                    label: '搁置久了',
                    items: t.pausedStalled,
                    renderItem: (item, i) =>
                      h(Row, {
                        key: i,
                        main: item.title,
                        side: `${item.stalledDays} 天`,
                        title: `搁置 ${item.stalledDays} 天了——捡回来还是弃了？`,
                      }),
                    note: '捡回来还是弃了？在对话里说一声就好。',
                  }),
                  h(Group, {
                    label: '在看中',
                    count: t.inProgressTotal,
                    items: t.inProgressRecent,
                    renderItem: (m, i) => h(PosterRow, { key: i, title: m.title, side: m.year ? String(m.year) : null }),
                    note:
                      t.inProgressTotal > t.inProgressRecent.length
                        ? `其余 ${t.inProgressTotal - t.inProgressRecent.length} 部从略。`
                        : null,
                  }),
                )
              : h(
                  'div',
                  { style: S.section },
                  h('div', { style: S.sectionLabel }, '要处理的'),
                  h('div', { style: S.empty }, '暂时没有。想记一部片，或记一笔续费，说一句话就好。'),
                ),
            h(
              'div',
              { style: S.footnote },
              '“本月看完”按完成日期口径。数据只来自你亲手记下的内容。',
            ),
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
