import type { Work } from './api.ts'
import type { Metrics } from './metrics.ts'

// bring-your-own key: OpenRouter's free tier, never shipped in the repo
const KEY = 'ariadne:llm-key'
const MODEL = 'moonshotai/kimi-k2:free'

export const getKey = () => localStorage.getItem(KEY) ?? ''
export const setKey = (k: string) => (k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY))

async function ask(prompt: string): Promise<string> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 250,
      messages: [
        {
          role: 'system',
          content:
            'You help a researcher survey scientific literature. Be specific, concrete, and terse. Never use preamble or hedging.',
        },
        { role: 'user', content: prompt },
      ],
    }),
  })
  if (!res.ok) throw new Error(`AI request failed (${res.status})`)
  const j = await res.json()
  const text = j.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('AI returned an empty answer')
  return text
}

export function inferIntent(seeds: Work[]): Promise<string> {
  const list = seeds
    .map((s) => `- ${s.title} (${s.year})${s.abstract ? `: ${s.abstract.slice(0, 400)}` : ''}`)
    .join('\n')
  return ask(
    `A researcher chose these papers as seeds for a literature review:\n${list}\n\nIn one sentence, state the specific research question or reading intent this seed set implies.`,
  )
}

export function whyForIntent(intent: string, w: Work, m: Metrics, seedTitles: string[]): Promise<string> {
  return ask(
    `Reading intent: ${intent}\nSeed papers: ${seedTitles.join(' · ')}\n\nCandidate paper: ${w.title} (${w.year}), cited ${w.citedBy} times (${w.recentCites} in the last 3 years), directly linked to ${m.seedLinks} of the seeds.${w.abstract ? `\nAbstract: ${w.abstract.slice(0, 800)}` : ''}\n\nIn 2 short sentences, tell the researcher why this paper does or does not matter for their intent.`,
  )
}
