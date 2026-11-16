import { describe, expect, it } from 'vitest';
import { isUrlWithinSourceBase } from './source-url-policy';

const base = (url: string) => new URL(url);

describe('isUrlWithinSourceBase', () => {
  it('accepts the same path, nested paths and a trailing slash on the base', () => {
    expect(
      isUrlWithinSourceBase(base('https://example.com/assets'), base('https://example.com/assets')),
    ).toBe(true);
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets/'),
        base('https://example.com/assets/icons/logo.svg'),
      ),
    ).toBe(true);
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets//'),
        base('https://example.com/assets/icons/logo.svg'),
      ),
    ).toBe(true);
  });

  it('does not treat a sibling path with the same prefix as nested', () => {
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets'),
        base('https://example.com/assets2'),
      ),
    ).toBe(false);
  });

  it('rejects a different origin even when the path matches', () => {
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets'),
        base('https://other.example/assets'),
      ),
    ).toBe(false);
    // 端口不同同样是不同 origin
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets'),
        base('https://example.com:8443/assets'),
      ),
    ).toBe(false);
  });

  it('only checks the origin when the base path is the root', () => {
    expect(
      isUrlWithinSourceBase(base('https://example.com/'), base('https://example.com/any/path')),
    ).toBe(true);
    expect(
      isUrlWithinSourceBase(base('https://example.com'), base('https://example.com/any/path')),
    ).toBe(true);
    expect(
      isUrlWithinSourceBase(base('https://example.com/'), base('https://other.example/any/path')),
    ).toBe(false);
  });

  it('ignores query strings and fragments on both sides', () => {
    expect(
      isUrlWithinSourceBase(
        base('https://example.com/assets?token=1'),
        base('https://example.com/assets/logo.svg?size=2#top'),
      ),
    ).toBe(true);
  });
});
