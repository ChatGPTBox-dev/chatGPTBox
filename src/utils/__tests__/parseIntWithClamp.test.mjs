import { parseIntWithClamp } from '../parse-int-with-clamp.mjs';

describe('parseIntWithClamp', () => {
  const min = 10;
  const max = 100;
  const defaultValue = 50;

  test('should return parsed integer for numeric string within range', () => {
    expect(parseIntWithClamp('42', min, max, defaultValue)).toBe(42);
  });

  test('should return the same integer for integer value within range', () => {
    expect(parseIntWithClamp(42, min, max, defaultValue)).toBe(42);
  });

  test('should return min value for numeric string below minimum', () => {
    expect(parseIntWithClamp('5', min, max, defaultValue)).toBe(min);
  });

  test('should return min value for integer value below minimum', () => {
    expect(parseIntWithClamp(5, min, max, defaultValue)).toBe(min);
  });

  test('should return max value for numeric string above maximum', () => {
    expect(parseIntWithClamp('105', min, max, defaultValue)).toBe(max);
  });

  test('should return max value for integer value above maximum', () => {
    expect(parseIntWithClamp(105, min, max, defaultValue)).toBe(max);
  });

  test('should return default value for non-numeric string', () => {
    expect(parseIntWithClamp('not a number', min, max, defaultValue)).toBe(defaultValue);
  });

  test('should return default value for null input', () => {
    expect(parseIntWithClamp(null, min, max, defaultValue)).toBe(defaultValue);
  });

  test('should return default value for undefined input', () => {
    expect(parseIntWithClamp(undefined, min, max, defaultValue)).toBe(defaultValue);
  });

  test('should return parsed integer for floating-point number string', () => {
    expect(parseIntWithClamp('42.99', min, max, defaultValue)).toBe(42);
    expect(parseIntWithClamp('10.01', min, max, defaultValue)).toBe(10);
  });

  test('should return parsed integer for floating-point number', () => {
    expect(parseIntWithClamp(42.99, min, max, defaultValue)).toBe(42);
    expect(parseIntWithClamp(10.01, min, max, defaultValue)).toBe(10);
  });

  test('should work correctly when min, max, and default are the same', () => {
    const val = 50;
    expect(parseIntWithClamp('50', val, val, val)).toBe(val);
    expect(parseIntWithClamp('40', val, val, val)).toBe(val); // Below min, should be val
    expect(parseIntWithClamp('60', val, val, val)).toBe(val); // Above max, should be val
    expect(parseIntWithClamp(val, val, val, val)).toBe(val);
    expect(parseIntWithClamp(val -10, val, val, val)).toBe(val);
    expect(parseIntWithClamp(val + 10, val, val, val)).toBe(val);
    expect(parseIntWithClamp('abc', val, val, val)).toBe(val);
  });

  test('should handle negative numbers correctly for min, max, and input', () => {
    const negMin = -100;
    const negMax = -10;
    const negDefault = -50;
    expect(parseIntWithClamp('-42', negMin, negMax, negDefault)).toBe(-42); // Within range
    expect(parseIntWithClamp(-42, negMin, negMax, negDefault)).toBe(-42); // Within range
    expect(parseIntWithClamp('-5', negMin, negMax, negDefault)).toBe(negMax);   // Above max
    expect(parseIntWithClamp(-5, negMin, negMax, negDefault)).toBe(negMax);   // Above max
    expect(parseIntWithClamp('-105', negMin, negMax, negDefault)).toBe(negMin); // Below min
    expect(parseIntWithClamp(-105, negMin, negMax, negDefault)).toBe(negMin); // Below min
    expect(parseIntWithClamp('abc', negMin, negMax, negDefault)).toBe(negDefault);
    expect(parseIntWithClamp('-42.5', negMin, negMax, negDefault)).toBe(-42);
    expect(parseIntWithClamp(-42.5, negMin, negMax, negDefault)).toBe(-42);
  });

  test('should return default value for empty string input', () => {
    expect(parseIntWithClamp('', min, max, defaultValue)).toBe(defaultValue);
  });

  test('should return default value for string with only whitespace', () => {
    expect(parseIntWithClamp('   ', min, max, defaultValue)).toBe(defaultValue);
  });

  test('should handle zero correctly', () => {
    expect(parseIntWithClamp('0', -10, 10, 5)).toBe(0);
    expect(parseIntWithClamp(0, -10, 10, 5)).toBe(0);
    expect(parseIntWithClamp('0', 10, 20, 15)).toBe(10); // 0 is below min
    expect(parseIntWithClamp(0, 10, 20, 15)).toBe(10); // 0 is below min
    expect(parseIntWithClamp('0', -20, -10, -15)).toBe(-10); // 0 is above max
    expect(parseIntWithClamp(0, -20, -10, -15)).toBe(-10); // 0 is above max
  });

  test('should handle NaN input for value by returning default value', () => {
    expect(parseIntWithClamp(NaN, min, max, defaultValue)).toBe(defaultValue);
  });

  test('should handle boolean inputs by returning default value', () => {
    expect(parseIntWithClamp(true, min, max, defaultValue)).toBe(defaultValue);
    expect(parseIntWithClamp(false, min, max, defaultValue)).toBe(defaultValue);
  });
});
