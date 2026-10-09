/**
 * The harness image every new sandbox runs, read from a mounted ConfigMap at
 * each mint. CD rewrites the ConfigMap, and the kubelet swaps the file in
 * place, so a new sandbox image reaches mate without a restart.
 */
import { type Log, plain } from './log.ts';

export type SandboxImage = () => Promise<string>;

/**
 * A file that cannot be read, or holds no image, keeps the last image read:
 * the kubelet's swap is atomic, so that is a fault worth a warning, not a
 * reason to stop minting. With nothing read yet, the mint fails.
 */
export function fileImage(path: string, log: Log): SandboxImage {
  let last: string | null = null;
  return async () => {
    try {
      const image = (await Bun.file(path).text()).trim();
      if (!image) throw new Error('the file is empty');
      if (image !== last) log.info('sandbox image', { image });
      last = image;
      return image;
    } catch (error) {
      if (last === null) {
        throw new Error(`no sandbox image in ${path}: ${plain(error)}`);
      }
      log.warn('could not read the sandbox image; keeping the last one', {
        file: path,
        image: last,
        error: plain(error),
      });
      return last;
    }
  };
}
