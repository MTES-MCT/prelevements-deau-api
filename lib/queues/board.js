import {Buffer} from 'node:buffer'
import express from 'express'
import {createBullBoard} from '@bull-board/api'
import {BullMQAdapter} from '@bull-board/api/bullMQAdapter'
import {ExpressAdapter} from '@bull-board/express'
import {getQueue, JOBS} from './config.js'

/**
 * Crée et retourne un router Express pour BullBoard avec authentification
 * @param {string} basePath - Chemin de base où le router sera monté (ex: '/admin/queues')
 * @param {string} password - Mot de passe requis pour accéder au dashboard
 * @param options
 * @returns {{router: Router, close: (function(): Promise<void>)|*}} Router Express configuré avec BullBoard et authentification
 */
export function createBullBoardRouter(basePath, password, options = {}) {
  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath(basePath)

  const rawQueues = options.queues ?? JOBS.map(job => getQueue(job.name)).filter(Boolean)

  const queues = rawQueues.map(queue => new BullMQAdapter(queue))

  createBullBoard({
    queues,
    serverAdapter
  })

  // Créer un wrapper router pour ajouter l'authentification
  // eslint-disable-next-line new-cap
  const router = express.Router()

  // Middleware d'authentification (s'exécute en premier)
  router.use((req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="BullBoard"')
      return res.status(401).json({error: 'Authentification requise'})
    }

    const base64Credentials = authHeader.split(' ')[1]
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii')
    const [, pwd] = credentials.split(':')

    if (pwd !== password) {
      res.setHeader('WWW-Authenticate', 'Basic realm="BullBoard"')
      return res.status(401).json({error: 'Authentification échouée'})
    }

    next()
  })

  // Monter le router BullBoard après l'authentification
  router.use(serverAdapter.getRouter())

  async function close() {
    await Promise.all(
      rawQueues.map(q => q?.close?.())
    )
  }

  return {router, close}
}
