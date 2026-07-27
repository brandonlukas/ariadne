import assert from 'node:assert'
import { titleMatch } from './api.ts'

// exact title, punctuation and case ignored
assert(titleMatch('Attention Is All You Need', 'Attention is all you need.') === 1)
// partial query fully contained in a longer title still scores 1
assert(titleMatch('scaling monosemanticity', 'Scaling Monosemanticity: Extracting Interpretable Features') === 1)
// unrelated title scores low — below the 0.8 fallback bar
assert(titleMatch('attention is all you need', 'ImageNet Classification with Deep CNNs') < 0.8)
// empty query never divides by zero
assert(titleMatch('', 'anything') === 0)

console.log('api ok')
