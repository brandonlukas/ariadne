import { autocompleteWorks, buildCorpus, getAlexKey, idLike, resolveSeed, searchSeeds, setAlexKey, stripDoi, type Corpus, type WeaveMode, type Work } from './api.ts'
import { getAiOn, getKey, getModel, inferIntent, MODELS, setAiOn, setKey, setModel, whyForIntent } from './llm.ts'
import { computeMetrics, PRESETS, type Metrics } from './metrics.ts'
import { createRenderer, readTheme, THREAD, type GraphNode, type ViewMode } from './render.ts'

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

// ink ramp — older papers fade, newer ones gain ink; seeds carry the thread.
// dark mode inverts it: ink is light there, so newest = brightest
const RAMP_LIGHT = ['#a8a494', '#948f80', '#7f7b6e', '#69665b', '#53504a', '#3b3934', '#1c1b18']
const RAMP_DARK = ['#5f5c52', '#716d61', '#837f71', '#969282', '#aaa697', '#c9c5b6', '#e8e6e0']
const darkMq = matchMedia('(prefers-color-scheme: dark)')

const HINTS: Record<ViewMode | 'gallery', string> = {
  constellation: `drag to pan · ${matchMedia('(pointer: coarse)').matches ? 'pinch' : 'scroll'} to zoom · touch a paper to find its thread`,
  circle: 'rings — steps outward from your seeds · touch a paper to find its thread',
  sphere: 'drag to rotate · touch a paper to find its thread',
  timeline: 'time flows left to right — citations point into the past · touch a paper to find its thread',
  gallery: 'figure 1 from each paper — arXiv, Nature family, and PLOS',
}

const STORE = 'ariadne:weave:v15' // bump when the cached corpus shape or harvest logic changes

// IndexedDB: localStorage's ~5MB quota couldn't hold three uncapped corpora,
// which silently dropped woven directions on refresh and forced refetches
let dbP: Promise<IDBDatabase> | null = null
const idb = () =>
  (dbP ??= new Promise((res, rej) => {
    const r = indexedDB.open('ariadne', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))
const idbGet = async (k: string): Promise<any> => {
  const d = await idb()
  return new Promise((res, rej) => {
    const q = d.transaction('kv').objectStore('kv').get(k)
    q.onsuccess = () => res(q.result)
    q.onerror = () => rej(q.error)
  })
}
const idbSet = async (k: string, v: unknown): Promise<void> => {
  const d = await idb()
  return new Promise((res, rej) => {
    const q = d.transaction('kv', 'readwrite').objectStore('kv').put(v, k)
    q.onsuccess = () => res()
    q.onerror = () => rej(q.error)
  })
}

function saveStore() {
  // IndexedDB, where the boot path reads from — localStorage's ~5MB quota
  // couldn't hold the corpora anyway
  idbSet(STORE, { seeds, corpora, ask, flags, intent, aiWhy }).catch(() => {}) // reweave on next visit instead
}

let seeds: Work[] = []
// one control: each ask bundles a harvest direction, a weighting, and a sort
type Ask = 'canon' | 'groundwork' | 'since' | 'now'
const ASKS: Record<Ask, { mode: WeaveMode; preset: keyof typeof PRESETS; sort: 'score' | 'year' }> = {
  canon: { mode: 'both', preset: 'canon', sort: 'score' },
  groundwork: { mode: 'roots', preset: 'loadbearing', sort: 'score' },
  since: { mode: 'shoots', preset: 'catchup', sort: 'score' },
  now: { mode: 'shoots', preset: 'catchup', sort: 'year' },
}
const ASK_DESCS: Record<Ask, string> = {
  canon: 'the core reading list — the most influential papers around your seeds, ancestors and descendants together',
  groundwork: 'what your seeds are built on — their references, and the references of those',
  since: 'what grew from your seeds — downstream work, ranked by influence and momentum',
  now: 'the newest work downstream of your seeds — sorted by date, not influence',
}
let ask: Ask = 'canon'
let oldestFirst = false // groundwork's order toggle: chronological ancestry
let weaveMode: WeaveMode = 'both'
let corpora: Partial<Record<WeaveMode, Corpus>> = {} // one seed set, up to three instruments
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
let byId = new Map<string, number>()
let yearSpan: [number, number] = [0, 0]

let hoverFallbackT = 0
const renderer = createRenderer($<HTMLCanvasElement>('canvas'), {
  onHover(id) {
    for (const li of rankedEl.children) li.classList.toggle('hover', (li as HTMLElement).dataset.id === id)
    // hover ends -> fall back to the open paper, so the list doesn't stay parked
    // on whatever was hovered last; debounced so sweeping across nodes doesn't twitch
    clearTimeout(hoverFallbackT)
    if (id) rankedEl.querySelector<HTMLElement>(`li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
    else hoverFallbackT = window.setTimeout(() =>
      rankedEl.querySelector<HTMLElement>('li.active')?.scrollIntoView({ block: 'nearest' }), 250)
  },
  onSelect(id) {
    if (id === null) {
      hidePanel()
      for (const li of rankedEl.children) li.classList.remove('active')
    } else {
      openDetails(byId.get(id)!)
    }
  },
})

// the panel is a history entry, so the browser's native back gesture closes it
let panelPushed = false
function showPanel() {
  if (!panelEl.classList.contains('open')) {
    history.pushState({ panel: true }, '')
    panelPushed = true
  }
  panelEl.classList.add('open')
}
function hidePanel() {
  panelEl.classList.remove('open')
  if (panelPushed) {
    panelPushed = false
    history.back()
  }
}
addEventListener('popstate', () => {
  if (panelEl.classList.contains('open')) {
    panelPushed = false // the browser already popped the entry
    $('back').click()
  }
})

$('back').onclick = () => {
  hidePanel()
  renderer.select(null)
  for (const li of rankedEl.children) li.classList.remove('active')
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && panelEl.classList.contains('open')) $('back').click()
})

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

const aiModelEl = $<HTMLInputElement>('ai-model')
const aiFields = $('ai-fields')
const aiPower = $<HTMLButtonElement>('ai-power')
$('ai-models').append(...['openrouter/auto-beta', 'openrouter/auto', ...MODELS].map((m) => Object.assign(el('option'), { value: m })))
const aiReady = () => !!getKey() && getAiOn()
const aiLabel = () => {
  const on = aiReady()
  const model = getModel().split('/').pop()?.replace(':free', '')
  $('ai-status').textContent = on ? `ai · ${model}` : getKey() ? 'ai paused' : 'ai off'
  $('alex-status').textContent = getAlexKey() ? 'openalex ✓' : 'openalex'
  aiPower.classList.toggle('on', on)
  aiPower.classList.toggle('paused', !on && !!getKey())
}
// the cog opens the callout via popovertarget; the model field tracks storage
aiFields.ontoggle = () => {
  if (aiFields.matches(':popover-open')) aiModelEl.value = getModel()
}
aiPower.onclick = () => {
  if (!getKey()) return aiFields.showPopover() // nothing to switch — show where the key goes
  setAiOn(!getAiOn())
  aiLabel()
  if (aiReady()) maybeInferIntent()
}
aiModelEl.onchange = () => {
  setModel(aiModelEl.value.trim())
  aiModelEl.value = getModel() // clearing the field shows the default it fell back to
  aiLabel()
  aiModelEl.parentElement?.querySelector('.saved')?.remove()
  const ok = el('span', 'saved', '✓ saved')
  aiModelEl.insertAdjacentElement('afterend', ok)
  setTimeout(() => ok.remove(), 1600)
}

// a stored key renders as a masked chip with its own forget button; an empty one
// renders as an input — on/off is the storage itself, no separate switch to drift
function keyRow(slot: HTMLElement, placeholder: string, get: () => string, set: (k: string) => void, changed: () => void) {
  const render = () => {
    const k = get()
    if (k) {
      const chip = el('span', 'keychip')
      chip.append(el('span', 'mask', '••••·' + k.slice(-4)))
      const forget = el('button', 'forget', 'forget ×')
      forget.type = 'button'
      forget.onclick = () => {
        set('')
        render()
        changed()
      }
      chip.append(forget)
      slot.replaceChildren(chip)
    } else {
      const input = el('input')
      input.type = 'password'
      input.placeholder = placeholder
      input.onchange = () => {
        set(input.value.trim())
        render()
        changed()
      }
      slot.replaceChildren(input)
    }
  }
  render()
}
keyRow($('ai-key-slot'), 'paste OpenRouter key — free at openrouter.ai', getKey, setKey, () => {
  if (!getKey()) {
    setModel('')
    intent = ''
    aiWhy = {} // forgetting the key also forgets what it generated
    saveStore()
    renderIntent()
  }
  aiLabel()
  maybeInferIntent()
})
keyRow($('alex-key-slot'), 'paste OpenAlex key', getAlexKey, setAlexKey, aiLabel)
aiLabel()

function renderIntent() {
  const line = $('intent-line')
  line.hidden = !intent
  line.textContent = intent ? `✦ ${intent}` : ''
}

async function maybeInferIntent() {
  if (!corpus || !aiReady() || intent) return
  const line = $('intent-line')
  line.onclick = null
  line.style.cursor = ''
  line.hidden = false
  line.textContent = '✦ reading the seeds…'
  try {
    intent = await inferIntent(corpus.works.filter((w) => w.isSeed))
    saveStore()
    renderIntent()
  } catch (err) {
    line.textContent = `✦ ${err instanceof Error ? err.message : String(err)} — tap to retry`
    line.style.cursor = 'pointer'
    line.onclick = () => maybeInferIntent()
  }
}

// --- seeds ---

function renderChips() {
  chipsEl.replaceChildren(
    ...seeds.map((s, i) => {
      const li = el('li')
      const t = el('button', 't', s.title)
      t.title = 'see the full record'
      t.onclick = () => openSeedDetails(s)
      const y = el('span', 'y', String(s.year))
      const x = el('button', 'x', '×')
      x.title = 'remove this seed'
      x.onclick = () => {
        seeds.splice(i, 1)
        if (panelId === s.id) hidePanel()
        renderChips()
      }
      li.append(t, y, x)
      return li
    }),
  )
  weaveBtn.disabled = seeds.length === 0 || (seedKey() === wovenKey && !!corpora[weaveMode])
  $('seed-sum').textContent = seeds.length ? `seeds · ${seeds.length}` : 'seeds'
  if (seeds.length === 0) idbSet(STORE, null).catch(() => {})
}

const pickerEl = $<HTMLUListElement>('picker')

// one row shape for both search results and type-ahead suggestions:
// title · (preprint tag) · meta · cite count
function pickerRow(title: string, meta: string, preprint: boolean, citedBy: number | null, pick: () => void) {
  const li = el('li')
  const t = el('span', 't', title)
  t.title = title
  li.append(t)
  if (preprint) li.append(el('span', 'tag', 'preprint'))
  li.append(el('span', 'y', meta))
  if (citedBy !== null) li.append(el('span', 'c', `${citedBy.toLocaleString()} cites`))
  li.onclick = pick
  return li
}

function pushSeed(w: Work) {
  if (!seeds.some((s) => s.id === w.id)) seeds.push(w)
  seedInput.value = ''
  status('')
  renderChips()
}

async function addSeed() {
  const q = seedInput.value.trim()
  if (!q) return
  cancelSuggest()
  addSeedBtn.disabled = true
  pickerEl.replaceChildren()
  status('Resolving paper…')
  try {
    if (idLike(q)) {
      pushSeed(await resolveSeed(q))
    } else {
      const results = await searchSeeds(q, 10)
      if (!results.length)
        throw new Error(
          `No paper found for “${q}” — very recent papers reach OpenAlex on a delay; pasting the DOI or arXiv link often works sooner`,
        )
      if (results.length === 1) pushSeed(results[0])
      else {
        // fuzzy match — let the user confirm which paper they meant
        status('Which one?')
        pickerEl.replaceChildren(
          ...results.map((w) => {
            const surname = w.authors[0]?.split(' ').pop() ?? '?'
            const meta = `${w.venue ? w.venue + ' · ' : ''}${surname} ${w.year}`
            return pickerRow(w.title, meta, w.preprint, w.citedBy, () => {
              pickerEl.replaceChildren()
              pushSeed(w)
            })
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

// type-ahead: debounced suggestions into the same picker; best-effort only —
// failures stay silent because submit still searches properly
let suggestTimer = 0
let suggestSeq = 0
const cancelSuggest = () => {
  clearTimeout(suggestTimer)
  suggestSeq++
}
seedInput.oninput = () => {
  pickerEl.replaceChildren()
  cancelSuggest()
  const q = seedInput.value.trim()
  if (q.length < 3 || idLike(q)) return
  const seq = suggestSeq
  suggestTimer = window.setTimeout(async () => {
    try {
      const suggestions = await autocompleteWorks(q)
      if (seq !== suggestSeq) return // stale — every input change bumps the seq
      // same title twice usually means preprint + published twin; collapse to
      // one row that falls through to the full picker, where venue/type/cites
      // make the two tellable apart (autocomplete's payload can't)
      const byTitle = new Map<string, { s: (typeof suggestions)[0]; dup: boolean }>()
      for (const s of suggestions) {
        const k = s.title.toLowerCase()
        const hit = byTitle.get(k)
        if (hit) hit.dup = true
        else byTitle.set(k, { s, dup: false })
      }
      pickerEl.replaceChildren(
        ...[...byTitle.values()].slice(0, 5).map(({ s, dup }) =>
          pickerRow(s.title, s.hint?.split(',')[0] ?? '', false, null, async () => {
            pickerEl.replaceChildren()
            if (dup) {
              seedInput.value = s.title
              addSeed()
              return
            }
            status('Resolving paper…')
            try {
              pushSeed(await resolveSeed(s.id))
            } catch (err) {
              status(err instanceof Error ? err.message : String(err), true)
            }
          }),
        ),
      )
    } catch {}
  }, 250)
}

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

const writeHash = () =>
  history.replaceState(
    null,
    '',
    '#s=' + seeds.map((s) => s.id).join(',') + (ask === 'canon' ? '' : '&a=' + ask),
  )

function syncAskUI() {
  document
    .querySelectorAll<HTMLButtonElement>('#preset button[data-a]')
    .forEach((x) => x.classList.toggle('on', x.dataset.a === ask))
  $('order-line').hidden = ask !== 'groundwork'
  $('oldest').classList.toggle('on', oldestFirst)
  $('order-score').classList.toggle('on', !oldestFirst)
}

$('ask-legend').append(
  ...(Object.entries(ASK_DESCS) as [Ask, string][]).flatMap(([a, d]) => [el('b', '', a), el('span', '', d)]),
)

document.querySelectorAll<HTMLButtonElement>('#preset button[data-a]').forEach((b) => {
  b.onclick = () => {
    ask = b.dataset.a as Ask
    if (ask !== 'groundwork') oldestFirst = false
    const wanted = ASKS[ask].mode
    syncAskUI()
    if (wanted !== weaveMode) {
      weaveMode = wanted
      renderChips()
      if (corpora[weaveMode] && seedKey() === wovenKey) {
        corpus = corpora[weaveMode]!
        writeHash()
        saveStore()
        present()
      } else if (seeds.length && seedKey() === wovenKey) {
        weaveBtn.click() // same seeds, unwoven direction — fetch it
      }
      return
    }
    if (!corpus) return
    metrics = computeMetrics(corpus.works, corpus.edges, PRESETS[ASKS[ask].preset], weaveMode === 'roots')
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
    writeHash()
    refreshViews()
  }
})

const setOrder = (oldest: boolean) => {
  oldestFirst = oldest
  syncAskUI()
  computeOrder()
  refreshViews()
}
$<HTMLButtonElement>('oldest').onclick = () => setOrder(true)
$<HTMLButtonElement>('order-score').onclick = () => setOrder(false)

// --- weave ---

function present() {
  if (!corpus) return
  syncAskUI()
  metrics = computeMetrics(corpus.works, corpus.edges, PRESETS[ASKS[ask].preset], weaveMode === 'roots')
  byId = new Map(corpus.works.map((w, i) => [w.id, i]))
  computeOrder()
  $<HTMLInputElement>('find').value = ''
  needle = ''
  renderList()
  renderGraph()
  $('gallery').replaceChildren()
  galleryStale = true
  renderYears()
  renderIntent()
  $('fold').hidden = false
  $('tabs').hidden = false
  $('list-tools').hidden = false
  $('preset').hidden = false
  $('bridges').hidden = corpus.works.filter((w) => w.isSeed).length < 2
  bridgesOnly = false
  $('bridges').classList.remove('on')
  setTab('papers')
  lens = null
  applyBrush(null)
  $('stage').classList.add('woven')
  document.querySelector<HTMLButtonElement>('#modes [data-m="constellation"]')!.click()
}

// --- list order + refresh ---

function computeOrder() {
  if (!corpus) return
  const byYear = ASKS[ask].sort === 'year' || oldestFirst
  const key = byYear
    ? (i: number) => corpus!.works[i].year || (oldestFirst ? 9999 : 0)
    : (i: number) => metrics[i].score
  order = corpus.works.map((_, i) => i).sort((a, b) => key(b) - key(a))
  if (oldestFirst) order.reverse() // ancestry reads oldest-first: the story in order
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
  const seedYears = new Set(corpus.works.filter((w) => w.isSeed).map((w) => w.year))
  const bars = []
  for (let y = yearSpan[0]; y <= yearSpan[1]; y++) {
    const n = counts.get(y) ?? 0
    const bar = el('div')
    if (seedYears.has(y)) bar.classList.add('seed-year')
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
  if (bridgesOnly && !w.isSeed && (metrics[byId.get(w.id)!]?.seedLinks ?? 0) < 2) return false
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
  // one rule: the list shows what passes the filters; the graph dims the rest
  for (const li of rankedEl.children) {
    const row = li as HTMLElement
    row.hidden = vis !== null && !vis.has(row.dataset.id!)
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

// --- sidebar tabs: papers | venues | authors ---

const lensesEl = $('lenses')
let tab: 'papers' | 'venues' | 'authors' = 'papers'

let lensesKey = '' // which (tab, corpus) the current rows were built from

function renderLenses() {
  if (!corpus || tab === 'papers') return
  // the rows are pure functions of the works list — skip the ~thousands-of-nodes
  // rebuild when it hasn't changed, just re-sync the lit state
  const key = `${tab}:${weaveMode}:${wovenKey}`
  if (key === lensesKey) return applyFilter()
  lensesKey = key
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
document.querySelectorAll<HTMLElement>('#tabs button[data-t]').forEach((b) => {
  b.onclick = () => setTab(b.dataset.t as typeof tab)
})

// the fold divider collapses the seed panel — the desktop cousin of #divider
const setFold = (f: boolean) => {
  $('sidebar').classList.toggle('folded', f)
  $<HTMLButtonElement>('fold-up').disabled = f
  $<HTMLButtonElement>('fold-down').disabled = !f
}
$('fold-up').onclick = () => setFold(true)
$('fold-down').onclick = () => setFold(false)

// phones: the divider chevrons snap the stack between list / split / graph
const setSplit = (s: 'list' | 'split' | 'graph') => {
  $('main').classList.toggle('m-list', s === 'list')
  $('main').classList.toggle('m-graph', s === 'graph')
  $<HTMLButtonElement>('div-up').disabled = s === 'graph'
  $<HTMLButtonElement>('div-down').disabled = s === 'list'
}
$('div-up').onclick = () =>
  setSplit($('main').classList.contains('m-list') ? 'split' : 'graph')
$('div-down').onclick = () =>
  setSplit($('main').classList.contains('m-graph') ? 'split' : 'list')

weaveBtn.onclick = async () => {
  weaveBtn.disabled = true
  hidePanel()
  try {
    const built = await buildCorpus(seeds, status, weaveMode)
    if (seedKey() !== wovenKey) {
      corpora = {} // new seed set — every mode's corpus went stale
      intent = '' // so did the inferred question and its cached answers
      aiWhy = {}
    }
    corpus = built
    corpora[weaveMode] = built
    wovenKey = seedKey()
    writeHash()
    saveStore()
    present()
    setSplit('split') // if a phone had collapsed a pane, the new graph reopens it
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
  const ramp = darkMq.matches ? RAMP_DARK : RAMP_LIGHT
  const t = max > min ? (year - min) / (max - min) : 0.5
  return ramp[Math.min(ramp.length - 1, Math.floor(t * ramp.length))]
}

darkMq.addEventListener('change', () => {
  readTheme()
  renderer.recolor((n) => (n.isSeed ? THREAD : yearColor(n.year, yearSpan[0], yearSpan[1])))
  renderYears() // year-brush bars bake ramp colors into inline styles
})

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
      if (w.isSeed) li.classList.add('seed')
      const body = el('div', 'body')
      const meta = el('div', 'meta', `${w.authors[0] ?? 'Unknown'}${w.authors.length > 1 ? ' et al.' : ''}, ${w.year}`)
      if (w.isSeed) meta.append(el('span', 'seed-mark', ' — seed'))
      if (!w.isSeed && metrics[i].seedLinks >= 2) meta.append(el('span', 'seed-mark', ` — bridges ${metrics[i].seedLinks} seeds`))
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
      if (!w.isSeed && metrics[i].seedLinks >= 2) m.append(el('span', 'seed', ` — bridges ${metrics[i].seedLinks}`))
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

function why(w: Work, m: Metrics): string {
  if (w.isSeed) return 'One of your seed papers — the thread starts here.'
  const bits: string[] = []
  if (m.seedLinks >= 2) bits.push(`directly linked to ${m.seedLinks} of your seeds`)
  // components are rank-normalized, so these thresholds mean "top ~15%"
  if (m.parts.foundational > 0.85) bits.push('structurally foundational in this neighborhood')
  if (m.parts.bridge > 0.85) bits.push('bridges otherwise-separate clusters')
  if (m.parts.momentum > 0.75) bits.push(`gaining citations fast (${w.recentCites.toLocaleString()} in the last 3 years)`)
  if (!bits.length) bits.push(`part of the seed neighborhood, cited ${w.citedBy.toLocaleString()} times overall`)
  const s = bits.join('; ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

// title, authors, provenance, abstract — everything OpenAlex hands us about a
// paper, independent of any weave
function paperHead(w: Work) {
  const meta = [w.venue, String(w.year), `cited ${w.citedBy.toLocaleString()} times`, w.preprint && 'preprint']
  return [
    el('h2', '', w.title),
    el('div', 'byline', w.authors.slice(0, 6).join(', ') + (w.authors.length > 6 ? ' et al.' : '')),
    el('div', 'date', meta.filter(Boolean).join(' · ')),
    ...(w.abstract ? [el('p', 'desc', w.abstract)] : []),
  ]
}

function linkPills(w: Work) {
  const pills = el('div', 'pills')
  const open = el('a', 'pill', 'open paper ↗')
  open.href = w.doi ?? `https://openalex.org/${w.id}`
  open.target = '_blank'
  pills.append(open)
  if (w.pdf) {
    const pdf = el('a', 'pill', 'pdf ↗')
    pdf.href = w.pdf
    pdf.target = '_blank'
    pdf.title = 'open-access copy'
    pills.append(pdf)
  }
  return pills
}

// a seed chip before weaving has no metrics or neighborhood to show — just the
// record, so you can confirm you picked the right paper without weaving first
function openSeedDetails(w: Work) {
  const i = byId.get(w.id)
  if (corpus && i !== undefined) return openDetails(i) // woven: the full panel earns its place
  panelBody.replaceChildren(...paperHead(w), linkPills(w))
  if (panelId !== w.id) panelEl.scrollTop = 0
  panelId = w.id
  showPanel()
}

function openDetails(i: number) {
  if (!corpus) return
  const w = corpus.works[i]
  const m = metrics[i]
  for (const li of rankedEl.children) li.classList.toggle('active', (li as HTMLElement).dataset.id === w.id)
  rankedEl.querySelector<HTMLElement>(`li[data-id="${w.id}"]`)?.scrollIntoView({ block: 'nearest' })
  renderer.select(w.id)

  panelBody.replaceChildren(...paperHead(w))
  if (panelId !== w.id) panelEl.scrollTop = 0 // new paper starts at the top; ai-text swaps don't jump
  panelId = w.id
  const whyEl = el('p', 'why')
  const ai = aiWhy[w.id]
  whyEl.append(
    el('b', '', ai ? '✦ why it matters for your thread' : 'why it matters'),
    document.createTextNode(' — ' + (ai ?? why(w, m))),
  )
  if (!ai && aiReady() && intent) {
    whyEl.append(el('span', '', ' ✦…'))
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
  const pills = linkPills(w)
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

  // the paper's neighborhood, so finding a node's connections doesn't require
  // clicking around the canvas
  const byScore = (a: number, b: number) => metrics[b].score - metrics[a].score
  const ins: number[] = []
  const outs: number[] = []
  for (const [s, t] of corpus.edges) {
    if (t === i) ins.push(s)
    if (s === i) outs.push(t)
  }
  const group = (label: string, idxs: number[]) => {
    if (!idxs.length) return
    panelBody.append(el('div', 'ch', `${label} · ${idxs.length} in this weave`))
    for (const j of idxs.sort(byScore)) {
      const w2 = corpus!.works[j]
      const row = el('div', w2.isSeed ? 'conn seed' : 'conn')
      row.append(el('span', 'y', String(w2.year || '—')), el('span', 't', w2.title))
      row.title = w2.title
      row.onmouseenter = () => renderer.highlight(w2.id)
      row.onmouseleave = () => renderer.highlight(null)
      row.onclick = () => {
        renderer.focus(w2.id)
        openDetails(j)
      }
      panelBody.append(row)
    }
  }
  group('cited by', ins)
  group('cites', outs)

  showPanel()
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

// what an export walks: the current view, or one section per woven direction
// ('now' shares since's corpus — same papers, so no fourth section)
function exportSections(all: boolean) {
  if (!all) return corpus ? [{ label: '', c: corpus, ms: metrics, ord: order }] : []
  const out: { label: string; c: Corpus; ms: Metrics[]; ord: number[] }[] = []
  for (const a of ['canon', 'groundwork', 'since'] as const) {
    const c = corpora[ASKS[a].mode]
    if (!c) continue
    const ms = computeMetrics(c.works, c.edges, PRESETS[ASKS[a].preset], ASKS[a].mode === 'roots')
    const ord = c.works.map((_, i) => i).sort((x, y) => ms[y].score - ms[x].score)
    out.push({ label: a, c, ms, ord })
  }
  return out
}

const visible = (c: Corpus, ord: number[]) => ord.filter((i) => flags[c.works[i].id] !== 'hide')

function exportMd(all: boolean) {
  const secs = exportSections(all)
  if (!secs.length) return
  const lines = ['# Ariadne corpus', '', `Seeds: ${seeds.map((s) => s.title).join(' · ')}`, '']
  for (const { label, c, ms, ord } of secs) {
    const h = label ? '###' : '##'
    if (label) lines.push(`## ${label} — ${ASK_DESCS[label as Ask]}`, '')
    const vis = visible(c, ord)
    lines.push(`Papers: ${vis.length} · ranked by composite influence`, '')
    vis.forEach((i, rank) => {
      const w = c.works[i]
      const m = ms[i]
      lines.push(`${h} ${rank + 1}. ${w.title} (${w.year})${w.isSeed ? ' — SEED' : ''}${flags[w.id] === 'star' ? ' ★' : ''}`)
      lines.push(`- Authors: ${w.authors.slice(0, 8).join(', ')}${w.authors.length > 8 ? ' et al.' : ''}`)
      if (w.venue) lines.push(`- Published in: ${w.venue}`)
      if (w.doi) lines.push(`- DOI: ${w.doi}`)
      if (w.pdf) lines.push(`- PDF (open access): ${w.pdf}`)
      lines.push(`- Score: ${m.score.toFixed(2)} (foundational ${m.parts.foundational.toFixed(2)}, bridge ${m.parts.bridge.toFixed(2)}, momentum ${m.parts.momentum.toFixed(2)}, relevance ${m.parts.relevance.toFixed(2)})`)
      lines.push(`- Why it matters: ${why(w, m)}`)
      if (w.abstract) lines.push(`\n> ${w.abstract}`)
      lines.push('')
    })
  }
  download('ariadne-corpus.md', lines.join('\n'), 'text/markdown')
}

function exportBib(all: boolean) {
  const secs = exportSections(all)
  if (!secs.length) return
  const used = new Set<string>()
  const seen = new Set<string>()
  const entries: string[] = []
  for (const { c, ord } of secs)
    for (const i of visible(c, ord)) {
      const w = c.works[i]
      if (seen.has(w.id)) continue
      seen.add(w.id)
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
      entries.push(`@article{${key},\n${fields.join(',\n')}\n}`)
    }
  download('ariadne-corpus.bib', entries.join('\n\n') + '\n', 'text/plain')
}

function exportJson(all: boolean) {
  const secs = exportSections(all)
  if (!secs.length) return
  const rows = ({ c, ms, ord }: (typeof secs)[number]) =>
    visible(c, ord).map((i, rank) => {
      const w = c.works[i]
      return {
        rank: rank + 1,
        ...w,
        starred: flags[w.id] === 'star',
        score: ms[i].score,
        parts: ms[i].parts,
        why: why(w, ms[i]),
      }
    })
  const data = all ? Object.fromEntries(secs.map((s) => [s.label, rows(s)])) : rows(secs[0])
  download('ariadne-corpus.json', JSON.stringify(data, null, 2), 'application/json')
}

const EXPORTERS: Record<string, (all: boolean) => void> = { md: exportMd, bib: exportBib, json: exportJson }
const exportMenu = $<HTMLDetailsElement>('export-menu')
document.addEventListener('click', (e) => {
  if (!exportMenu.contains(e.target as Node)) exportMenu.open = false
})
exportMenu.querySelectorAll<HTMLButtonElement>('button[data-fmt]').forEach((b) => {
  b.onclick = () => {
    exportMenu.open = false
    EXPORTERS[b.dataset.fmt!](b.dataset.all === '1')
  }
})

// --- remember the weave ---
;(async () => {
  localStorage.removeItem(STORE) // stale megabytes from when saveStore wrote here
  try {
    const saved = await idbGet(STORE)
    if (saved?.corpora) {
      seeds = saved.seeds
      corpora = saved.corpora
      ask = saved.ask ?? 'canon'
      weaveMode = ASKS[ask].mode
      corpus = corpora[weaveMode] ?? null
      flags = saved.flags ?? {}
      intent = saved.intent ?? ''
      aiWhy = saved.aiWhy ?? {}
      wovenKey = seedKey()
      renderChips()
      if (corpus) present()
      maybeInferIntent() // a key may be set while the last session's intent isn't
    }
  } catch {} // corrupt store — start fresh

  // a shared link's seeds win over whatever this browser had woven before
  const linked = location.hash.match(/^#s=([\w,]+)/)?.[1]?.split(',').filter(Boolean) ?? []
  const linkedAsk = location.hash.match(/[#&]a=(canon|groundwork|since|now)/)?.[1] as
    | Ask
    | undefined
  if (linkedAsk && linkedAsk !== ask) {
    ask = linkedAsk
    weaveMode = ASKS[ask].mode
    corpus = corpora[weaveMode] ?? null
    if (corpus) present()
  }
  if (linked.length && ([...linked].sort().join('|') !== wovenKey || !corpora[weaveMode])) {
    status('Resolving linked seeds…')
    try {
      seeds = []
      for (const id of linked) seeds.push(await resolveSeed(id))
      renderChips()
      // no autoweave: the harvest is the expensive part, and it would spend the
      // link recipient's API budget before they've even seen the seeds
      status(`${seeds.length} seed${seeds.length === 1 ? '' : 's'} from link — weave when ready`)
    } catch (err) {
      status(err instanceof Error ? err.message : String(err), true)
    }
  }
})()
