import process from 'node:process'
import prismaPkg from '@prisma/client'
import pgPkg from 'pg'
import {PrismaPg} from '@prisma/adapter-pg'

const {PrismaClient} = prismaPkg
const {Pool} = pgPkg

const g = globalThis

g.pgPool ||= new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5
})

g.prismaAdapter ||= new PrismaPg(g.pgPool)

g.prisma ||= new PrismaClient({
  adapter: g.prismaAdapter
})

export const {prisma} = g
