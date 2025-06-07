import {
  CardHeading,
  CardList,
  EmojiSmile,
  Palette,
  QuestionCircle,
  Translate,
  Braces,
  Globe,
  ChatText,
} from 'react-bootstrap-icons'
import { getPreferredLanguage } from '../../config/language.mjs'

const createGenPrompt =
  ({
    message = '',
    isTranslation = false,
    targetLanguage = '',
    enableBidirectional = false,
    includeLanguagePrefix = false,
  }) =>
  async (selection) => {
    let preferredLanguage = targetLanguage

    if (!preferredLanguage) {
      preferredLanguage = await getPreferredLanguage()
    }

    let fullMessage = isTranslation
      ? `You are a professional translator. Translate the following text into ${preferredLanguage}, preserving meaning, tone, and formatting. Only provide the translated result.`
      : message
    if (enableBidirectional) {
      fullMessage += ` If the text is already in ${preferredLanguage}, translate it into English instead following the same requirements. Only provide the translated result.`
    }
    const prefix = includeLanguagePrefix ? `Reply in ${preferredLanguage}.` : ''
    return `${prefix}${fullMessage}:\n'''\n${selection}\n'''`
  }

export const config = {
  explain: {
    icon: <ChatText />,
    label: 'Explain',
    genPrompt: createGenPrompt({
      message:
        'You are an expert teacher. Explain the following content in simple terms and highlight the key points',
      includeLanguagePrefix: true,
    }),
  },
  translate: {
    icon: <Translate />,
    label: 'Translate',
    genPrompt: createGenPrompt({
      isTranslation: true,
    }),
  },
  translateToEn: {
    icon: <Globe />,
    label: 'Translate (To English)',
    genPrompt: createGenPrompt({
      isTranslation: true,
      targetLanguage: 'English',
    }),
  },
  translateToZh: {
    icon: <Globe />,
    label: 'Translate (To Chinese)',
    genPrompt: createGenPrompt({
      isTranslation: true,
      targetLanguage: 'Chinese',
    }),
  },
  translateBidi: {
    icon: <Globe />,
    label: 'Translate (Bidirectional)',
    genPrompt: createGenPrompt({
      isTranslation: true,
      enableBidirectional: true,
    }),
  },
  summary: {
    icon: <CardHeading />,
    label: 'Summary',
    genPrompt: createGenPrompt({
      message:
        'You are a professional summarizer. Summarize the following content in a few sentences, focusing on the key points',
      includeLanguagePrefix: true,
    }),
  },
  polish: {
    icon: <Palette />,
    label: 'Polish',
    genPrompt: createGenPrompt({
      message:
        'Act as a skilled editor. Correct grammar and word choice in the following text, improve readability and flow while preserving the original meaning, and return only the polished version',
    }),
  },
  sentiment: {
    icon: <EmojiSmile />,
    label: 'Sentiment Analysis',
    genPrompt: createGenPrompt({
      message:
        'You are an expert in sentiment analysis. Analyze the following content and provide a brief summary of the overall emotional tone, labeling it with a short descriptive word or phrase',
      includeLanguagePrefix: true,
    }),
  },
  divide: {
    icon: <CardList />,
    label: 'Divide Paragraphs',
    genPrompt: createGenPrompt({
      message:
        'You are a skilled editor. Divide the following text into clear, easy-to-read and easy-to-understand paragraphs',
    }),
  },
  code: {
    icon: <Braces />,
    label: 'Code Explain',
    genPrompt: createGenPrompt({
      message:
        'You are a senior software engineer and system architect. Break down the following code step by step, explain how each part works and why it was designed that way, note any potential issues, and summarize the overall purpose',
      includeLanguagePrefix: true,
    }),
  },
  ask: {
    icon: <QuestionCircle />,
    label: 'Ask',
    genPrompt: createGenPrompt({
      message:
        'Analyze the following content carefully and provide a concise answer or opinion with a short explanation',
      includeLanguagePrefix: true,
    }),
  },
}
