import type { Work } from './api.ts'
import type { Metrics } from './metrics.ts'

// bring-your-own key: OpenRouter's free tier, never shipped in the repo
const KEY = 'ariadne:llm-key'
const MODEL_KEY = 'ariadne:llm-model'
// free models churn on OpenRouter — walk the list until one answers.
// gemma first: it doesn't reason, so it can't leak chain-of-thought into answers
export const MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openai/gpt-oss-20b:free',
]

let lastModel = ''
export const getLastModel = () => lastModel

export const getKey = () => localStorage.getItem(KEY) ?? ''
export const setKey = (k: string) => (k ? localStorage.setItem(KEY, k) : localStorage.removeItem(KEY))
export const getModel = () => localStorage.getItem(MODEL_KEY) ?? ''
export const setModel = (m: string) => (m ? localStorage.setItem(MODEL_KEY, m) : localStorage.removeItem(MODEL_KEY))

async function ask(prompt: string): Promise<string> {
  let err = new Error('AI request failed')
  // the user's chosen model goes first; the free list stays as the safety net
  const models = getModel() ? [getModel(), ...MODELS] : MODELS
  for (const model of models) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getKey()}` },
      body: JSON.stringify({
        model,
        max_tokens: 250,
        reasoning: { exclude: true }, // keep chain-of-thought out of the answer
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
    if (res.status === 401) throw new Error('AI key rejected (401) — check your OpenRouter key')
    if (!res.ok) {
      err = new Error(`AI request failed (${res.status})`)
      continue
    }
    const text = (await res.json()).choices?.[0]?.message?.content
      ?.replace(/<think>[\s\S]*?<\/think>/gi, '') // some reasoners think in-band anyway
      .trim()
    if (text) {
      lastModel = model
      return text
    }
    err = new Error('AI returned an empty answer')
  }
  throw err
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
    `Reading intent: ${intent}\nSeed papers: ${seedTitles.join(' · ')}\n\nCandidate paper: ${w.title} (${w.year}), cited ${w.citedBy} times (${w.recentCites} in the last 3 years), directly linked to ${m.seedLinks} of the seeds.${w.abstract ? `\nAbstract: ${w.abstract.slice(0, 800)}` : ''}\n\nIn 2 short sentences, tell the researcher why this paper does or does not matter for their intent. Output only those 2 sentences — no reasoning steps, no preamble.`,
  )
}
