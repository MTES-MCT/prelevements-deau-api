import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {inventory, revision, shardTotal, writeReceipt} from './ci-shards.mjs'

export default async ({projectDir}) => {
  const index = Number(process.env.CI_NODE_INDEX)
  assert.equal(process.env.CI_NODE_TOTAL, String(shardTotal))
  assert.ok(Number.isInteger(index) && index >= 0 && index < shardTotal)
  assert.equal(process.env.GITLAB_CI, undefined, 'GitLab changes native AVA shard indexing')
  const files = await inventory()
  const config = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8')).ava
  return {
    ...config,
    cache: false,
    nonSemVerExperiments: {observeRunsFromConfig: true},
    async observeRun({events}) {
      const finishedFiles = []
      let stats
      for await (const event of events) {
        if (event.type === 'stats') stats = event.stats
        if (event.type === 'worker-finished') finishedFiles.push(path.relative(projectDir, event.testFile))
        if (event.type === 'end') {
          const {byFile, ...summary} = stats
          writeReceipt(process.env.AVA_SHARD_RECEIPT, {
            version: 1, ...revision(), index, total: shardTotal, files,
            completed: true, finishedFiles,
            observedFiles: [...byFile.keys()].map(file => path.relative(projectDir, file)),
            stats: summary
          })
        }
      }
    }
  }
}
