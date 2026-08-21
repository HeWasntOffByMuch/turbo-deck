/**
 * Vite's `?raw` imports, typed (spec 072).
 *
 * The map stopped using this in spec 202 -- it was 11.5 MB of world compiled
 * into the bundle as a string literal -- and is fetched as a JSON asset now.
 * `?raw` remains for the things it suits: small text a page genuinely wants
 * inline rather than behind a request.
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
  /**
   * The `?url` form, for discovering assets rather than naming them (spec 113).
   *
   * The game's unit roster is the contents of `assets/units/`, not a list in a
   * source file -- so the `.glb` paths cannot be written as imports. This gives
   * the bundler a static pattern it can still analyse, and hands back the emitted
   * URL per file. Eager, and cheap: what is eager is the string, not the bytes.
   */
  glob(
    pattern: string,
    options: { query: '?url'; import: 'default'; eager: true },
  ): Record<string, string>;
}

/**
 * Vite's `?url` imports, typed (spec 110).
 *
 * The Studio tab's preview loads real `.glb` files, and they are binary: `?raw`
 * would mangle them and inlining a skinned mesh as base64 would put it in the
 * main bundle for a tab most sessions never open. `?url` emits the file as an
 * asset and hands back a path, so the browser fetches it only when the preview
 * is actually mounted.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
