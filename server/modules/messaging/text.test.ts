import { describe, expect, it } from 'vitest';
import { withoutMentions } from './text';

describe('withoutMentions', () => {
  it('removes user, role and channel mentions and every @', () => {
    expect(withoutMentions('Card <@123> Shop @everyone')).toBe('Card  Shop everyone');
    expect(withoutMentions('<@!42><@&7><#9>Ash @here')).toBe('Ash here');
    expect(withoutMentions('Card Shop')).toBe('Card Shop');
  });
});
