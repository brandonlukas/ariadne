import assert from 'node:assert'
import { deTag, idLike, titleMatch } from './api.ts'

// PMIDs take the exact-resolve path instead of being text-searched as a title
assert(idLike('31978945'))
assert(idLike('PMID: 31978945'))
assert(idLike('https://pubmed.ncbi.nlm.nih.gov/31978945/'))
// the other id forms still route around search
assert(idLike('10.1038/nature14539') && idLike('https://doi.org/10.1038/nature14539'))
assert(idLike('arXiv:2301.12345') && idLike('2301.12345v2') && idLike('W2100837269'))
// a year or a title is not an id — these must still fuzzy-search
assert(!idLike('2019') && !idLike('attention is all you need'))

// exact title, punctuation and case ignored
assert(titleMatch('Attention Is All You Need', 'Attention is all you need.') === 1)
// partial query fully contained in a longer title still scores 1
assert(titleMatch('scaling monosemanticity', 'Scaling Monosemanticity: Extracting Interpretable Features') === 1)
// unrelated title scores low — below the 0.8 fallback bar
assert(titleMatch('attention is all you need', 'ImageNet Classification with Deep CNNs') < 0.8)
// empty query never divides by zero
assert(titleMatch('', 'anything') === 0)

// tags the old allowlist missed, and the whitespace they leave behind
assert(deTag('<tt>edgeR</tt>: a Bioconductor package') === 'edgeR: a Bioconductor package')
assert(deTag('<i>Drosophila</i> <mml:math><mml:mi>x</mml:mi></mml:math> genes') === 'Drosophila x genes')
// a bare comparison in a title is not markup
assert(deTag('when a < b holds') === 'when a < b holds')

console.log('api ok')
