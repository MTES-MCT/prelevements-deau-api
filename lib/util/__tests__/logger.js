import test from 'ava'
import {createLogger} from '../logger.js'

test('createLogger with job.log should use job.log', t => {
  const logs = []
  const job = {
    log: message => logs.push(message)
  }

  const logger = createLogger(job)
  logger.log('test message')

  t.is(logs.length, 1)
  t.is(logs[0], 'test message')
})

test('createLogger with job.log should prefix warnings', t => {
  const logs = []
  const job = {
    log: message => logs.push(message)
  }

  const logger = createLogger(job)
  logger.warn('warning message')

  t.is(logs.length, 1)
  t.is(logs[0], '⚠️ warning message')
})

test('createLogger with job.log should prefix errors', t => {
  const logs = []
  const job = {
    log: message => logs.push(message)
  }

  const logger = createLogger(job)
  logger.error('error message')

  t.is(logs.length, 1)
  t.is(logs[0], '❌ error message')
})

test('createLogger without job should fallback to console', t => {
  const logger = createLogger()

  t.is(logger.log, console.log)
  t.is(logger.warn, console.warn)
  t.is(logger.error, console.error)
})

test('createLogger with null should fallback to console', t => {
  const logger = createLogger(null)

  t.is(logger.log, console.log)
  t.is(logger.warn, console.warn)
  t.is(logger.error, console.error)
})

test('createLogger with job without log method should fallback to console', t => {
  const job = {}
  const logger = createLogger(job)

  t.is(logger.log, console.log)
  t.is(logger.warn, console.warn)
  t.is(logger.error, console.error)
})
