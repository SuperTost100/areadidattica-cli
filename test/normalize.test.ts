import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { courseFromTitle, htmlToText, parseNoticeScope, pickNotice } from '../src/normalize.ts';

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
});

describe('parseNoticeScope', () => {
  it('reads the course id, with or without the teaching prefix and notice id', () => {
    assert.deepEqual(parseNoticeScope(['courses', '258674', 'notices']), { courseKey: '258674', noticeId: null });
    assert.deepEqual(parseNoticeScope(['teaching', 'courses', '1', 'notices', '42']), { courseKey: '1', noticeId: 42 });
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
    assert.equal(courseFromTitle('Chiusura sedi'), null);
  });
});
