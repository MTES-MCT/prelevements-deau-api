// Temporary IAM-private diagnostic container only; never run in a business namespace.
// No arbitrary URL, command or environment value can be requested over HTTP.
import {createServer, request} from 'node:http'
import {lookup} from 'node:dns/promises'
import {connect} from 'node:tls'
import process from 'node:process'

const proxyHost = '172.16.12.19'
const partnerHost = 'api.ipify.org'

function fixedEgress() {
  return new Promise((resolve, reject) => {
    const connection = request({hostname: proxyHost, port: 3128, method: 'CONNECT', path: `${partnerHost}:443`, timeout: 15_000})
    connection.on('timeout', () => connection.destroy(new Error('PROXY_TIMEOUT')))
    connection.on('error', reject)
    connection.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new Error('PROXY_REFUSED'))
        return
      }

      const secure = connect({socket, servername: partnerHost, rejectUnauthorized: true})
      let responseText = ''
      secure.setTimeout(15_000, () => secure.destroy(new Error('TLS_TIMEOUT')))
      secure.on('error', reject)
      secure.on('secureConnect', () => secure.write(`GET / HTTP/1.1\r\nHost: ${partnerHost}\r\nConnection: close\r\n\r\n`))
      secure.on('data', chunk => {
        responseText += chunk.toString('utf8')
        if (responseText.length > 8192) {
          secure.destroy(new Error('RESPONSE_TOO_LARGE'))
        }
      })
      secure.on('end', () => {
        const separator = responseText.indexOf('\r\n\r\n')
        const address = responseText.slice(separator + 4).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
        if (!responseText.startsWith('HTTP/1.1 200') || address !== '51.158.122.78') {
          reject(new Error('UNEXPECTED_EGRESS'))
          return
        }

        resolve(address)
      })
    })
    connection.end()
  })
}

createServer(async (incoming, response) => {
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  if (incoming.method !== 'GET' || !['/healthz', '/probe'].includes(incoming.url)) {
    response.writeHead(404).end('{}')
    return
  }

  if (incoming.url === '/healthz') {
    response.end(JSON.stringify({ok: true}))
    return
  }

  try {
    const {address} = await lookup('partageonsleau-demo-egress-proxy.partageonsleau-demo-pn.internal', {family: 4})
    response.end(JSON.stringify({
      ok: true,
      egress: await fixedEgress(),
      proxyDnsMatches: address === proxyHost,
      probeOneUpdated: process.env.PROBE_ONE === 'pe-demo-updated-sentinel',
      probeTwoPreserved: process.env.PROBE_TWO === 'pe-demo-retained-sentinel'
    }))
  } catch {
    response.writeHead(502).end(JSON.stringify({ok: false, error: 'NETWORK_PROBE_FAILED'}))
  }
}).listen(Number(process.env.PORT || 8080), '0.0.0.0')
