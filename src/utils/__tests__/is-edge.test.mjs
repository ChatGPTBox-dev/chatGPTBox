import { isEdge } from '../is-edge.mjs';

describe('isEdge', () => {
  let userAgentSpy;
  let initialUserAgent;

  beforeEach(() => {
    if (typeof global.navigator !== 'object' || global.navigator === null) {
      global.navigator = {};
    }

    const descriptor = Object.getOwnPropertyDescriptor(global.navigator, 'userAgent');
    if (descriptor) {
      initialUserAgent = descriptor.get ? descriptor.get() : descriptor.value;
    } else {
      initialUserAgent = undefined;
    }

    let currentAgent = initialUserAgent || '';
    Object.defineProperty(global.navigator, 'userAgent', {
      get: () => currentAgent,
      set: (value) => { currentAgent = value; },
      configurable: true,
    });

    userAgentSpy = jest.spyOn(global.navigator, 'userAgent', 'get');
  });

  afterEach(() => {
    userAgentSpy.mockRestore();
    if (initialUserAgent !== undefined) {
         Object.defineProperty(global.navigator, 'userAgent', {
            value: initialUserAgent,
            configurable: true,
            writable: true,
        });
    } else {
        global.navigator.userAgent = undefined;
    }
  });

  test('should return true for Edge user agent (Edg)', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 Edg/91.0.864.59');
    expect(isEdge()).toBe(true);
  });

  test('should return true for Edge user agent with mixed case (EdG)', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36 EdG/91.0.864.59');
    expect(isEdge()).toBe(true);
  });

  test('should return true for legacy Edge user agent (Edge/)', () => {
    userAgentSpy.mockReturnValue(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.36 Edge/16.16299'
    );
    expect(isEdge()).toBe(true);
  });

  test('should return false for Chrome user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    expect(isEdge()).toBe(false);
  });

  test('should return false for Firefox user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0');
    expect(isEdge()).toBe(false);
  });

  test('should return false for Safari user agent', () => {
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Safari/605.1.15');
    expect(isEdge()).toBe(false);
  });

  test('should return false for an empty user agent', () => {
    userAgentSpy.mockReturnValue('');
    expect(isEdge()).toBe(false);
  });

  test('should throw TypeError when userAgent is null', () => {
    userAgentSpy.mockReturnValue(null);
    expect(() => isEdge()).toThrow(TypeError);
  });

  test('should throw TypeError when userAgent is undefined', () => {
    userAgentSpy.mockReturnValue(undefined);
    expect(() => isEdge()).toThrow(TypeError);
  });

});
