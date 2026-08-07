/**
 * Vite's `?raw` imports, typed (spec 072).
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

/**
 * Vite's `import.meta.glob`, typed just far enough for the eager JSON case.
 *
 * The map editor bundles every recipe under `maps/recipes/` so a part can be
 * grown with no server behind the page (spec 084). Declared here rather than by
 * pulling in `vite/client`, which would bring the whole ambient surface along
 * with it for one function.
 */
interface ImportMeta {
  glob(pattern: string, options: { eager: true }): Record<string, unknown>;
}
