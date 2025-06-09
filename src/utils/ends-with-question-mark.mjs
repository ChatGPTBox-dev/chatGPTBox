export function endsWithQuestionMark(question) {
  if (typeof question !== 'string') {
    return false;
  }
  const trimmedQuestion = question.trim();
  return (
    trimmedQuestion.endsWith('?') || // ASCII
    trimmedQuestion.endsWith('？') || // Chinese/Japanese
    trimmedQuestion.endsWith('؟') || // Arabic
    trimmedQuestion.endsWith('⸮') // Reversed/inverted question mark (used in some contexts including Arabic)
  )
}
