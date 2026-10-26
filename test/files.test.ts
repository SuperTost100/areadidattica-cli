import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { safeSegment } from '../src/files.ts';

describe('safeSegment', () => {
  it('keeps ordinary names as they are', () => {
    assert.equal(safeSegment('L01 Introduzione (v2).pdf', 'x'), 'L01 Introduzione (v2).pdf');
  });

  it('turns path separators and control characters into underscores', () => {
    assert.equal(safeSegment('a/b\\c\nd.pdf', 'x'), 'a_b_c_d.pdf');
  });

  it('never yields . or ..', () => {
    assert.equal(safeSegment('..', 'fallback'), 'fallback');
    assert.equal(safeSegment('.', 'fallback'), 'fallback');
    assert.equal(safeSegment('   ', 'fallback'), 'fallback');
    assert.equal(safeSegment('.hidden', 'x'), 'hidden');
  });

  it('caps long names', () => {
    assert.equal(safeSegment('a'.repeat(400), 'x').length, 150);
  });
});
