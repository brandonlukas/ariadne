export interface Metrics {
  score: number
  seedLinks: number // distinct seeds this paper directly cites or is cited by
  parts: { foundational: number; bridge: number; momentum: number; relevance: number }
}

// era: score multiplier for papers not newer than the latest seed. Classics and
// seed-era peers out-collect every new paper in absolute recent citations, so
// without this gate they top "catch-up" too — but only papers published after
// the seeds can be developments since them. Seeds themselves are exempt.
type Weights = { f: number; b: number; m: number; r: number; era: number }
// weighting presets behind the ask row: canon = committee-exam classics,
// catchup = developments since the seeds
export const PRESETS: Record<'canon' | 'catchup' | 'loadbearing', Weights> = {
  canon: { f: 0.35, b: 0.25, m: 0.2, r: 0.2, era: 1 },
  catchup: { f: 0.1, b: 0.15, m: 0.45, r: 0.3, era: 0.5 },
  // roots mode: ancestry is a closed world — no momentum, no era gate, and
  // foundational becomes personalized ("load-bearing for YOUR lineage")
  loadbearing: { f: 0.6, b: 0.25, m: 0, r: 0.15, era: 1 },
}

// restart: optional teleport distribution. Uniform = classic PageRank; mass on
// the seeds = personalized PageRank ("a reader starts at YOUR papers and
// forever follows references — where do they keep arriving?")
export function pagerank(
  n: number,
  edges: [number, number][],
  d = 0.85,
  iters = 50,
  restart?: number[],
): number[] {
  const rv = restart ?? new Array(n).fill(1 / n)
  const out = new Array(n).fill(0)
  for (const [s] of edges) out[s]++
  let pr: number[] = [...rv]
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill(0)
    let dangling = 0
    for (let i = 0; i < n; i++) if (out[i] === 0) dangling += pr[i]
    for (const [s, t] of edges) next[t] += pr[s] / out[s]
    for (let i = 0; i < n; i++) next[i] = (1 - d) * rv[i] + d * (next[i] + dangling * rv[i])
    pr = next
  }
  return pr
}

function undirected(n: number, edges: [number, number][]): number[][] {
  const adj: number[][] = Array.from({ length: n }, () => [])
  for (const [s, t] of edges) {
    adj[s].push(t)
    adj[t].push(s)
  }
  return adj
}

// Brandes' algorithm on the undirected view
export function betweenness(n: number, edges: [number, number][]): number[] {
  const adj = undirected(n, edges)
  const bc = new Array(n).fill(0)
  for (let s = 0; s < n; s++) {
    const stack: number[] = []
    const pred: number[][] = Array.from({ length: n }, () => [])
    const sigma = new Array(n).fill(0)
    const dist = new Array(n).fill(-1)
    sigma[s] = 1
    dist[s] = 0
    const queue = [s]
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi]
      stack.push(v)
      for (const w of adj[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1
          queue.push(w)
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v]
          pred[w].push(v)
        }
      }
    }
    const delta = new Array(n).fill(0)
    while (stack.length) {
      const w = stack.pop()!
      for (const v of pred[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
      if (w !== s) bc[w] += delta[w]
    }
  }
  return bc
}

export function seedDistance(n: number, edges: [number, number][], seedIdx: number[]): number[] {
  const adj = undirected(n, edges)
  const dist = new Array(n).fill(Infinity)
  const queue = [...seedIdx]
  for (const i of seedIdx) dist[i] = 0
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi]
    for (const w of adj[v])
      if (!Number.isFinite(dist[w])) {
        dist[w] = dist[v] + 1
        queue.push(w)
      }
  }
  return dist
}

// rank-normalize: pagerank and citation counts are heavy-tailed, so dividing by
// the max lets one outlier compress everyone else to ~0; ties share a rank
const norm = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const first = new Map<number, number>()
  sorted.forEach((v, i) => {
    if (!first.has(v)) first.set(v, i)
  })
  const d = Math.max(1, xs.length - 1)
  return xs.map((v) => first.get(v)! / d)
}

export function computeMetrics(
  works: { recentCites: number; citedBy: number; year: number; isSeed: boolean }[],
  edges: [number, number][],
  w: Weights = PRESETS.canon,
  personalized = false,
): Metrics[] {
  const era = Math.max(0, ...works.filter((wk) => wk.isSeed && wk.year > 0).map((wk) => wk.year))
  const n = works.length
  const nSeeds = works.filter((wk) => wk.isSeed).length
  const restart =
    personalized && nSeeds ? works.map((wk) => (wk.isSeed ? 1 / nSeeds : 0)) : undefined
  const pr = norm(pagerank(n, edges, 0.85, 50, restart))
  const bt = norm(betweenness(n, edges))
  const vel = norm(works.map((wk) => Math.log1p(wk.recentCites)))
  // fraction of lifetime citations from the last 3 years — high for new-and-hot
  // papers at any absolute count, near zero for settled classics
  const rise = works.map((wk) => Math.min(1, wk.recentCites / Math.max(1, wk.citedBy)))
  const seedIdx = works.flatMap((wk, i) => (wk.isSeed ? [i] : []))
  const seedSet = new Set(seedIdx)
  const counted = works.map(() => new Set<number>())
  for (const [s, t] of edges) {
    if (seedSet.has(t)) counted[s].add(t)
    if (seedSet.has(s)) counted[t].add(s)
  }
  const links = counted.map((c) => c.size)
  const dist = seedDistance(n, edges, seedIdx)
  const prox = dist.map((d) => (Number.isFinite(d) ? 1 / (1 + d) : 0))
  // bridge boost: touching several seeds is the strongest relevance signal a
  // citation graph can give — proximity alone can't see it (d=1 either way)
  const rel = prox.map((p, i) => Math.min(1, p * (1 + 0.6 * Math.max(0, links[i] - 1))))
  return works.map((_, i) => {
    const parts = {
      foundational: pr[i],
      bridge: bt[i],
      momentum: 0.6 * vel[i] + 0.4 * rise[i],
      relevance: rel[i],
    }
    const raw =
      w.f * parts.foundational + w.b * parts.bridge + w.m * parts.momentum + w.r * parts.relevance
    return {
      score: works[i].year && !works[i].isSeed && works[i].year <= era ? raw * w.era : raw,
      seedLinks: links[i],
      parts,
    }
  })
}
