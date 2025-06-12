/* eslint-disable promise/prefer-await-to-then */
import PQueue from 'p-queue'

const queue = new PQueue({concurrency: 1})

// This function is used to defer the execution of a function to the next tick of the event loop. To remove when we have a proper task queue (retry, etc.).
export function defer(handler) {
  queue.add(handler).catch(error => console.error(error))
}

export async function finished() {
  await queue.onIdle()
}
