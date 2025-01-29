// XlsxWorker.js
import {parentPort, workerData} from 'node:worker_threads'

import xlsx from 'xlsx'

try {
  const workbook = xlsx.readFile(workerData.filePath)
  const data = {}

  for (const sheetName of workbook.SheetNames) {
    if (sheetName.startsWith('Data')) {
      const worksheet = workbook.Sheets[sheetName]

      // Extract specific headers for columns A to I from row 2
      const headerRow = xlsx.utils.sheet_to_json(worksheet, {header: 1, range: 'A2:I2'})[0]

      // Extract data starting from line 12
      const sheetData = xlsx.utils.sheet_to_json(worksheet, {header: 1, range: 11}) // Line 12 (index 11)

      // Apply headers from line 2 for columns C to I (2nd to 8th index)
      const updatedHeaders = sheetData[0].map((header, index) =>
        (index >= 2 && index <= 8) ? headerRow[index] || header : header
      )

      // Set updated headers in `sheetData`
      sheetData[0] = updatedHeaders

      // Convert modified data to CSV
      const csvData = xlsx.utils.sheet_to_csv(xlsx.utils.aoa_to_sheet(sheetData))
      data[sheetName] = csvData
    }
  }

  parentPort.postMessage({success: true, workbookData: data})
} catch (error) {
  parentPort.postMessage({success: false, error: error.message})
}
