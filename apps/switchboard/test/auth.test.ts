import { describe, expect, test } from 'bun:test';
import { bearerMatches, constantTimeEqual } from '../src/auth.ts';

describe('bearerMatches', () => {
  test('matches the exact bearer token', () => {
    expect(bearerMatches('Bearer secret', 'secret')).toBe(true);
  });

  test('refuses a wrong token, wrong case, wrong scheme, or no header', () => {
    expect(bearerMatches('Bearer nope', 'secret')).toBe(false);
    expect(bearerMatches('Bearer SECRET', 'secret')).toBe(false);
    expect(bearerMatches('Basic secret', 'secret')).toBe(false);
    expect(bearerMatches('secret', 'secret')).toBe(false);
    expect(bearerMatches(undefined, 'secret')).toBe(false);
    expect(bearerMatches(null, 'secret')).toBe(false);
    expect(bearerMatches('', 'secret')).toBe(false);
  });
});

describe('constantTimeEqual', () => {
  test('a shorter or longer candidate never throws and never matches', () => {
    expect(constantTimeEqual('short', 'a-lot-longer-token')).toBe(false);
    expect(constantTimeEqual('', 'secret')).toBe(false);
  });

  test('is reflexive', () => {
    expect(constantTimeEqual('same-token', 'same-token')).toBe(true);
  });
});
