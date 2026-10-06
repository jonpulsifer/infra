/**
 * The browser half of the server-owned creation draft. The reducer lives in the
 * domain so commands, persistence and the browser validate one document.
 */
export {
  type Blocker,
  blockersFor,
  CREATION_BLOCKER_CODES,
  type CreationDraftView,
  creationDraftSchema,
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
