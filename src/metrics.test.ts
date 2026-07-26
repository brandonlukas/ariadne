import assert from 'node:assert'
import { pagerank, betweenness, seedDistance, computeMetrics, PRESETS } from './metrics.ts'

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
    { recentCites: 10, citedBy: 12, year: 2022, isSeed: true },
    { recentCites: 0, citedBy: 500, year: 2015, isSeed: false },
  ],
  [[1, 0]],
)
assert(m.every((x) => x.score >= 0 && x.score <= 1.0001))
assert(m[0].parts.relevance === 1)
// hot-and-new beats the settled classic on momentum
assert(m[0].parts.momentum > m[1].parts.momentum)

// a paper touching both seeds gets the bridge boost: 0.5 prox * 1.6 = 0.8
const b = computeMetrics(
  [
    { recentCites: 0, citedBy: 10, year: 2021, isSeed: true },
    { recentCites: 0, citedBy: 10, year: 2022, isSeed: true },
    { recentCites: 5, citedBy: 5, year: 2023, isSeed: false },
  ],
  [
    [2, 0],
    [2, 1],
  ],
)
assert(b[2].seedLinks === 2)
assert(Math.abs(b[2].parts.relevance - 0.8) < 1e-9)

// era gate: identical stats, but the paper predating the seed scores era-times less
const e = computeMetrics(
  [
    { recentCites: 0, citedBy: 10, year: 2022, isSeed: true },
    { recentCites: 9, citedBy: 9, year: 2015, isSeed: false },
    { recentCites: 9, citedBy: 9, year: 2023, isSeed: false },
  ],
  [
    [1, 0],
    [2, 0],
  ],
  PRESETS.catchup,
)
assert(Math.abs(e[1].score - PRESETS.catchup.era * e[2].score) < 1e-9)

console.log('metrics ok')
