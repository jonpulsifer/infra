/**
 * The archive upload boundary.
 *
 * §4: "Archive upload accepts real bytes, stages them durably, and follows the
 * supplied-artifact or source-build path selected during creation."
 *
 * Session-authenticated route `/internal/upload` that receives archive bytes,
 * computes the SHA-256 digest, stages the archive to durable storage, and
 * returns the digest and location.
 */
import {
  ArchiveFormatError,
  normalizeArchive,
} from '@repo/archive/archive-format';
import {
  type StagedArchive,
  sourceDepotFor,
  stageArchiveBytes,
} from '../storage/archives.ts';
import type { DispatchDeps } from './dispatch.ts';
import { UPLOAD_PATH } from './upload-path.ts';

export { UPLOAD_PATH } from './upload-path.ts';

export function uploadRoutes(deps: DispatchDeps) {
  return {
    [UPLOAD_PATH]: (request: Request) => handleUpload(request, deps),
  };
}

export async function handleUpload(
  request: Request,
  deps: DispatchDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json(
      {
        ok: false,
        failure: {
          code: 'METHOD_NOT_ALLOWED',
          message: 'Upload must use POST',
        },
      },
      { status: 405 },
    );
  }

  const authentication = await deps.authenticate(request);
  if (authentication.kind === 'anonymous') {
    return Response.json(
      {
        ok: false,
        failure: {
          code: 'UNAUTHENTICATED',
          message: 'Session required to upload',
        },
      },
      { status: 401 },
    );
  }
  if (authentication.kind === 'forbidden') {
    return Response.json(
      {
        ok: false,
        failure: { code: 'FORBIDDEN', message: authentication.message },
      },
      { status: 403 },
    );
  }

  try {
    let filename = 'upload.zip';
    let bytes: Uint8Array;

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const file = (formData.get('file') ||
        formData.get('archive')) as File | null;
      if (!file) {
        return Response.json(
          {
            ok: false,
            failure: {
              code: 'MALFORMED_REQUEST',
              message: 'No file found in multipart field "file" or "archive"',
            },
          },
          { status: 400 },
        );
      }
      filename = file.name || 'upload.zip';
      bytes = new Uint8Array(await file.arrayBuffer());
    } else {
      const headerFilename = request.headers.get('x-filename');
      if (headerFilename) filename = headerFilename;
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength === 0) {
        return Response.json(
          {
            ok: false,
            failure: {
              code: 'MALFORMED_REQUEST',
              message: 'Upload payload is empty',
            },
          },
          { status: 400 },
        );
      }
      bytes = new Uint8Array(buffer);
    }

    // The one container every build route can open, before anything durable
    // happens. A ZIP is transcoded and anything else is refused here — see
    // `storage/archive-format.ts` for why the boundary is the right place and
    // why the digest is therefore over the converted bytes.
    //
    // Refused as a `400`, because it is: the request carried bytes this
    // installation cannot stage, and saying so now is the whole difference
    // between a wrong upload and a spent build that blames the platform.
    let archive: ReturnType<typeof normalizeArchive>;
    try {
      archive = normalizeArchive(filename, bytes);
    } catch (error: unknown) {
      if (error instanceof ArchiveFormatError) {
        return Response.json(
          { ok: false, failure: { code: error.code, message: error.message } },
          { status: 400 },
        );
      }
      throw error;
    }

    // One staging call, to one place, so the returned location describes where
    // the bytes actually are. A depot failure is a `500` that says so, because
    // a staged bundle nobody can retrieve is not a staged bundle.
    //
    // The place is the installation's, not the request's. This route used to
    // honour an `x-bucket` header, which made "which bucket" a thing a caller
    // asserted rather than a thing the manifest declares — see
    // `sourceDepotFor`.
    const context = await deps.context(authentication.principal);
    const depot = sourceDepotFor(context.manifest);

    let staged: StagedArchive;
    try {
      staged = await stageArchiveBytes(archive.filename, archive.bytes, depot);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : `Staging ${filename} to gs://${depot?.bucket} failed`;
      return Response.json(
        { ok: false, failure: { code: 'STORAGE_FAILURE', message } },
        { status: 500 },
      );
    }

    return Response.json(
      {
        ok: true,
        value: {
          digest: staged.digest,
          location: staged.location,
          filename: staged.filename,
          size: staged.size,
        },
      },
      { status: 200 },
    );
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : 'Upload processing failed';
    return Response.json(
      { ok: false, failure: { code: 'MALFORMED_REQUEST', message } },
      { status: 400 },
    );
  }
}
