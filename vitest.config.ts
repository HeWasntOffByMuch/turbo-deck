import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * 20s rather than vitest's 5s default.
     *
     * A cluster of tests here parse and rebuild the *real* arena -- 28,919
     * collider circles since spec 165 grew the map, and growing still -- and
     * they have drifted up against the default without anybody noticing,
     * because a test only fails when the machine is busy. Measured on an idle
     * box: `map-source` 4721ms and 4682ms, `grow-script` 4436ms, `spec157`
     * 4491ms. That is 88 to 94 per cent of the budget, so the suite went red or
     * green depending on what else was running, and every one of them was one
     * added test file away from failing for good.
     *
     * The work is legitimate -- parsing a large document is not a hang -- so
     * the answer is a budget that measures the work rather than the load. What
     * it costs is that a genuinely hung test now takes 20s to say so.
     */
    testTimeout: 20_000,
  },
});
