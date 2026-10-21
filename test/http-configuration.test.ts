import { describe, expect, test } from 'bun:test';
import { readHttpConfiguration } from '../src/infrastructure/config/http-configuration.js';

describe('HTTP configuration', () => {
  test('uses local defaults without environment values', () => {
    expect(readHttpConfiguration({})).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  test('accepts an explicit container binding', () => {
    expect(readHttpConfiguration({ HOST: '0.0.0.0', PORT: '8080' }))
      .toEqual({ host: '0.0.0.0', port: 8080 });
  });

  test.each(['', 'abc', '3000abc', '1.5', '1e3', '-1', '0', '65536', 'Infinity', ' 3000'])
  ('rejects invalid PORT %j', (port: string) => {
    expect(() => readHttpConfiguration({ PORT: port })).toThrow('PORT must be an integer');
  });

  test.each(['', ' ', ' 127.0.0.1'])('rejects invalid HOST %j', (host: string) => {
    expect(() => readHttpConfiguration({ HOST: host })).toThrow('HOST must be non-empty');
  });
});
