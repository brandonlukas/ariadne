import { buildCorpus, idLike, resolveSeed, searchSeeds, stripDoi, type Corpus, type Work } from './api.ts'
import { getKey, getLastModel, getModel, inferIntent, MODELS, setKey, setModel, whyForIntent } from './llm.ts'
import { computeMetrics, PRESETS, type Metrics } from './metrics.ts'
import { createRenderer, THREAD, type GraphNode, type ViewMode } from './render.ts'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

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

function saveStore() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ seeds, corpus, flags, intent, aiWhy }))
  } catch {} // over quota — reweave on next visit instead
}

let seeds: Work[] = []
let rank: keyof typeof PRESETS | 'newest' = 'canon'
let preset: keyof typeof PRESETS = 'canon' // last weight-bearing choice; newest reuses it
let bridgesOnly = false
let needle = ''
let flags: Record<string, 'star' | 'hide'> = {}
let intent = '' // the LLM's one-line reading of what the seed set is asking
let aiWhy: Record<string, string> = {}
let panelId = ''
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
    $('stage').classList.toggle('gallery', m === 'gallery')
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

// --- ai: bring-your-own free key ---

const aiKeyEl = $<HTMLInputElement>('ai-key')
const aiModelEl = $<HTMLInputElement>('ai-model')
const aiFields = $('ai-fields')
const aiToggle = $<HTMLButtonElement>('ai-toggle')
$('ai-models').append(...MODELS.map((m) => Object.assign(el('option'), { value: m })))
const aiLabel = () => {
  const on = !!getKey()
  const model = getLastModel().split('/').pop()?.replace(':free', '')
  aiToggle.replaceChildren(
    el('span', 'dot'),
    document.createTextNode(on ? (model ? `ai · ${model}` : 'ai on') : 'ai off'),
  )
  aiToggle.classList.toggle('on', on)
}
aiToggle.onclick = () => {
  aiFields.hidden = !aiFields.hidden
  if (!aiFields.hidden) {
    aiKeyEl.value = getKey()
    aiModelEl.value = getModel()
    aiKeyEl.focus()
  }
}
aiKeyEl.onchange = () => {
  setKey(aiKeyEl.value.trim())
  aiFields.hidden = true
  aiLabel()
  maybeInferIntent()
}
aiModelEl.onchange = () => setModel(aiModelEl.value.trim())
$('ai-off').onclick = () => {
  setKey('')
  setModel('')
  intent = ''
  aiWhy = {} // forgetting the key also forgets what it generated
  saveStore()
  renderIntent()
  aiFields.hidden = true
  aiLabel()
}
aiLabel()

function renderIntent() {
  const line = $('intent-line')
  line.hidden = !intent
  line.textContent = intent ? `✦ ${intent}` : ''
}

async function maybeInferIntent() {
  if (!corpus || !getKey() || intent) return
  const line = $('intent-line')
  line.hidden = false
  line.textContent = '✦ reading the seeds…'
  try {
    intent = await inferIntent(corpus.works.filter((w) => w.isSeed))
    saveStore()
    renderIntent()
    aiLabel() // now we know which model answered
  } catch (err) {
    line.textContent = `✦ ${err instanceof Error ? err.message : String(err)}`
  }
}

// --- seeds ---

function renderChips() {
  chipsEl.replaceChildren(
    ...seeds.map((s, i) => {
      const li = el('li')
      const t = el('span', 't', s.title)
      t.title = s.title
      const y = el('span', 'y', String(s.year))
      const x = el('button', '', '×')
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

const pickerEl = $<HTMLUListElement>('picker')

function pushSeed(w: Work) {
  if (!seeds.some((s) => s.id === w.id)) seeds.push(w)
  seedInput.value = ''
  status('')
  renderChips()
}

async function addSeed() {
  const q = seedInput.value.trim()
  if (!q) return
  addSeedBtn.disabled = true
  pickerEl.replaceChildren()
  status('Resolving paper…')
  try {
    if (idLike(q)) {
      pushSeed(await resolveSeed(q))
    } else {
      const results = await searchSeeds(q, 3)
      if (!results.length) throw new Error(`No paper found for “${q}”`)
      if (results.length === 1) pushSeed(results[0])
      else {
        // fuzzy match — let the user confirm which paper they meant
        status('Which one?')
        pickerEl.replaceChildren(
          ...results.map((w) => {
            const li = el('li')
            const t = el('span', 't', w.title)
            t.title = w.title
            li.append(t, el('span', 'y', `${w.authors[0]?.split(' ').pop() ?? '?'} ${w.year}`))
            li.onclick = () => {
              pickerEl.replaceChildren()
              pushSeed(w)
            }
            return li
          }),
        )
      }
    }
  } catch (err) {
    status(err instanceof Error ? err.message : String(err), true)
  } finally {
    addSeedBtn.disabled = false
    seedInput.focus()
  }
}
seedInput.oninput = () => pickerEl.replaceChildren()

$<HTMLFormElement>('seed-form').onsubmit = (e) => {
  e.preventDefault()
  addSeed()
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
  metrics = computeMetrics(corpus.works, corpus.edges, PRESETS[preset])
  byId = new Map(corpus.works.map((w, i) => [w.id, i]))
  seedLinks = metrics.map((m) => m.seedLinks)
  computeOrder()
  $<HTMLInputElement>('find').value = ''
  needle = ''
  renderList()
  renderGraph()
  $('gallery').replaceChildren()
  galleryStale = true
  renderYears()
  renderFacts()
  renderIntent()
  $('tabs').hidden = false
  $('list-tools').hidden = false
  $('preset').hidden = false
  $('bridges').hidden = corpus.works.filter((w) => w.isSeed).length < 2
  bridgesOnly = false
  $('bridges').classList.remove('on')
  setTab('papers')
  lens = null
  applyBrush(null)
  $('counts').innerHTML = `<b>${corpus.works.length}</b> papers &nbsp;·&nbsp; <b>${corpus.edges.length}</b> citations`
  $('stage').classList.add('woven')
  document.querySelector<HTMLButtonElement>('#modes [data-m="constellation"]')!.click()
}

// --- list order + refresh ---

function computeOrder() {
  if (!corpus) return
  const key =
    rank === 'newest' ? (i: number) => corpus!.works[i].year : (i: number) => metrics[i].score
  order = corpus.works.map((_, i) => i).sort((a, b) => key(b) - key(a))
}

// rebuild everything that depends on `order` or per-paper flags
function refreshViews() {
  renderList()
  galleryStale = true
  const gallery = $('gallery')
  if (!gallery.hidden) {
    galleryStale = false
    renderGallery()
  }
  applyFilter()
}

$<HTMLInputElement>('find').oninput = (e) => {
  needle = (e.target as HTMLInputElement).value.trim().toLowerCase()
  applyFilter()
}

document.querySelectorAll<HTMLButtonElement>('#preset button[data-p]').forEach((b) => {
  b.onclick = () => {
    rank = b.dataset.p as typeof rank
    document.querySelectorAll('#preset button[data-p]').forEach((x) => x.classList.toggle('on', x === b))
    if (!corpus) return
    if (rank !== 'newest' && rank !== preset) {
      preset = rank
      metrics = computeMetrics(corpus.works, corpus.edges, PRESETS[preset])
      seedLinks = metrics.map((m) => m.seedLinks)
      computeOrder()
      const labeled = new Set(order.slice(0, 14))
      renderer.restyle(
        new Map(
          corpus.works.map((w, i) => [
            w.id,
            { r: 3.5 + metrics[i].score * 14, labeled: labeled.has(i) || w.isSeed },
          ]),
        ),
      )
    } else {
      computeOrder()
    }
    refreshViews()
  }
})

$<HTMLButtonElement>('bridges').onclick = (e) => {
  bridgesOnly = !bridgesOnly
  ;(e.target as HTMLElement).classList.toggle('on', bridgesOnly)
  applyFilter()
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
    const bar = el('div')
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
    const t = el('span', '', String(y))
    t.style.left = `${((y - yearSpan[0] + 0.5) / bins) * 100}%`
    ticksEl.append(t)
  }
}

const readoutEl = $('brush-readout')

function updateReadout(hoverYear?: number) {
  if (!corpus) return
  const pill = (range: string, n: number, clearable: boolean) => {
    readoutEl.replaceChildren(el('b', '', range), document.createTextNode(`${n} paper${n === 1 ? '' : 's'}`))
    if (clearable) {
      const x = el('span', 'x', '×')
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

// brush, lens, text, and hide-flags compose: a paper must pass all to stay lit
let lens: { kind: 'venue' | 'author'; name: string } | null = null

function matches(w: Work): boolean {
  if (flags[w.id] === 'hide') return false
  if (bridgesOnly && !w.isSeed && (seedLinks[byId.get(w.id)!] ?? 0) < 2) return false
  if (brushRange && (w.year < brushRange[0] || w.year > brushRange[1])) return false
  if (needle && !`${w.title} ${w.authors.join(' ')} ${w.venue ?? ''}`.toLowerCase().includes(needle)) return false
  if (lens) return lens.kind === 'venue' ? w.venue === lens.name : w.authors.includes(lens.name)
  return true
}

function applyFilter() {
  if (!corpus) return
  const filtering =
    !!(brushRange || lens || needle || bridgesOnly) || corpus.works.some((w) => flags[w.id] === 'hide')
  const vis = filtering ? new Set(corpus.works.filter(matches).map((w) => w.id)) : null
  renderer.setFilter(vis)
  for (const bar of yearsEl.children) {
    const y = +(bar as HTMLElement).dataset.y!
    ;(bar as HTMLElement).style.opacity =
      brushRange && (y < brushRange[0] || y > brushRange[1]) ? '0.25' : '1'
  }
  for (const li of rankedEl.children) {
    const row = li as HTMLElement
    const miss = vis !== null && !vis.has(row.dataset.id!)
    row.classList.toggle('ghost', miss)
    row.hidden = miss && !!needle // text filter hides; brush/lens only dim
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
  const recent = Math.round((works.filter((w) => w.year >= new Date().getFullYear() - 2).length / works.length) * 100)
  factsEl.replaceChildren(el('b', '', 'span — '), document.createTextNode(`${yearSpan[0]}–${yearSpan[1]} · ${recent}% from the last 3 years`))
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
      const row = el('div', 'row')
      row.dataset.kind = kind
      row.dataset.name = name
      const nm = el('span', 'n', name)
      nm.title = name
      const track = el('span', 'track')
      const fill = el('i')
      fill.style.width = `${Math.round((n / max) * 100)}%`
      track.append(fill)
      row.append(nm, track, el('em', '', String(n)))
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
    intent = '' // the question changed with the seeds; cached answers went stale too
    aiWhy = {}
    history.replaceState(null, '', '#s=' + seeds.map((s) => s.id).join(','))
    saveStore()
    present()
    status('')
    maybeInferIntent()
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
      const li = el('li')
      li.dataset.id = w.id
      li.tabIndex = 0
      const body = el('div', 'body')
      const meta = el('div', 'meta', `${w.authors[0] ?? 'Unknown'}${w.authors.length > 1 ? ' et al.' : ''}, ${w.year}`)
      if (w.isSeed) meta.append(el('span', 'seed-mark', ' — seed'))
      if (!w.isSeed && seedLinks[i] >= 2) meta.append(el('span', 'seed-mark', ` — bridges ${seedLinks[i]} seeds`))
      if (flags[w.id] === 'star') meta.append(el('span', 'seed-mark', ' ★'))
      body.append(el('div', 'title', w.title), meta)
      if (w.venue) {
        const venue = el('div', 'venue', w.venue)
        venue.title = w.venue
        body.append(venue)
      }
      li.append(el('span', 'rank', String(rank + 1)), body, el('span', 'sc', metrics[i].score.toFixed(2)))
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

// Some hosts only reveal a figure's path through their API (bioRxiv needs the
// posting date; eLife needs the asset's revision). Both are CORS-open.
const asyncFigures = new Map<string, Promise<string[]>>()

function lookupFigures(doi: string): Promise<string[]> {
  let p = asyncFigures.get(doi)
  if (p) return p
  if (isPreprint(doi)) {
    const server = doi.startsWith('10.1101/') ? 'biorxiv' : 'medrxiv'
    const suffix = doi.slice(doi.indexOf('/') + 1)
    p = fetch(`https://api.${server}.org/details/${server}/${doi}`)
      .then((r) => r.json())
      .then((j: any) =>
        // newest revision first — figures live under each version's posting date
        (j.collection ?? [])
          .map((c: any) => c.date?.replaceAll('-', '/'))
          .filter(Boolean)
          .reverse()
          .map((d: string) => `https://www.${server}.org/content/${server}/early/${d}/${suffix}/F1.large.jpg`),
      )
      .catch(() => [])
  } else {
    const id = doi.match(/^10\.7554\/elife\.(\d+)/i)![1]
    p = fetch(`https://api.elifesciences.org/articles/${id}`)
      .then((r) => r.text())
      .then((t) => {
        const uri = t.match(/https:\/\/iiif[^"]*?fig1-v\d+\.tif/)?.[0]
        return uri ? [`${uri}/full/617,/0/default.jpg`] : []
      })
      .catch(() => [])
  }
  asyncFigures.set(doi, p)
  return p
}

const strippedDoi = (w: Work) => (w.doi ? stripDoi(w.doi) : '')

// candidates are tried in order until one loads
function figureUrls(w: Work): string[] {
  if (w.arxivId) return [`https://ar5iv.labs.arxiv.org/html/${w.arxivId}/assets/x1.png`]
  const doi = strippedDoi(w)
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

// bioRxiv (10.1101/2021.10.04.463034) and medRxiv (10.1101/2020.05.06.20093542);
// the same prefix also carries Cold Spring Harbor journals, whose suffixes aren't dated
const isPreprint = (doi: string) => /^10\.1101\/\d{4}\.\d{2}\.\d{2}\./.test(doi)
// hosts whose figure path takes an extra API lookup
const needsLookup = (doi: string) => isPreprint(doi) || /^10\.7554\/elife\./i.test(doi)

let galleryStale = true

function renderGallery() {
  if (!corpus) return
  const rankOf = new Map(order.map((idx, r) => [idx, r + 1]))
  // influence order; CSS reflows figureless cards to the end as they resolve
  $('gallery').replaceChildren(
    ...order.map((i) => {
      const w = corpus!.works[i]
      const card = el('div', 'card')
      card.dataset.id = w.id
      const fig = el('div', 'fig')
      const nofig = () => {
        card.classList.remove('pending')
        card.classList.add('nofig')
        fig.replaceChildren(document.createTextNode('no figure'))
      }
      const srcs = figureUrls(w)
      if (!srcs.length && needsLookup(strippedDoi(w))) {
        card.classList.add('pending')
        lookupFigures(strippedDoi(w)).then((urls) => {
          if (!urls.length) return nofig()
          const img = el('img')
          img.alt = ''
          img.loading = 'lazy'
          let n = 0
          img.onerror = () => (n < urls.length ? (img.src = urls[n++]) : nofig())
          img.onload = () => card.classList.remove('pending')
          img.src = urls[n++]
          fig.replaceChildren(img)
        })
      } else if (srcs.length) {
        card.classList.add('pending')
        const img = el('img')
        img.alt = ''
        img.loading = 'lazy'
        // walk the candidates, then walk them once more — a burst of loads can
        // draw a transient failure from a publisher's CDN
        let next = 0
        let retried = false
        const tryNext = () => {
          if (next < srcs.length) img.src = `${srcs[next++]}${retried ? '#r' : ''}`
          else if (!retried) {
            retried = true
            next = 0
            setTimeout(tryNext, 1500)
          } else nofig()
        }
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
      const m = el('div', 'm', `${rankOf.get(i)} · ${w.authors[0] ?? 'Unknown'}${w.authors.length > 1 ? ' et al.' : ''}, ${w.year}`)
      if (w.isSeed) m.append(el('span', 'seed', ' — seed'))
      if (!w.isSeed && seedLinks[i] >= 2) m.append(el('span', 'seed', ` — bridges ${seedLinks[i]}`))
      if (flags[w.id] === 'star') m.append(el('span', 'seed', ' ★'))
      card.append(fig, el('div', 't', w.title), m)
      if (w.venue) {
        const v = el('div', 'v', w.venue)
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
  // components are rank-normalized, so these thresholds mean "top ~15%"
  if (m.parts.foundational > 0.85) bits.push('structurally foundational in this neighborhood')
  if (m.parts.bridge > 0.85) bits.push('bridges otherwise-separate clusters')
  if (m.parts.momentum > 0.75) bits.push(`gaining citations fast (${w.recentCites.toLocaleString()} in the last 3 years)`)
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

  panelBody.replaceChildren(
    el('h2', '', w.title),
    el('div', 'byline', w.authors.slice(0, 6).join(', ') + (w.authors.length > 6 ? ' et al.' : '')),
    el('div', 'date', `${w.venue ? w.venue + ' · ' : ''}${w.year} · cited ${w.citedBy.toLocaleString()} times`),
  )
  if (w.abstract) panelBody.append(el('p', 'desc', w.abstract))
  panelId = w.id
  const whyEl = el('p', 'why')
  const ai = aiWhy[w.id]
  whyEl.append(
    el('b', '', ai ? '✦ why it matters for your thread' : 'why it matters'),
    document.createTextNode(' — ' + (ai ?? why(w, m, seedLinks[i]))),
  )
  if (!ai && getKey() && intent) {
    whyEl.append(el('span', 'seed-mark', ' ✦…'))
    whyForIntent(intent, w, m, corpus.works.filter((x) => x.isSeed).map((x) => x.title))
      .then((t) => {
        aiWhy[w.id] = t
        saveStore()
        aiLabel()
        if (panelId === w.id) openDetails(i) // panel still on this paper — swap the text in
      })
      .catch(() => whyEl.querySelector('.seed-mark')?.remove())
  }
  panelBody.append(whyEl)
  for (const [name, v] of Object.entries(m.parts)) {
    const row = el('div', 'meter')
    const track = el('div', 'track')
    const fill = el('i')
    fill.style.width = `${Math.round(v * 100)}%`
    track.append(fill)
    row.append(el('span', '', name), track, el('em', '', v.toFixed(2)))
    panelBody.append(row)
  }
  const pills = el('div', 'pills')
  const open = el('a', 'pill', 'open paper ↗')
  open.href = w.doi ?? `https://openalex.org/${w.id}`
  open.target = '_blank'
  pills.append(open)
  const setFlag = (kind: 'star' | 'hide') => {
    if (flags[w.id] === kind) delete flags[w.id]
    else flags[w.id] = kind
    saveStore()
    refreshViews()
    openDetails(i) // rebuild the panel so the button labels update
  }
  const star = el('button', 'pill', flags[w.id] === 'star' ? '★ starred' : '☆ star')
  star.onclick = () => setFlag('star')
  const hide = el('button', 'pill', flags[w.id] === 'hide' ? 'unhide' : 'hide')
  hide.onclick = () => setFlag('hide')
  pills.append(star, hide)
  if (!seeds.some((s) => s.id === w.id)) {
    const grow = el('button', 'pill', 'add as seed + reweave')
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
  const a = el('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
}

$('copy-link').onclick = async (e) => {
  const b = e.target as HTMLButtonElement
  await navigator.clipboard.writeText(location.href)
  b.textContent = 'copied ✓'
  setTimeout(() => (b.textContent = 'copy link'), 1200)
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
  order.filter((i) => flags[corpus!.works[i].id] !== 'hide').forEach((i, rank) => {
    const w = corpus!.works[i]
    const m = metrics[i]
    lines.push(`## ${rank + 1}. ${w.title} (${w.year})${w.isSeed ? ' — SEED' : ''}${flags[w.id] === 'star' ? ' ★' : ''}`)
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

$('export-bib').onclick = () => {
  if (!corpus) return
  const used = new Set<string>()
  const entries = order
    .filter((i) => flags[corpus!.works[i].id] !== 'hide')
    .map((i) => {
      const w = corpus!.works[i]
      let key = `${(w.authors[0] ?? 'anon').split(' ').pop()}${w.year || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
      while (used.has(key)) key += 'x'
      used.add(key)
      const fields = [
        `  title = {${w.title.replace(/[{}]/g, '')}}`,
        w.authors.length ? `  author = {${w.authors.join(' and ')}}` : '',
        w.year ? `  year = {${w.year}}` : '',
        w.venue ? `  journal = {${w.venue}}` : '',
        w.doi ? `  doi = {${stripDoi(w.doi)}}` : '',
      ].filter(Boolean)
      return `@article{${key},\n${fields.join(',\n')}\n}`
    })
  download('ariadne-corpus.bib', entries.join('\n\n') + '\n', 'text/plain')
}

$('export-json').onclick = () => {
  if (!corpus) return
  const data = order
    .filter((i) => flags[corpus!.works[i].id] !== 'hide')
    .map((i, rank) => {
      const w = corpus!.works[i]
      return {
        rank: rank + 1,
        ...w,
        starred: flags[w.id] === 'star',
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
    flags = saved.flags ?? {}
    intent = saved.intent ?? ''
    aiWhy = saved.aiWhy ?? {}
    wovenKey = seedKey()
    renderChips()
    present()
    maybeInferIntent() // a key may be set while the last session's intent isn't
  }
} catch {} // corrupt store — start fresh

// a shared link's seeds win over whatever this browser had woven before
const linked = location.hash.match(/^#s=([\w,]+)/)?.[1]?.split(',').filter(Boolean) ?? []
if (linked.length && [...linked].sort().join('|') !== wovenKey) {
  ;(async () => {
    status('Resolving linked seeds…')
    try {
      seeds = []
      for (const id of linked) seeds.push(await resolveSeed(id))
      renderChips()
      weaveBtn.click()
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true)
    }
  })()
}
