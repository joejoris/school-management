/**
 * The domain, from one entry point.
 *
 * Everything else imports from `@library/contracts` and nothing from a path into
 * `src/`. A deep import is how a feature ends up depending on an implementation
 * detail and nobody noticing until it moves.
 */

export * from './enums.ts'
export * from './entities.ts'
export * from './page.ts'
export * from './refusals.ts'
export * from './permissions.ts'
export type { LibraryApi } from './api.ts'
export type {
  AddCopiesInput,
  AssessFineInput,
  AuditQuery,
  CheckoutInput,
  CreateUserInput,
  FineQuery,
  ImportStartInput,
  LoanQuery,
  MemberQuery,
  PlaceHoldInput,
  RecordPaymentInput,
  RenewInput,
  ReturnInput,
  TitleQuery,
  UpdateCopyInput,
  UpdateMemberInput,
  UpdateMemberTypeInput,
  WaiveFineInput,
} from './api.ts'