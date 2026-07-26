export interface Work {
  id: string
  title: string
  year: number
  citedBy: number
  authors: string[]
  venue: string | null
  arxivId: string | null
  refs: string[]
  recentCites: number
  doi: string | null
  abstract: string | null
  isSeed: boolean
}

export interface Corpus {
  works: Work[]
  edges: [number, number][] // [citing index, cited index]
}

const API = 'https://api.openalex.org'
const MAILTO = 'brandonlukas@gmail.com'
const SELECT =
  'id,display_name,publication_year,cited_by_count,authorships,primary_location,locations,referenced_works,counts_by_year,doi,abstract_inverted_index'
const MAX_NODES = 200
const CITERS_PER_SEED = 50

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1)

async function getJson(path: string): Promise<any> {
  const url = `${API}${path}${path.includes('?') ? '&' : '?'}mailto=${MAILTO}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url)
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (!res.ok) throw new Error(`OpenAlex returned ${res.status}`)
    return res.json()
  }
}

function deInvert(inv: Record<string, number[]> | null): string | null {
  if (!inv) return null
  const words: string[] = []
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w
  return words.join(' ')
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
  return {
    id: short(j.id),
    title: j.display_name ?? '(untitled)',
    year: j.publication_year ?? 0,
    citedBy: j.cited_by_count ?? 0,
    authors: (j.authorships ?? []).map((a: any) => a.author?.display_name).filter(Boolean),
    venue: j.primary_location?.source?.display_name ?? null,
    arxivId: findArxivId(j),
    refs: (j.referenced_works ?? []).map(short),
    recentCites,
    doi: j.doi ?? null,
    abstract: deInvert(j.abstract_inverted_index ?? null),
    isSeed: false,
  }
}

export async function resolveSeed(input: string): Promise<Work> {
  const q = input.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  if (/^10\.\d{4,}\//.test(q)) {
    return parseWork(await getJson(`/works/doi:${q}?select=${SELECT}`))
  }
  const j = await getJson(`/works?search=${encodeURIComponent(q)}&per-page=1&select=${SELECT}`)
  if (!j.results?.length) throw new Error(`No paper found for “${input}”`)
  return parseWork(j.results[0])
}

export async function buildCorpus(seeds: Work[], onStatus: (msg: string) => void): Promise<Corpus> {
  const pool = new Map<string, Work>()
  for (const s of seeds) pool.set(s.id, { ...s, isSeed: true })

  // how many distinct seed-neighborhood links corroborate each candidate
  const links = new Map<string, number>()
  const bump = (id: string) => links.set(id, (links.get(id) ?? 0) + 1)

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]
    onStatus(`Pulling citations ${i + 1}/${seeds.length}: ${s.title.slice(0, 48)}…`)
    for (const r of s.refs) bump(r)
    const j = await getJson(
      `/works?filter=cites:${s.id}&per-page=${CITERS_PER_SEED}&sort=cited_by_count:desc&select=${SELECT}`,
    )
    for (const raw of j.results ?? []) {
      const w = parseWork(raw)
      if (!pool.has(w.id)) pool.set(w.id, w)
      bump(w.id)
    }
  }

  const seedIds = new Set(seeds.map((s) => s.id))
  const candidates = [...links.entries()]
    .filter(([id]) => !seedIds.has(id))
    .sort(
      (a, b) => b[1] - a[1] || (pool.get(b[0])?.citedBy ?? 0) - (pool.get(a[0])?.citedBy ?? 0),
    )
    .slice(0, MAX_NODES - seeds.length)
    .map(([id]) => id)

  const toFetch = candidates.filter((id) => !pool.has(id))
  for (let i = 0; i < toFetch.length; i += 50) {
    onStatus(`Fetching papers ${Math.min(i + 50, toFetch.length)}/${toFetch.length}…`)
    const j = await getJson(
      `/works?filter=openalex:${toFetch.slice(i, i + 50).join('|')}&per-page=50&select=${SELECT}`,
    )
    for (const raw of j.results ?? []) {
      const w = parseWork(raw)
      pool.set(w.id, w)
    }
  }

  const keep = new Set([...seedIds, ...candidates])
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
