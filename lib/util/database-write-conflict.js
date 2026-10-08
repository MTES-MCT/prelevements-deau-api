// Prisma can expose raw-query conflicts through the driver adapter instead of
// P2034. Keep the classification strict; other database errors must not retry.
export function isDatabaseWriteConflict(error) {
  return [error?.code, error?.meta?.code, error?.cause?.code,
    error?.meta?.driverAdapterError?.cause?.originalCode]
    .some(code => ['P2034', '40001', '40P01'].includes(code))
}
