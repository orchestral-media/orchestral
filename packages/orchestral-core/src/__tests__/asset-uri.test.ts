import { afterEach, describe, expect, it } from 'vitest'
import { fromAssetUri, isAssetUri, setAssetUriScheme, toAssetUri } from '../asset-uri'

afterEach(() => {
  setAssetUriScheme('asset://')
})

describe('asset-uri', () => {
  it('round-trips a plain handle', () => {
    expect(toAssetUri('image_2')).toBe('asset://image_2')
    expect(fromAssetUri('asset://image_2')).toBe('image_2')
  })
  it('percent-encodes filename handles (spaces, parens)', () => {
    expect(toAssetUri('my photo (1).png')).toBe('asset://my%20photo%20(1).png')
    expect(fromAssetUri('asset://my%20photo%20(1).png')).toBe('my photo (1).png')
  })
  it('passes non-uri strings through unchanged', () => {
    expect(fromAssetUri('image_2')).toBe('image_2')
    expect(fromAssetUri('http://example.com/x')).toBe('http://example.com/x')
  })
  it('survives malformed percent-encoding without throwing', () => {
    expect(fromAssetUri('asset://bad%zzenc')).toBe('bad%zzenc')
  })
  it('isAssetUri discriminates', () => {
    expect(isAssetUri('asset://image_2')).toBe(true)
    expect(isAssetUri('image_2')).toBe(false)
  })
  it('round-trips the empty handle', () => {
    expect(toAssetUri('')).toBe('asset://')
    expect(fromAssetUri('asset://')).toBe('')
  })

  describe('setAssetUriScheme', () => {
    it('encodes and decodes under the configured scheme', () => {
      setAssetUriScheme('host://')
      expect(toAssetUri('image_2')).toBe('host://image_2')
      expect(isAssetUri('host://image_2')).toBe(true)
      expect(fromAssetUri('host://my%20photo.png')).toBe('my photo.png')
    })
    it('stops recognizing the previous scheme', () => {
      setAssetUriScheme('host://')
      expect(isAssetUri('asset://image_2')).toBe(false)
      expect(fromAssetUri('asset://image_2')).toBe('asset://image_2')
    })
    it('last call wins and repeat calls are harmless', () => {
      setAssetUriScheme('host://')
      setAssetUriScheme('host://')
      setAssetUriScheme('other://')
      expect(toAssetUri('image_1')).toBe('other://image_1')
    })
    it('rejects a prefix that is not a scheme', () => {
      expect(() => setAssetUriScheme('asset')).toThrow(/scheme/)
      expect(() => setAssetUriScheme('')).toThrow(/scheme/)
      expect(toAssetUri('image_1')).toBe('asset://image_1')
    })
  })
})
