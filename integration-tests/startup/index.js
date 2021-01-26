'use strict'

const options = {}

if (process.env.AGENT_PORT) {
  options.port = process.env.AGENT_PORT
}

if (process.env.AGENT_URL) {
  options.url = process.env.AGENT_URL
}

if (process.env.SCOPE) {
  options.scope = process.env.SCOPE
}

require('../..').init(options)

const http = require('http')

const server = http.createServer((req, res) => {
  process.nextTick(() => {
    setImmediate(() => {
      (async () => {
        await new Promise(resolve => {
          resolve()
        }).then(() => {
          res.end('hello, world\n')
        })
      })()
    })
  })
}).listen(0, () => {
  const port = server.address().port
  process.send({ port })
})
