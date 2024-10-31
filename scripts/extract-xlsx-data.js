import fs from 'fs'
import path from 'path'
import {fileURLToPath} from 'url'
import {Worker} from 'worker_threads'

const __filename = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(__filename), '..')

const inputDirectory = path.join(projectRoot, 'data/files')
const outputDirectory = path.join(projectRoot, 'data/output')
const srcDirectory = path.join(projectRoot, 'src')
const reportFilePath = path.join(outputDirectory, 'report.json')
const FILE_PROCESS_TIMEOUT = 30_000 // 30 seconds

// Ensure the output directory exists
fs.mkdirSync(outputDirectory, {recursive: true})

// Function to use a worker for reading a workbook with timeout
const readWorkbookWithWorker = filePath => new Promise((resolve, reject) => {
  const worker = new Worker(`${srcDirectory}/xlsx-worker.js`, {workerData: {filePath}})

  const timer = setTimeout(() => {
    worker.terminate()
    reject(`Timeout exceeded for file: ${filePath}`)
  }, FILE_PROCESS_TIMEOUT)

  worker.on('message', message => {
    clearTimeout(timer)
    if (message.success) {
      resolve(message.workbookData)
    } else {
      reject(message.error)
    }
  })

  worker.on('error', error => {
    clearTimeout(timer)
    reject(`Worker error for file: ${filePath}\nError: ${error.message}`)
  })
})

// Process each Excel file in the input directory
const processFiles = async () => {
  console.log(`Starting data extraction from files in directory: ${inputDirectory}`)
  const report = []

  try {
    const files = fs.readdirSync(inputDirectory).filter(file => file.endsWith('.xlsx'))

    if (files.length === 0) {
      console.log('No .xlsx files found in the input directory.')
      return
    }

    for (const [index, file] of files.entries()) {
      const result = {filename: file, success: false, error: null}
      console.log(`Processing file ${index + 1} of ${files.length}: ${file}`)
      const filePath = path.join(inputDirectory, file)

      try {
        console.log(`\tAttempting to open workbook for file: ${file}`)
        const workbookData = await readWorkbookWithWorker(filePath)
        console.log(`\tOpened workbook for file: ${file}`)

        // Save each sheet's CSV data to separate CSV files
        for (const [sheetName, csvData] of Object.entries(workbookData)) {
          const sanitizedSheetName = sheetName.replaceAll(/[/\\?%*:|"<>]/g, '_') // Sanitize sheet name for filename
          const outputFilePath = path.join(outputDirectory, `${path.parse(file).name}_${sanitizedSheetName}.csv`)
          fs.writeFileSync(outputFilePath, csvData, 'utf-8')
          console.log(`\tData for sheet "${sheetName}" saved to: ${outputFilePath}`)
        }

        result.success = true
      } catch (error) {
        result.error = error
        console.error(`Skipped file due to error: ${file}\nReason: ${error}`)
      }

      // Add result to report
      report.push(result)
    }

    // Write report to JSON file
    fs.writeFileSync(reportFilePath, JSON.stringify(report, null, 2), 'utf-8')
    console.log(`Data extraction completed for all files. Report saved to ${reportFilePath}`)
  } catch (dirError) {
    console.error(`Failed to read directory: ${inputDirectory}\nError: ${dirError.message}`)
  }
}

processFiles()
