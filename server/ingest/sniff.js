// Content sniffing.
//
// Fitberg reads FIT and TCX files. Identification is by CONTENT, never by filename,
// which is deliberate: Strava names activity files `1234567890.fit.gz`, browsers
// append "(1)", Windows hides extensions, and people rename things. A FIT file is a
// FIT file whatever it is called.
//
// What needs recognising: a FIT file, a TCX file, and the two containers they arrive
// inside — a gzip member, or a ZIP archive full of them.

export const KINDS = {
  ZIP: 'zip',
  GZIP: 'gzip',
  FIT: 'fit',
  TCX: 'tcx',
  UNKNOWN: 'unknown',
};

/**
 * @param {Buffer} head   the first chunk of the file (4 KB is plenty)
 * @param {string} [filename]  used only to describe a skip, never to decide
 * @returns {{kind:string, reason:string}}
 */
export function sniff(head, filename = '') {
  if (!head || head.length < 4) return { kind: KINDS.UNKNOWN, reason: 'file is empty or too short' };

  if (head[0] === 0x50 && head[1] === 0x4b
      && (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07)) {
    return { kind: KINDS.ZIP, reason: 'ZIP archive' };
  }
  if (head[0] === 0x1f && head[1] === 0x8b) {
    return { kind: KINDS.GZIP, reason: 'gzip file' };
  }
  // FIT files carry ".FIT" at byte offset 8, inside the 12/14-byte header.
  if (head.length >= 12 && head.subarray(8, 12).toString('latin1') === '.FIT') {
    return { kind: KINDS.FIT, reason: 'FIT file' };
  }

  const text = head.toString('utf8').replace(/^﻿/, '').trimStart();
  if (text.startsWith('<') && (/TrainingCenterDatabase/i.test(text) || /<Trackpoint\b/i.test(text))) {
    return { kind: KINDS.TCX, reason: 'TCX file' };
  }

  return { kind: KINDS.UNKNOWN, reason: describeUnsupported(head, filename) };
}

/**
 * Name what the file was, or return null to ignore it without comment.
 *
 * The distinction matters. An export archive is mostly scaffolding — indexes, metadata,
 * profile images, web pages — and itemising forty of those buries the one line that
 * carries information. So: things that could plausibly have been an activity recording
 * are named; everything else is ignored without comment.
 */
function describeUnsupported(head, filename) {
  const latin = head.toString('latin1');
  const text = head.toString('utf8').replace(/^﻿/, '').trimStart();

  // Export scaffolding. Not activities, so not worth a line each.
  if (latin.startsWith('\xff\xd8') || latin.startsWith('\x89PNG')) return null;
  if (/\.(csv|json|txt|html?|pdf|xlsx?|md|png|jpe?g|gif|webp|heic)$/i.test(filename)) return null;

  if (text.startsWith('<')) {
    // GPX *is* an activity recording, in a format Fitberg does not store. Worth naming,
    // because the count tells you whether anything you cared about was missed. TCX is
    // handled above — it is no longer unsupported.
    if (/<\s*gpx/i.test(text) || /<trkpt\b/i.test(text)) return 'GPX file';
    return null;
  }

  if (text.startsWith('{') || text.startsWith('[')) return null;
  if ((text.split('\n', 1)[0] || '').includes(',')) return null;

  return 'not a FIT file';
}
