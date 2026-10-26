import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { destinations, safeSegment } from '../src/files.ts';

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

describe('destinations', () => {
  const file = (id: string, folder: string, name: string) => ({
    id, folder, name, sizeKB: 1, mimeType: 'application/pdf', createdAt: '2026-10-01T10:00:00Z', checksum: id,
  });

  it('keeps names that are unique in their folder', () => {
    const where = destinations([file('1', 'Lezioni', 'Slides.pdf'), file('2', 'Esami', 'Slides.pdf')]);
    assert.equal(where.get('1'), path.join('Lezioni', 'Slides.pdf'));
    assert.equal(where.get('2'), path.join('Esami', 'Slides.pdf'));
  });

  it('adds the id to files that would land on the same path', () => {
    const where = destinations([
      file('1', 'Lezioni', 'Slides.pdf'),
      file('2', 'Lezioni', 'slides.pdf'),
      file('3', 'Lezioni', 'a/b.pdf'),
      file('4', 'Lezioni', 'a_b.pdf'),
    ]);
    assert.deepEqual([...where.values()], [
      path.join('Lezioni', 'Slides (1).pdf'),
      path.join('Lezioni', 'slides (2).pdf'),
      path.join('Lezioni', 'a_b (3).pdf'),
      path.join('Lezioni', 'a_b (4).pdf'),
    ]);
  });

  it('never gives a generated name to a file that already has it', () => {
    const where = destinations([
      file('1', '', 'Slides.pdf'),
      file('2', '', 'Slides.pdf'),
      file('3', '', 'Slides (1).pdf'),
    ]);
    const paths = [...where.values()].map((p) => p.toLowerCase());
    assert.equal(new Set(paths).size, 3, paths.join(', '));
    assert.equal(where.get('3'), 'Slides (1).pdf');
  });
});
