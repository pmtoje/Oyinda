/** Domain error carrying a safe, customer-presentable message. Internal detail is logged, never returned. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication is required.') => new AppError(401, 'UNAUTHENTICATED', message);
export const forbidden = (message = 'You are not permitted to perform this action.') => new AppError(403, 'FORBIDDEN', message);
// IDOR defence: resources the caller may not see are reported as not found.
export const notFound = (what = 'Record') => new AppError(404, 'NOT_FOUND', `${what} was not found.`);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: unknown) => new AppError(422, code, message, details);
export const tooMany = (message = 'Too many attempts. Please wait and try again.') => new AppError(429, 'RATE_LIMITED', message);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);
