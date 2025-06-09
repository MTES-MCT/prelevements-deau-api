import test from 'ava'
import {transformUrlsDeep} from '../files.js'

test('transformUrlsDeep', t => {
  const urlCollector = new Map()

  const obj = {
    foo: 'bar',
    files: [
      {
        filename: 'foo.txt',
        checksum: '1234567890',
        url: 'https://example.com/foo.txt'
      }
    ]
  }

  const transformed = transformUrlsDeep(obj, urlCollector)

  t.deepEqual(transformed, {
    foo: 'bar',
    files: [
      {
        filename: 'foo.txt',
        checksum: '1234567890',
        storageKey: 'c775e7b7-foo.txt'
      }
    ]
  })

  t.is(urlCollector.size, 1)
  t.is(urlCollector.get('c775e7b7-foo.txt'), 'https://example.com/foo.txt')
})
