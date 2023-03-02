const crypto = require('crypto')
const { Configuration, OpenAIApi } = require("openai")

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
})
const openai = new OpenAIApi(configuration)

class StorageEngine {
  constructor () {
    this.bots = []
    this.users = []
    this.conversations = []
    this.messages = []
    this.marketplace = []
  }

  createUser ({
    identityKey,
    name
  }) {
    this.users.push({ identityKey, name })
  }

  doesUserExist ({ identityKey }) {
    return this.users.some(x => x.identityKey === identityKey)
  }

  createBot ({
    creatorIdentityKey,
    name,
    motto,
    trainingMessages
  }) {
    const id = crypto.randomBytes(12).toString('hex')
    this.bots.push({
      creatorIdentityKey,
      ownerIdentityKey: creatorIdentityKey,
      name,
      motto,
      trainingMessages,
      id
    })
    return id
  }

  listOwnBots ({ identityKey }) {
    return this.bots.filter(x => x.ownerIdentityKey === identityKey)
  }

  doesUserOwnBot ({ identityKey, botID }) {
    return this.bots
      .some(x => x.ownerIdentityKey === identityKey && x.id === botID)
  }

  createConversation ({ identityKey, botID, title }) {
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
    return id
  }

  listConversationsWithBot ({ identityKey, botID }) {
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
      model: "gpt-3.5-turbo",
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
}

module.exports = StorageEngine
