/**
 * Bun's `.svg` loader is the file loader: the importer gets the asset's URL,
 * and the bytes are emitted beside the bundle rather than inlined. `bun-types`
 * declares nothing for it, so this is what makes `tsc` agree with the bundler
 * about what `import mark from './mark.svg'` is worth.
 */
declare module '*.svg' {
  const url: string;
  export default url;
}
