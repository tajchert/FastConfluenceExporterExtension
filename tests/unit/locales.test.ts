import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = resolve(__dirname, '../../public/_locales');

describe('locale names', () => {
  it('never lead with the Confluence trademark', () => {
    for (const locale of readdirSync(dir)) {
      const messages = JSON.parse(readFileSync(resolve(dir, locale, 'messages.json'), 'utf8')) as Record<string, { message: string }>;
      for (const key of ['extName', 'extShortName']) {
        expect(messages[key]?.message, `${locale}.${key}`).toBeTruthy();
        expect(messages[key]!.message.trim().toLowerCase().startsWith('confluence'), `${locale}.${key}`).toBe(false);
      }
    }
  });
});
