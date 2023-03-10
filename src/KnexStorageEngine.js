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
    if (name.length > 30) {
      throw new Error('Max character limit for bot names is 30 characters!')
    }
    const id = await this.knex('bots').insert({
      creatorIdentityKey: identityKey,
      ownerIdentityKey: identityKey,
      name,
      motto,
      trainingMessages: JSON.stringify(trainingMessages),
      deleted: false
    })
    return id[0]
  }

  async listOwnBots ({ identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const bots = await this.knex('bots')
      .where({ ownerIdentityKey: identityKey, deleted: false })
      .select('name', 'id', 'motto', 'creatorIdentityKey', 'ownerIdentityKey')
    const result = []
    for (const bot of bots) {
      const [{ name: creatorName }] = await this.knex('users')
        .where({ identityKey: bot.creatorIdentityKey })
      const isForSale = await this.isBotOnMarketplace({ botID: bot.id })
      if (bot.creatorIdentityKey === identityKey) {
        const [{ trainingMessages }] = await this.knex('bots')
          .where({ id: bot.id, deleted: false }).select('trainingMessages')
        bot.trainingMessages = JSON.parse(trainingMessages)
        bot.editable = true
      }
      result.push({
        ...bot,
        creatorName,
        isForSale
      })
    }
    return result
  }

  async doesUserOwnBot ({ identityKey, botID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    const [found] = await this.knex('bots').where({
      id: botID,
      ownerIdentityKey: identityKey,
      deleted: false
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
      title,
      deleted: false
    })
    return id[0]
  }

  async renameConversation ({ identityKey, conversationID, newName }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    await this.knex('conversations').where({
      ownerIdentityKey: identityKey,
      id: conversationID
    }).update({ title: newName })
    return true
  }

  async deleteConversation ({ identityKey, conversationID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    await this.knex('conversations').where({
      ownerIdentityKey: identityKey,
      id: conversationID
    }).update({ deleted: true })
    return true
  }

  async listConversationsWithBot ({ identityKey, botID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    const search = await this.knex('conversations').where({
      ownerIdentityKey: identityKey,
      deleted: false,
      botID
    })
    for (const c of search) {
      const latestMessage = await this.knex('messages').where({
        conversationID: c.id
      }).orderBy('created_at', 'desc').select('content').first()
      if (latestMessage) {
        c.lastMessage = latestMessage.content
      } else {
        c.lastMessage = 'No messages yet...'
      }
    }
    return search
  }

  async canBotAccessConversation ({ conversationID, botID }) {
    const [found] = await this.knex('conversations').where({
      botID,
      id: conversationID,
      deleted: false
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

  async findBotById ({ id, identityKey }) {
    const bot = await this.knex('bots').where({ id, deleted: false })
      .select(
        'name', 'motto', 'id', 'creatorIdentityKey', 'ownerIdentityKey'
      ).first()
    if (!bot) {
      throw new Error('Bot not found!')
    }
    const [{ name: creatorName }] = await this.knex('users')
      .where({ identityKey: bot.creatorIdentityKey })
    bot.creatorName = creatorName
    bot.isForSale = await this.isBotOnMarketplace({ botID: bot.id })
    if (identityKey && bot.creatorIdentityKey === identityKey) {
      const [{ trainingMessages }] = await this.knex('bots')
        .where({ id, deleted: false }).select('trainingMessages')
      bot.trainingMessages = JSON.parse(trainingMessages)
      bot.editable = true
    }
    return bot
  }

  async killBot ({ botID, identityKey }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    await this.knex('bots').where({ id: botID }).update({ deleted: true })
    return true
  }

  async didUserCreateBot ({ identityKey, botID }) {
    const bot = await this.knex('bots').where({ id: botID, deleted: false })
      .select('creatorIdentityKey').first()
    return identityKey === bot.creatorIdentityKey
  }

  async renameBot ({ botID, identityKey, newName }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.didUserCreateBot({ botID, identityKey })) {
      throw new Error('You can only rename bots you created!')
    }
    await this.knex('bots').where({ id: botID, deleted: false }).update({
      name: newName
    })
    return true
  }

  async changeBotMotto ({ botID, identityKey, newMotto }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.didUserCreateBot({ botID, identityKey })) {
      throw new Error('You can only re-motto bots you created!')
    }
    await this.knex('bots').where({ id: botID, deleted: false }).update({
      motto: newMotto
    })
    return true
  }

  async retrainBot ({ botID, identityKey, newTrainingMessages }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.didUserCreateBot({ botID, identityKey })) {
      throw new Error('You can only retrain bots you created!')
    }
    await this.knex('bots').where({ id: botID, deleted: false }).update({
      trainingMessages: JSON.stringify(newTrainingMessages)
    })
    return true
  }

  async tryMarketplaceBot ({ identityKey, botID, messages, paymentAmount }) {
    if (!await this.isBotOnMarketplace({ botID })) {
      throw new Error('You can only try bots that are on the marketplace!')
    }
    if (!await this.isBotOnMarketplace({ botID })) {
      await this.knex('users').where({ identityKey }).update({
        balance: this.knex.raw(`balance + ${paymentAmount - 50}`)
      })
      throw new Error('This bot doesn\'t appear to be on the marketplace! Did someone just buy it? Your payment has been refunded to your balance.')
    }
    const marketplace = await this.knex('marketplace')
      .where({ botID, sold: false }).first()
    const bot = await this.knex('bots')
      .where({ id: botID, deleted: false }).first()

    // !!! moderate this: message
    const completion = await openai.createChatCompletion({
      model: 'gpt-3.5-turbo',
      messages: [
        ...JSON.parse(bot.trainingMessages),
        ...messages
      ]
    })
    const botResponse = completion.data.choices[0].message.content
    await this.knex('users').where({ identityKey: marketplace.seller }).update({
      balance: this.knex.raw(`balance + ${parseInt(paymentAmount * 0.5)}`)
    })
    await this.knex('users').where({ identityKey: bot.creatorIdentityKey })
      .update({
        balance: this.knex.raw(`balance + ${parseInt(paymentAmount * 0.05)}`)
      })
    return botResponse
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
    const bot = await this.knex('bots').where({ id: botID }).first()
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
    if (amount < 10000) {
      throw new Error('Sell your bot for at least 10,000 satoshis. Give yourself some credit!')
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

  async removeBotFromMarketplace ({ identityKey, botID }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    if (!await this.doesUserOwnBot({ identityKey, botID })) {
      throw new Error('You do not appear to own this bot!')
    }
    if (!await this.isBotOnMarketplace({ botID })) {
      throw new Error(
        'This bot isn\'t listed on the marketplace, so can\'t be removed.'
      )
    }
    await this.knex('marketplace').where({
      botID,
      seller: identityKey,
      sold: false
    }).del()
    return true
  }

  async listMarketplaceBots () {
    const results = []
    const search = await this.knex('marketplace').where({ sold: false })
    for (const r of search) {
      let b
      try {
        b = await this.findBotById({ id: r.botID })
      } catch (e) {
        continue
      }
      const [{ name: sellerName }] = await this.knex('users')
        .where({ identityKey: r.seller })
      const [{ name: creatorName }] = await this.knex('users')
        .where({ identityKey: b.creatorIdentityKey })
      results.push({
        ...r,
        ...b,
        sellerName,
        creatorName,
        trainingMessages: undefined
      })
    }
    return results
  }

  async getPriceForBot ({ botID }) {
    const bot = await this.knex('marketplace').where({ botID, sold: false })
      .select('amount').first()
    if (!bot) {
      throw new Error(
        'The bot is not on the marketplace, or it is already sold!'
      )
    }
    return bot.amount
  }

  async buyBotFromMarketplace ({
    identityKey,
    botID,
    paymentAmount,
    trialMessages
  }) {
    if (!await this.doesUserExist({ identityKey })) {
      throw new Error('Register a user account before taking this action!')
    }
    let [seller] = await this.knex('marketplace')
      .where({ botID, sold: false }).select('seller')
    if (!seller) {
      await this.knex('users').where({ identityKey }).update({
        balance: this.knex.raw(`balance + ${paymentAmount - 50}`)
      })
      throw new Error('Could not find this bot on the marketplace! Did someone already buy it? Your payment has been refunded.')
    }
    seller = seller.seller
    await this.knex('marketplace').where({ botID, sold: false })
      .update({ sold: true, updated_at: new Date() })
    const [bot] = await this.knex('bots').where({ id: botID, deleted: false })
      .select('creatorIdentityKey')
    await this.knex('users').where({ identityKey: seller }).update({
      balance: this.knex.raw(
        `balance + ${parseInt(paymentAmount * 0.8)}`
      )
    })
    await this.knex('users').where({ identityKey: bot.creatorIdentityKey })
      .update({
        balance: this.knex.raw(
          `balance + ${parseInt(paymentAmount * 0.05)}`
        )
      })
    await this.knex('bots').where({ id: botID, deleted: false }).update({
      ownerIdentityKey: identityKey
    })
    if (trialMessages) {
      const [newConversation] = await this.knex('conversations').insert({
        title: 'Trial Conversation',
        ownerIdentityKey: identityKey,
        botID,
        deleted: false
      })
      for (const msg of trialMessages) {
        await this.knex('messages').insert({
          conversationID: newConversation,
          created_at: new Date(),
          role: msg.role,
          content: msg.content
        })
      }
    }
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
