import { buildOpenAIMessageContent } from '../services/apis/images.mjs'

export function getConversationPairs(records, isCompletion) {
  let pairs
  if (isCompletion) {
    pairs = ''
    for (const record of records) {
      pairs += 'Human: ' + record.question + '\nAI: ' + record.answer + '\n'
    }
  } else {
    pairs = []
    for (const record of records) {
      pairs.push({
        role: 'user',
        content: buildOpenAIMessageContent(record['question'], record.images),
      })
      pairs.push({ role: 'assistant', content: record['answer'] })
    }
  }

  return pairs
}
