/**
 * The browser half of the server-owned creation draft.
 *
 * The vocabulary and reducer live in `domain/creation-draft.ts` so commands,
 * persistence, and the browser validate the same document.
 */
export {
  type Blocker,
  blockersFor,
  CREATION_BLOCKER_CODES,
  type CreationDraftView,
  creationDraftSchema,
  DECISIONS,
  type Detection,
  type Draft,
  type DraftAction,
  type DraftConfigKey,
  type DraftSource,
  draftReducer,
  ENTRIES,
  type EntryId,
  initialCreationDraft,
  type Vessel,
} from '../../../../domain/creation-draft.ts';
