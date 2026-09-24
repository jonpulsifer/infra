import { Firestore } from '@google-cloud/firestore';
import { getVercelOidcToken } from '@vercel/oidc';
import {
  ExternalAccountClient,
  type ExternalAccountClientOptions,
} from 'google-auth-library';
import {
  GCP_PROJECT_ID,
  GCP_WORKLOAD_IDENTITY_AUDIENCE,
  IS_VERCEL,
  OAUTH_SUBJECT_TOKEN_TYPE,
  OAUTH_TOKEN_URL,
} from './constants';

const GCP_WORKLOAD_IDENTITY_EXTERNAL_ACCOUNT_CONFIG = {
  type: 'external_account',
  audience: GCP_WORKLOAD_IDENTITY_AUDIENCE,
  subject_token_type: OAUTH_SUBJECT_TOKEN_TYPE,
  token_url: OAUTH_TOKEN_URL,
  subject_token_supplier: { getSubjectToken: getVercelOidcToken },
} as ExternalAccountClientOptions;

let cachedAuthClient: ExternalAccountClient | null = null;
let cachedDefaultFirestore: Firestore | null = null;
let cachedExternalFirestore: Firestore | null = null;

// gRPC PERMISSION_DENIED (7) and UNAUTHENTICATED (16), then HTTP statuses.
const UNAVAILABLE_CODES = new Set<number | string>([7, 16, 401, 403, 404]);

const UNAVAILABLE_MESSAGES = [
  'Missing or insufficient permissions',
  'Caller does not have permission',
  'unauthorized',
  'UNAUTHENTICATED',
  // Credentials could not be obtained at all.
  'Could not load the default credentials',
  'Getting metadata from plugin failed',
  'invalid_grant',
  'invalid_rapt',
];

// True for a missing, expired or unauthorized credential. Callers degrade to
// empty results so a build without credentials still completes.
export const isFirestoreUnavailableError = (error: unknown) => {
  const err = error as { code?: number | string; message?: string } | null;
  if (!err) return false;
  if (err.code !== undefined && UNAVAILABLE_CODES.has(err.code)) return true;
  const message = err.message || '';
  return UNAVAILABLE_MESSAGES.some((needle) => message.includes(needle));
};

function getAuthClient(): ExternalAccountClient {
  if (!cachedAuthClient) {
    cachedAuthClient = ExternalAccountClient.fromJSON(
      GCP_WORKLOAD_IDENTITY_EXTERNAL_ACCOUNT_CONFIG,
    );
    if (!cachedAuthClient) {
      throw new Error(
        'Failed to create GCP workload identity external account client',
      );
    }
  }
  return cachedAuthClient;
}

// On Vercel, Firestore authenticates with the Vercel OIDC token through
// workload identity federation; elsewhere it uses default credentials.
export async function getFirestore(): Promise<Firestore> {
  if (IS_VERCEL) {
    if (!cachedExternalFirestore) {
      const authClient = getAuthClient();
      cachedExternalFirestore = new Firestore({
        authClient,
        projectId: GCP_PROJECT_ID,
      });
    }
    return cachedExternalFirestore;
  }
  if (!cachedDefaultFirestore) {
    cachedDefaultFirestore = new Firestore({
      projectId: GCP_PROJECT_ID,
    });
  }
  return cachedDefaultFirestore;
}
