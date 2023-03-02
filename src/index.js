const express = require('express')
const bodyparser = require('body-parser')
require('dotenv').config()
const StorageEngine = require('./StorageEngine')

const app = express()
app.use(bodyparser.json())

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*')
  res.header('Access-Control-Allow-Headers', '*')
  res.header('Access-Control-Allow-Methods', '*')
  res.header('Access-Control-Expose-Headers', '*')
  res.header('Access-Control-Allow-Private-Network', 'true')
  if (req.method === 'OPTIONS') {
    res.sendStatus(200)
  } else {
    next()
  }
})

const engine = new StorageEngine()

const endpoints = Object
  .getOwnPropertyNames(Object.getPrototypeOf(engine))
  .filter(x => x !== 'constructor')

for (const endpoint of endpoints) {
  app.post(`/${endpoint}`, async (req, res) => {
    try {
      const result = await engine[endpoint](req.body)
      res.status(200).json({
        result
      })
    } catch (e) {
      console.error(e)
      res.status(400).json({
        status: 'error',
        description: e.message
      })
    }
  })
}

app.listen(4444, () => console.log('listening on 4444'))