import {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

type Handler = RequestHandler | ErrorRequestHandler;

function wrap(handler: Handler): Handler {
  // Preserve Express error-handler arity.
  if (handler.length === 4) return handler;
  const requestHandler = handler as RequestHandler;
  return function asyncSafeHandler(req: Request, res: Response, next: NextFunction) {
    try {
      const result = (requestHandler as unknown as (
        request: Request,
        response: Response,
        nextFunction: NextFunction
      ) => unknown)(req, res, next);
      if (result && typeof (result as Promise<unknown>).catch === 'function') {
        void (result as Promise<unknown>).catch(next);
      }
    } catch (error) {
      next(error);
    }
  };
}

/** Express 4 router whose promise-returning handlers always reach next(err). */
export function createRouter(): Router {
  const router = Router();
  const methods = ['all', 'get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
  for (const method of methods) {
    const original = (router as any)[method].bind(router);
    (router as any)[method] = (path: unknown, ...handlers: Handler[]) =>
      original(path, ...handlers.map(wrap));
  }

  const originalUse = (router as any).use.bind(router);
  (router as any).use = (...args: unknown[]) => originalUse(
    ...args.map(arg => {
      if (typeof arg !== 'function') return arg;
      // Nested Express routers have their own stack and must retain identity.
      if ('stack' in arg) return arg;
      return wrap(arg as Handler);
    })
  );
  return router;
}
