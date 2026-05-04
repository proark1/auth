// Typed application errors that translate to HTTP responses.
// Fastify's error handler will pick up the .statusCode and .code fields.

export class AppError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const errors = {
  invalidToken: () => new AppError(400, 'invalid_token', 'token is invalid or expired'),
  weakPassword: () => new AppError(400, 'weak_password', 'password does not meet requirements'),
};
