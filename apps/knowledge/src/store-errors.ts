/** The backing database failed or is unreachable; the services answer 503. */
export class StoreUnavailableError extends Error {
  override name = "StoreUnavailableError";
}
