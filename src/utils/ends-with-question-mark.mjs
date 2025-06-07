export function endsWithQuestionMark(question) {
  const trimmedQuestion = question.trim();
  return (
    trimmedQuestion.endsWith('?') || // ASCII
    trimmedQuestion.endsWith('？') || // Chinese/Japanese
    trimmedQuestion.endsWith('؟') || // Arabic
    trimmedQuestion.endsWith('⸮') // Arabic
  )
}
