/// <reference types="vite/client" />

// Vite resolves asset imports to a served URL string at build time.
declare module '*.png' {
  const url: string;
  export default url;
}
