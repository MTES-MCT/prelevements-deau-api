import prismaPkg from '@prisma/client'
import pgPkg from 'pg'
import {PrismaPg} from '@prisma/adapter-pg'

const {PrismaClient} = prismaPkg
const {Pool} = pgPkg

const pool = new Pool({connectionString: process.env.DATABASE_URL})
const adapter = new PrismaPg(pool)

export const prisma = globalThis.prisma ?? new PrismaClient({adapter})

if (process.env.NODE_ENV !== 'production') {
  globalThis.prisma = prisma
}
