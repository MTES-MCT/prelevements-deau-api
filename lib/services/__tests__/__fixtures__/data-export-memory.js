import {mkdtemp, rm, stat} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import ExcelJS from 'exceljs'
import {buildXlsxFile, rowToExportObject} from '../../data-exports.js'

const count = Number(process.argv[2] ?? 27_731)
const initialRssBytes = process.memoryUsage().rss
let observedRssBytes = initialRssBytes
const sample = () => { observedRssBytes = Math.max(observedRssBytes, process.memoryUsage().rss) }
const sampler = setInterval(sample, 10)
const directory = await mkdtemp(path.join(tmpdir(), 'pe-export-memory-test-'))
try {
  const filename = path.join(directory, 'export.xlsx')
  async function* rows() {
    for (let index = 0; index < count; index++) {
      if (index % 500 === 0) sample()
      yield rowToExportObject({pointPrelevementId: '00000000-0000-4000-8000-000000000001', pointPrelevementNom: `Point synthétique ${index}`,
        communeName: 'Commune synthétique', communeCode: '00000', codeBSS: `BSS-${index}`, codeOPR: `OPR-${index}`,
        waterBodyType: 'SUPERFICIELLE', nature: 'COURS_EAU', withdrawalType: 'CONTINENTAL', isZre: true,
        flowType: 'PRELEVEMENT', metricTypeCode: 'volume', unit: 'm³', frequency: '1 day', valueKind: 'DECLARED',
        periodStart: new Date('2026-09-27T20:00:00Z'), periodEnd: new Date('2026-09-28T20:00:00Z'), value: '12.5000000000000001',
        remark: `Remarque synthétique ${index}`, chunkMetadata: {nativeTemporal: true, valueType: 'cumulative'},
        exploitationId: '00000000-0000-4000-8000-000000000002', countingCode: 'SYNTHETIC', calculationStrategy: 'GENERIC',
        usageCode: 'SYNTHETIC', usageLabel: 'Usage synthétique', usageKind: 'USAGE', preleveurId: '00000000-0000-4000-8000-000000000003',
        preleveurSocialReason: 'Préleveur synthétique', preleveurEmail: '', collecteurId: null, isTelemetry: false})
    }
  }
  const rowCount = await buildXlsxFile(rows(), filename)
  sample()
  const writeMaxRssBytes = observedRssBytes
  let readCount = 0
  let columnCount = 0
  const workbook = new ExcelJS.stream.xlsx.WorkbookReader(filename)
  for await (const sheet of workbook) {
    for await (const row of sheet) {
      if (row.number === 1) columnCount = row.cellCount
      else readCount++
    }
  }
  console.log(JSON.stringify({rowCount, readCount, columnCount, bytes: (await stat(filename)).size,
    maxRssKiB: process.resourceUsage().maxRSS, initialRssBytes, writeMaxRssBytes, observedRssBytes, heapLimitMiB: 128}))
} finally {
  clearInterval(sampler)
  await rm(directory, {recursive: true, force: true})
}
