/* eslint-disable no-await-in-loop */

import hashObject from 'hash-object'
import got from 'got'

import {fetchData} from './graphql/request.js'
import {transformUrlsDeep, getAttachmentObjectKey} from './files.js'
import {readDatabase, writeDatabase, writeDossier} from './database.js'

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
        await this.onDossier({...existingEntry, dossier, isUpdated: false})
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

        const objectKey = getAttachmentObjectKey(this.demarcheNumber, dossier.number, storageKey)

        try {
          await downloadAndStore(fileEntry.url, objectKey, {
            type: fileEntry.type,
            filename: fileEntry.filename,
            s3: this.s3
          })
        } catch (error) {
          console.error(`[dossier: ${dossier.number}] Erreur lors du téléchargement de la pièce jointe : ${fileEntry.filename}`, error)
        }
      }

      await writeDossier(this.s3, this.demarcheNumber, dossier)

      // Delete old attachments

      if (existingEntry) {
        await Promise.all(
          existingEntry.attachments
            .filter(storageKey => !attachmentsCollector.has(storageKey))
            .map(storageKey =>
              this.s3.deleteObject(getAttachmentObjectKey(this.demarcheNumber, dossier.number, storageKey), true)))
      }

      // Intermediary save
      if (this.databaseChanges > 20) {
        await this.saveDatabase()
      }

      await this.onDossier({...dbEntry, dossier, isUpdated: true})
    }

    await this.saveDatabase()
  }

  async initDatabase() {
    this.database = new Map()

    try {
      const {dossiers} = await readDatabase(this.s3, this.demarcheNumber)

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

    await writeDatabase(this.s3, this.demarcheNumber, {
      dossiers: [...this.database.values()]
    })

    this.databaseChanges = 0
  }
}

export async function sync(demarcheNumber, {s3, onDossier} = {}) {
  const process = new SyncProcess(demarcheNumber, {s3, onDossier})
  await process.exec()
}
