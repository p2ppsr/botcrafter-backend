const crypto = require('crypto')
const { Configuration, OpenAIApi } = require('openai')
const Ninja = require('utxoninja')
const { getPaymentAddress } = require('sendover')
const bsv = require('babbage-bsv')

/*



PLEASE NOTE:


This file is outdated, and the Memory Storage Engine will not work as a drop-in replacement for the Knex Storage Engine. It would need to be updated with the functionality of the Knex Storage Engine before it could be used again.




*/

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})
const openai = new OpenAIApi(configuration)

class StorageEngine {
  constructor () {
    this.bots = []
    this.users = []
    this.conversations = []
    this.messages = []
    this.marketplace = []
    this.transactions = []
  }

  createUser ({
    identityKey,
    name
  }) {
    if (!name || name.length < 2) {
      throw new Error('Enter your name to register!')
    }
    this.users.push({ identityKey, name, balance: 0 })
  }

  doesUserExist ({ identityKey }) {
    return this.users.some(x => x.identityKey === identityKey)
  }

  getOwnProfile ({ identityKey }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const user = this.users.find(x => x.identityKey === identityKey)
    const unacknowledged = this.transactions.filter(x => x.recipient === identityKey && x.acknowledged === false).reduce((a, e) => a + e.amount, 0)
    return {
      ...user,
      balance: user.balance + unacknowledged
    }
  }

  createBot ({
    identityKey,
    name,
    motto,
    trainingMessages
  }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const id = crypto.randomBytes(12).toString('hex')
    this.bots.push({
      creatorIdentityKey: identityKey,
      ownerIdentityKey: identityKey,
      name,
      motto,
      trainingMessages,
      id
    })
    return id
  }

  listOwnBots ({ identityKey }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    return this.bots.filter(x => x.ownerIdentityKey === identityKey)
      .map(x => ({ ...x, trainingMessages: undefined }))
  }

  doesUserOwnBot ({ identityKey, botID }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    return this.bots
      .some(x => x.ownerIdentityKey === identityKey && x.id === botID)
  }

  createConversation ({ identityKey, botID, title }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    const id = crypto.randomBytes(12).toString('hex')
    this.conversations.push({
      ownerIdentityKey: identityKey,
      botID,
      title,
      id
    })
  }

  listConversationsWithBot ({ identityKey, botID }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    return this.conversations
      .filter(x => x.ownerIdentityKey === identityKey && x.botID === botID)
  }

  canBotAccessConversation ({ conversationID, botID }) {
    return this.conversations
      .some(x => x.botID === botID && x.id === conversationID)
  }

  listConversationMessages ({ identityKey, botID, conversationID }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!this.canBotAccessConversation({ botID, conversationID })) {
      throw new Error(
        'This bot does not appear to have access to this conversation!'
      )
    }
    return this.messages.filter(x => x.conversationID === conversationID)
  }

  findBotById ({ id }) {
    return this.bots.find(x => x.id === id)
  }

  async sendMessage ({ identityKey, botID, conversationID, message }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!this.canBotAccessConversation({ botID, conversationID })) {
      throw new Error(
        'This bot does not appear to have access to this conversation!'
      )
    }
    const bot = this.findBotById({ id: botID })
    const conversationMessages = this
      .listConversationMessages({ identityKey, botID, conversationID })
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        ...bot.trainingMessages,
        ...conversationMessages.map(x => ({
          role: x.role,
          content: x.content
        })),
        { role: 'user', content: message }
      ]
    })
    const botResponse = completion.data.choices[0].message.content
    this.messages.push({
      id: crypto.randomBytes(12).toString('hex'),
      created: Date.now(),
      role: 'user',
      content: message,
      conversationID
    })
    this.messages.push({
      id: crypto.randomBytes(12).toString('hex'),
      created: Date.now(),
      role: 'assistant',
      content: botResponse,
      conversationID
    })
    return botResponse
  }

  isBotOnMarketplace ({ botID }) {
    return this.marketplace.some(x => x.botID === botID)
  }

  listBotOnMarketplace ({ identityKey, botID, amount }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (this.isBotOnMarketplace({ botID })) {
      throw new Error('This bot is already on the marketplace!')
    }
    this.marketplace.push({
      botID,
      amount,
      seller: identityKey
    })
    return true
  }

  listMarketplaceBots () {
    return this.marketplace.map(x => {
      const { name: sellerName } = this.users
        .find(y => y.identityKey === x.seller)
      return {
        ...x,
        ...this.findBotById({ id: x.botID }),
        sellerName,
        trainingMessages: undefined
      }
    })
  }

  getPriceForBot ({ botID }) {
    const marketplaceEntry = this.marketplace
      .find(x => x.botID === botID)
    return marketplaceEntry.amount
  }

  buyBotFromMarketplace ({ identityKey, botID, paymentAmount }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const marketplaceEntry = this.marketplace.find(x => x.botID === botID)
    this.users = this.users.map(x => {
      if (x.identityKey === marketplaceEntry.seller) {
        x.balance = parseInt(x.balance + (paymentAmount * 0.85))
      }
      return x
    })
    this.bots = this.bots.map(x => {
      if (x.botID === botID) {
        x.ownerIdentityKey = identityKey
      }
      return x
    })
    this.marketplace
      .splice(this.marketplace.findIndex(x => x.botID === botID), 1)
    return botID
  }

  getBalance ({ identityKey }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const { balance } = this.users.find(x => x.identityKey === identityKey)
    return balance
  }

  async cashOut ({ identityKey }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }

    // Unacknowledged transactions are returned if they exist
    const foundPayment = this.transactions.find(x => x.acknowledged === false && x.recipient === identityKey)
    if (foundPayment) return foundPayment

    const user = this.users.find(x => x.identityKey === identityKey)
    if (user.balance < 1000) {
      throw new Error(
        `Your balance is ${user.balance} but the minimum for cashing out is 1000 satoshis.`
      )
    }
    // Create a derivation prefix and suffix to derive the public key
    const derivationPrefix = require('crypto')
      .randomBytes(10)
      .toString('base64')
    const derivationSuffix = require('crypto')
      .randomBytes(10)
      .toString('base64')
      // Derive the public key used for creating the output script
    const derivedPublicKey = getPaymentAddress({
      senderPrivateKey: process.env.SERVER_PRIVATE_KEY,
      recipientPublicKey: identityKey,
      invoiceNumber: `2-3241645161d8-${derivationPrefix} ${derivationSuffix}`,
      returnType: 'publicKey'
    })

    // Create an output script that can only be unlocked with the corresponding derived private key
    const script = new bsv.Script(
      bsv.Script.fromAddress(bsv.Address.fromPublicKey(
        bsv.PublicKey.fromString(derivedPublicKey)
      ))
    ).toHex()
    // Create a new output to spend
    const outputs = [{
      script,
      satoshis: user.balance
    }]
    // Create a new transaction with Ninja which pays the output
    const ninja = new Ninja({
      privateKey: process.env.SERVER_PRIVATE_KEY,
      config: {
        dojoURL: process.env.DOJO_URL
      }
    })
    const transaction = await ninja.getTransactionWithOutputs({
      outputs,
      note: 'Sent cash-out payment to seller.'
    })
    const payment = {
      transaction,
      derivationPrefix,
      derivationSuffix,
      amount: user.balance,
      senderIdentityKey: bsv.PrivateKey
        .fromHex(process.env.SERVER_PRIVATE_KEY).publicKey.toString(),
      recipient: identityKey,
      acknowledged: false,
      paymentID: crypto.randomBytes(12).toString('hex')
    }
    this.transactions.push(payment)
    this.users = this.users.map(x => {
      if (x.identityKey === identityKey) {
        x.balance = 0
      }
      return x
    })
    return payment
  }

  acknowledgePayment ({ identityKey, paymentID }) {
    if (!this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const payment = this.transactions
      .find(x => x.paymentID === paymentID && x.recipient === identityKey)
    if (!payment) {
      throw new Error('Payment not found!')
    }
    if (payment.acknowledged) {
      throw new Error('Payment already acknowledged!')
    }
    this.transactions = this.transactions.map(x => {
      if (x.recipient === identityKey && x.paymentID === paymentID) {
        x.acknowledged = true
      }
      return x
    })
    return true
  }
}

module.exports = StorageEngine
