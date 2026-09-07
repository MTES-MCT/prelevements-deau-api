import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'

import test from 'ava'

import {
  assertVerificationOptions,
  semanticMismatchedFields,
  summarizeSemanticFailures,
  verifyTargetDocumentContent
} from '../migrate-reunion.js'

test('verify refuse explicitement de sauter le contrôle S3', t => {
  t.throws(() => assertVerificationOptions({skipS3: true}), {
    message: /--skip-s3 est interdit avec verify/
  })
  t.notThrows(() => assertVerificationOptions({skipS3: false}))
})

test('le rapport sémantique expose les champs mais jamais leurs valeurs', t => {
  const expected = {
    'user.email': 'personne@example.test',
    'relations.pointSourceId': 'reunion:DEP-974:point:1'
  }
  const actual = {
    'user.email': 'autre@example.test',
    'relations.pointSourceId': 'reunion:DEP-974:point:2'
  }
  const fields = semanticMismatchedFields(expected, actual)
  const summary = summarizeSemanticFailures([{
    entity: 'declarant',
    sourceId: 'reunion:DEP-974:declarant:1',
    code: 'SEMANTIC_MISMATCH',
    fields
  }])
  const serialized = JSON.stringify(summary)

  t.deepEqual(fields, ['user.email', 'relations.pointSourceId'])
  t.false(serialized.includes('personne@example.test'))
  t.false(serialized.includes('autre@example.test'))
  t.is(summary.total, 1)
})

test('le contrôle S3 relit le corps et ne fait pas confiance au metadata sha256', async t => {
  const actualContent = Buffer.from('contenu falsifie')
  const expectedContent = Buffer.from('contenu attendu!')
  t.is(actualContent.length, expectedContent.length)
  const expectedSha256 = createHash('sha256').update(expectedContent).digest('hex')
  const context = {
    bucket: 'target',
    client: {
      async send(command) {
        if (command.constructor.name === 'HeadObjectCommand') {
          return {
            ContentLength: actualContent.length,
            ETag: '"stable"',
            Metadata: {sha256: expectedSha256}
          }
        }

        return {Body: Readable.from([actualContent])}
      }
    }
  }

  t.false(await verifyTargetDocumentContent(
    context,
    'reunion/document.pdf',
    expectedSha256,
    expectedContent.length
  ))
})
