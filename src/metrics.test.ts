import assert from 'node:assert'
import { pagerank, betweenness, seedDistance, computeMetrics } from './metrics.ts'

// citation chain 0→1→2: rank accumulates downstream, sums to 1
const pr = pagerank(3, [
  [0, 1],
  [1, 2],
])
assert(pr[2] > pr[1] && pr[1] > pr[0])
assert(Math.abs(pr.reduce((a, b) => a + b) - 1) < 1e-6)

// path 0-1-2: only the middle node carries shortest paths
const bt = betweenness(3, [
  [0, 1],
  [1, 2],
])
assert(bt[1] > 0 && bt[0] === 0 && bt[2] === 0)

// star centered on 0
const st = betweenness(4, [
  [0, 1],
  [0, 2],
  [0, 3],
])
assert(st[0] > st[1])

const d = seedDistance(4, [
  [0, 1],
  [1, 2],
], [0])
assert.deepEqual(d.slice(0, 3), [0, 1, 2])
assert(!Number.isFinite(d[3]))

const m = computeMetrics(
  [
    { recentCites: 10, isSeed: true },
    { recentCites: 0, isSeed: false },
  ],
  [[1, 0]],
)
assert(m.every((x) => x.score >= 0 && x.score <= 1.0001))
assert(m[0].parts.relevance === 1)

console.log('metrics ok')
