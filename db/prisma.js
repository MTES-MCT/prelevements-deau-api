import process from 'node:process'
import prismaPkg from '@prisma/client'
import {PrismaPg} from '@prisma/adapter-pg'

import {InstrumentedPool, readDatabasePoolMax} from './instrumented-pool.js'

const {PrismaClient} = prismaPkg

const g = globalThis

g.pgPool ||= new InstrumentedPool({
  connectionString: process.env.DATABASE_URL,
  max: readDatabasePoolMax()
})

g.prismaAdapter ||= new PrismaPg(g.pgPool)

g.prisma ||= new PrismaClient({
  adapter: g.prismaAdapter
})

export const {prisma} = g
