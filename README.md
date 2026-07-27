# ariadne

Follow the thread through the literature. Give ariadne a few seed papers and it
weaves a citation graph around them from [OpenAlex](https://openalex.org),
ranks what it finds, and lets you explore the result as a constellation,
concentric rings, a sphere, a timeline, or a gallery of first figures.

**Live:** https://brandonlukas.github.io/ariadne

## Use

1. Search for or paste a paper (title, DOI, arXiv id, or OpenAlex id) and add it as a seed.
2. Add a couple more seeds — the interesting papers are the ones that connect them.
3. Weave. Papers are ranked by configurable metrics (citations, recency, bridging, …).
4. Click any paper for details, its thread back to your seeds, and an optional
   LLM one-liner on why it matters.

Everything runs in the browser; the corpus is cached in IndexedDB so re-weaves are instant.

### Keys (both optional, bring-your-own)

- **OpenAlex** — anonymous use shares a small per-IP daily budget; a free key
  ([openalex.org/settings/api](https://openalex.org/settings/api)) gives 10× the room.
- **OpenRouter** — enables the "why it matters" summaries via free-tier models.

Keys live in localStorage only; nothing is shipped in the repo.

## Develop

```sh
npm install
npm run dev     # vite dev server
npm test        # node-run unit tests for metrics + api
npm run build   # typecheck + bundle to dist/
```

TypeScript + Vite, one runtime dependency (`d3-force`).
