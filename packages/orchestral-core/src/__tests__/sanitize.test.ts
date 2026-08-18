import { describe, expect, it } from 'vitest'

import { sanitizeToolOutput } from '../sanitize'

const STRIPPED = '<binary stripped — reference via assetId>'

describe('sanitizeToolOutput', () => {
  it('keeps null / undefined / primitives untouched', () => {
    expect(sanitizeToolOutput(null)).toBeNull()
    expect(sanitizeToolOutput(undefined)).toBeUndefined()
    expect(sanitizeToolOutput(42)).toBe(42)
    expect(sanitizeToolOutput(true)).toBe(true)
  })

  it('keeps short strings', () => {
    expect(sanitizeToolOutput('hello')).toBe('hello')
  })

  it('strips data: URLs', () => {
    expect(
      sanitizeToolOutput('data:image/png;base64,iVBORw0KGgo='),
    ).toBe(STRIPPED)
  })

  it('strips bare base64 blobs without a data: prefix', () => {
    const blob = 'iVBORw0KGgoAAAANSUhEUg+/='.repeat(300)
    expect(blob.length).toBeGreaterThan(4096)
    expect(sanitizeToolOutput(blob)).toBe(STRIPPED)
  })

  it('treats uniform char runs over the scan gate as binary-shaped', () => {
    // 'x'.repeat(4097) is a >1024 contiguous base64-alphabet run.
    expect(sanitizeToolOutput('x'.repeat(4097))).toBe(STRIPPED)
    // At or under MAX_INLINE_LEN the string is never scanned.
    expect(sanitizeToolOutput('x'.repeat(4096))).toBe('x'.repeat(4096))
  })

  it('strips long strings laced with control characters (raw bytes)', () => {
    const garbage = '\u0000\uFFFDabcdefg'.repeat(500)
    expect(garbage.length).toBeGreaterThan(4096)
    expect(sanitizeToolOutput(garbage)).toBe(STRIPPED)
  })

  it('keeps long opaque JSON cursors (refkit load-more regression)', () => {
    // Same shape as a saturated refkit nextCursor: JSON envelope wrapping
    // ~500 short base36 hashes — quotes and commas keep every run tiny.
    const cursor = JSON.stringify({
      v: 1,
      page: 9,
      seen: Array.from({ length: 500 }, (_, i) =>
        ((i + 7) * 2654435761).toString(36).padStart(8, '0'),
      ),
    })
    expect(cursor.length).toBeGreaterThan(4096)
    expect(sanitizeToolOutput(cursor)).toBe(cursor)
  })

  it('keeps v2 binary cursors (contiguous base64url under the scan gate)', () => {
    // refkit v2 nextCursor = base64url(packed bytes): ONE contiguous run with no
    // punctuation breaks. Saturated size (500 seen) ≈ 2.7k chars — it survives
    // because it sits under MAX_INLINE_LEN (4096), NOT because runs are broken.
    // If the cursor cap ever pushes real cursors past 4096 they would trip the
    // base64-run heuristic; this test is the tripline for that coupling.
    const cursor = 'AbC-_9'.repeat(450) // 2700 chars, pure base64url alphabet
    expect(cursor.length).toBeLessThan(4096)
    expect(sanitizeToolOutput(cursor)).toBe(cursor)
  })

  it('keeps long prose', () => {
    const prose = 'The quick brown fox jumps over the lazy dog. '.repeat(120)
    expect(prose.length).toBeGreaterThan(4096)
    expect(sanitizeToolOutput(prose)).toBe(prose)
  })

  it('keeps long lists of signed URLs (sub-1024 token runs)', () => {
    const urls = Array.from(
      { length: 12 },
      (_, i) =>
        `https://storage.example.com/asset-${i}.png?X-Goog-Signature=${'abcdef0123456789'.repeat(32)}`,
    ).join('\n')
    expect(urls.length).toBeGreaterThan(4096)
    expect(sanitizeToolOutput(urls)).toBe(urls)
  })

  it('walks into nested objects and arrays', () => {
    const result = sanitizeToolOutput({
      assetId: 'asset-1',
      preview: 'data:image/png;base64,zzz',
      meta: { caption: 'fine', blob: 'y'.repeat(5000) },
      tags: ['ok', 'data:foo'],
    })
    expect(result).toEqual({
      assetId: 'asset-1',
      preview: STRIPPED,
      meta: { caption: 'fine', blob: STRIPPED },
      tags: ['ok', STRIPPED],
    })
  })
})

describe('sanitizeToolOutput onStrip tripwire', () => {
  it('reports path and reason for each strip', () => {
    const hits: Array<{ path: string; reason: string }> = []
    sanitizeToolOutput(
      {
        ok: 'fine',
        preview: 'data:image/png;base64,zzz',
        nested: { blob: 'x'.repeat(4097) },
        arr: ['ok', 'data:foo'],
      },
      { onStrip: (info) => hits.push(info) },
    )
    expect(hits).toEqual([
      { path: 'preview', reason: 'data-url' },
      { path: 'nested.blob', reason: 'binary-run' },
      { path: 'arr[1]', reason: 'data-url' },
    ])
  })

  it('does not fire on clean output', () => {
    const hits: unknown[] = []
    sanitizeToolOutput({ a: 'short', b: ['x'.repeat(4096)] }, { onStrip: (i) => hits.push(i) })
    expect(hits).toEqual([])
  })

  it('reports control-chars reason', () => {
    const hits: Array<{ reason: string }> = []
    sanitizeToolOutput({ g: '\u0000\uFFFDabcdefg'.repeat(500) }, {
      onStrip: (i) => hits.push(i),
    })
    expect(hits.map((h) => h.reason)).toEqual(['control-chars'])
  })

  it('honours caller-supplied thresholds', () => {
    // 200 base64-ish chars: clean under the defaults, binary under a
    // tightened maxInlineLen + base64RunMin.
    const token = 'a'.repeat(200)
    expect(sanitizeToolOutput(token)).toBe(token)
    expect(
      sanitizeToolOutput(token, { maxInlineLen: 64, base64RunMin: 128 }),
    ).toBe(STRIPPED)
  })

  it('reports empty path for a root-level strip', () => {
    const hits: Array<{ path: string; reason: string }> = []
    sanitizeToolOutput('data:image/png;base64,zzz', { onStrip: (i) => hits.push(i) })
    expect(hits).toEqual([{ path: '', reason: 'data-url' }])
  })
})
