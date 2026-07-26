import { buildCorpus, resolveSeed, type Corpus, type Work } from './api.ts'
import { computeMetrics, type Metrics } from './metrics.ts'
import { createRenderer, THREAD, type GraphNode, type ViewMode } from './render.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const seedInput = $<HTMLInputElement>('seed-input')
const addSeedBtn = $<HTMLButtonElement>('add-seed')
const chipsEl = $<HTMLUListElement>('seed-chips')
const weaveBtn = $<HTMLButtonElement>('weave')
const statusEl = $('status')
const rankedEl = $<HTMLOListElement>('ranked')
const panelEl = $('panel')
const panelBody = $('panel-body')

// ink ramp on white — older papers fade, newer ones darken; seeds carry the thread
const INK_RAMP = ['#a8a494', '#948f80', '#7f7b6e', '#69665b', '#53504a', '#3b3934', '#1c1b18']

const HINTS: Record<ViewMode | 'gallery', string> = {
  constellation: 'drag to pan · scroll to zoom · touch a paper to find its thread',
  circle: 'rings — steps outward from your seeds · touch a paper to find its thread',
  sphere: 'drag to rotate · touch a paper to find its thread',
  gallery: 'figure 1 from each paper — arXiv, Nature family, and PLOS',
}

const STORE = 'ariadne:weave:v5' // bump when the cached Work shape changes

let seeds: Work[] = []
let wovenKey = '' // seed set of the last successful weave — identical set = nothing to refetch
const seedKey = () => seeds.map((s) => s.id).sort().join('|')
let corpus: Corpus | null = null
let metrics: Metrics[] = []
let order: number[] = []
let seedLinks: number[] = []
let byId = new Map<string, number>()
let yearSpan: [number, number] = [0, 0]

const renderer = createRenderer($<HTMLCanvasElement>('canvas'), {
  onHover(id) {
    for (const li of rankedEl.children) li.classList.toggle('hover', (li as HTMLElement).dataset.id === id)
    const li = id ? rankedEl.querySelector<HTMLElement>(`li[data-id="${id}"]`) : null
    li?.scrollIntoView({ block: 'nearest' })
  },
  onSelect(id) {
    if (id === null) {
      panelEl.classList.remove('open')
      for (const li of rankedEl.children) li.classList.remove('active')
    } else {
      openDetails(byId.get(id)!)
    }
  },
})

$('back').onclick = () => {
  panelEl.classList.remove('open')
  renderer.select(null)
  for (const li of rankedEl.children) li.classList.remove('active')
}

document.querySelectorAll<HTMLButtonElement>('#modes button').forEach((b) => {
  b.onclick = () => {
    const m = b.dataset.m as ViewMode | 'gallery'
    document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b))
    $('hint').textContent = HINTS[m]
    $('gallery').hidden = m !== 'gallery'
    // build the wall on first open: lazy images never load while the container is hidden
    if (m === 'gallery' && galleryStale) {
      galleryStale = false
      renderGallery()
      applyFilter()
    }
    if (m !== 'gallery') renderer.setMode(m)
  }
})

function status(msg: string, isError = false) {
  statusEl.textContent = msg
  statusEl.classList.toggle('error', isError)
}

// --- seeds ---

function renderChips() {
  chipsEl.replaceChildren(
    ...seeds.map((s, i) => {
      const li = document.createElement('li')
      const t = document.createElement('span')
      t.className = 't'
      t.textContent = s.title
      t.title = s.title
      const y = document.createElement('span')
      y.className = 'y'
      y.textContent = String(s.year)
      const x = document.createElement('button')
      x.textContent = '×'
      x.onclick = () => {
        seeds.splice(i, 1)
        renderChips()
      }
      li.append(t, y, x)
      return li
    }),
  )
  weaveBtn.disabled = seeds.length === 0 || seedKey() === wovenKey
  if (seeds.length === 0) localStorage.removeItem(STORE)
}

async function addSeed() {
  const q = seedInput.value.trim()
  if (!q) return
  addSeedBtn.disabled = true
  status('Resolving paper…')
  try {
    const w = await resolveSeed(q)
    if (!seeds.some((s) => s.id === w.id)) seeds.push(w)
    seedInput.value = ''
    status('')
    renderChips()
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true)
  } finally {
    addSeedBtn.disabled = false
    seedInput.focus()
  }
}

addSeedBtn.onclick = addSeed
seedInput.onkeydown = (e) => {
  if (e.key === 'Enter') addSeed()
}

$<HTMLButtonElement>('demo').onclick = async (e) => {
  const btn = e.target as HTMLButtonElement
  btn.disabled = true
  status('Resolving demo seeds…')
  try {
    for (const q of ['10.1038/nature14539', '10.1145/3065386']) {
      const w = await resolveSeed(q)
      if (!seeds.some((s) => s.id === w.id)) seeds.push(w)
    }
    renderChips()
    weaveBtn.click()
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true)
    btn.disabled = false
  }
}

// --- weave ---

function present() {
  if (!corpus) return
  metrics = computeMetrics(corpus.works, corpus.edges)
  byId = new Map(corpus.works.map((w, i) => [w.id, i]))
  const seedIdx = new Set(corpus.works.flatMap((w, i) => (w.isSeed ? [i] : [])))
  const counted = corpus.works.map(() => new Set<number>())
  for (const [s, t] of corpus.edges) {
    if (seedIdx.has(t)) counted[s].add(t)
    if (seedIdx.has(s)) counted[t].add(s)
  }
  seedLinks = counted.map((c) => c.size)
  order = corpus.works.map((_, i) => i).sort((a, b) => metrics[b].score - metrics[a].score)
  renderList()
  renderGraph()
  $('gallery').replaceChildren()
  galleryStale = true
  renderYears()
  renderFacts()
  $('tabs').hidden = false
  setTab('papers')
  lens = null
  applyBrush(null)
  $('counts').innerHTML = `<b>${corpus.works.length}</b> papers &nbsp;·&nbsp; <b>${corpus.edges.length}</b> citations`
  $('stage').classList.add('woven')
  document.querySelector<HTMLButtonElement>('#modes [data-m="constellation"]')!.click()
}

// --- year histogram + brush ---

const yearsEl = $('years')

function renderYears() {
  if (!corpus) return
  const counts = new Map<number, number>()
  for (const w of corpus.works) if (w.year) counts.set(w.year, (counts.get(w.year) ?? 0) + 1)
  const max = Math.max(...counts.values())
  const bars = []
  for (let y = yearSpan[0]; y <= yearSpan[1]; y++) {
    const n = counts.get(y) ?? 0
    const bar = document.createElement('div')
    bar.dataset.y = String(y)
    bar.style.height = `${2 + Math.round(26 * (n / max))}px`
    bar.style.background = yearColor(y, yearSpan[0], yearSpan[1])
    bar.title = `${y} — ${n} paper${n === 1 ? '' : 's'}`
    bars.push(bar)
  }
  yearsEl.replaceChildren(...bars)

  const ticksEl = $('year-ticks')
  ticksEl.replaceChildren()
  const bins = yearSpan[1] - yearSpan[0] + 1
  ticksEl.style.width = `${bins * 5 - 1}px`
  for (let y = Math.ceil(yearSpan[0] / 10) * 10; y <= yearSpan[1]; y += 10) {
    const t = document.createElement('span')
    t.textContent = String(y)
    t.style.left = `${((y - yearSpan[0] + 0.5) / bins) * 100}%`
    ticksEl.append(t)
  }
}

const readoutEl = $('brush-readout')

function updateReadout(hoverYear?: number) {
  if (!corpus) return
  const pill = (range: string, n: number, clearable: boolean) => {
    const b = document.createElement('b')
    b.textContent = range
    readoutEl.replaceChildren(b, document.createTextNode(`${n} paper${n === 1 ? '' : 's'}`))
    if (clearable) {
      const x = document.createElement('span')
      x.className = 'x'
      x.textContent = '×'
      x.onclick = () => applyBrush(null)
      readoutEl.append(x)
    }
    readoutEl.hidden = false
  }
  if (hoverYear !== undefined) {
    pill(String(hoverYear), corpus.works.filter((w) => w.year === hoverYear).length, false)
  } else if (brushRange) {
    const [a, b] = brushRange
    pill(a === b ? String(a) : `${a}–${b}`, corpus.works.filter((w) => w.year >= a && w.year <= b).length, true)
  } else {
    readoutEl.hidden = true
  }
}

// brush and lens compose: a paper must pass both to stay lit
let lens: { kind: 'venue' | 'author'; name: string } | null = null

function matches(w: Work): boolean {
  if (brushRange && (w.year < brushRange[0] || w.year > brushRange[1])) return false
  if (lens) return lens.kind === 'venue' ? w.venue === lens.name : w.authors.includes(lens.name)
  return true
}

function applyFilter() {
  if (!corpus) return
  const vis = !brushRange && !lens ? null : new Set(corpus.works.filter(matches).map((w) => w.id))
  renderer.setFilter(vis)
  for (const bar of yearsEl.children) {
    const y = +(bar as HTMLElement).dataset.y!
    ;(bar as HTMLElement).style.opacity =
      brushRange && (y < brushRange[0] || y > brushRange[1]) ? '0.25' : '1'
  }
  for (const li of rankedEl.children) {
    const el = li as HTMLElement
    el.classList.toggle('ghost', vis !== null && !vis.has(el.dataset.id!))
  }
  for (const card of document.querySelectorAll<HTMLElement>('#gallery .card'))
    card.classList.toggle('ghost', vis !== null && !vis.has(card.dataset.id!))
  for (const row of document.querySelectorAll<HTMLElement>('#lenses .row'))
    row.classList.toggle('lit', lens !== null && row.dataset.kind === lens.kind && row.dataset.name === lens.name)
  updateReadout()
}

function applyBrush(range: [number, number] | null) {
  brushRange = range
  applyFilter()
}

let brushFrom: number | null = null
let brushRange: [number, number] | null = null
const yearAt = (clientX: number) => {
  const r = yearsEl.getBoundingClientRect()
  const t = Math.min(0.999, Math.max(0, (clientX - r.left) / r.width))
  return yearSpan[0] + Math.floor(t * (yearSpan[1] - yearSpan[0] + 1))
}
yearsEl.onpointerdown = (e) => {
  yearsEl.setPointerCapture(e.pointerId)
  brushFrom = yearAt(e.clientX)
  brushRange = [brushFrom, brushFrom]
  applyBrush(brushRange)
}
yearsEl.onpointermove = (e) => {
  if (brushFrom === null) {
    updateReadout(yearAt(e.clientX))
    return
  }
  const y = yearAt(e.clientX)
  brushRange = [Math.min(brushFrom, y), Math.max(brushFrom, y)]
  applyBrush(brushRange)
}
yearsEl.onpointerleave = () => updateReadout()
yearsEl.onpointerup = () => {
  if (brushRange && brushRange[0] === brushRange[1]) applyBrush((brushRange = null)) // plain click clears
  brushFrom = null
}

// --- corpus facts ---

function renderFacts() {
  if (!corpus) return
  const works = corpus.works
  const factsEl = $('facts')
  const b = document.createElement('b')
  b.textContent = 'span — '
  const recent = Math.round((works.filter((w) => w.year >= new Date().getFullYear() - 2).length / works.length) * 100)
  factsEl.replaceChildren(b, document.createTextNode(`${yearSpan[0]}–${yearSpan[1]} · ${recent}% from the last 3 years`))
  factsEl.hidden = false
}

// --- sidebar tabs: papers | venues | authors ---

const lensesEl = $('lenses')
let tab: 'papers' | 'venues' | 'authors' = 'papers'

function renderLenses() {
  if (!corpus || tab === 'papers') return
  const kind = tab === 'venues' ? ('venue' as const) : ('author' as const)
  const counts = new Map<string, number>()
  for (const w of corpus.works)
    for (const x of kind === 'venue' ? (w.venue ? [w.venue] : []) : w.authors)
      counts.set(x, (counts.get(x) ?? 0) + 1)
  const entries = [...counts].sort((a, b) => b[1] - a[1])
  const max = entries[0]?.[1] ?? 1
  lensesEl.replaceChildren(
    ...entries.map(([name, n]) => {
      const row = document.createElement('div')
      row.className = 'row'
      row.dataset.kind = kind
      row.dataset.name = name
      const nm = document.createElement('span')
      nm.className = 'n'
      nm.textContent = name
      nm.title = name
      const track = document.createElement('span')
      track.className = 'track'
      const fill = document.createElement('i')
      fill.style.width = `${Math.round((n / max) * 100)}%`
      track.append(fill)
      const em = document.createElement('em')
      em.textContent = String(n)
      row.append(nm, track, em)
      row.onclick = () => {
        lens = lens?.kind === kind && lens.name === name ? null : { kind, name }
        applyFilter()
      }
      return row
    }),
  )
  applyFilter()
}

function setTab(t: typeof tab) {
  tab = t
  document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t))
  rankedEl.hidden = t !== 'papers'
  lensesEl.hidden = t === 'papers'
  renderLenses()
}
document.querySelectorAll<HTMLElement>('#tabs button').forEach((b) => {
  b.onclick = () => setTab(b.dataset.t as typeof tab)
})

weaveBtn.onclick = async () => {
  weaveBtn.disabled = true
  panelEl.classList.remove('open')
  try {
    corpus = await buildCorpus(seeds, status)
    wovenKey = seedKey()
    try {
      localStorage.setItem(STORE, JSON.stringify({ seeds, corpus }))
    } catch {} // over quota — reweave on next visit instead
    present()
    status('')
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true)
  } finally {
    renderChips()
  }
}

// --- graph ---

function yearColor(year: number, min: number, max: number): string {
  const t = max > min ? (year - min) / (max - min) : 0.5
  return INK_RAMP[Math.min(INK_RAMP.length - 1, Math.floor(t * INK_RAMP.length))]
}

function renderGraph() {
  if (!corpus) return
  const works = corpus.works
  const years = works.map((w) => w.year).filter(Boolean)
  const minY = Math.min(...years)
  const maxY = Math.max(...years)
  yearSpan = [minY, maxY]
  $('year-min').textContent = String(minY)
  $('year-max').textContent = String(maxY)
  const labeled = new Set(order.slice(0, 14))
  const nodes: GraphNode[] = works.map((w, i) => ({
    id: w.id,
    r: 3.5 + metrics[i].score * 14,
    color: w.isSeed ? THREAD : yearColor(w.year, minY, maxY),
    label: w.title.length > 34 ? w.title.slice(0, 32) + '…' : w.title,
    isSeed: w.isSeed,
    labeled: labeled.has(i) || w.isSeed,
    year: w.year,
  }))
  renderer.setData(nodes, corpus.edges.map(([s, t]) => [works[s].id, works[t].id]))
}

// --- ranked list ---

function renderList() {
  if (!corpus) return
  const works = corpus.works
  rankedEl.replaceChildren(
    ...order.map((i, rank) => {
      const w = works[i]
      const li = document.createElement('li')
      li.dataset.id = w.id
      li.tabIndex = 0
      const rankEl = document.createElement('span')
      rankEl.className = 'rank'
      rankEl.textContent = String(rank + 1)
      const body = document.createElement('div')
      body.className = 'body'
      const title = document.createElement('div')
      title.className = 'title'
      title.textContent = w.title
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.textContent = `${w.authors[0] ?? 'Unknown'}${w.authors.length > 1 ? ' et al.' : ''}, ${w.year}`
      if (w.isSeed) {
        const mark = document.createElement('span')
        mark.className = 'seed-mark'
        mark.textContent = ' — seed'
        meta.append(mark)
      }
      body.append(title, meta)
      if (w.venue) {
        const venue = document.createElement('div')
        venue.className = 'venue'
        venue.textContent = w.venue
        venue.title = w.venue
        body.append(venue)
      }
      const sc = document.createElement('span')
      sc.className = 'sc'
      sc.textContent = metrics[i].score.toFixed(2)
      li.append(rankEl, body, sc)
      li.onmouseenter = () => renderer.highlight(w.id)
      li.onmouseleave = () => renderer.highlight(null)
      li.onclick = () => {
        renderer.focus(w.id)
        openDetails(i)
      }
      li.onkeydown = (e) => {
        if (e.key === 'Enter') {
          renderer.focus(w.id)
          openDetails(i)
        }
      }
      return li
    }),
  )
}

// --- gallery: figure 1 from open-access hosts, derived from the paper's own ids ---

// PMC and NCBI both hotlink-block their images, so publisher CDNs are the only
// browser-loadable sources. Each is a pure URL derivation — no API calls.
const PLOS_JOURNALS: Record<string, string> = {
  pone: 'plosone',
  pbio: 'plosbiology',
  pmed: 'plosmedicine',
  pcbi: 'ploscompbiol',
  pgen: 'plosgenetics',
  ppat: 'plospathogens',
  pntd: 'plosntds',
}

// candidates are tried in order until one loads
function figureUrls(w: Work): string[] {
  if (w.arxivId) return [`https://ar5iv.labs.arxiv.org/html/${w.arxivId}/assets/x1.png`]
  const doi = w.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//, '') ?? ''
  // Springer Nature (Nature family, BMC, …): 10.1038/s41586-021-03819-2 -> 41586_2021_3819_Fig1
  // Nature serves .png, Nature Communications .jpg, so try both
  const s = doi.match(/^10\.\d+\/s(\d+)-(\d+)-(\d+)-/i)
  if (s) {
    const base = `https://media.springernature.com/lw685/springer-static/image/art%3A${encodeURIComponent(doi)}/MediaObjects/${s[1]}_${2000 + Number(s[2])}_${Number(s[3])}_Fig1_HTML`
    return [`${base}.png`, `${base}.jpg`]
  }
  const p = doi.match(/^10\.1371\/journal\.(\w+)\./i)
  if (p && PLOS_JOURNALS[p[1]])
    return [`https://journals.plos.org/${PLOS_JOURNALS[p[1]]}/article/figure/image?size=medium&id=${doi}.g001`]
  return []
}

let galleryStale = true

function renderGallery() {
  if (!corpus) return
  const rankOf = new Map(order.map((idx, r) => [idx, r + 1]))
  // influence order; CSS reflows figureless cards to the end as they resolve
  $('gallery').replaceChildren(
    ...order.map((i) => {
      const w = corpus!.works[i]
      const card = document.createElement('div')
      card.className = 'card'
      card.dataset.id = w.id
      const fig = document.createElement('div')
      fig.className = 'fig'
      const nofig = () => {
        card.classList.remove('pending')
        card.classList.add('nofig')
        fig.replaceChildren(document.createTextNode('no figure'))
      }
      const srcs = figureUrls(w)
      if (srcs.length) {
        card.classList.add('pending')
        const img = document.createElement('img')
        img.alt = ''
        img.loading = 'lazy'
        let next = 0
        const tryNext = () => (next < srcs.length ? (img.src = srcs[next++]) : nofig())
        img.onerror = tryNext
        img.onload = () => {
          // ar5iv answers 200 with a 325x400 "no image available" placeholder
          if (img.naturalWidth === 325 && img.naturalHeight === 400) nofig()
          else card.classList.remove('pending')
        }
        tryNext()
        fig.append(img)
      } else {
        card.classList.add('nofig')
        fig.append(document.createTextNode('no figure'))
      }
      const t = document.createElement('div')
      t.className = 't'
      t.textContent = w.title
      const m = document.createElement('div')
      m.className = 'm'
      m.textContent = `${rankOf.get(i)} · ${w.authors[0] ?? 'Unknown'}${w.authors.length > 1 ? ' et al.' : ''}, ${w.year}`
      if (w.isSeed) {
        const s = document.createElement('span')
        s.className = 'seed'
        s.textContent = ' — seed'
        m.append(s)
      }
      card.append(fig, t, m)
      if (w.venue) {
        const v = document.createElement('div')
        v.className = 'v'
        v.textContent = w.venue
        v.title = w.venue
        card.append(v)
      }
      card.onclick = () => openDetails(i)
      return card
    }),
  )
}

// --- details panel ---

function why(w: Work, m: Metrics, links: number): string {
  if (w.isSeed) return 'One of your seed papers — the thread starts here.'
  const bits: string[] = []
  if (links >= 2) bits.push(`directly linked to ${links} of your seeds`)
  if (m.parts.foundational > 0.5) bits.push('structurally foundational in this neighborhood')
  if (m.parts.bridge > 0.5) bits.push('bridges otherwise-separate clusters')
  if (m.parts.momentum > 0.6) bits.push(`gaining citations fast (${w.recentCites.toLocaleString()} in the last 3 years)`)
  if (!bits.length) bits.push(`part of the seed neighborhood, cited ${w.citedBy.toLocaleString()} times overall`)
  const s = bits.join('; ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

function openDetails(i: number) {
  if (!corpus) return
  const w = corpus.works[i]
  const m = metrics[i]
  for (const li of rankedEl.children) li.classList.toggle('active', (li as HTMLElement).dataset.id === w.id)
  rankedEl.querySelector<HTMLElement>(`li[data-id="${w.id}"]`)?.scrollIntoView({ block: 'nearest' })
  renderer.select(w.id)

  panelBody.replaceChildren()
  const h2 = document.createElement('h2')
  h2.textContent = w.title
  const byline = document.createElement('div')
  byline.className = 'byline'
  byline.textContent = w.authors.slice(0, 6).join(', ') + (w.authors.length > 6 ? ' et al.' : '')
  const date = document.createElement('div')
  date.className = 'date'
  date.textContent = `${w.venue ? w.venue + ' · ' : ''}${w.year} · cited ${w.citedBy.toLocaleString()} times`
  panelBody.append(h2, byline, date)
  if (w.abstract) {
    const d = document.createElement('p')
    d.className = 'desc'
    d.textContent = w.abstract
    panelBody.append(d)
  }
  const whyEl = document.createElement('p')
  whyEl.className = 'why'
  const b = document.createElement('b')
  b.textContent = 'why it matters'
  whyEl.append(b, document.createTextNode(' — ' + why(w, m, seedLinks[i])))
  panelBody.append(whyEl)
  for (const [name, v] of Object.entries(m.parts)) {
    const row = document.createElement('div')
    row.className = 'meter'
    const label = document.createElement('span')
    label.textContent = name
    const track = document.createElement('div')
    track.className = 'track'
    const fill = document.createElement('i')
    fill.style.width = `${Math.round(v * 100)}%`
    track.append(fill)
    const val = document.createElement('em')
    val.textContent = v.toFixed(2)
    row.append(label, track, val)
    panelBody.append(row)
  }
  const pills = document.createElement('div')
  pills.className = 'pills'
  const open = document.createElement('a')
  open.className = 'pill'
  open.href = w.doi ?? `https://openalex.org/${w.id}`
  open.target = '_blank'
  open.textContent = 'open paper ↗'
  pills.append(open)
  if (!seeds.some((s) => s.id === w.id)) {
    const grow = document.createElement('button')
    grow.className = 'pill'
    grow.textContent = 'add as seed + reweave'
    grow.onclick = () => {
      seeds.push({ ...w, isSeed: false })
      renderChips()
      weaveBtn.click()
    }
    pills.append(grow)
  }
  panelBody.append(pills)
  panelEl.classList.add('open')
}

// --- export ---

function download(name: string, text: string, type: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

$('export-md').onclick = () => {
  if (!corpus) return
  const lines = [
    '# Ariadne corpus',
    '',
    `Seeds: ${seeds.map((s) => s.title).join(' · ')}`,
    `Papers: ${corpus.works.length} · ranked by composite influence (foundational 35%, bridge 25%, momentum 20%, relevance 20%)`,
    '',
  ]
  order.forEach((i, rank) => {
    const w = corpus!.works[i]
    const m = metrics[i]
    lines.push(`## ${rank + 1}. ${w.title} (${w.year})${w.isSeed ? ' — SEED' : ''}`)
    lines.push(`- Authors: ${w.authors.slice(0, 8).join(', ')}${w.authors.length > 8 ? ' et al.' : ''}`)
    if (w.venue) lines.push(`- Published in: ${w.venue}`)
    if (w.doi) lines.push(`- DOI: ${w.doi}`)
    lines.push(`- Score: ${m.score.toFixed(2)} (foundational ${m.parts.foundational.toFixed(2)}, bridge ${m.parts.bridge.toFixed(2)}, momentum ${m.parts.momentum.toFixed(2)}, relevance ${m.parts.relevance.toFixed(2)})`)
    lines.push(`- Why it matters: ${why(w, m, seedLinks[i])}`)
    if (w.abstract) lines.push(`\n> ${w.abstract}`)
    lines.push('')
  })
  download('ariadne-corpus.md', lines.join('\n'), 'text/markdown')
}

$('export-json').onclick = () => {
  if (!corpus) return
  const data = order.map((i, rank) => {
    const w = corpus!.works[i]
    return {
      rank: rank + 1,
      ...w,
      score: metrics[i].score,
      parts: metrics[i].parts,
      why: why(w, metrics[i], seedLinks[i]),
    }
  })
  download('ariadne-corpus.json', JSON.stringify(data, null, 2), 'application/json')
}

// --- remember the weave ---
try {
  const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null')
  if (saved?.corpus) {
    seeds = saved.seeds
    corpus = saved.corpus
    wovenKey = seedKey()
    renderChips()
    present()
  }
} catch {} // corrupt store — start fresh
