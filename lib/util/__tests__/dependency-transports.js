import process from 'node:process'
import {Buffer} from 'node:buffer'
import net from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {once} from 'node:events'
import test from 'ava'
import {parse} from 'content-disposition'

const execute = promisify(execFile)
const emailModule = new URL('../email.js', import.meta.url).href
const templateModule = new URL('../email-templates.js', import.meta.url).href
const storageModule = new URL('../s3.js', import.meta.url).href

async function createSmtpServer(t, {rejectRecipient = false} = {}) {
  const messages = []
  const commands = []
  const sockets = new Set()
  const server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.write('220 localhost ESMTP test\r\n')
    let buffer = ''
    let message
    socket.on('data', chunk => {
      buffer += chunk
      let separator
      while ((separator = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, separator)
        buffer = buffer.slice(separator + 2)
        if (message) {
          if (line === '.') {
            messages.push(message.join('\r\n'))
            message = undefined
            socket.write('250 Message accepted\r\n')
          } else {
            message.push(line)
          }
        } else {
          commands.push(line)
          if (line.startsWith('EHLO ') || line.startsWith('HELO ')) {
            socket.write('250-localhost\r\n250 8BITMIME\r\n')
          } else if (line.startsWith('RCPT TO:') && rejectRecipient) {
            socket.write('550 Recipient refused\r\n')
          } else if (line === 'DATA') {
            message = []
            socket.write('354 End with a dot\r\n')
          } else if (line === 'QUIT') {
            socket.end('221 Bye\r\n')
          } else {
            socket.write('250 OK\r\n')
          }
        }
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.teardown(async () => {
    for (const socket of sockets) {
      socket.destroy()
    }

    await new Promise(resolve => {
      server.close(resolve)
    })
  })
  return {messages, commands, port: server.address().port}
}

function smtpEnvironment(port) {
  // Never inherit credentials or endpoints from a developer's environment.
  return {
    NODE_ENV: 'test',
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(port),
    SMTP_FROM: 'Partageons l’eau <sender@example.test>',
    SMTP_IGNORE_TLS: 'true',
    MAIL_SUBJECT_PREFIX: '[TEST] '
  }
}

test('Nodemailer 10 transmet un vrai mail MJML au SMTP local, avec sujet et destinataire préservés', async t => {
  const smtp = await createSmtpServer(t)
  const source = `
    import {sendEmail} from ${JSON.stringify(emailModule)}
    import {renderPasswordChangedAlertEmail} from ${JSON.stringify(templateModule)}
    const html = await renderPasswordChangedAlertEmail({firstName: 'Camille', lastName: 'Rivière'})
    const result = await sendEmail('  AGENT+TEST@EXAMPLE.TEST  ', 'Votre mot de passe a été modifié', html)
    console.log(JSON.stringify({accepted: result.accepted, rejected: result.rejected}))
  `
  const {stdout} = await execute(process.execPath, ['--input-type=module', '-e', source], {
    env: smtpEnvironment(smtp.port), timeout: 20_000
  })
  t.deepEqual(JSON.parse(stdout), {accepted: ['agent+test@example.test'], rejected: []})
  t.is(smtp.messages.length, 1)
  t.true(smtp.commands.includes('RCPT TO:<agent+test@example.test>'))
  const mime = smtp.messages[0].replaceAll('=\r\n', '')
  t.true(mime.includes('Content-Type: text/html; charset=utf-8'))
  const subjectHeader = /^subject: (.+)$/im.exec(smtp.messages[0].replaceAll(/\r\n[\t ]+/gu, ' '))[1]
  const subject = subjectHeader.replaceAll(/\?=\s+=\?/gu, '?==?')
    .replaceAll(/=\?utf-8\?([qb])\?([^?]+)\?=/gi, (_match, encoding, value) => encoding.toUpperCase() === 'B'
      ? Buffer.from(value, 'base64').toString('utf8')
      : decodeURIComponent(value.replaceAll('_', ' ').replaceAll('=', '%')))
  t.is(subject, '[TEST] Votre mot de passe a été modifié')
  t.true(mime.includes('contact@partageonsleau.beta.gouv.fr'))
  t.false(mime.includes('<mjml>'))
})

test('un refus SMTP reste une erreur contrôlée, sans déclarer le mail envoyé', async t => {
  const smtp = await createSmtpServer(t, {rejectRecipient: true})
  const source = `
    import {sendEmail} from ${JSON.stringify(emailModule)}
    try {
      await sendEmail('agent@example.test', 'Test', '<p>Test</p>')
      console.log(JSON.stringify({unexpectedSuccess: true}))
    } catch (error) {
      console.log(JSON.stringify({status: error.status, message: error.message}))
    }
  `
  const {stdout} = await execute(process.execPath, ['--input-type=module', '-e', source], {
    env: smtpEnvironment(smtp.port), timeout: 20_000
  })
  t.deepEqual(JSON.parse(stdout), {status: 500, message: 'Impossible d\'envoyer l\'email'})
  t.is(smtp.messages.length, 0)
})

test('le SDK AWS signe hors réseau un téléchargement Unicode avec les mêmes paramètres S3', async t => {
  const source = `
    import createStorageClient from ${JSON.stringify(storageModule)}
    const storage = createStorageClient('documents')
    console.log(await storage.getPresignedUrl('de\u0301claration/relevé.xlsx', {
      filename: '/tmp/relevé été (m³).xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      expiresIn: 999999
    }))
  `
  const {stdout} = await execute(process.execPath, ['--input-type=module', '-e', source], {
    env: {
      NODE_ENV: 'development', S3_ENDPOINT: 'http://127.0.0.1:9', S3_REGION: 'fr-par',
      S3_ACCESS_KEY: 'TEST_ONLY_KEY', S3_SECRET_KEY: 'TEST_ONLY_SECRET', S3_BUCKET_PREFIX: 'fixture-'
    },
    timeout: 20_000
  })
  const url = new URL(stdout.trim())
  t.is(url.hostname, '127.0.0.1')
  t.true(decodeURIComponent(url.pathname).includes('déclaration/relevé.xlsx'))
  t.is(parse(url.searchParams.get('response-content-disposition')).parameters.filename, 'relevé été (m³).xlsx')
  t.is(url.searchParams.get('X-Amz-Expires'), '43200')
  t.truthy(url.searchParams.get('X-Amz-Signature'))
  t.is(url.searchParams.get('response-content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
})
