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
        content: record['question'],
      })
      pairs.push({ role: 'assistant', content: record['answer'] })
    }
  }

  return pairs
}
