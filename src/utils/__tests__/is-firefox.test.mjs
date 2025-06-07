import { isFirefox } from '../is-firefox.mjs';

describe('isFirefox', () => {
  let userAgentSpy;
  let originalUserAgentDescriptor;

  beforeEach(() => {
    if (typeof global.navigator !== 'object' || global.navigator === null) {
      global.navigator = {};
    }

    originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(global.navigator, 'userAgent');

    let currentAgent = ''; // Default to empty string or load from originalDescriptor if needed
    if (originalUserAgentDescriptor && typeof originalUserAgentDescriptor.get === 'function') {
        currentAgent = originalUserAgentDescriptor.get();
    } else if (originalUserAgentDescriptor) {
        currentAgent = originalUserAgentDescriptor.value;
    }

    Object.defineProperty(global.navigator, 'userAgent', {
      get: () => currentAgent,
      set: (value) => { currentAgent = value; },
      configurable: true, // Crucial for spyOn and for restoring later
    });

    userAgentSpy = jest.spyOn(global.navigator, 'userAgent', 'get');
  });

  afterEach(() => {
    userAgentSpy.mockRestore();
    // Attempt to restore the original userAgent property definition
    if (originalUserAgentDescriptor) {
      Object.defineProperty(global.navigator, 'userAgent', originalUserAgentDescriptor);
    } else {
      // If it didn't exist before we defined it, we can delete it.
      delete global.navigator.userAgent;
    }
  });

  test('should return true for Firefox user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0');
    expect(isFirefox()).toBe(true);
  });

  test('should return true for Firefox user agent with mixed case', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:90.0) Gecko/20100101 FireFox/90.0');
    expect(isFirefox()).toBe(true);
  });

  test('should return false for Chrome user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    expect(isFirefox()).toBe(false);
  });

  test('should return false for Safari user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15');
    expect(isFirefox()).toBe(false);
  });

  test('should return false for Edge user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59');
    expect(isFirefox()).toBe(false);
  });

  test('should return false for an empty user agent', () => {
    userAgentSpy.mockReturnValue('');
    expect(isFirefox()).toBe(false);
  });

  test('should throw TypeError when userAgent is null', () => {
    userAgentSpy.mockReturnValue(null);
    expect(() => isFirefox()).toThrow(TypeError);
  });

  test('should throw TypeError when userAgent is undefined', () => {
    userAgentSpy.mockReturnValue(undefined);
    expect(() => isFirefox()).toThrow(TypeError);
  });

});
