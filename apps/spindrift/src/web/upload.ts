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
import { type StagedArchive, stageArchiveBytes } from '../storage/archives.ts';
import { uploadToGcsBucket } from '../storage/cloud.ts';
import type { DispatchDeps } from './dispatch.ts';

export const UPLOAD_PATH = '/internal/upload';

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

    const staged: StagedArchive = await stageArchiveBytes(filename, bytes);

    let location = staged.location;
    const context = deps.context(authentication.principal);
    const bucket =
      request.headers.get('x-bucket')?.trim() ||
      process.env.SPINDRIFT_ARTIFACTS_BUCKET?.trim() ||
      context.manifest?.sources?.defaultBucket?.trim() ||
      context.manifest?.sources?.buckets?.[0]?.trim();

    if (bucket) {
      const federation = context.manifest?.cloud?.federation;
      if (federation) {
        try {
          const hex = staged.digest.replace('sha256:', '');
          const ext = filename.includes('.')
            ? filename.split('.').pop()
            : 'zip';
          const gcs = await uploadToGcsBucket({
            bucketName: bucket,
            objectName: `${hex}.${ext}`,
            bytes,
            federation,
          });
          location = gcs.location;
        } catch (error: unknown) {
          const message =
            error instanceof Error
              ? error.message
              : `Cloud storage upload to gs://${bucket} failed`;
          return Response.json(
            {
              ok: false,
              failure: { code: 'STORAGE_FAILURE', message },
            },
            { status: 500 },
          );
        }
      }
    }

    return Response.json(
      {
        ok: true,
        value: {
          digest: staged.digest,
          location,
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
