import { getConversationPairs } from '../get-conversation-pairs.mjs';

describe('getConversationPairs', () => {
  describe('when isCompletion is true (string output)', () => {
    test('should return an empty string for an empty records array', () => {
      expect(getConversationPairs([], true)).toBe('');
    });

    test('should convert a single record to Human/AI string format', () => {
      const records = [{ question: 'Hello?', answer: 'Hi there!' }];
      expect(getConversationPairs(records, true)).toBe('Human: Hello?\nAI: Hi there!\n');
    });

    test('should convert multiple records to Human/AI string format', () => {
      const records = [
        { question: 'First question', answer: 'First answer' },
        { question: 'Second question', answer: 'Second answer' },
      ];
      const expectedString =
        'Human: First question\nAI: First answer\n' +
        'Human: Second question\nAI: Second answer\n';
      expect(getConversationPairs(records, true)).toBe(expectedString);
    });

    test('should handle records with empty question or answer strings', () => {
      const records = [{ question: '', answer: 'An answer.' }, { question: 'A question', answer: '' }];
      const expectedString =
        'Human: \nAI: An answer.\n' +
        'Human: A question\nAI: \n';
      expect(getConversationPairs(records, true)).toBe(expectedString);
    });

    test('should handle records with missing question or answer properties (undefined becomes "undefined")', () => {
      const records = [
        { answer: 'Answer only' }, // question is undefined
        { question: 'Question only' }, // answer is undefined
      ];
      const expectedString =
        'Human: undefined\nAI: Answer only\n' +
        'Human: Question only\nAI: undefined\n';
      expect(getConversationPairs(records, true)).toBe(expectedString);
    });

    test('should handle records with null question or answer properties (null becomes "null")', () => {
      const records = [
        { question: null, answer: 'Answer for null Q' },
        { question: 'Question for null A', answer: null },
      ];
      const expectedString =
        'Human: null\nAI: Answer for null Q\n' +
        'Human: Question for null A\nAI: null\n';
      expect(getConversationPairs(records, true)).toBe(expectedString);
    });
  });

  describe('when isCompletion is false (array of objects output)', () => {
    test('should return an empty array for an empty records array', () => {
      expect(getConversationPairs([], false)).toEqual([]);
    });

    test('should convert a single record to a user/assistant pair of objects', () => {
      const records = [{ question: 'Hello?', answer: 'Hi there!' }];
      const expectedOutput = [
        { role: 'user', content: 'Hello?' },
        { role: 'assistant', content: 'Hi there!' },
      ];
      expect(getConversationPairs(records, false)).toEqual(expectedOutput);
    });

    test('should convert multiple records to user/assistant pairs of objects', () => {
      const records = [
        { question: 'Q1', answer: 'A1' },
        { question: 'Q2', answer: 'A2' },
      ];
      const expectedOutput = [
        { role: 'user', content: 'Q1' },
        { role: 'assistant', content: 'A1' },
        { role: 'user', content: 'Q2' },
        { role: 'assistant', content: 'A2' },
      ];
      expect(getConversationPairs(records, false)).toEqual(expectedOutput);
    });

    test('should handle records with empty question or answer strings', () => {
      const records = [{ question: '', answer: 'Ans' }, { question: 'Ques', answer: '' }];
      const expectedOutput = [
        { role: 'user', content: '' },
        { role: 'assistant', content: 'Ans' },
        { role: 'user', content: 'Ques' },
        { role: 'assistant', content: '' },
      ];
      expect(getConversationPairs(records, false)).toEqual(expectedOutput);
    });

    test('should handle records with missing question or answer properties (content becomes undefined)', () => {
      const records = [
        { answer: 'Answer only' }, // question is undefined
        { question: 'Question only' }, // answer is undefined
      ];
      const expectedOutput = [
        { role: 'user', content: undefined },
        { role: 'assistant', content: 'Answer only' },
        { role: 'user', content: 'Question only' },
        { role: 'assistant', content: undefined },
      ];
      expect(getConversationPairs(records, false)).toEqual(expectedOutput);
    });

    test('should handle records with null question or answer properties (content becomes null)', () => {
      const records = [
        { question: null, answer: 'Answer for null Q' },
        { question: 'Question for null A', answer: null },
      ];
      const expectedOutput = [
        { role: 'user', content: null },
        { role: 'assistant', content: 'Answer for null Q' },
        { role: 'user', content: 'Question for null A' },
        { role: 'assistant', content: null },
      ];
      expect(getConversationPairs(records, false)).toEqual(expectedOutput);
    });

    test('should default to isCompletion = false if second argument is undefined', () => {
      const records = [{ question: 'Q', answer: 'A' }];
      const expectedOutput = [
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' },
      ];
      expect(getConversationPairs(records, undefined)).toEqual(expectedOutput);
      expect(getConversationPairs(records)).toEqual(expectedOutput); // Also test with no second arg
    });
  });
});
