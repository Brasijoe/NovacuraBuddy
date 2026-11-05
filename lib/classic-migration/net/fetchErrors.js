function describeFetchFailure(err, url) {
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : null;
  return new Error(
    `Could not reach '${url}' \u2014 check VPN/network connectivity and that the URL is correct.${cause ? ` (${cause})` : ""}`
  );
}
export {
  describeFetchFailure
};
