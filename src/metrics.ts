export interface Metrics {
  score: number
  parts: { foundational: number; bridge: number; momentum: number; relevance: number }
}

export function pagerank(n: number, edges: [number, number][], d = 0.85, iters = 50): number[] {
  const out = new Array(n).fill(0)
  for (const [s] of edges) out[s]++
  let pr: number[] = new Array(n).fill(1 / n)
  for (let it = 0; it < iters; it++) {
    const next = new Array(n).fill(0)
    let dangling = 0
    for (let i = 0; i < n; i++) if (out[i] === 0) dangling += pr[i]
    for (const [s, t] of edges) next[t] += pr[s] / out[s]
    for (let i = 0; i < n; i++) next[i] = (1 - d) / n + d * (next[i] + dangling / n)
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

const norm = (xs: number[]) => {
  const m = Math.max(...xs, 1e-12)
  return xs.map((x) => x / m)
}

export function computeMetrics(
  works: { recentCites: number; isSeed: boolean }[],
  edges: [number, number][],
): Metrics[] {
  const n = works.length
  const pr = norm(pagerank(n, edges))
  const bt = norm(betweenness(n, edges))
  const vel = norm(works.map((w) => Math.log1p(w.recentCites)))
  const dist = seedDistance(n, edges, works.flatMap((w, i) => (w.isSeed ? [i] : [])))
  const prox = dist.map((d) => (Number.isFinite(d) ? 1 / (1 + d) : 0))
  return works.map((_, i) => {
    const parts = { foundational: pr[i], bridge: bt[i], momentum: vel[i], relevance: prox[i] }
    return {
      score: 0.35 * pr[i] + 0.25 * bt[i] + 0.2 * vel[i] + 0.2 * prox[i],
      parts,
    }
  })
}
