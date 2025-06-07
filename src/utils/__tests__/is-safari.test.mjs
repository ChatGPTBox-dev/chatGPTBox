import { isSafari } from '../is-safari.mjs';

describe('isSafari', () => {
  let vendorSpy;
  let initialVendor;

  beforeEach(() => {
    if (typeof global.navigator !== 'object' || global.navigator === null) {
      global.navigator = {};
    }

    const descriptor = Object.getOwnPropertyDescriptor(global.navigator, 'vendor');
    if (descriptor) {
      initialVendor = descriptor.get ? descriptor.get() : descriptor.value;
    } else {
      initialVendor = undefined;
    }

    let currentVendor = initialVendor || '';
    Object.defineProperty(global.navigator, 'vendor', {
      get: () => currentVendor,
      set: (value) => { currentVendor = value; },
      configurable: true,
    });

    vendorSpy = jest.spyOn(global.navigator, 'vendor', 'get');
  });

  afterEach(() => {
    vendorSpy.mockRestore();
    if (initialVendor !== undefined) {
         Object.defineProperty(global.navigator, 'vendor', {
            value: initialVendor,
            configurable: true,
            writable: true,
        });
    } else {
        global.navigator.vendor = undefined;
    }
  });

  test('should return true when navigator.vendor is "Apple Computer, Inc."', () => {
    vendorSpy.mockReturnValue('Apple Computer, Inc.');
    expect(isSafari()).toBe(true);
  });

  test('should return false when navigator.vendor is different (e.g., Google Inc.)', () => {
    vendorSpy.mockReturnValue('Google Inc.'); // Common for Chrome
    expect(isSafari()).toBe(false);
  });

  test('should return false when navigator.vendor is empty', () => {
    vendorSpy.mockReturnValue('');
    expect(isSafari()).toBe(false);
  });

  test('should return false when navigator.vendor contains "Apple" but is not exact match', () => {
    vendorSpy.mockReturnValue('Apple');
    expect(isSafari()).toBe(false);
  });

  test('should return false when navigator.vendor is null', () => {
    vendorSpy.mockReturnValue(null);
    // The function directly compares navigator.vendor === 'Apple Computer, Inc.'
    // So, null === 'Apple Computer, Inc.' is false. No error should be thrown.
    expect(isSafari()).toBe(false);
  });

  test('should return false when navigator.vendor is undefined', () => {
    vendorSpy.mockReturnValue(undefined);
    // undefined === 'Apple Computer, Inc.' is false.
    expect(isSafari()).toBe(false);
  });

  // Test with a typical Safari user agent, but ensuring vendor is the key
  // This test is more for documentation/completeness, the function *only* uses vendor.
  test('should return true for Safari like setup (vendor is Apple)', () => {
    // We also set userAgent just to simulate a more complete Safari environment,
    // but isSafari() doesn't use it.
    const initialUserAgent = global.navigator.userAgent;
    Object.defineProperty(global.navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Safari/605.1.15',
        configurable: true,
        writable: true
    });
    vendorSpy.mockReturnValue('Apple Computer, Inc.');
    expect(isSafari()).toBe(true);
    // Restore userAgent if changed
     Object.defineProperty(global.navigator, 'userAgent', {
        value: initialUserAgent,
        configurable: true,
        writable: true
    });
  });

});
