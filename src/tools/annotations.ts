export const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true
} as const;

export const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: false
} as const;

export const safeMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true
} as const;

export const nonDestructiveMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false
} as const;

export const idempotentWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
  idempotentHint: true
} as const;

export const openWorldReadOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true
} as const;

export const openWorldMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
  idempotentHint: true
} as const;

export const openWorldNonDestructiveMutationAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true
} as const;
