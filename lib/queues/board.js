import process from 'node:process'
import {createBullBoard} from '@bull-board/api'
import {BullMQAdapter} from '@bull-board/api/bullMQAdapter'
import {ExpressAdapter} from '@bull-board/express'
import {getQueue, JOBS} from './config.js'

const {env: {NODE_ENV: nodeEnv, BULLBOARD_PASSWORD: bullboardPassword}} = process
const isTest = nodeEnv === 'test'

/**
 * Configure et retourne le router BullBoard pour Express
 * @returns {object} {router, basePath} ou null si désactivé
 */
export function setupBullBoard() {
  // Désactiver en mode test ou si pas de mot de passe configuré
  if (isTest || !bullboardPassword) {
    if (!isTest && !bullboardPassword) {
      console.warn('⚠️  BullBoard désactivé : variable BULLBOARD_PASSWORD non définie')
    }

    return null
  }

  const serverAdapter = new ExpressAdapter()
  serverAdapter.setBasePath('/admin/queues')

  // Ajouter toutes les queues au board
  const queues = JOBS
    .map(job => getQueue(job.name))
    .filter(Boolean) // Exclure les queues null (mode test)
    .map(queue => new BullMQAdapter(queue))

  createBullBoard({
    queues,
    serverAdapter
  })

  // Middleware d'authentification simple par mot de passe
  const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="BullBoard"')
      return res.status(401).send('Authentification requise')
    }

    const base64Credentials = authHeader.split(' ')[1]
    const credentials = Buffer.from(base64Credentials, 'base64').toString('ascii')
    const [, password] = credentials.split(':')

    // Vérifier le mot de passe (username ignoré)
    if (password !== bullboardPassword) {
      res.setHeader('WWW-Authenticate', 'Basic realm="BullBoard"')
      return res.status(401).send('Authentification échouée')
    }

    next()
  }

  // Appliquer l'authentification sur toutes les routes du board
  const router = serverAdapter.getRouter()
  router.use(authMiddleware)

  return {
    router,
    basePath: '/admin/queues'
  }
}
