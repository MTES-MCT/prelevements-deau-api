/* eslint-disable no-await-in-loop */

import hashObject from 'hash-object'
import got from 'got'

import {fetchData} from './graphql/request.js'
import {transformUrlsDeep} from './files.js'

export async function * fetchDossiersGenerator(demarcheNumber, {includeChamps = true, cursor = null} = {}) {
  const variables = {
    demarcheNumber,
    first: 100,
    includeDossiers: true,
    includeChamps
  }

  if (cursor) {
    variables.after = cursor
  }

  const {demarche: {dossiers}} = await fetchData('getDemarche', variables)

  for (const dossier of dossiers.nodes) {
    yield dossier
  }

  if (dossiers.pageInfo.hasNextPage) {
    yield * fetchDossiersGenerator(demarcheNumber, {includeChamps, cursor: dossiers.pageInfo.endCursor})
  }
}

async function computeHash(dossier) {
  return hashObject(dossier, {algorithm: 'sha256'}).slice(0, 7)
}

export async function downloadAndStore(originalUrl, objectKey, {s3, filename, type}) {
  if (await s3.objectExists(objectKey)) {
    return
  }

  const buffer = await got(originalUrl).buffer()
  await s3.uploadObject(objectKey, buffer, {filename, type})
}

class SyncProcess {
  constructor(demarcheNumber, {s3, onDossier}) {
    this.demarcheNumber = demarcheNumber
    this.s3 = s3
    this.onDossier = onDossier || (() => {})
    this.database = null
    this.databaseChanges = 0
    this.databaseObjectKey = `demarche-${demarcheNumber}/database.json`
  }

  async exec() {
    await this.initDatabase()

    for await (const rawDossier of fetchDossiersGenerator(this.demarcheNumber)) {
      const {pdf, ...rest} = rawDossier
      const attachmentsCollector = new Map()
      const dossier = transformUrlsDeep(rest, attachmentsCollector)
      const dossierHash = await computeHash(dossier)

      const dbEntry = {
        number: dossier.number,
        hash: dossierHash,
        state: dossier.state,
        attachments: [...attachmentsCollector.keys()]
      }

      const existingEntry = this.database.get(dossier.number)

      if (existingEntry && existingEntry.hash === dossierHash) {
        this.onDossier({...existingEntry, dossier, isUpdated: false})
        continue
      }

      this.database.set(dossier.number, dbEntry)
      this.databaseChanges++

      // Store new attachments

      for (const [storageKey, fileEntry] of attachmentsCollector.entries()) {
        // Check if attachment already exists
        if (existingEntry && existingEntry.attachments.includes(storageKey)) {
          continue
        }

        const objectKey = `demarche-${this.demarcheNumber}/dossiers/${dossier.number}/attachments/${storageKey}`

        try {
          await downloadAndStore(fileEntry.url, objectKey, {
            type: fileEntry.type,
            filename: fileEntry.filename,
            s3: this.s3
          })
        } catch {
          console.error(`[dossier: ${dossier.number}] Erreur lors du téléchargement de la pièce jointe : ${fileEntry.filename}`)
        }
      }

      const dossierBuffer = Buffer.from(JSON.stringify(dossier), 'utf8')

      await this.s3.uploadObject(`demarche-${this.demarcheNumber}/dossiers/${dossier.number}/dossier.json`, dossierBuffer)

      // Delete old attachments

      if (existingEntry) {
        await Promise.all(
          existingEntry.attachments
            .filter(storageKey => !attachmentsCollector.has(storageKey))
            .map(storageKey =>
              this.s3.deleteObject(`demarche-${this.demarcheNumber}/dossiers/${dossier.number}/attachments/${storageKey}`, true)))
      }

      // Intermediary save
      if (this.databaseChanges > 20) {
        await this.saveDatabase()
      }

      this.onDossier({...dbEntry, dossier, isUpdated: true})
    }

    await this.saveDatabase()
  }

  async initDatabase() {
    this.database = new Map()

    try {
      const buffer = await this.s3.downloadObject(this.databaseObjectKey)
      const {dossiers} = JSON.parse(buffer.toString('utf8'))

      for (const dossier of dossiers) {
        this.database.set(dossier.number, dossier)
      }
    } catch {}

    this.databaseChanges = 0
  }

  async saveDatabase() {
    if (!this.databaseChanges) {
      return
    }

    const buffer = Buffer.from(JSON.stringify({dossiers: [...this.database.values()]}), 'utf8')
    await this.s3.uploadObject(this.databaseObjectKey, buffer)

    this.databaseChanges = 0
  }
}

export async function sync(demarcheNumber, {s3, onDossier} = {}) {
  const process = new SyncProcess(demarcheNumber, {s3, onDossier})
  await process.exec()
}

