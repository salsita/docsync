import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
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
