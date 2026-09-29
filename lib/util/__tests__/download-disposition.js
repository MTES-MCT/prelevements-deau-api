import test from 'ava'
import {parse} from 'content-disposition'
import {createDownloadDisposition} from '../s3.js'

for (const filename of ['relevé été.xlsx', 'besoins 2026.csv', 'rapport "final".pdf', 'niveau € (m³).xlsx']) {
  test(`préserve le nom du téléchargement : ${filename}`, t => {
    const header = createDownloadDisposition(filename)
    t.is(parse(header).type, 'attachment')
    t.is(parse(header).parameters.filename, filename)
  })
}

test('ne publie pas le chemin du fichier dans le nom du téléchargement', t => {
  const header = createDownloadDisposition('/tmp/documents/rapport.xlsx')
  t.is(parse(header).parameters.filename, 'rapport.xlsx')
  t.false(header.includes('/tmp'))
})

test('les sauts de ligne restent encodés dans le nom, pas dans les en-têtes HTTP', t => {
  const header = createDownloadDisposition('rapport\r\nX-Injected: true.xlsx')
  t.notRegex(header, /[\r\n]/)
  t.is(parse(header).parameters.filename, 'rapport\r\nX-Injected: true.xlsx')
})
