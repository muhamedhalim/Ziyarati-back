/**
 * Augments the Express request with the correlation id set by
 * RequestContextMiddleware. (`request.user` is contributed by the passport
 * typings and read with a narrow cast where needed.)
 */
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export {};
