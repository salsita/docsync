import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The fake `git-remote-docsync` the two real-git test files run is built
    // once here, before any worker starts, instead of once inside each file.
    globalSetup: ['src/helper/global-setup.mock.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // `*.mock.ts` are the loopback OAuth servers the auth tests share; they
      // are test scaffolding that happens to be importable from more than one
      // test file.
      exclude: ['src/**/*.test.ts', 'src/**/*.mock.ts'],
      reporter: ['text', 'html'],
    },
  },
});
