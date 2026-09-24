/**
 * The session-authenticated archive upload. It normalizes the bytes, stages
 * them in the installation's source depot, and returns the digest and location.
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

    // Before anything is staged: a ZIP is transcoded and other formats refused,
    // so the digest covers the converted bytes.
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

    // The depot comes from the manifest, never from the request.
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
