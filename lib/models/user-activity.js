import {prisma} from '../../db/prisma.js'

const MAX_CACHE_ENTRIES = 10_000
const monthFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit'
})

export const USER_ACTIVITY_COLLECTION_ID = 'active-users'

export function getUserActivityMonth(date) {
  return monthFormatter.format(date)
}

export function createUserActivityRecorder({
  client = prisma,
  now = () => new Date(),
  maxCacheEntries = MAX_CACHE_ENTRIES
} = {}) {
  const recorded = new Set()
  const pending = new Map()
  let cachedMonth

  return async ({userId, role}) => {
    const createdAt = now()
    const month = getUserActivityMonth(createdAt)
    const key = `${month}:${userId}`

    if (cachedMonth !== month) {
      recorded.clear()
      cachedMonth = month
    }

    if (recorded.has(key)) {
      return {month}
    }

    if (pending.has(key)) {
      return pending.get(key)
    }

    const operation = client.$transaction(async transaction => {
      // createMany + skipDuplicates émet ON CONFLICT DO NOTHING : la première
      // date de collecte et le premier rôle du mois restent immuables.
      await transaction.userActivityCollectionState.createMany({
        data: {id: USER_ACTIVITY_COLLECTION_ID, startedAt: createdAt},
        skipDuplicates: true
      })
      await transaction.userMonthlyActivity.createMany({
        data: {month, userId, role, createdAt},
        skipDuplicates: true
      })
      return {month}
    })

    // La coalescence est elle aussi bornée. La contrainte SQL protège les
    // autres processus et les appels qui dépasseraient cette limite.
    if (pending.size < maxCacheEntries) {
      pending.set(key, operation)
    }

    try {
      const result = await operation
      if (cachedMonth === month && maxCacheEntries > 0) {
        if (recorded.size >= maxCacheEntries) {
          recorded.delete(recorded.values().next().value)
        }

        recorded.add(key)
      }

      return result
    } finally {
      if (pending.get(key) === operation) {
        pending.delete(key)
      }
    }
  }
}

export const recordUserActivity = createUserActivityRecorder()
