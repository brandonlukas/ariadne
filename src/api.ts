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
const MAX_NODES = 200
const CITERS_PER_SEED = 50

const short = (url: string) => url.slice(url.lastIndexOf('/') + 1)
export const stripDoi = (s: string) => s.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')

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
  const arxivId = findArxivId(j)
  return {
    id: short(j.id),
    title: j.display_name ?? '(untitled)',
    year: j.publication_year ?? 0,
    citedBy: j.cited_by_count ?? 0,
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

export async function searchSeeds(q: string, n: number): Promise<Work[]> {
  const j = await getJson(`/works?search=${encodeURIComponent(q)}&per-page=${n}&select=${SELECT}`)
  return (j.results ?? []).map(parseWork)
}

export async function buildCorpus(seeds: Work[], onStatus: (msg: string) => void): Promise<Corpus> {
  const pool = new Map<string, Work>()
  for (const s of seeds) pool.set(s.id, { ...s, isSeed: true })
  const thisYear = new Date().getFullYear()

  // every id met in the seed neighborhood — refs, citers, heavy co-citations
  const seen = new Set<string>()
  // co-citation: papers cited alongside a seed by a tenth of its sampled
  // citers earn neighborhood membership — the only signal that reaches true
  // contemporaries, which often share no direct edge with the seed. The bar is
  // relative per seed: an absolute one would silently never fire for niche
  // seeds with few citers.
  const coEarned = new Map<string, number>()

  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i]
    onStatus(`Pulling citations ${i + 1}/${seeds.length}: ${s.title.slice(0, 48)}…`)
    for (const r of s.refs) seen.add(r)
    // three pulls per seed: the canon (all-time top-cited), the pulse (newest by
    // date), and the frontier (last-2-years citers ranked by traction)
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

  const seedIds = new Set(seeds.map((s) => s.id))

  // co-citation credit is capped below what two direct links buy, so peers
  // never outrank true bridges
  const earned = (id: string) => Math.min(2, coEarned.get(id) ?? 0)
  for (const [id] of coEarned) if (!seedIds.has(id)) seen.add(id)

  // fetch every candidate we only know as a reference id — unfetched refs rank
  // at zero, which silently dropped the seeds' actual contemporaries (SwinIR,
  // MPRNet, IPT never made the corpus) while 50-citation citers walked in
  const unknown = [...seen].filter((id) => !seedIds.has(id) && !pool.has(id))
  for (let i = 0; i < unknown.length; i += 50) {
    onStatus(`Reading references ${Math.min(i + 50, unknown.length)}/${unknown.length}…`)
    const j = await getJson(
      `/works?filter=openalex:${unknown.slice(i, i + 50).join('|')}&per-page=50&select=${SELECT}`,
    )
    for (const raw of j.results ?? []) {
      const w = parseWork(raw)
      pool.set(w.id, w)
    }
  }

  // direct links counted from actual citation data, not pull membership — a
  // paper citing both seeds may surface in only one seed's pulls (StruNet did)
  const refOfSeed = new Map<string, number>()
  for (const s of seeds) for (const r of s.refs) refOfSeed.set(r, (refOfSeed.get(r) ?? 0) + 1)
  const directOf = (id: string) =>
    (refOfSeed.get(id) ?? 0) + (pool.get(id)?.refs.filter((r) => seedIds.has(r)).length ?? 0)
  const corro = (id: string) => directOf(id) + earned(id)

  // tiebreak on citations per year, not lifetime count — else age wins every tie
  const perYear = (id: string) => {
    const w = pool.get(id)
    return w ? w.citedBy / Math.max(1, thisYear - w.year + 1) : 0
  }
  const ranked = [...seen]
    .filter((id) => !seedIds.has(id))
    .sort((a, b) => corro(b) - corro(a) || perYear(b) - perYear(a))
  const cutN = MAX_NODES - seeds.length
  const candidates = ranked.slice(0, cutN)
  // recency quota: the cut otherwise re-drops the young low-cite papers the
  // frontier pull just harvested — reserve a quarter of the slots for them
  const isRecent = (id: string) => (pool.get(id)?.year ?? 0) >= thisYear - 2
  const quota = Math.floor(cutN * 0.25)
  let need = quota - candidates.filter(isRecent).length
  if (need > 0) {
    const extra = ranked.slice(cutN).filter(isRecent).slice(0, need)
    for (let i = candidates.length - 1; i >= 0 && extra.length; i--)
      if (!isRecent(candidates[i])) candidates.splice(i, 1, extra.shift()!)
  }
  // every lens owns a slice of the cut — without one for strict chronology,
  // brand-new zero-citation work always loses the traction contest and the
  // "newest" rank could only show survivors of other lenses' criteria
  const fresh = ranked
    .filter((id) => !candidates.includes(id) && (pool.get(id)?.year ?? 0) >= thisYear - 1)
    .slice(0, 10)
  for (const id of fresh)
    for (let i = candidates.length - 1; i >= 0; i--) {
      const c = candidates[i]
      if ((pool.get(c)?.year ?? 0) < thisYear - 1 && directOf(c) < 2) {
        candidates.splice(i, 1)
        candidates.push(id)
        break
      }
    }

  // papers directly touching 2+ seeds are the rarest, most intent-relevant
  // finds in the graph — they must never lose the cut to co-cited crowds
  for (const id of ranked)
    if (directOf(id) >= 2 && !candidates.includes(id))
      for (let i = candidates.length - 1; i >= 0; i--)
        if (directOf(candidates[i]) < 2) {
          candidates.splice(i, 1)
          candidates.push(id)
          break
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
