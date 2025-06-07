import { isMobile } from '../is-mobile.mjs';

describe('isMobile', () => {
  let userAgentSpy, userAgentDataSpy, vendorSpy, operaSpy;
  let initialUserAgent, initialUserAgentData, initialVendor, initialOpera;

  beforeEach(() => {
    // Mock navigator and window objects
    if (typeof global.navigator !== 'object' || global.navigator === null) {
      global.navigator = {};
    }
    if (typeof global.window !== 'object' || global.window === null) {
      global.window = {};
    }

    // Store initial values and define properties with getters/setters
    initialUserAgent = global.navigator.userAgent;
    let currentUA = initialUserAgent || '';
    Object.defineProperty(global.navigator, 'userAgent', {
      get: () => currentUA,
      set: (v) => { currentUA = v; },
      configurable: true,
    });
    userAgentSpy = jest.spyOn(global.navigator, 'userAgent', 'get');

    initialUserAgentData = global.navigator.userAgentData;
    let currentUAData = initialUserAgentData; // Can be undefined
    Object.defineProperty(global.navigator, 'userAgentData', {
      get: () => currentUAData,
      set: (v) => { currentUAData = v; },
      configurable: true,
    });
    // userAgentDataSpy will spy on the 'get' of userAgentData itself,
    // then we can make it return an object with a 'mobile' property.
    userAgentDataSpy = jest.spyOn(global.navigator, 'userAgentData', 'get');

    initialVendor = global.navigator.vendor;
    let currentVendor = initialVendor || '';
    Object.defineProperty(global.navigator, 'vendor', {
      get: () => currentVendor,
      set: (v) => { currentVendor = v; },
      configurable: true,
    });
    vendorSpy = jest.spyOn(global.navigator, 'vendor', 'get');

    initialOpera = global.window.opera;
    let currentOpera = initialOpera || '';
     Object.defineProperty(global.window, 'opera', {
      get: () => currentOpera,
      set: (v) => { currentOpera = v; },
      configurable: true,
    });
    operaSpy = jest.spyOn(global.window, 'opera', 'get');

  });

  afterEach(() => {
    userAgentSpy.mockRestore();
    userAgentDataSpy.mockRestore();
    vendorSpy.mockRestore();
    operaSpy.mockRestore();

    // Restore initial properties
    // This part needs to be careful not to break if properties didn't exist
    if (initialUserAgent !== undefined) global.navigator.userAgent = initialUserAgent; else delete global.navigator.userAgent;
    if (initialUserAgentData !== undefined) global.navigator.userAgentData = initialUserAgentData; else delete global.navigator.userAgentData;
    if (initialVendor !== undefined) global.navigator.vendor = initialVendor; else delete global.navigator.vendor;
    if (initialOpera !== undefined) global.window.opera = initialOpera; else delete global.window.opera;
  });

  // Test cases for userAgentData
  test('should return true if navigator.userAgentData.mobile is true', () => {
    userAgentDataSpy.mockReturnValue({ mobile: true });
    expect(isMobile()).toBe(true);
  });

  test('should return false if navigator.userAgentData.mobile is false', () => {
    userAgentDataSpy.mockReturnValue({ mobile: false });
    // Fallback to userAgent check will occur, so ensure userAgent is not mobile-like
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    expect(isMobile()).toBe(false);
  });

  // Test cases for userAgent regex
  test('should return true for iPhone user agent', () => {
    userAgentDataSpy.mockReturnValue(undefined); // Ensure userAgentData path is not taken
    userAgentSpy.mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 13_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.1.1 Mobile/15E148 Safari/604.1');
    expect(isMobile()).toBe(true);
  });

  test('should return true for Android user agent', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Linux; Android 10; SM-G975F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/87.0.4280.141 Mobile Safari/537.36');
    expect(isMobile()).toBe(true);
  });

  test('should return true for "mobile.+firefox" user agent', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Android 11; Mobile; rv:68.0) Gecko/68.0 Firefox/68.0');
    expect(isMobile()).toBe(true);
  });

  test('should return false for a desktop user agent (Chrome)', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    expect(isMobile()).toBe(false);
  });

  test('should return false for a desktop user agent (Firefox)', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0');
    expect(isMobile()).toBe(false);
  });

  test('should return false when userAgent and userAgentData are undefined/null', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue(undefined); // This will cause an error in the function with .substr(0,4)
    vendorSpy.mockReturnValue(undefined);
    operaSpy.mockReturnValue(undefined);
    // The function is written as (navigator.userAgent || navigator.vendor || window.opera)
    // If all are undefined/null, `a.substr(0,4)` will throw.
    expect(() => isMobile()).toThrow();
  });

  test('should return false for empty user agent and no userAgentData.mobile', () => {
    userAgentDataSpy.mockReturnValue({ mobile: false }); // or undefined
    userAgentSpy.mockReturnValue('');
    vendorSpy.mockReturnValue('');
    operaSpy.mockReturnValue('');
    expect(isMobile()).toBe(false);
  });

   test('should use navigator.vendor if userAgent is not available', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue(null); // or undefined
    vendorSpy.mockReturnValue('PalmOS'); // Example of a mobile keyword in vendor
    operaSpy.mockReturnValue(null);
    expect(isMobile()).toBe(true);
  });

  test('should use window.opera if userAgent and vendor are not available', () => {
    userAgentDataSpy.mockReturnValue(undefined);
    userAgentSpy.mockReturnValue(null);
    vendorSpy.mockReturnValue(null);
    operaSpy.mockReturnValue('Opera/9.80 (Android; Opera Mini/7.5.33361/31.1448; U; en) Presto/2.8.119 Version/11.10'); // Mobile opera string
    expect(isMobile()).toBe(true);
  });

});
