import { getClientPosition } from '../get-client-position.mjs';

describe('getClientPosition', () => {
  test('should return the left and top of the element from getBoundingClientRect', () => {
    const mockElement = {
      getBoundingClientRect: jest.fn(() => ({
        left: 50,
        top: 100,
        right: 150,
        bottom: 200,
        width: 100,
        height: 100,
      })),
    };

    const position = getClientPosition(mockElement);
    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(position).toEqual({ x: 50, y: 100 });
  });

  test('should work with different values from getBoundingClientRect', () => {
    const mockElement = {
      getBoundingClientRect: jest.fn(() => ({
        left: -20,
        top: 30,
        right: 80,
        bottom: 130,
        width: 100,
        height: 100,
      })),
    };

    const position = getClientPosition(mockElement);
    expect(position).toEqual({ x: -20, y: 30 });
  });

  test('should throw an error if the element is null', () => {
    expect(() => getClientPosition(null)).toThrow(TypeError);
    // Because null.getBoundingClientRect() will throw "Cannot read properties of null (reading 'getBoundingClientRect')"
  });

  test('should throw an error if the element is undefined', () => {
    expect(() => getClientPosition(undefined)).toThrow(TypeError);
    // Because undefined.getBoundingClientRect() will throw "Cannot read properties of undefined (reading 'getBoundingClientRect')"
  });

  test('should throw an error if getBoundingClientRect is not a function', () => {
    const mockElement = {}; // No getBoundingClientRect
    expect(() => getClientPosition(mockElement)).toThrow(TypeError);
    // Because e.getBoundingClientRect is not a function
  });
});
