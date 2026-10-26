import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { courseFromTitle, htmlToText, parseNoticeScope, pickNotice, romeDate, romeDay } from '../src/normalize.ts';

describe('htmlToText', () => {
  it('keeps the Italian wording and drops only markup', () => {
    assert.equal(
      htmlToText('<p>L&#39;esame &egrave; <b>confermato</b> per gioved&igrave;&nbsp;alle 9.</p>'),
      "L'esame è confermato per giovedì alle 9.",
    );
  });

  it('writes links as label (url), or just the url when they match', () => {
    assert.equal(
      htmlToText('<a href="https://a.it/x">pagina</a> e <a href="https://b.it">https://b.it</a>'),
      'pagina (https://a.it/x) e https://b.it',
    );
  });

  it('turns breaks and paragraphs into newlines, without piling up blank lines', () => {
    assert.equal(htmlToText('<p>uno<br/>due</p>\r\r<p></p><p>tre</p>'), 'uno\ndue\n\ntre');
  });

  it('writes a table as one line per row, cells split by tabs, even with paragraphs in the cells', () => {
    const html =
      '<p>Calendario degli orali.</p><table><tbody>' +
      '<tr><td><p><strong>MATRICOLA</strong></p></td><td><p>Giorno</p></td><td><p>Aula</p></td></tr>' +
      '<tr><td><p>260240</p></td><td><p>Mercoled&igrave; 16<br>09:00</p></td><td></td></tr>' +
      '</tbody></table><p>Cari saluti</p>';
    assert.equal(
      htmlToText(html),
      'Calendario degli orali.\n\nMATRICOLA\tGiorno\tAula\n260240\tMercoledì 16 09:00\t\n\nCari saluti',
    );
  });
});

describe('parseNoticeScope', () => {
  it('reads the course id, with or without the teaching prefix and notice id', () => {
    assert.deepEqual(parseNoticeScope(['courses', '258674', 'notices']), { courseKey: '258674', noticeId: null });
    assert.deepEqual(parseNoticeScope(['teaching', 'courses', '1', 'notices', '42']), { courseKey: '1', noticeId: 42 });
    // The live API sends the ids as numbers.
    assert.deepEqual(parseNoticeScope(['teaching', 'courses', 303878, 'notices', 531892]), { courseKey: '303878', noticeId: 531892 });
  });

  it('ignores files, lectures and message notifications', () => {
    assert.equal(parseNoticeScope(['teaching', 'courses', '1', 'files']), null);
    assert.equal(parseNoticeScope(['messages', '7']), null);
    assert.equal(parseNoticeScope(undefined), null);
  });
});

describe('pickNotice', () => {
  const notices = [
    { id: 1, publishedAt: '2026-10-01T08:00:00Z', expiresAt: null, content: 'a' },
    { id: 2, publishedAt: '2026-10-12T08:00:00Z', expiresAt: null, content: 'b' },
  ];

  it('picks the notice published closest to the notification', () => {
    assert.equal(pickNotice(notices, { courseKey: '1', noticeId: null }, '2026-10-12T08:02:00Z')?.id, 2);
  });

  it('picks nothing when no notice is within a day', () => {
    assert.equal(pickNotice(notices, { courseKey: '1', noticeId: null }, '2026-10-05T08:00:00Z'), undefined);
  });
});

describe('courseFromTitle', () => {
  it('extracts the course from "Nuovo avviso da ..."', () => {
    assert.equal(courseFromTitle('Nuovo avviso da Basi di dati'), 'Basi di dati');
    assert.equal(courseFromTitle('Nuovo avviso nel Corso di Analisi matematica II'), 'Analisi matematica II');
    assert.equal(courseFromTitle('Chiusura sedi'), null);
  });
});

describe('romeDate', () => {
  it('adds calendar days in Turin, also on the night the clocks go back', () => {
    // 00:30 in Turin on 2026-10-25, the day that lasts 25 hours.
    const now = Date.parse('2026-10-24T22:30:00Z');
    assert.equal(romeDate(0, now), '2026-10-25');
    assert.equal(romeDate(1, now), '2026-10-26');
    assert.equal(romeDate(30, now), '2026-11-24');
  });

  it('crosses month and year ends', () => {
    assert.equal(romeDate(1, Date.parse('2026-12-31T12:00:00Z')), '2027-01-01');
  });
});

describe('romeDay', () => {
  it('gives the day in Turin whatever the offset', () => {
    assert.equal(romeDay('2026-10-16T01:35:28+02:00'), '2026-10-16');
    assert.equal(romeDay('2026-10-15T23:35:28Z'), '2026-10-16');
  });
});
