// Dependencies
const urlFinder = require('./url')
const { findChat, addVoice } = require('./db')
const { report } = require('./report')
const urlToText = require('./urlToText')
const { isRuChat } = require('./isRuChat')
const _ = require('lodash')

const promoExceptions = [
  -1001122726482,
  -1001140130398,
  -1001275987479,
  -1001128503769,
  -1001179199008,
  -1001260542215,

  -471839945,
  -499632766,
  -428387998,
  -483383014,
  -424820225,
  -453221176,
  -465403737,
]

const promoTexts = {
  en: 'Powered by [Todorant](https://todorant.com/?ref=voicy)',
  ru: 'Powered by [Todorant](https://todorant.com/?ref=voicy)',
}

/**
 * Handles any message that comes with voice
 * @param {Telegraf:Context} ctx Context of the request
 */
async function handleMessage(ctx) {
  try {
    // Get chat
    const chat = await findChat(ctx.chat.id)
    // Get message
    const message = ctx.message || ctx.update.channel_post
    // Get voice message
    const voice =
      message.voice || message.document || message.audio || message.video_note
    // Send an error to user if file is larger than 20 mb
    if (voice.file_size && voice.file_size >= 19 * 1024 * 1024) {
      if (!chat.silent) {
        await sendLargeFileError(ctx, message)
      }
      return
    }
    // Get full url to the voice message
    const fileData = await ctx.telegram.getFile(voice.file_id)
    const voiceUrl = await urlFinder.fileUrl(fileData.file_path)
    // Send action or transcription depending on whether chat is silent
    if (chat.silent) {
      try {
        await sendAction(ctx, voiceUrl, chat, voice.file_id)
      } catch (err) {
        report(ctx, err, 'sendAction')
      }
    } else {
      try {
        await sendTranscription(ctx, voiceUrl, chat, voice.file_id)
      } catch (err) {
        report(ctx, err, 'sendTranscription')
      }
    }
  } catch (err) {
    report(ctx, err, 'handleMessage')
  }
}

/**
 * Sends temp message first and then updates that message to the transcription or error
 * @param {Telegraf:Context} ctx Context of the message
 * @param {URL} url Url of audio file to transcript
 * @param {Mongoose:Chat} chat Chat object where message has been received
 */
async function sendTranscription(ctx, url, chat, fileId) {
  // Get message
  const message = ctx.message || ctx.update.channel_post
  // Send initial message
  const sentMessage = await sendVoiceRecognitionMessage(ctx, message)
  // Get language
  const lan = languageFromChat(chat)
  // Check if ok with google engine
  if (chat.engine === 'google' && !chat.googleKey) {
    updateWithGoogleKeyError(ctx, sentMessage, chat)
    return
  }
  try {
    // Convert url to text
    const { textWithTimecodes, duration } = await urlToText(
      url,
      sanitizeChat(chat)
    )
    // Send trancription to user
    const text = chat.timecodesEnabled
      ? textWithTimecodes.map((t) => `${t[0]}:\n${t[1]}`).join('\n')
      : textWithTimecodes
          .map((t) => t[1].trim())
          .filter((v) => !!v)
          .join('. ')
    await updateMessagewithTranscription(ctx, sentMessage, text, chat)
    // Save voice to db
    await addVoice(
      url,
      textWithTimecodes
        .map((t) => t[1].trim())
        .filter((v) => !!v)
        .join('. '),
      chat,
      duration,
      textWithTimecodes,
      fileId
    )
  } catch (err) {
    // In case of error, send it
    await updateMessagewithError(ctx, sentMessage, chat, err)
    report(ctx, err, 'sendTranscription')
  } finally {
    // Log time
    console.info(
      `audio message processed in ${
        (new Date().getTime() - ctx.timeReceived.getTime()) / 1000
      }s`
    )
  }
}

/**
 * Sends typing action first and then sends transcription (doesn't send error)
 * @param {Telegraf:Context} ctx Context that triggered voice recognition
 * @param {URL} url Url of audio file to transcript
 * @param {Mongoose:Chat} chat Chat object where message has been received
 */
async function sendAction(ctx, url, chat, fileId) {
  // Send typing action
  await ctx.replyWithChatAction('typing')
  // Try to find existing voice message
  const lan = languageFromChat(chat)
  // Check if ok with google engine
  if (chat.engine === 'google' && !chat.googleKey) {
    return
  }
  try {
    // Convert utl to text
    const { textWithTimecodes, duration } = await urlToText(
      url,
      sanitizeChat(chat)
    )
    // Send trancription to user
    const text = chat.timecodesEnabled
      ? textWithTimecodes.map((t) => `${t[0]}:\n${t[1]}`).join('\n')
      : textWithTimecodes
          .map((t) => t[1].trim())
          .filter((v) => !!v)
          .join('. ')
    await sendMessageWithTranscription(ctx, text, chat)
    // Save voice to db
    await addVoice(
      url,
      textWithTimecodes
        .map((t) => t[1].trim())
        .filter((v) => !!v)
        .join('. '),
      chat,
      duration,
      textWithTimecodes,
      fileId
    )
  } catch (err) {
    // In case of error, log it
    report(ctx, err, 'sendTranscription.silent')
  } finally {
    // Log time
    console.info(
      `audio message processed in ${
        (new Date().getTime() - ctx.timeReceived.getTime()) / 1000
      }s`
    )
  }
}

/**
 * Updates message with text
 * @param {Telegraf:Context} ctx Context of the message
 * @param {Telegraf:Message} msg Message to be updated
 * @param {String} text Text that the message should be updated to
 * @param {Mongoose:Chat} chat Relevant to this voice chat
 * @param {Boolean} markdown Whether to support markdown or not
 */
async function updateMessagewithTranscription(ctx, msg, text, chat, markdown) {
  // Create options
  const options = {}
  options.parse_mode = 'Markdown'
  options.disable_web_page_preview = true
  // Add promo
  if (text && !promoExceptions.includes(ctx.chat.id)) {
    const promoText = promoTexts[isRuChat(chat) ? 'ru' : 'en']
    text = `${text}\n${promoText}`
  }
  if (!text || text.length <= 4000) {
    // Edit message
    await ctx.telegram.editMessageText(
      msg.chat.id,
      msg.message_id,
      null,
      text || ctx.i18n.t('speak_clearly'),
      options
    )
  } else {
    // Get chunks
    const chunks = text.match(/[\s\S]{1,4000}/g)
    // Edit message
    await ctx.telegram.editMessageText(
      msg.chat.id,
      msg.message_id,
      null,
      chunks.shift(),
      options
    )
    // Send the rest of text
    for (const chunk of chunks) {
      await ctx.reply(chunk, {
        ...options,
        reply_to_message_id: msg.message_id,
      })
    }
  }
}

/**
 * Sending message with transcription to chat
 * @param {Telegraf:Context} ctx Context to respond to
 * @param {String} text Transcription
 * @param {Mongoose:Chat} chat Chat to respond to
 * @param {Boolean} markdown Whether should support markdown or not
 */
async function sendMessageWithTranscription(ctx, text, chat, markdown) {
  // Get message
  const message = ctx.message || ctx.update.channel_post
  // Create options
  const options = {
    reply_to_message_id: message.message_id,
  }
  options.parse_mode = 'Markdown'
  options.disable_web_page_preview = true
  // Add promo
  if (text && !promoExceptions.includes(ctx.chat.id)) {
    const promoText = promoTexts[isRuChat(chat) ? 'ru' : 'en']
    text = `${text}\n${promoText}`
  }
  // Send message
  if (text && text.length < 4000) {
    await ctx.telegram.sendMessage(chat.id, text, options)
  } else if (text) {
    // Get chunks
    const chunks = text.match(/.{1,4000}/g)
    // Edit message
    const sentMessage = await ctx.telegram.sendMessage(
      chat.id,
      chunks.shift(),
      options
    )
    // Send the rest of text
    for (const chunk of chunks) {
      await ctx.reply(chunk, {
        ...options,
        reply_to_message_id: sentMessage.message_id,
      })
    }
  }
}

/**
 * Function to update the message with error
 * @param {Telegraf:Context} ctx Context of the message
 * @param {Telegraf:Message} msg Message to be updated
 * @param {Mongoose:Chat} chat Relevant chat
 * @param {Error} error Error of this message
 */
async function updateMessagewithError(ctx, msg, chat, error) {
  try {
    // Get text
    let text = ctx.i18n.t('error')
    if (chat.engine === 'google') {
      text = `${text}\n\n\`\`\` ${error.message || 'Unknown error'}\`\`\``
    }
    // Edit message
    await ctx.telegram.editMessageText(
      msg.chat.id,
      msg.message_id,
      null,
      text,
      {
        parse_mode: 'Markdown',
      }
    )
  } catch (err) {
    report(ctx, err, 'updateMessagewithError')
  }
}

function languageFromChat(chat) {
  return chat.engine === 'google' ? chat.googleLanguage : chat.witLanguage
}

function sendLargeFileError(ctx, message) {
  return ctx.replyWithMarkdown(ctx.i18n.t('error_twenty'), {
    parse_mode: 'Markdown',
    reply_to_message_id: message.message_id,
  })
}

function sendVoiceRecognitionMessage(ctx, message) {
  return ctx.replyWithMarkdown(ctx.i18n.t('initiated'), {
    reply_to_message_id: message.message_id,
  })
}

function updateWithGoogleKeyError(ctx, sentMessage, chat) {
  updateMessagewithTranscription(
    ctx,
    sentMessage,
    ctx.i18n.t('google_error_creds'),
    chat,
    true
  )
}

function sanitizeChat(chat) {
  return _.pick(chat, [
    'id',
    'engine',
    'googleLanguage',
    'witLanguage',
    'adminLocked',
    'silent',
    'filesBanned',
    'googleSetupMessageId',
    'googleKey',
    'language',
  ])
}

// Exports
module.exports = handleMessage
