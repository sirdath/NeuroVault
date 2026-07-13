/** Tiny shared claim for the optional meetings drop zone. Keeping this outside
 * EmployeePanel prevents the disabled employee UI from entering the consumer
 * app's startup bundle merely so App can inspect one boolean. */
export const meetingsDropClaim = { over: false };
