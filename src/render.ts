import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force'

export type ViewMode = 'constellation' | 'circle' | 'sphere' | 'timeline'

export interface GraphNode extends SimulationNodeDatum {
  id: string
  r: number
  color: string
  label: string
  isSeed: boolean
  labeled: boolean
  year: number
}

type GraphLink = SimulationLinkDatum<GraphNode>

// canvas can't see CSS vars — mirror them; readTheme() re-reads on a scheme flip
export let THREAD = '#b41f3a'
let PAPER = '#ffffff'
let INK = '#1b1a17'
let GRAY = '#6e6c65'
let FAINT = '#a6a49c'
let inkRGB = '27,26,23'
export function readTheme() {
  const s = getComputedStyle(document.documentElement)
  const v = (name: string, fb: string) => s.getPropertyValue(name).trim() || fb
  PAPER = v('--paper', PAPER)
  THREAD = v('--thread', THREAD)
  INK = v('--ink', INK)
  GRAY = v('--gray', GRAY)
  FAINT = v('--faint', FAINT)
  inkRGB = [1, 3, 5].map((i) => parseInt(INK.slice(i, i + 2), 16)).join(',')
}
readTheme()
const inkA = (a: number) => `rgba(${inkRGB},${a})`
const SR = 400 // sphere radius in world units
const TW = 1200 // timeline width in world units
const GA = 2.399963229728653 // golden angle

export function createRenderer(
  canvas: HTMLCanvasElement,
  cb: { onHover(id: string | null): void; onSelect(id: string | null): void },
) {
  const ctx = canvas.getContext('2d')!
  let nodes: GraphNode[] = []
  let edgeIdx: [number, number][] = []
  let sim: Simulation<GraphNode, GraphLink> | null = null
  let byId = new Map<string, number>()
  let adj: Set<number>[] = []

  let mode: ViewMode = 'constellation'
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches
  const rot = { theta: 0.4, phi: 0.25 }
  let rotTarget: number | null = null

  // per-node display state, lerped toward the active layout each frame
  let dx: number[] = []
  let dy: number[] = []
  let da: number[] = []
  let dr: number[] = []
  let circPos: [number, number][] = []
  let ringR: number[] = []
  let maxRingR = 0
  let sphereU: [number, number, number][] = []
  let timePos: [number, number][] = []
  let timeSpan: [number, number] = [0, 0]
  let timeMaxOff = 0

  const view = { x: 0, y: 0, k: 1 }
  const target = { x: 0, y: 0, k: 1 }
  let hovered: number | null = null
  let selected: number | null = null
  let external: number | null = null
  let visible: Set<string> | null = null // year-brush filter; null = everything
  const ghosted = (i: number) => visible !== null && !visible.has(nodes[i].id)

  let w = 0
  let h = 0
  const dpr = window.devicePixelRatio || 1

  function resize() {
    w = canvas.clientWidth
    h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
  }
  new ResizeObserver(resize).observe(canvas)
  resize()

  const toWorld = (px: number, py: number) => ({
    x: (px - w / 2 - view.x) / view.k,
    y: (py - h / 2 - view.y) / view.k,
  })

  const hitSlop = matchMedia('(pointer: coarse)').matches ? 20 : 9

  function findNode(px: number, py: number): number | null {
    const p = toWorld(px, py)
    let best: number | null = null
    let bestD = Infinity
    for (let i = 0; i < nodes.length; i++) {
      if (da[i] < 0.5 || ghosted(i)) continue
      const d = Math.hypot(dx[i] - p.x, dy[i] - p.y)
      if (d < Math.max(dr[i] + 2, hitSlop / view.k) && d < bestD) {
        best = i
        bestD = d
      }
    }
    return best
  }

  // concentric rings: ring = citation-hops from the seeds, neighborhoods kept together by angle
  function computeCircle() {
    const n = nodes.length
    const depth = new Array(n).fill(Infinity)
    const queue: number[] = []
    nodes.forEach((nd, i) => {
      if (nd.isSeed) {
        depth[i] = 0
        queue.push(i)
      }
    })
    for (let qi = 0; qi < queue.length; qi++)
      for (const nb of adj[queue[qi]])
        if (!Number.isFinite(depth[nb])) {
          depth[nb] = depth[queue[qi]] + 1
          queue.push(nb)
        }
    const maxDepth = Math.max(0, ...depth.filter(Number.isFinite))
    const rings: number[][] = []
    for (let i = 0; i < n; i++) {
      const d = Number.isFinite(depth[i]) ? depth[i] : maxDepth + 1
      ;(rings[d] ??= []).push(i)
    }
    ringR = []
    let prevR = 0
    rings.forEach((members, d) => {
      if (!members) return
      ringR[d] =
        d === 0
          ? members.length > 1
            ? 48
            : 0
          : Math.max(prevR + 85, (members.length * 25) / (2 * Math.PI))
      prevR = ringR[d]
    })
    maxRingR = prevR
    circPos = new Array(n)
    rings.forEach((members, d) => {
      if (!members) return
      members.sort((a, b) => Math.atan2(nodes[a].y ?? 0, nodes[a].x ?? 0) - Math.atan2(nodes[b].y ?? 0, nodes[b].x ?? 0))
      members.forEach((i, k) => {
        const a = -Math.PI / 2 + (2 * Math.PI * k) / members.length + d * 0.35
        circPos[i] = [Math.cos(a) * ringR[d], Math.sin(a) * ringR[d]]
      })
    })
  }

  // columns per year, strongest paper at the spine, the rest alternating outward —
  // every citation edge points left, into the past
  function computeTimeline() {
    const years = nodes.map((n) => n.year).filter(Boolean)
    const minY = Math.min(...years)
    const span = Math.max(1, Math.max(...years) - minY)
    timeSpan = [minY, minY + span]
    const cols = new Map<number, number[]>()
    nodes.forEach((n, i) => {
      const y = n.year || minY // unknown years join the oldest column
      ;(cols.get(y) ?? cols.set(y, []).get(y)!).push(i)
    })
    timePos = new Array(nodes.length)
    timeMaxOff = 0
    for (const [year, members] of cols) {
      members.sort((a, b) => nodes[b].r - nodes[a].r)
      members.forEach((i, k) => {
        const off = Math.ceil(k / 2) * 26 * (k % 2 ? 1 : -1)
        timeMaxOff = Math.max(timeMaxOff, Math.abs(off))
        timePos[i] = [((year - minY) / span) * TW - TW / 2, off]
      })
    }
  }

  function fitK(m: ViewMode): number {
    const pad = 90
    if (m === 'circle') return Math.min(w, h) / (2 * maxRingR + 2 * pad)
    if (m === 'sphere') return Math.min(w, h) / (2 * SR + 2 * pad)
    if (m === 'timeline')
      return Math.min(w / (TW + 2 * pad), h / (2 * timeMaxOff + 2 * pad))
    return 1
  }

  function step(dt: number) {
    if (mode === 'sphere' && !reducedMotion && selected == null && rotTarget == null) rot.theta += dt * 0.07
    if (rotTarget != null) {
      const d = ((((rotTarget - rot.theta + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI
      rot.theta += d * 0.07
      if (Math.abs(d) < 0.01) rotTarget = null
    }
    const ct = Math.cos(rot.theta)
    const st = Math.sin(rot.theta)
    const cp = Math.cos(rot.phi)
    const sp = Math.sin(rot.phi)
    for (let i = 0; i < nodes.length; i++) {
      let tx: number, ty: number, ta: number, tr: number
      if (mode === 'constellation') {
        tx = nodes[i].x ?? 0
        ty = nodes[i].y ?? 0
        ta = 1
        tr = nodes[i].r
      } else if (mode === 'circle' || mode === 'timeline') {
        ;[tx, ty] = (mode === 'circle' ? circPos : timePos)[i]
        ta = 1
        tr = nodes[i].r
      } else {
        const [ux, uy, uz] = sphereU[i]
        const x1 = ux * ct + uz * st
        const z1 = -ux * st + uz * ct
        const y2 = uy * cp - z1 * sp
        const z2 = uy * sp + z1 * cp
        tx = x1 * SR
        ty = y2 * SR
        ta = z2 > 0 ? 1 : 0.13
        tr = nodes[i].r * 0.64
      }
      dx[i] += (tx - dx[i]) * 0.14
      dy[i] += (ty - dy[i]) * 0.14
      da[i] += (ta - da[i]) * 0.2
      dr[i] += (tr - dr[i]) * 0.14
    }
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (w / 2 + view.x), dpr * (h / 2 + view.y))
    const active = hovered ?? external ?? selected
    const hood = active != null ? adj[active] : null

    if (mode === 'timeline') {
      // year gridlines and labels in world space; font counter-scaled to stay 10px
      ctx.strokeStyle = inkA(0.06)
      ctx.lineWidth = 1 / view.k
      ctx.fillStyle = FAINT
      ctx.font = `${10 / view.k}px -apple-system, "Helvetica Neue", sans-serif`
      ctx.textAlign = 'center'
      const [minY, maxY] = timeSpan
      const span = maxY - minY // ≥1 by construction in computeTimeline
      const ext = timeMaxOff + 40
      for (let y = Math.ceil(minY / 5) * 5; y <= maxY; y += 5) {
        const gx = ((y - minY) / span) * TW - TW / 2
        ctx.beginPath()
        ctx.moveTo(gx, -ext)
        ctx.lineTo(gx, ext)
        ctx.stroke()
        ctx.fillText(String(y), gx, ext + 18 / view.k)
      }
    }

    if (mode === 'circle') {
      ctx.strokeStyle = inkA(0.07)
      ctx.lineWidth = 1 / view.k
      ringR.forEach((R, d) => {
        if (!R) return
        const segs = 5 + ((d * 2) % 4)
        for (let k = 0; k < segs; k++) {
          const a0 = (k / segs) * 2 * Math.PI + Math.sin(d * 7 + k * 13) * 0.2
          ctx.beginPath()
          ctx.arc(0, 0, R, a0, a0 + ((2 * Math.PI) / segs) * 0.8)
          ctx.stroke()
        }
      })
    }

    for (const [s, t] of edgeIdx) {
      const lit = active != null && (s === active || t === active)
      if (mode === 'sphere' && !lit) continue
      ctx.strokeStyle = lit ? THREAD + 'cc' : inkA(0.06)
      ctx.lineWidth = (lit ? 1.5 : 1) / view.k
      ctx.globalAlpha = Math.min(da[s], da[t]) * (ghosted(s) || ghosted(t) ? 0.15 : 1)
      ctx.beginPath()
      ctx.moveTo(dx[s], dy[s])
      ctx.lineTo(dx[t], dy[t])
      ctx.stroke()
      ctx.globalAlpha = 1
    }
    for (let i = 0; i < nodes.length; i++) {
      const dim = active != null && i !== active && !hood!.has(i)
      ctx.globalAlpha = da[i] * (dim ? 0.25 : 1) * (ghosted(i) ? 0.12 : 1)
      ctx.beginPath()
      ctx.arc(dx[i], dy[i], dr[i], 0, Math.PI * 2)
      ctx.fillStyle = nodes[i].color
      ctx.fill()
      if (i === active || i === selected) {
        ctx.strokeStyle = THREAD
        ctx.lineWidth = 1.4 / view.k
        ctx.beginPath()
        ctx.arc(dx[i], dy[i], dr[i] + 4 / view.k, 0, Math.PI * 2)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
    ctx.font = '11px -apple-system, "Helvetica Neue", sans-serif'
    ctx.textAlign = 'center'
    for (let i = 0; i < nodes.length; i++) {
      const wantLabel =
        mode === 'sphere'
          ? i === active || i === selected
          : mode === 'timeline' // the spine stacks the strongest papers — full labels collide
            ? nodes[i].isSeed || i === active || i === selected
            : nodes[i].labeled || i === active || i === selected
      if (!wantLabel || ghosted(i)) continue
      const dim = active != null && i !== active && !hood!.has(i)
      ctx.globalAlpha = da[i] * (dim ? 0.2 : 1)
      let ly = dy[i] + dr[i] + 13
      if (mode === 'timeline' && nodes[i].isSeed && i !== active && i !== selected) {
        // seeds share the spine — alternate labels above/below so close seeds don't collide
        let ord = 0
        for (let j = 0; j < i; j++) if (nodes[j].isSeed) ord++
        if (ord % 2) ly = dy[i] - dr[i] - 6
      }
      ctx.strokeStyle = PAPER
      ctx.lineWidth = 3
      ctx.strokeText(nodes[i].label, dx[i], ly)
      ctx.fillStyle = i === active || i === selected ? INK : GRAY
      ctx.fillText(nodes[i].label, dx[i], ly)
      ctx.globalAlpha = 1
    }
  }

  let lastT = performance.now()
  function frame(t: number) {
    const dt = Math.min(0.05, (t - lastT) / 1000)
    lastT = t
    view.x += (target.x - view.x) * 0.14
    view.y += (target.y - view.y) * 0.14
    view.k += (target.k - view.k) * 0.14
    step(dt)
    draw()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // --- interaction ---
  let dragging: number | null = null
  let panning = false
  let moved = false
  let last = { x: 0, y: 0 }
  const pinch = new Map<number, { x: number; y: number }>() // active touch points
  let pinchDist = 0

  const dropDrag = () => {
    if (dragging != null) {
      nodes[dragging].fx = nodes[dragging].fy = null
      sim?.alphaTarget(0)
      dragging = null
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId)
    if (e.pointerType === 'touch') {
      pinch.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
      if (pinch.size === 2) {
        // second finger: whatever the first was doing becomes a pinch
        dropDrag()
        panning = false
        const [a, b] = [...pinch.values()]
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y)
        moved = true
        return
      }
    }
    moved = false
    last = { x: e.offsetX, y: e.offsetY }
    const n = mode === 'constellation' ? findNode(e.offsetX, e.offsetY) : null
    if (n != null && sim) {
      dragging = n
      nodes[n].fx = nodes[n].x
      nodes[n].fy = nodes[n].y
      sim.alphaTarget(0.25).restart()
    } else {
      panning = true
    }
  })

  canvas.addEventListener('pointermove', (e) => {
    if (pinch.has(e.pointerId)) pinch.set(e.pointerId, { x: e.offsetX, y: e.offsetY })
    if (pinch.size === 2) {
      // zoom about the midpoint, same math as the wheel handler
      const [a, b] = [...pinch.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      if (pinchDist > 0) {
        const k2 = Math.min(6, Math.max(0.15, view.k * (d / pinchDist)))
        const p = toWorld(mx, my)
        view.x = target.x = mx - w / 2 - p.x * k2
        view.y = target.y = my - h / 2 - p.y * k2
        view.k = target.k = k2
      }
      pinchDist = d
      return
    }
    if (dragging != null) {
      const p = toWorld(e.offsetX, e.offsetY)
      nodes[dragging].fx = p.x
      nodes[dragging].fy = p.y
      dx[dragging] = p.x
      dy[dragging] = p.y
      moved = true
    } else if (panning) {
      const mx = e.offsetX - last.x
      const my = e.offsetY - last.y
      if (mode === 'sphere') {
        rot.theta += mx * 0.004
        rot.phi = Math.max(-1.2, Math.min(1.2, rot.phi + my * 0.004))
        rotTarget = null
      } else {
        target.x = view.x = view.x + mx
        target.y = view.y = view.y + my
      }
      last = { x: e.offsetX, y: e.offsetY }
      if (Math.abs(mx) + Math.abs(my) > 1) moved = true
    } else {
      const n = findNode(e.offsetX, e.offsetY)
      if (n !== hovered) {
        hovered = n
        canvas.style.cursor = n != null ? 'pointer' : 'default'
        cb.onHover(n != null ? nodes[n].id : null)
      }
    }
  })

  canvas.addEventListener('pointerleave', () => {
    if (hovered != null) {
      hovered = null
      canvas.style.cursor = 'default'
      cb.onHover(null)
    }
  })

  canvas.addEventListener('pointercancel', (e) => {
    pinch.delete(e.pointerId)
    dropDrag()
    panning = false
  })

  canvas.addEventListener('pointerup', (e) => {
    pinch.delete(e.pointerId)
    if (dragging != null) {
      const n = dragging
      dragging = null
      sim?.alphaTarget(0)
      nodes[n].fx = nodes[n].fy = null
      if (!moved) {
        selected = n
        cb.onSelect(nodes[n].id)
      }
    } else if (panning) {
      panning = false
      if (!moved) {
        const n = findNode(e.offsetX, e.offsetY)
        selected = n
        cb.onSelect(n != null ? nodes[n].id : null)
      }
    }
  })

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const f = Math.exp(-e.deltaY * 0.002)
    const k2 = Math.min(6, Math.max(0.15, view.k * f))
    const p = toWorld(e.offsetX, e.offsetY)
    view.x = target.x = e.offsetX - w / 2 - p.x * k2
    view.y = target.y = e.offsetY - h / 2 - p.y * k2
    view.k = target.k = k2
  }, { passive: false })

  return {
    setData(newNodes: GraphNode[], edgePairs: [string, string][]) {
      nodes = newNodes
      byId = new Map(nodes.map((n, i) => [n.id, i]))
      edgeIdx = edgePairs.map(([s, t]) => [byId.get(s)!, byId.get(t)!])
      adj = nodes.map(() => new Set<number>())
      for (const [s, t] of edgeIdx) {
        adj[s].add(t)
        adj[t].add(s)
      }
      hovered = selected = external = null
      sim?.stop()
      sim = forceSimulation(nodes)
        .force('link', forceLink<GraphNode, GraphLink>(edgeIdx.map(([s, t]) => ({ source: s, target: t }))).distance(45).strength(0.25))
        .force('charge', forceManyBody().strength(-140))
        .force('x', forceX(0).strength(0.06))
        .force('y', forceY(0).strength(0.06))
        .force('collide', forceCollide<GraphNode>((d) => d.r + 3))
      dx = nodes.map((n) => n.x ?? 0)
      dy = nodes.map((n) => n.y ?? 0)
      da = nodes.map(() => 1)
      dr = nodes.map((n) => n.r)
      // sphere: Fibonacci spiral, oldest papers at the top pole
      const byYear = nodes.map((_, i) => i).sort((a, b) => nodes[a].year - nodes[b].year)
      sphereU = new Array(nodes.length)
      byYear.forEach((i, j) => {
        const y = 1 - (2 * (j + 0.5)) / nodes.length
        const rad = Math.sqrt(1 - y * y)
        sphereU[i] = [Math.cos(j * GA) * rad, y, Math.sin(j * GA) * rad]
      })
      mode = 'constellation'
      view.x = view.y = target.x = target.y = 0
      view.k = target.k = 1
    },
    setMode(m: ViewMode) {
      if (m === mode) return
      if (m === 'circle') computeCircle()
      if (m === 'timeline') computeTimeline()
      mode = m
      rotTarget = null
      if (m === 'constellation') sim?.alpha(0.15).restart()
      else sim?.stop()
      target.x = target.y = 0
      target.k = fitK(m)
    },
    restyle(style: Map<string, { r: number; labeled: boolean }>) {
      // sizes lerp toward the new radii in step(); no relayout needed
      for (const n of nodes) {
        const s = style.get(n.id)
        if (s) {
          n.r = s.r
          n.labeled = s.labeled
        }
      }
    },
    recolor(color: (n: GraphNode) => string) {
      for (const n of nodes) n.color = color(n)
    },
    highlight(id: string | null) {
      external = id ? (byId.get(id) ?? null) : null
    },
    focus(id: string) {
      const i = byId.get(id)
      if (i === undefined) return
      selected = i
      if (mode === 'sphere') {
        const [ux, , uz] = sphereU[i]
        rotTarget = Math.atan2(-ux, uz)
        target.x = target.y = 0
      } else {
        target.k = Math.max(view.k, 1.1)
        // center in the area left of the 384px detail panel
        target.x = -dx[i] * target.k - 192
        target.y = -dy[i] * target.k
      }
    },
    select(id: string | null) {
      selected = id ? (byId.get(id) ?? null) : null
    },
    setFilter(ids: Set<string> | null) {
      visible = ids
    },
  }
}
