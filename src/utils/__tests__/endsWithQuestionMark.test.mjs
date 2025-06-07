import { endsWithQuestionMark } from '../ends-with-question-mark.mjs';

describe('endsWithQuestionMark', () => {
  test('should return true for strings ending with an ASCII question mark', () => {
    expect(endsWithQuestionMark('Hello?')).toBe(true);
  });

  test('should return true for strings ending with a Chinese/Japanese question mark', () => {
    expect(endsWithQuestionMark('你好？')).toBe(true);
  });

  test('should return true for strings ending with an Arabic question mark', () => {
    expect(endsWithQuestionMark('مرحبا؟')).toBe(true);
  });

  test('should return true for strings ending with an alternative Arabic question mark', () => {
    expect(endsWithQuestionMark('Alternative Arabic⸮')).toBe(true);
  });

  test('should return false for strings not ending with a question mark', () => {
    expect(endsWithQuestionMark('Hello')).toBe(false);
  });

  test('should return false for an empty string', () => {
    expect(endsWithQuestionMark('')).toBe(false);
  });

  test('should return false for a string with a question mark in the middle', () => {
    expect(endsWithQuestionMark('Hello? World')).toBe(false);
  });

  test('should return true for a string with only an ASCII question mark', () => {
    expect(endsWithQuestionMark('?')).toBe(true);
  });

  test('should return true for a string with only a Chinese/Japanese question mark', () => {
    expect(endsWithQuestionMark('？')).toBe(true);
  });

  test('should return true for a string with only an Arabic question mark', () => {
    expect(endsWithQuestionMark('؟')).toBe(true);
  });

  test('should return true for a string with only an alternative Arabic question mark', () => {
    expect(endsWithQuestionMark('⸮')).toBe(true);
  });

  test('should return false for a string with leading/trailing whitespace not ending in a question mark', () => {
    expect(endsWithQuestionMark('  Hello  ')).toBe(false);
  });

  test('should return true for a string with leading/trailing whitespace ending in an ASCII question mark', () => {
    expect(endsWithQuestionMark('  Hello?  ')).toBe(true);
  });

   test('should return true for a string with leading/trailing whitespace ending in a Chinese/Japanese question mark', () => {
    expect(endsWithQuestionMark('  你好？  ')).toBe(true);
  });

  test('should return true for a string with leading/trailing whitespace ending in an Arabic question mark', () => {
    expect(endsWithQuestionMark('  مرحبا؟  ')).toBe(true);
  });

  test('should return true for a string with leading/trailing whitespace ending in an alternative Arabic question mark', () => {
    expect(endsWithQuestionMark('  Alternative Arabic⸮  ')).toBe(true);
  });
});
