export interface Work {
  id: string
  title: string
  year: number
  citedBy: number
  preprint: boolean
  authors: string[]
  venue: string | null
  arxivId: string | null
  refs: string[]
  recentCites: number
  doi: string | null
  abstract: string | null
  pdf: string | null // legal open-access copy, when one exists
  isSeed: boolean
}

export interface Corpus {
  works: Work[]
  edges: [number, number][] // [citing index, cited index]
}

const API = 'https://api.openalex.org'
const MAILTO = 'brandonlukas@gmail.com'
const SELECT =
  'id,display_name,publication_year,cited_by_count,authorships,primary_location,locations,referenced_works,counts_by_year,doi,abstract_inverted_index,best_oa_location'
const CITERS_PER_SEED = 50

// bring-your-own OpenAlex key: anonymous use shares a $0.10/day per-IP budget;
// a free key (openalex.org/settings/api) is $1/day — ten times the room
const ALEX_KEY = 'ariadne:alex-key'
export const getAlexKey = () => localStorage.getItem(ALEX_KEY) ?? ''
export const setAlexKey = (k: string) =>
  k ? localStorage.setItem(ALEX_KEY, k) : localStorage.removeItem(ALEX_KEY)

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1)
export const stripDoi = (s: string) => s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')

// session-lived caches: identical requests are answered once (mode switches
// and reweaves re-ask mostly the same questions), and every paper ever parsed
// is remembered so batch fetches only request genuinely new ids. A page reload
// clears both — that is the freshness story, and it's enough.
const urlCache = new Map<string, Promise<any>>()
const workCache = new Map<string, Work>()

function getJson(path: string): Promise<any> {
  const key = getAlexKey()
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}mailto=${MAILTO}${key ? `&api_key=${key}` : ''}`
  const hit = urlCache.get(url)
  if (hit) return hit
  const p = (async () => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url)
      if (res.status === 429) {
        // budget-exhaustion 429s don't recover in seconds — only wait out a
        // short server-stated Retry-After, once; otherwise fail fast
        const wait = Number(res.headers.get('retry-after'))
        if (attempt === 0 && wait > 0 && wait <= 10) {
          await new Promise((r) => setTimeout(r, wait * 1000))
          continue
        }
        throw new Error(
          getAlexKey()
            ? 'OpenAlex is rate-limiting (429) — daily budget likely spent; it refills daily'
            : 'OpenAlex is rate-limiting (429) — a free API key (openalex.org/settings/api, paste it under data · openalex) gives 10× the daily budget',
        )
      }
      if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`)
      return res.json()
    }
  })()
  urlCache.set(url, p)
  p.catch(() => urlCache.delete(url)) // failures may retry fresh
  return p
}

// OpenAlex passes publisher JATS markup through in titles/abstracts; strip only the
// known tag set — a blanket <…> strip would eat literal "x<y and z>w" in abstracts
const deTag = (s: string) => s.replace(/<\/?(scp|i|b|em|strong|sub|sup|sc|italic|bold)\b[^>]*>/gi, '')

function deInvert(inv: Record<string, number[]> | null): string | null {
  if (!inv) return null
  const words: string[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w
  return deTag(words.join(' '))
}

function findArxivId(j: any): string | null {
  const urls: (string | null)[] = (j.locations ?? []).flatMap((l: any) => [l.landing_page_url, l.pdf_url])
  urls.push(j.doi ?? null)
  for (const u of urls) {
    const m = u?.match(/arxiv\.org\/(?:abs|pdf)\/([0-9]+\.[0-9]+(?:v[0-9]+)?)|10\.48550\/arxiv\.([0-9]+\.[0-9]+)/i)
    if (m) return m[1] ?? m[2]
  }
  return null
}

function parseWork(j: any): Work {
  const thisYear = new Date().getFullYear()
  const recentCites = (j.counts_by_year ?? [])
    .filter((c: any) => c.year >= thisYear - 2)
    .reduce((s: number, c: any) => s + c.cited_by_count, 0)
  const arxivId = findArxivId(j)
  const w: Work = {
    id: short(j.id),
    title: deTag(j.display_name ?? '(untitled)'),
    year: j.publication_year ?? 0,
    citedBy: j.cited_by_count ?? 0,
    // OpenAlex's own `type` field mislabels thousands of journal articles as
    // 'preprint' (Cytoscape, GATK, … are all typed preprint under Genome
    // Research); who hosts the primary copy is the signal that holds
    preprint: j.primary_location?.source?.type === 'repository',
    authors: (j.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
    venue: j.primary_location?.source?.display_name ?? null,
    arxivId,
    refs: (j.referenced_works ?? []).map(short),
    recentCites,
    doi: j.doi ?? null,
    abstract: deInvert(j.abstract_inverted_index ?? null),
    pdf: j.best_oa_location?.pdf_url ?? (arxivId ? `https://arxiv.org/pdf/${arxivId}` : null),
    isSeed: false,
  }
  workCache.set(w.id, w)
  return w
}

const arxOf = (q: string) =>
  q.match(/^(?:arxiv:)?(\d{4}\.\d{4,5})(?:v\d+)?$/i)?.[1] ??
  q.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5})/i)?.[1]

// DOI, arXiv id/URL, or OpenAlex id — anything resolvable without a fuzzy search
export const idLike = (q: string) =>
  !!arxOf(q) || /^10\.\d{4,}\//.test(stripDoi(q.trim())) || /^W\d+$/i.test(q.trim())

export async function resolveSeed(input: string): Promise<Work> {
  const q = stripDoi(input.trim())
  const arx = arxOf(q)
  if (arx) return parseWork(await getJson(`/works/doi:10.48550/arXiv.${arx}?select=${SELECT}`))
  if (/^10\.\d{4,}\//.test(q)) return parseWork(await getJson(`/works/doi:${q}?select=${SELECT}`))
  if (/^W\d+$/i.test(q)) return parseWork(await getJson(`/works/${q}?select=${SELECT}`))
  const results = await searchSeeds(q, 1)
  if (!results.length) throw new Error(`No paper found for “${input}”`)
  return results[0]
}

const tokens = (s: string) =>
  new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(Boolean))

// share of the query's words found in the title — 1 means every word landed
export function titleMatch(q: string, title: string): number {
  const qt = tokens(q)
  const tt = tokens(title)
  let hit = 0
  for (const w of qt) if (tt.has(w)) hit++
  return qt.size ? hit / qt.size : 0
}

export async function searchSeeds(q: string, n: number): Promise<Work[]> {
  const page = (params: string): Promise<Work[]> =>
    getJson(`/works?${params}&per-page=10&select=${SELECT}`).then((j) => (j.results ?? []).map(parseWork))
  let works = await page(`search=${encodeURIComponent(q)}`)
  // general search is citation-weighted, which buries new zero-cite papers even
  // on an exact-title query; a title-only phrase search rescues them
  if (!works.some((w) => titleMatch(q, w.title) >= 0.8))
    works = works.concat(await page(`filter=title.search:${encodeURIComponent(q.replace(/[,:]/g, ' '))}`))
  // ties (identical twins) break toward the record with a DOI — the better-linked one
  return [...new Map(works.map((w) => [w.id, w])).values()]
    .sort((a, b) => titleMatch(q, b.title) - titleMatch(q, a.title) || b.citedBy - a.citedBy || +!!b.doi - +!!a.doi)
    .slice(0, n)
}

export interface Suggestion {
  id: string
  title: string
  hint: string | null // authors, per OpenAlex autocomplete
}

// purpose-built type-ahead endpoint: fast and cheap, but the payload carries no
// year/venue, and its cited_by_count is unreliable (returns 0 for cited works)
export async function autocompleteWorks(q: string): Promise<Suggestion[]> {
  const j = await getJson(`/autocomplete/works?q=${encodeURIComponent(q)}`)
  return (j.results ?? []).map((r: any) => ({
    id: short(r.id),
    title: deTag(r.display_name ?? '(untitled)'),
    hint: r.hint ?? null,
  }))
}

export type WeaveMode = 'roots' | 'both' | 'shoots'

export async function buildCorpus(
  seeds: Work[],
  onStatus: (msg: string) => void,
  mode: WeaveMode = 'both',
): Promise<Corpus> {
  const pool = new Map<string, Work>()
  for (const s of seeds) pool.set(s.id, { ...s, isSeed: true })
  const thisYear = new Date().getFullYear()
  const seedIds = new Set(seeds.map((s) => s.id))

  // every id met in the seed neighborhood — refs, citers, earned admissions
  const seen = new Set<string>()
  // earned membership: in shoots/both, papers co-cited alongside a seed by a
  // tenth of its sampled citers (the only signal reaching true contemporaries,
  // which often share no direct edge); in roots, references-of-references
  // cited by a tenth of a seed's bibliography (the canon behind the canon).
  // Relative bars — absolute ones silently never fire for niche seeds.
  const coEarned = new Map<string, number>()

  const fetchUnknown = async (label: string) => {
    for (const id of seen) {
      const known = workCache.get(id)
      if (known && !pool.has(id)) pool.set(id, known)
    }
    const unknown = [...seen].filter((id) => !seedIds.has(id) && !pool.has(id))
    for (let i = 0; i < unknown.length; i += 50) {
      onStatus(`${label} ${Math.min(i + 50, unknown.length)}/${unknown.length}…`)
      const j = await getJson(
        `/works?filter=openalex:${unknown.slice(i, i + 50).join('|')}&per-page=50&select=${SELECT}`,
      )
      for (const raw of j.results ?? []) {
        const w = parseWork(raw)
        pool.set(w.id, w)
      }
    }
  }

  // ancestry: the seeds' own bibliographies (shoots reaches refs only when
  // co-citation readmits them as living peers)
  if (mode !== 'shoots') for (const s of seeds) for (const r of s.refs) seen.add(r)

  if (mode !== 'roots') {
    for (let i = 0; i < seeds.length; i++) {
      const s = seeds[i]
      onStatus(`Pulling citations ${i + 1}/${seeds.length}: ${s.title.slice(0, 48)}…`)
      // three pulls per seed: the canon (all-time top-cited), the pulse (newest
      // by date), and the frontier (last-2-years citers ranked by traction)
      const citers = new Set<string>()
      for (const query of [
        `filter=cites:${s.id}&sort=cited_by_count:desc`,
        `filter=cites:${s.id}&sort=publication_date:desc`,
        `filter=cites:${s.id},from_publication_date:${thisYear - 2}-01-01&sort=cited_by_count:desc`,
      ]) {
        const j = await getJson(`/works?${query}&per-page=${CITERS_PER_SEED}&select=${SELECT}`)
        for (const raw of j.results ?? []) {
          const w = parseWork(raw)
          if (!pool.has(w.id)) pool.set(w.id, w)
          citers.add(w.id)
        }
      }
      const co = new Map<string, number>()
      for (const id of citers) {
        seen.add(id)
        for (const r of pool.get(id)!.refs) if (r !== s.id) co.set(r, (co.get(r) ?? 0) + 1)
      }
      const bar = Math.max(5, Math.ceil(citers.size * 0.1))
      for (const [id, n] of co) if (n >= bar) coEarned.set(id, (coEarned.get(id) ?? 0) + 1)
    }
    for (const [id] of coEarned) if (!seedIds.has(id)) seen.add(id)
  }

  await fetchUnknown('Reading references')

  if (mode === 'roots') {
    // grand-ancestry, counted from reference lists already in hand — one hop
    // deeper than any other mode reaches
    for (const s of seeds) {
      const co = new Map<string, number>()
      for (const r of s.refs)
        for (const r2 of pool.get(r)?.refs ?? [])
          if (!seedIds.has(r2)) co.set(r2, (co.get(r2) ?? 0) + 1)
      const bar = Math.max(5, Math.ceil(s.refs.length * 0.1))
      for (const [id, n] of co) if (n >= bar) coEarned.set(id, (coEarned.get(id) ?? 0) + 1)
    }
    for (const [id] of coEarned) seen.add(id)
    await fetchUnknown('Tracing the roots')
  }

  // no cut. Everything the harvest gathered stays: every candidate was already
  // fetched, so the old 200-cap was a layout budget masquerading as curation.
  // Admission itself (complete bibliographies, deliberate citer samples,
  // relative co-citation bars) is the curation; ranking decides reading order.
  // ponytail: the constellation may chug past ~1500 nodes — tighten
  // CITERS_PER_SEED if huge seed sets ever hurt.
  const keep = new Set([...seedIds, ...seen])
  const works = [...pool.values()].filter((w) => keep.has(w.id))
  const idx = new Map(works.map((w, i) => [w.id, i]))
  const edges: [number, number][] = []
  for (const w of works) {
    const from = idx.get(w.id)!
    for (const r of w.refs) {
      const to = idx.get(r)
      if (to !== undefined) edges.push([from, to])
    }
  }
  return { works, edges }
}
