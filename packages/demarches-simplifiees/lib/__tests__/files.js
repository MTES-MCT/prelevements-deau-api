import test from 'ava'
import {transformUrlsDeep} from '../files.js'

test('replaces url with storageKey and collects file meta', t => {
  const urlCollector = new Map()
  const input = {
    title: 'sample',
    files: [
      {
        filename: 'foo.txt',
        checksum: '123456',
        url: 'https://example.com/foo.txt',
        contentType: 'text/plain'
      }
    ]
  }

  const transformed = transformUrlsDeep(input, urlCollector)

  // URL should be replaced by storageKey
  t.like(transformed, {
    files: [
      {
        filename: 'foo.txt',
        checksum: '123456'
      }
    ]
  })
  // StorageKey should match `<8-hex>-foo.txt`
  t.regex(transformed.files[0].storageKey, /^[a-f\d]{8}-foo\.txt$/)

  // Collector should contain one entry matching that storageKey
  t.is(urlCollector.size, 1)
  const [[key, meta]] = [...urlCollector]
  t.is(key, transformed.files[0].storageKey)
  t.deepEqual(meta, {
    url: 'https://example.com/foo.txt',
    filename: 'foo.txt',
    type: 'text/plain'
  })
})

test('supports multiple files and nested collections', t => {
  const urlCollector = new Map()
  const input = {
    a: 1,
    files: [
      {filename: 'foo.txt', checksum: 'aaa', url: 'https://e.com/foo.txt'},
      {filename: 'bar.pdf', checksum: 'bbb', url: 'https://e.com/bar.pdf', contentType: 'application/pdf'}
    ],
    nested: {
      attachments: [
        {filename: 'baz.png', checksum: 'ccc', url: 'https://e.com/baz.png', contentType: 'image/png'}
      ]
    }
  }

  const transformed = transformUrlsDeep(input, urlCollector)

  // Every original file object must now expose a storageKey and no url.
  t.true(transformed.files.every(f => typeof f.storageKey === 'string' && !('url' in f)))
  t.true(transformed.nested.attachments.every(f => typeof f.storageKey === 'string' && !('url' in f)))

  // One collector entry per original file
  t.is(urlCollector.size, 3)
  for (const [, meta] of urlCollector) {
    t.deepEqual(Object.keys(meta).sort(), ['filename', 'type', 'url'].sort())
    t.true(meta.url.startsWith('https://e.com/'))
  }
})

test('leaves primitives and unrelated objects untouched', t => {
  const urlCollector = new Map()
  const input = {
    count: 5,
    enabled: true,
    note: null,
    meta: {foo: 'bar'}
  }

  const transformed = transformUrlsDeep(input, urlCollector)

  t.deepEqual(transformed, input)
  t.is(urlCollector.size, 0)
})
