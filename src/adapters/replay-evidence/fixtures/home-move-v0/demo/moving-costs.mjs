export function movingCostCents(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100);
}

export function calculateMovingTotalCents(quote) {
  return (
    movingCostCents(quote.base) +
    movingCostCents(quote.distance) +
    movingCostCents(quote.fees)
  );
}
