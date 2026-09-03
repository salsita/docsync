import { describe, expect, it } from 'vitest';
import { refreshSkillFiles } from './skill.js';

describe('refreshSkillFiles', () => {
  it('is a no-op until ticket 11', async () => {
    await expect(refreshSkillFiles('/nowhere')).resolves.toBeUndefined();
  });
});
