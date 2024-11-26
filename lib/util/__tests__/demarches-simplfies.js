import test from 'ava'
import {getFileUrlsFromDossier} from '../demarches-simplifies/index.js'

test('getFileUrlsFromDossier correctly extracts files with their labels, excluding images and PDFs', t => {
  const data = [
    {
      pdf: {
        __typename: 'File',
        filename: 'dossier-17269915.pdf',
        contentType: 'application/pdf',
        byteSize: '0',
        url: 'https://example.com/pdf',
        createdAt: '2024-10-31T10:24:58+01:00'
      },
      champs: [
        {
          id: 'Q2hhbXAtMzk4ODQ3NQ==',
          champDescriptorId: 'Q2hhbXAtMzk4ODQ3NQ==',
          __typename: 'PieceJustificativeChamp',
          label: 'Registre au format tableur',
          files: [
            {
              __typename: 'File',
              filename: 'SUVIE DES VOLUMES PRELEVES 2023 bis.xlsx',
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              byteSize: '22174',
              url: 'https://example.com/xlsx',
              createdAt: '2024-04-18T08:26:52+02:00'
            }
          ]
        },
        {
          id: 'Q2hhbXAtMzkxNTEwMA==',
          champDescriptorId: 'Q2hhbXAtMzkxNTEwMA==',
          __typename: 'RepetitionChamp',
          label: 'Extrait de registre',
          rows: [
            {
              champs: [
                {
                  id: 'Q2hhbXAtMzkxNTEwMnwwMUhUWTRWNlZCWlhOMDJZUVE2OEtISEJDVw==',
                  champDescriptorId: 'Q2hhbXAtMzkxNTEwMg==',
                  __typename: 'PieceJustificativeChamp',
                  label: 'Extrait de registre',
                  files: [
                    {
                      __typename: 'File',
                      filename: 'SUVIE DES VOLUMES PRELEVES 2023.pdf',
                      contentType: 'application/pdf',
                      byteSize: '111276',
                      url: 'https://example.com/pdf2',
                      createdAt: '2024-04-18T08:27:42+02:00'
                    },
                    {
                      __typename: 'File',
                      filename: 'image1.jpg',
                      contentType: 'image/jpeg',
                      byteSize: '50000',
                      url: 'https://example.com/image1.jpg',
                      createdAt: '2024-04-18T08:27:42+02:00'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
  ]

  const expectedResult = [
    {
      filename: 'SUVIE DES VOLUMES PRELEVES 2023 bis.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      byteSize: '22174',
      url: 'https://example.com/xlsx',
      createdAt: '2024-04-18T08:26:52+02:00',
      fileType: 'Registre au format tableur'
    }
  ]

  const result = getFileUrlsFromDossier(data)
  t.deepEqual(result, expectedResult)
})

test('getFileUrlsFromDossier does not include files from the "pdf" property', t => {
  const data = [
    {
      pdf: {
        __typename: 'File',
        filename: 'should-not-be-included.pdf',
        contentType: 'application/pdf',
        byteSize: '12345',
        url: 'https://example.com/should-not-be-included.pdf',
        createdAt: '2024-10-31T10:24:58+01:00'
      }
    }
  ]

  const result = getFileUrlsFromDossier(data)
  t.deepEqual(result, [])
})

test('getFileUrlsFromDossier handles empty data gracefully', t => {
  const data = []
  const result = getFileUrlsFromDossier(data)
  t.deepEqual(result, [])
})

test('getFileUrlsFromDossier handles nested labels correctly, excluding images and PDFs', t => {
  const data = [
    {
      champs: [
        {
          __typename: 'PieceJustificativeChamp',
          label: 'Parent Label',
          files: [
            {
              __typename: 'File',
              filename: 'file1.pdf',
              contentType: 'application/pdf',
              byteSize: '1000',
              url: 'https://example.com/file1.pdf',
              createdAt: '2024-01-01T00:00:00+00:00'
            },
            {
              __typename: 'File',
              filename: 'file3.txt',
              contentType: 'text/plain',
              byteSize: '500',
              url: 'https://example.com/file3.txt',
              createdAt: '2024-01-01T00:00:00+00:00'
            }
          ],
          subChamps: [
            {
              __typename: 'PieceJustificativeChamp',
              label: 'Child Label',
              files: [
                {
                  __typename: 'File',
                  filename: 'file2.pdf',
                  contentType: 'application/pdf',
                  byteSize: '2000',
                  url: 'https://example.com/file2.pdf',
                  createdAt: '2024-01-02T00:00:00+00:00'
                },
                {
                  __typename: 'File',
                  filename: 'image2.png',
                  contentType: 'image/png',
                  byteSize: '3000',
                  url: 'https://example.com/image2.png',
                  createdAt: '2024-01-02T00:00:00+00:00'
                },
                {
                  __typename: 'File',
                  filename: 'file4.docx',
                  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                  byteSize: '4000',
                  url: 'https://example.com/file4.docx',
                  createdAt: '2024-01-02T00:00:00+00:00'
                }
              ]
            }
          ]
        }
      ]
    }
  ]

  const expectedResult = [
    {
      filename: 'file3.txt',
      contentType: 'text/plain',
      byteSize: '500',
      url: 'https://example.com/file3.txt',
      createdAt: '2024-01-01T00:00:00+00:00',
      fileType: 'Parent Label'
    },
    {
      filename: 'file4.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteSize: '4000',
      url: 'https://example.com/file4.docx',
      createdAt: '2024-01-02T00:00:00+00:00',
      fileType: 'Child Label'
    }
  ]

  const result = getFileUrlsFromDossier(data)
  t.deepEqual(result, expectedResult)
})

test('getFileUrlsFromDossier excludes files with contentType image/* and application/pdf', t => {
  const data = [
    {
      champs: [
        {
          __typename: 'PieceJustificativeChamp',
          label: 'Test Label',
          files: [
            {
              __typename: 'File',
              filename: 'file1.pdf',
              contentType: 'application/pdf',
              byteSize: '1000',
              url: 'https://example.com/file1.pdf',
              createdAt: '2024-01-01T00:00:00+00:00'
            },
            {
              __typename: 'File',
              filename: 'image1.jpg',
              contentType: 'image/jpeg',
              byteSize: '2000',
              url: 'https://example.com/image1.jpg',
              createdAt: '2024-01-01T00:00:00+00:00'
            },
            {
              __typename: 'File',
              filename: 'file2.doc',
              contentType: 'application/msword',
              byteSize: '3000',
              url: 'https://example.com/file2.doc',
              createdAt: '2024-01-01T00:00:00+00:00'
            }
          ]
        }
      ]
    }
  ]

  const expectedResult = [
    {
      filename: 'file2.doc',
      contentType: 'application/msword',
      byteSize: '3000',
      url: 'https://example.com/file2.doc',
      createdAt: '2024-01-01T00:00:00+00:00',
      fileType: 'Test Label'
    }
  ]

  const result = getFileUrlsFromDossier(data)
  t.deepEqual(result, expectedResult)
})
