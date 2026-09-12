/**
 * Tracks whether this vitest file imported `./db` and therefore created a
 * PGlite instance. setup.ts afterAll reads this so pure-logic files skip
 * executor drain + client.close().
 */
export let dbCreated = false;

export function markDbCreated(): void {
  dbCreated = true;
}
