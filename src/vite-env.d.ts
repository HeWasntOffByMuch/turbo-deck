/**
 * Vite's `?raw` imports, typed (spec 070).
 *
 * The Play view needs the map document *inside the bundle*: it runs the
 * authoritative server in the tab, and that server has no filesystem to read
 * `maps/arena.json` from. `?raw` inlines the text at build time, which also
 * keeps the page free of a fetch -- the same constraint that put the pixel font
 * in a table rather than behind a request.
 */
declare module '*?raw' {
  const content: string;
  export default content;
}
