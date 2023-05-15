const express = require('express')
const bodyparser = require('body-parser')
require('dotenv').config()
const http = require('http')
const StorageEngine = require('./KnexStorageEngine')
const authrite = require('authrite-express')
const PacketPay = require('@packetpay/express')
const knex = require('knex')(require('../knexfile').production)

const PORT = process.env.HTTP_PORT || process.env.PORT || 4444

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

app.use(authrite.middleware({
  serverPrivateKey: process.env.SERVER_PRIVATE_KEY,
  baseUrl: process.env.HOSTING_DOMAIN
}))

const engine = new StorageEngine(knex)

app.use(PacketPay({
  calculateRequestPrice: req => {
    if (req.originalUrl === '/createBot') {
      return 25000
    } else if (req.originalUrl === '/buyBotFromMarketplace') {
      return engine.getPriceForBot({ botID: req.body.botID })
    } else if (req.originalUrl === '/tryMarketplaceBot') {
      return JSON.stringify(req.body.messages).length * 20
    } else if (req.originalUrl === '/retrainBot') {
      return 15000
    }
    return 0
  },
  serverPrivateKey: process.env.SERVER_PRIVATE_KEY,
  ninjaConfig: {
    dojoURL: process.env.DOJO_URL
  }
}))

const endpoints = Object
  .getOwnPropertyNames(Object.getPrototypeOf(engine))
  .filter(x => x !== 'constructor')

for (const endpoint of endpoints) {
  app.post(`/${endpoint}`, async (req, res) => {
    try {
      const result = await engine[endpoint]({
        ...req.body,
        identityKey: req.authrite.identityKey,
        paymentAmount: req.packetpay.satoshisPaid
      })
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

http.createServer({ maxHeaderSize: 32000000 }, app).listen(PORT, () => console.log(`listening on ${PORT}`))
