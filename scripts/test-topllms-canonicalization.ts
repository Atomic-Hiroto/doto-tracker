import assert from 'node:assert/strict';

import {
  canonicalModelKey,
  canonicalModelName,
} from '../src/commands/topLlms';

const opus5Variants = [
  'claude-opus-5-high',
  'Claude Opus 5 (Adaptive Reasoning, Max Effort)',
  '*claude-opus-5',
  'anthropic/claude_opus_5_xhigh',
];
assert.equal(new Set(opus5Variants.map(canonicalModelKey)).size, 1);

// A completely unknown future family must work without a hand-written alias.
const futureVariants = [
  'orion-nebula-7-xhigh',
  'Orion Nebula 7 (Adaptive Reasoning, Max Effort)',
  'vendor/orion_nebula_7-high',
];
assert.equal(new Set(futureVariants.map(canonicalModelKey)).size, 1);

assert.notEqual(canonicalModelKey('orion-nebula-7'), canonicalModelKey('orion-nebula-8'));
assert.equal(canonicalModelName('gpt-5.5-xhigh'), 'GPT-5.5');
assert.equal(canonicalModelName('Claude Fable 5 (max)'), 'Claude Fable 5');

console.log('Top LLM model canonicalization checks passed.');
