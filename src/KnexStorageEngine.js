const crypto = require('crypto')
const { Configuration, OpenAIApi } = require('openai')
const Ninja = require('utxoninja')
const { getPaymentAddress } = require('sendover')
const bsv = require('babbage-bsv')

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY
})
const openai = new OpenAIApi(configuration)

class StorageEngine {
  constructor (knex) {
    this.knex = knex
  }

  async createUser ({
    identityKey,
    name
  }) {
    if (!name || name.length < 2) {
      throw new Error('Enter your name to register!')
    }
    await this.knex('users').insert({ name, identityKey, balance: 0 })
  }

  async doesUserExist ({ identityKey }) {
    const [user] = await this.knex('users').where({ identityKey })
    return !!user
  }

  async getOwnProfile ({ identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const user = await this.knex('users').where({ identityKey }).first()
    const unacknowledgedTransactions = await this.knex('transactions')
      .where({
        recipient: identityKey,
        acknowledged: false
      })
    const unacknowledged = unacknowledgedTransactions
      .reduce((a, e) => a + e.amount, 0)
    return {
      ...user,
      balance: user.balance + unacknowledged
    }
  }

  async createBot ({
    identityKey,
    name,
    motto,
    trainingMessages
  }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const id = await this.knex('bots').insert({
      creatorIdentityKey: identityKey,
      ownerIdentityKey: identityKey,
      name,
      motto,
      trainingMessages: JSON.stringify(trainingMessages)
    })
    return id[0]
  }

  async listOwnBots ({ identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    return await this.knex('bots').where({ ownerIdentityKey: identityKey })
      .select('name', 'id', 'motto', 'creatorIdentityKey', 'ownerIdentityKey')
  }

  async doesUserOwnBot ({ identityKey, botID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const [found] = await this.knex('bots').where({
      id: botID,
      ownerIdentityKey: identityKey
    })
    return !!found
  }

  async createConversation ({ identityKey, botID, title }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    const id = await this.knex('conversations').insert({
      ownerIdentityKey: identityKey,
      botID,
      title
    })
    return id[0]
  }

  async listConversationsWithBot ({ identityKey, botID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    return await this.knex('conversations').where({
      ownerIdentityKey: identityKey,
      botID
    })
  }

  async canBotAccessConversation ({ conversationID, botID }) {
    const [found] = await this.knex('conversations').where({
      botID,
      id: conversationID
    })
    return !!found
  }

  async listConversationMessages ({ identityKey, botID, conversationID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.canBotAccessConversation({ botID, conversationID })) {
      throw new Error(
        'This bot does not appear to have access to this conversation!'
      )
    }
    return await this.knex('messages').where({ conversationID })
  }

  async findBotById ({ id }) {
    return await this.knex('bots').where({ id }).first()
  }

  async sendMessage ({ identityKey, botID, conversationID, message }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.canBotAccessConversation({ botID, conversationID })) {
      throw new Error(
        'This bot does not appear to have access to this conversation!'
      )
    }
    const bot = await this.findBotById({ id: botID })
    const conversationMessages = await this
      .listConversationMessages({ identityKey, botID, conversationID })

    // !!! moderate this: message
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        ...JSON.parse(bot.trainingMessages),
        ...conversationMessages.map(x => ({
          role: x.role,
          content: x.content
        })),
        { role: 'user', content: message }
      ]
    })
    const botResponse = completion.data.choices[0].message.content
    // !!! Moderate this: botResponse
    await this.knex('messages').insert({
      created_at: new Date(),
      role: 'user',
      content: message,
      conversationID
    })
    await this.knex('messages').insert({
      created_at: new Date(),
      role: 'assistant',
      content: botResponse,
      conversationID
    })
    return botResponse
  }

  async isBotOnMarketplace ({ botID }) {
    const [found] = await this.knex('marketplace').where({ botID, sold: false })
    return !!found
  }

  async listBotOnMarketplace ({ identityKey, botID, amount }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (await this.isBotOnMarketplace({ botID })) {
      throw new Error('This bot is already on the marketplace!')
    }
    await this.knex('marketplace').insert({
      botID,
      amount,
      seller: identityKey,
      sold: false,
      created_at: new Date(),
      updated_at: new Date()
    })
    return true
  }

  async listMarketplaceBots () {
    const results = []
    const search = await this.knex('marketplace').where({ sold: false })
    for (const r of search) {
      const [{ name: sellerName }] = await this.knex('users')
        .where({ identityKey: r.seller })
      results.push({
        ...r,
        ...(await this.findBotById({ id: r.botID })),
        sellerName,
        trainingMessages: undefined
      })
    }
    return results
  }

  async getPriceForBot ({ botID }) {
    const bot = await this.knex('marketplace').where({ botID, sold: false }).select('amount').first()
    if (!bot) {
      throw new Error(
        'The bot is not on the marketplace, or it is already sold!'
      )
    }
    return bot.amount
  }

  async buyBotFromMarketplace ({ identityKey, botID, paymentAmount }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const [{ seller }] = await this.knex('marketplace')
      .where({ botID, sold: false }).select('seller')
    await this.knex('marketplace').where({ botID, sold: false })
      .update({ sold: true, updated_at: new Date() })
    await this.knex('users').where({ identityKey: seller }).update({
      balance: this.knex.raw(
        `balance + ${parseInt(paymentAmount * 0.85)}`
      )
    })
    await this.knex('bots').where({ id: botID }).update({
      ownerIdentityKey: identityKey
    })
    return botID
  }

  async getBalance ({ identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const { balance } = await this.knex('users').where({ identityKey }).first()
    return balance
  }

  async cashOut ({ identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }

    // Unacknowledged transactions are returned if they exist
    const [foundPayment] = await this.knex('transactions').where({
      recipient: identityKey,
      acknowledged: false
    })
    if (foundPayment) {
      return {
        ...foundPayment,
        transaction: JSON.parse(foundPayment.transaction)
      }
    }

    const user = await this.knex('users').where({ identityKey }).first()
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
      created_at: new Date(),
      transaction: JSON.stringify(transaction),
      derivationPrefix,
      derivationSuffix,
      amount: user.balance,
      senderIdentityKey: bsv.PrivateKey
        .fromHex(process.env.SERVER_PRIVATE_KEY).publicKey.toString(),
      recipient: identityKey,
      acknowledged: false,
      paymentID: crypto.randomBytes(12).toString('hex')
    }
    await this.knex('transactions').insert(payment)
    await this.knex('users').where({ identityKey }).update({
      balance: this.knex.raw(`balance - ${user.balance}`)
    })
    return {
      ...payment,
      transaction: JSON.parse(payment.transaction)
    }
  }

  async acknowledgePayment ({ identityKey, paymentID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const payment = await this.knex('transactions')
      .where({ paymentID, recipient: identityKey }).first()
    if (!payment) {
      throw new Error('Payment not found!')
    }
    if (payment.acknowledged) {
      throw new Error('Payment already acknowledged!')
    }
    await this.knex('transactions')
      .where({ paymentID, recipient: identityKey }).update({
        acknowledged: true,
        updated_at: new Date()
      })
    return true
  }
}

module.exports = StorageEngine
