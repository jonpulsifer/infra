// Bun's file loader gives an `.svg` import the asset's URL, which `bun-types`
// does not declare.
declare module '*.svg' {
  const url: string;
  export default url;
}
